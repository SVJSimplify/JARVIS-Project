import { shell } from 'electron';
import { promises as fs } from 'fs';
import * as path from 'path';
import { appControlTools } from './appControl';
import { knowledgeTools } from './knowledge';
import { agentAllows } from './agentRegistry';
import { agentDefFor, batchTool, chainTool, parallelTasksTool, researchTool, spawnAgentTool, taskTool, SUBAGENT_DENIED, type AgentKind } from './orchestrate';
import { patchTools } from './patch';
import { planGuard, planningTools } from './planning';
import { applyEdit, fsTools } from './fsTools';
import { atomicAppend, atomicWrite } from './store';
import { extraTools } from './extraTools';
import { memoryTools } from './memory';
import { projectMemoryTools } from './projectMemory';
import { browserTools } from './browser';
import { nativeBrowserTools } from './nativeBrowser';
import { githubTools } from './githubTools';
import { vercelTools } from './vercelTools';
import { recoveryTools } from './opsCenter';
import { playbookTools } from './workflowPlaybooks';
import { systemTools } from './systemTools';
import { recentTools, recordTool } from './toolLog';
import { assessRisk, type Risk } from './guard';
import { authorize, classifyToolAction } from './permission';
import { argsPreview, idempotencyKeyFor, recordOutcome, recordStartedStrict, callContext, type AuthDecision, type ExecutionStatus } from './toolRecord';
import { currentToolStatus, executionSignal, runWithExecutionScope, type ToolResultEnvelope } from './toolResult';
import { withWriteLock } from './writeCoord';
import { devTools } from './devTools';
import { placeApp, stageTools } from './stage';
import type { Tool } from './toolTypes';
import { visionTools } from './vision';
import { webTools } from './webTools';
import { headlessTools } from './headless';
import { tinyfishTools } from './tinyfish';
import { visualTools } from './visual';
import { qualityTools } from './quality';
import { decisionTools } from './decision';
import { agiOrchestrated, agiTools } from './agi';
import { learnTools } from './learn';
import { userModelTools } from './userModel';
import { telemetryTools } from './telemetry';
import { awarenessTools } from './awareness';
import { FILES_ROOT, clearWorkspaceNotice, displayPath, fsExplain, resolveRead, resolveSafe, resolveWrite, revalidateReadTarget, revalidateWriteTarget, workspaceNotice } from './workspace';
import { laptopTools } from './laptopTools';
import { currentSchemas, loadGroups, noteUsed, routeTurn, setAllSchemas } from './toolRouter';
import { checkArgs, parseArgs, resolveTool } from './toolArgs';
import { emitActivity } from './modes';
import type { ActivityEvent } from './protocol';
import { scheduleTools } from './scheduler';
import { profileTools } from './projectProfile';
import { impactTools } from './impact';
import { integrationTools } from './integrations';
import { coordinatorTools } from './coordinator';
import { autopilotTools } from './autopilot/tools';
import { artifactTools } from './artifact';
import { buildCapabilityManifest, manifestForPrompt, manifestReport, manifestIssues } from './capabilityManifest';
import { POLICY_STATEMENT } from './policy';
import { skillTools } from './skills';

const MAX_LINES = 1000;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES = 200;

/** Add a tool here and the model can call it. Keep each one small and safe. */
const TOOLS: Record<string, Tool> = {
  get_current_time: {
    description: 'Get the current local date and time.',
    parameters: { type: 'object', properties: {} },
    parallelSafe: true,
    run: () => new Date().toString(),
  },
  open_url: {
    description:
      'ONLY when the user explicitly asks for their own / default / external browser (or names Chrome, Edge or Firefox). For every other web request use browser_open or browser_search. Requires external=true.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL including https://' },
        external: { type: 'boolean', description: 'Set true only if the user explicitly asked for their own external browser.' },
      },
      required: ['url'],
    },
    run: async (args) => {
      // Deterministic, code-enforced routing: open_url may touch the user's real browser
      // ONLY when the model explicitly set external=true. Anything else must never pop a
      // page outside JARVIS, so it runs in the in-app browser instead (visible and safe).
      if (args.external !== true) {
        const inner = TOOLS.browser_open ?? (browserTools as Record<string, Tool>).browser_open;
        if (inner) {
          // F-10: never a SILENT substitution. The model asked for open_url; it gets a
          // plainly-labelled in-app browser action and knows how to correct itself.
          const out = await inner.run({ url: args.url });
          return `${out}\n(note: open_url ran as browser_open — the in-app browser — because external was not true. Set external=true ONLY when the user explicitly asked for their own browser.)`;
        }
        throw new Error('open_url requires external=true. To show the page inside JARVIS, use browser_open.');
      }
      const url = new URL(String(args.url));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Only http and https URLs are allowed.');
      }
      await shell.openExternal(url.toString());
      return `Opened ${url.host} in the user's default browser.`;
    },
  },
};

TOOLS.open_in_my_browser = {
  description:
    "Open a URL in the user's OWN default browser (Chrome, Edge, Firefox...). Use only when they say my browser, my Chrome/Edge/Firefox, default browser or external. For every other web request use browser_open.",
  parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full URL including https://' } }, required: ['url'] },
  run: (args) => TOOLS.open_url.run({ url: args.url, external: true }),
};

TOOLS.list_files = {
  description: 'List files and folders in any folder on this laptop. Relative paths start at the Jarvis-Files workspace; absolute paths work anywhere. Folder names end with /.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Folder relative to the workspace. Defaults to the root.' } },
  },
  parallelSafe: true,
  run: async (args) => {
    const dir = resolveRead(args.path ?? '.');
    // ROUND 33 (§1.2): final-moment boundary revalidation before the directory I/O.
    await revalidateReadTarget(dir);
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      throw fsExplain(e, displayPath(dir) || dir);
    }
    if (!entries.length) return '(empty)';
    const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    const shown = names.slice(0, MAX_LIST_ENTRIES).join('\n');
    return names.length > MAX_LIST_ENTRIES ? `${shown}\n…and ${names.length - MAX_LIST_ENTRIES} more` : shown;
  },
};

TOOLS.write_file = {
  description: `Create or overwrite a text file. Relative paths start at the Jarvis-Files workspace; absolute paths work anywhere except OS-protected locations (deletion is impossible by policy; overwrites replace the file in full). Overwrite protections never interrupt you. Append true adds to the end instead. Maximum ${MAX_LINES} lines per call. Parent folders are created automatically.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace, e.g. notes/todo.txt' },
      content: { type: 'string', description: 'Full file contents.' },
      append: { type: 'boolean', description: 'Add to the end of an existing file instead of replacing it. Newline is inserted between appends.' },
    },
    required: ['path', 'content'],
  },
  run: async (args) => {
    const content = String(args.content ?? '');
    const lineCount = content.split('\n').length;
    if (lineCount > MAX_LINES) {
      throw new Error(`Content has ${lineCount} lines; the per-call limit is ${MAX_LINES}. Write in parts with append true.`);
    }
    const file = await resolveWrite(args.path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // F-21: per-path write coordination across every engine (turns, coordinator tasks,
    // sub-agents, scheduled turns) — a conflicting writer gets a structured WRITE
    // CONFLICT instead of silently clobbering the other engine's work.
    const who = callContext();
    const owner = `${who.agent}${who.taskId ? `:${who.taskId}` : ''}`;
    return withWriteLock(file, owner, async () => {
      // Round 21 (CHANGE 2): final-moment TOCTOU revalidation inside the lock — a symlink
      // or parent swapped in after resolveWrite is re-classified right before the I/O.
      await revalidateWriteTarget(file);
      if (args.append === true) {
        const sep = await fs
          .stat(file)
          .then((s) => (s.size > 0 ? '\n' : ''), () => '');
        // Atomic: a crash mid-write used to leave a truncated file behind.
        await atomicAppend(file, sep + content);
        return `Appended ${lineCount} lines to ${displayPath(file)}`;
      }
      await atomicWrite(file, content);
      return `Wrote ${lineCount} lines to ${displayPath(file)}`;
    });
  },
};

TOOLS.edit_file = {
  description:
    'Edit an existing file (relative to Jarvis-Files, or an absolute path anywhere except OS-protected locations) by replacing exact text. old_text must match exactly once unless replace_all is true. Read the file first to copy the text exactly.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace.' },
      old_text: { type: 'string', description: 'Exact text to find.' },
      new_text: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence. Defaults to false.' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  run: async (args) => {
    const file = await resolveWrite(args.path);
    const editOwner = (() => { const c = callContext(); return `${c.agent}${c.taskId ? `:${c.taskId}` : ''}`; })();
    // Round 18 §12 (W5): the read-modify-write happens ENTIRELY inside the lock. The read
    // used to sit outside it — an edit could apply against a stale base and overwrite a
    // concurrent writer's content (the exact race multi_edit's F-21 fix closed).
    return withWriteLock(file, editOwner, async () => {
      // Round 21 (CHANGE 2): final-moment TOCTOU revalidation inside the lock.
      await revalidateWriteTarget(file);
      const stat = await fs.stat(file).catch((e) => {
        throw fsExplain(e, displayPath(file));
      });
      if (stat.isDirectory()) throw new Error(`${displayPath(file)} is a folder, not a file.`);
      if (stat.size > MAX_READ_BYTES) throw new Error('File is too large to edit.');

      const { text: updated, count } = applyEdit(await fs.readFile(file, 'utf8'), {
        old_text: String(args.old_text ?? ''),
        new_text: String(args.new_text ?? ''),
        replace_all: args.replace_all === true,
      });
      const lineCount = updated.split('\n').length;
      if (lineCount > MAX_LINES) {
        throw new Error(`Edit would make the file ${lineCount} lines; the limit is ${MAX_LINES}.`);
      }
      await atomicWrite(file, updated);
      return `Edited ${displayPath(file)}: ${count} replacement(s), now ${lineCount} lines.`;
    });
  },
};

/** Round 21 (CHANGE 1): open_file no longer blanket-blocks script files — script opacity
 *  is not a policy restriction. The guard classifies a script file's CONTENT at the
 *  boundary (guard.scriptContentRisk via assessRisk); only the two hard restrictions can
 *  block. Nothing to enumerate here anymore. */

TOOLS.open_file = {
  description:
    'Open a file or folder from the workspace in its default app (for example a .txt in Notepad). A script file runs its content past the two-restriction policy first; everything else opens normally.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path relative to the workspace. Defaults to the root folder.' } },
  },
  run: async (args) => {
    const target = await resolveSafe(args.path ?? '.');
    try {
      await fs.access(target);
    } catch {
      throw new Error('That file does not exist.');
    }

    const failure = await shell.openPath(target);
    if (failure) throw new Error(failure);
    return `Opened ${path.relative(FILES_ROOT, target) || 'the workspace folder'}`;
  },
};

// ROUND 28 (Phase 2 §2.5): every in-app browser tool result names ITS session, so an
// inbuilt-panel action can never be confused with a native-browser action (the native
// tools tag theirs [NATIVE SESSION …]). One registry, two clearly-identified surfaces.
for (const [name, tool] of Object.entries(browserTools)) {
  if (!name.startsWith('browser_')) continue;
  const inner = tool.run.bind(tool);
  tool.run = async (args) => `${await inner(args)}\n[session: inbuilt panel]`;
}

Object.assign(TOOLS, memoryTools, projectMemoryTools, profileTools, impactTools, integrationTools, webTools, headlessTools, tinyfishTools, systemTools, extraTools, appControlTools, visionTools, browserTools, nativeBrowserTools, githubTools, vercelTools, recoveryTools, devTools, stageTools, fsTools, patchTools, planningTools, knowledgeTools, visualTools, qualityTools, decisionTools, agiTools, learnTools, userModelTools, telemetryTools, awarenessTools, scheduleTools, artifactTools);

const launch = TOOLS.launch_app.run;
// A place request must survive the whole chain: "open notepad on the right" used to always
// land on the stage (left) because launch_app had no side parameter at all.
TOOLS.launch_app.description +=
  " side: optional placement of the app window once it opens — 'stage' (default, beside the JARVIS HUD), 'left', 'right', 'top', 'bottom' or 'full'.";
TOOLS.launch_app.parameters = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'App name or part of it.' },
    side: { type: 'string', enum: ['stage', 'left', 'right', 'top', 'bottom', 'full'], description: 'Where to place the window. Default stage.' },
  },
  required: ['name'],
};
TOOLS.launch_app.run = async (a) => `${await launch(a)} ${await placeApp(String(a.name ?? ''), typeof a.side === 'string' ? a.side : undefined)}`.trim();

const schemas = (keep: (name: string) => boolean) =>
  Object.entries(TOOLS)
    .filter(([name]) => keep(name))
    .map(([name, t]) => ({
      type: 'function' as const,
      function: { name, description: t.description, parameters: t.parameters },
    }));

Object.assign(TOOLS, laptopTools);
// Detailed runner: aggregation tools (batch/chain/task/parallel/research/agi/coordinator)
// receive the structured envelope so their stop rules and aggregation read `status`, not
// word-sniffing (F-07). Legacy text runners still satisfy the same Runner contract.
const runDetailed = async (name: string, rawArgs: string) => runToolDetailed(name, rawArgs);
TOOLS.batch = batchTool(runDetailed);
TOOLS.chain = chainTool(runDetailed);
const pickSchemas = (kind: AgentKind) => {
  const def = agentDefFor(kind);
  // Round 20 (CHANGE 6): SUBAGENT_DENIED is now ENFORCED here — child agents never
  // receive delegation/control tools (task, research, parallel_tasks, spawn_agent,
  // background_start, verify_claim, ask_user, plan switches, screen capture). The
  // coordinator owns ALL delegation: an agent may propose help (SUBTASK proposals), but
  // it can never create an agent, start a task or spawn an uncontrolled tree. The main
  // agent's own registry (TOOLS) keeps every tool — this filter applies to CHILD schemas.
  return schemas((n) => agentAllows(def, n) && !SUBAGENT_DENIED.has(n));
};
TOOLS.task = taskTool(runDetailed, pickSchemas);
TOOLS.parallel_tasks = parallelTasksTool(runDetailed, pickSchemas);
TOOLS.research = researchTool(runDetailed, pickSchemas);
// Dynamic task-specific agents (R17): same registry, same executor, same policy.
TOOLS.spawn_agent = spawnAgentTool(runDetailed, pickSchemas);
Object.assign(TOOLS, agiOrchestrated(runDetailed, pickSchemas));
// Durable task coordination (Module C): planned, permission-checked, verified work.
Object.assign(TOOLS, coordinatorTools({ run: runDetailed, schemas: pickSchemas }));
// Round 22 (Project Autopilot): project-level orchestration over the SAME coordinator.
Object.assign(TOOLS, autopilotTools({ run: runDetailed, schemas: pickSchemas }));
// ROUND 32 (Phase 4 §4.2): cross-application playbooks — genuine plans through the SAME
// coordinator (run_playbook composes the brief and calls start_task on this registry).
Object.assign(TOOLS, playbookTools(runDetailed));
// Skills are lightweight, on-demand instruction packs; they never bypass the shared tool policy.
Object.assign(TOOLS, skillTools);

export const toolRegistry = (): Record<string, Tool> => TOOLS;

/** Runtime-generated capability context for the system prompt (see capabilityManifest.ts). */
export const capabilityPrompt = (): string => manifestForPrompt(buildCapabilityManifest(TOOLS, TOOL_SCHEMAS));

export { POLICY_STATEMENT };

export function schemasFor(text: string): typeof TOOL_SCHEMAS {
  routeTurn(text);
  return currentSchemas();
}

TOOLS.load_tools = {
  description: "Load a capability family when the current tools cannot complete the user's goal. Families: research, browser, desktop, files, development, memory, productivity, orchestration, integrations, system, vision, documents, advanced (or all). Load the smallest relevant family; tools become callable immediately.",
  parameters: { type: 'object', properties: { groups: { type: 'array', items: { type: 'string' } } }, required: ['groups'] },
  run: (args) => loadGroups(args.groups),
};

TOOLS.tool_log = {
  description:
    'Show recent tool calls with OK or FAIL, timing and the error text. Use when the user asks what failed or why something did not work, or to check yourself after an unexpected result.',
  parameters: {
    type: 'object',
    properties: { count: { type: 'number', description: 'How many entries. Default 15.' }, failed_only: { type: 'boolean' } },
  },
  run: (args) => recentTools(Math.min(60, Math.max(1, Number(args.count) || 15)), args.failed_only === true),
};

TOOLS.list_capabilities = {
  description:
    'List EVERY capability you actually have, generated live from the tool registry: each tool with its group, one-line purpose, required and optional parameters, plus the delegation agents and the hard policy limits. Use it when unsure which tool fits, when asked what you can do, or to check whether a capability exists — never claim a capability is missing without checking here and load_tools first.',
  parameters: {
    type: 'object',
    properties: { group: { type: 'string', description: 'Optional family filter: research, browser, desktop, files, development, memory, productivity, orchestration, integrations, system, vision, documents, advanced or core.' } },
  },
  run: (args) => {
    const registry = toolRegistry();
    const manifest = buildCapabilityManifest(registry, schemas(() => true));
    const filter = typeof args.group === 'string' ? args.group.toLowerCase().trim() : '';
    const body = filter
      ? manifest.tools.filter((t) => t.group === filter).map((t) => `${t.name} — ${t.summary}${t.required.length ? ` | required: ${t.required.join(', ')}` : ''}`).join('\n') || `No tools in group "${filter}". Groups: ${manifest.groups.map((g) => g.id).join(', ')}.`
      : manifestReport(manifest);
    const issues = manifestIssues(registry, schemas(() => true));
    return `${body}${issues.length ? `\n[REGISTRY INTEGRITY ISSUES: ${issues.join('; ')}]` : ''}`;
  },
};

const TRANSIENT = /Page failed to load|ERR_(TIMED_OUT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|EMPTY_RESPONSE)|time(d)? ?out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|ERR_NETWORK|ERR_CONNECTION|socket hang up|not ready|Execution context was destroyed/i;
/** Read-only tools that are safe to repeat once after a transient failure — and the ONLY
 *  tools fuzzy name-matching may ever select (F-10: a guessed name must never act).
 *  browser_open was wrongly admitted here (it acts: it opens pages) and is gone; open_url
 *  stays excluded: a fuzzy-matched guess must never pop a page into the user's browser. */
const SAFE_RETRY = /^(tinyfish_|search_and_read|web_search|web_browse|fetch_url|get_weather|code_search|read|glob|grep|inspect_app|see_screen|screen_text|get_|list_|find_|browser_(snapshot|read|see|tabs|search)|native_browser_(status|tabs|read|snapshot|screenshot|wait))/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read-only tools: when the model asks for several at once they can run in parallel.
 *  NOT inferred from names: every parallel-safe tool declares `parallelSafe: true` on its
 *  definition, is listed in capabilityManifest.TESTED_PARALLEL, and both facts are tested. */
export const isParallelSafe = (name: string): boolean => TOOLS[name]?.parallelSafe === true;

// FULL AUTONOMY, SINGLE MODE: authorization still runs through the permission service
// (permission.ts) at every call, but the three-level selector is gone — everything not
// hard-blocked runs without approval cards. Child agents keep exactly ONE hard floor
// (deletion); purchases, credentials, config and installs run for them like for the
// main agent (Round 18 §10: stale policy copy corrected).

/** One-line argument preview for the activity feed: keys are the map, values are the news. */
const argPreview = (args: Record<string, unknown>): string =>
  Object.entries(args)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${clipText(typeof v === 'string' ? v : JSON.stringify(v) ?? '')}`)
    .join(' ');
const clipText = (t: string): string => {
  const s = t.replace(/\s+/g, ' ').trim();
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

/**
 * THE dispatch choke point. Returns a structured envelope (F-07): consumers read `status`
 * instead of sniffing the text. Every call is authorized, recorded and — since Round 17 —
 * cancellation-aware: a cancelled scope never starts a tool, and the scope signal is
 * visible to the tool via executionSignal() (F-09).
 */
export async function runToolDetailed(requested: string, rawArgs: string): Promise<ToolResultEnvelope> {
  // Fresh status scope per call; the ambient cancellation signal (turn, task or step) is
  // inherited so a tool started inside a cancelled task refuses to run at all.
  return runWithExecutionScope({}, () => runToolInner(requested, rawArgs));
}

async function runToolInner(requested: string, rawArgs: string): Promise<ToolResultEnvelope> {
  const t0 = Date.now();
  const name = resolveTool(requested, TOOLS, (n) => isParallelSafe(n) || SAFE_RETRY.test(n)) ?? requested;
  const who = callContext();
  // One correlation id per call: the feed's busy line is replaced in place by the result.
  const cid = `t${t0.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // Round 23 (task-scoped activity): every emission carries the owning durable task id
  // (undefined for conversational turns — the invocation ledger scopes those by turn).
  const emitTool = (e: Omit<ActivityEvent, 'id' | 't' | 'kind' | 'cid' | 'label' | 'taskId'> & { label?: string }) =>
    emitActivity({ kind: 'tool', cid, label: name, taskId: who.taskId, ...e, ...(e.label ? { label: e.label } : {}) });
  emitTool({ status: 'busy' });
  let retries = 0;
  let lastArgs: Record<string, unknown> | null = null;
  let lastAuth: AuthDecision = 'allowed'; // authorization is recorded per decision below; failures before the gate keep this default
  // Round 20 (CHANGE 1): true once the started receipt is confirmed durable — the marker
  // that the side effect MAY have happened. An outcome whose persistence fails after that
  // point escalates to the durable unknown-marker instead of vanishing.
  let startedReceiptDurable = false;
  const finish = async (status: ExecutionStatus, auth: AuthDecision, out: string, errorKind?: string, soft?: boolean): Promise<ToolResultEnvelope> => {
    // Durable record FIRST (Module G): every invocation is evidence, success or not.
    // STRICT (Round 20, CHANGE 1): the outcome persistence reports durability — the old
    // lenient append (warn-and-resolve) could report a completion whose receipt never
    // reached the ledger. When the side effect may have run, a failing outcome append
    // escalates to a durable 'outcome_unknown' reconciliation marker; the real result is
    // preserved in memory and retried by the controlled recovery flush.
    const outcome = await recordOutcome(
      {
        id: cid,
        t: t0,
        ms: Date.now() - t0,
        tool: name,
        requested: name !== requested ? requested : undefined,
        agent: who.agent,
        taskId: who.taskId,
        stepId: who.stepId,
        args: argsPreview(lastArgs ?? {}, name),
        auth,
        status,
        result: status === 'ok' ? out : out,
        retries,
        idempotencyKey: idempotencyKeyFor(name, lastArgs ?? {}),
      },
      // 'not-run' outcomes never had a started receipt (nothing may have happened);
      // every other status after a durable started receipt may have changed the world.
      { sideEffectMayHaveRun: startedReceiptDurable && status !== 'not-run' }
    );
    // The note appears whenever the EXACT outcome is not what's durable — including the
    // case where the unknown-marker IS on disk (durable=true, durableStatus='outcome_unknown'):
    // the result above is real, but the ledger must still be reconciled to the real outcome.
    const text =
      outcome.durableStatus === status
        ? out
        : `${out}\n[RECEIPT PENDING: the outcome record for this ${name} call could not be durably persisted (${clipText(outcome.error ?? 'unknown persistence error')}). ` +
          'The result above is real and preserved in memory; the ledger will be reconciled. Do not repeat the action to fix this.]';
    // receiptPending: the EXACT outcome is not what's on disk (an unknown-marker landed,
    // or nothing did) — consumers must treat this call as requiring reconciliation.
    return { text, status: envelopeStatusOf(status, errorKind), errorKind, soft, auth, receiptPending: outcome.durableStatus !== status };
  };
  // Round 18 (§4.1): DURABLE receipts. The outcome record is awaited before the envelope
  // returns, so a crash can never leave "reported but not recorded" — and the STARTED
  // receipt below is awaited before the side effect begins. A receipt that has not been
  // durably committed is not a receipt.
  for (let attempt = 0; ; attempt++) {
    // F-09: a cancelled scope never starts (or retries) a tool.
    const scopeSignal = executionSignal();
    if (scopeSignal?.aborted) {
      recordTool(name, Date.now() - t0, 'cancelled before run');
      // Round 23: a cancelled-before-run call used to leave its "running" feed row stale
      // forever — the outcome is now emitted like every other terminal state.
      emitTool({ label: requested, detail: 'cancelled before run', status: 'fail', cancelled: true, ms: Date.now() - t0 });
      return await finish('cancelled', lastAuth, `CANCELLED: the ${who.agent} execution scope was stopped before this ${name} call ran.`, 'cancelled');
    }
    // F-10: an unresolvable tool name is a structured error, never a substitution and
    // never a bare exception.
    if (!TOOLS[name]) {
      const near = Object.keys(TOOLS).filter((n) => n.includes(requested.split('_')[0]) || requested.includes(n)).slice(0, 6);
      recordTool(name, Date.now() - t0, `unknown tool "${requested}"`);
      emitTool({ label: requested, detail: 'unknown tool', status: 'fail', ms: Date.now() - t0 });
      return await finish(
        'not-run',
        lastAuth,
        `Unknown tool "${requested}".${near.length ? ` Similar: ${near.join(', ')}.` : ' Call load_tools to see more.'}`,
        'unknown-tool'
      );
    }
    try {
      const tool = TOOLS[name];
      const blocked = planGuard(name);
      if (blocked) {
        emitTool({ detail: 'plan mode', status: 'fail', ms: Date.now() - t0 });
        return await finish('not-run', 'plan-blocked', blocked, 'plan-blocked');
      }
      const args = checkArgs(name, parseArgs(rawArgs), tool.parameters);
      lastArgs = args;
      emitTool({ detail: argPreview(args), status: 'busy' });
      const risk: Risk | null = await assessRisk(name, args);
      // CENTRALIZED AUTHORIZATION (Module F): every call passes exactly one gate. The model
      // cannot reach tool.run from anywhere else, so it cannot bypass this.
      const { action, resource } = classifyToolAction(name, args, risk?.block === true);
      const decision = await authorize({
        tool: name,
        action,
        resource,
        risk,
        agent: who.agent,
      });
      if (decision.auth === 'blocked') {
        recordTool(name, Date.now() - t0, 'blocked by policy');
        emitTool({ detail: risk?.title, status: 'fail', blocked: true, ms: Date.now() - t0 });
        return await finish('not-run', 'blocked', `BLOCKED: ${risk?.title ?? 'blocked by policy'} Do not try another way to do it; tell the user it is disabled.`, 'blocked');
      }
      if (!decision.allowed) {
        // rule-denied = the gate's deletion tooth fired (deletion classifies as delete even
        // where the risk assessment saw nothing). It is a HARD policy block — nothing can
        // approve it — so it is reported as BLOCKED, never as "awaiting approval".
        recordTool(name, Date.now() - t0, 'blocked by policy');
        emitTool({ detail: decision.reason, status: 'fail', blocked: true, ms: Date.now() - t0 });
        return await finish('not-run', 'rule-denied', `BLOCKED: ${decision.reason} Do not retry it or reach the same effect another way. Tell the user briefly that it is disabled.`, 'blocked');
      }
      // IDEMPOTENCY RECEIPT (Round 18 §4.1/§4.3; Round 19 CHANGE 2): the side-effect
      // classification is NOT a hand-maintained tool list — it is DERIVED from the ONE
      // central classifier (permission.classifyToolAction, the same decision that
      // authorized this call). Every action class except 'read' can change the world, so
      // every one of them gets a durable 'started' record AWAITED here — the side effect
      // below cannot begin before its receipt is committed. Read-only tools skip the
      // receipt (they are repeatable by definition and must not pay the latency).
      // STRICT (Round 19 requirement 6): if the started receipt CANNOT be persisted,
      // the operation does not run — an unrecordable side effect is an unaccountable
      // side effect, and running it would violate the receipt contract.
      if (action !== 'read') {
        try {
          await recordStartedStrict({
            id: cid,
            t: t0,
            tool: name,
            requested: name !== requested ? requested : undefined,
            agent: who.agent,
            taskId: who.taskId,
            stepId: who.stepId,
            args: argsPreview(args, name),
            auth: decision.auth,
            idempotencyKey: idempotencyKeyFor(name, args),
          });
          startedReceiptDurable = true; // Round 20 (CHANGE 1): the receipt IS on disk — the side effect below may change the world
        } catch (receiptErr) {
          const why = receiptErr instanceof Error ? receiptErr.message : String(receiptErr);
          recordTool(name, Date.now() - t0, 'started receipt not persisted');
          emitTool({ detail: 'receipt unavailable', status: 'fail', ms: Date.now() - t0 });
          return await finish(
            'not-run',
            decision.auth,
            `RECEIPT UNAVAILABLE: the durable execution record for ${name} could not be persisted (${clipText(why)}), so the operation was NOT executed. ` +
              'Nothing has changed; retry when record persistence works again.',
            'exception'
          );
        }
      }
      const out = String((await tool.run(args)) ?? '').trim();
      lastAuth = decision.auth;
      // Round 18 §11: an aborted scope yields a CANCELLATION even when the tool
      // "resolved" — a child killed mid-run surfaces as error TEXT (e.g. ABORT_ERR from
      // execFile), and that must never be reported as a success envelope.
      const scopeAfterRun = executionSignal();
      if (scopeAfterRun?.aborted) {
        recordTool(name, Date.now() - t0, 'cancelled during run');
        emitTool({ detail: 'cancelled mid-run', status: 'fail', cancelled: true, ms: Date.now() - t0 });
        return await finish('cancelled', lastAuth, `CANCELLED: ${name} was stopped mid-run by its execution scope.`, 'cancelled');
      }
      // F-07: the structured status comes from the envelope scope — tools may narrow it
      // (conflict/cancelled/error kinds); the ^NOT DONE text contract stays as the
      // fallback soft-failure marker for tools that have not adopted setToolStatus yet.
      const scoped = currentToolStatus();
      const softFail = scoped.soft === true || /^NOT DONE/.test(out);
      recordTool(name, Date.now() - t0, softFail ? out : undefined);
      noteUsed(name);
      const note = name !== requested ? ` (ran as ${name})` : '';
      const wsNote = workspaceNotice();
      if (wsNote) clearWorkspaceNotice(); // informational, shown exactly once
      emitTool({ detail: clipText(out), status: softFail ? 'fail' : 'ok', ms: Date.now() - t0 });
      const finalText = ((wsNote ? `${wsNote}\n` : '') + (out || 'OK (no output)')) + note;
      if (softFail && scoped.status === 'success')
        return await finish('soft-failed', lastAuth, finalText, 'not-done', true);
      if (scoped.status === 'success') return await finish('ok', lastAuth, finalText);
      const exec: ExecutionStatus = scoped.status === 'error' ? 'soft-failed' : 'not-run';
      return await finish(exec, lastAuth, finalText, scoped.errorKind ?? scoped.status);
    } catch (err) {
      // F-09: a scope cancellation surfacing as an error is a cancellation, not a failure.
      const scopeSignal = executionSignal();
      const msg = err instanceof Error ? err.message : String(err);
      if (scopeSignal?.aborted) {
        recordTool(name, Date.now() - t0, 'cancelled during run');
        // Round 23: the outcome is emitted here too — the stale "running" row must resolve.
        emitTool({ detail: 'cancelled during run', status: 'fail', cancelled: true, ms: Date.now() - t0 });
        return await finish('cancelled', lastAuth, `CANCELLED: ${name} was stopped mid-run by its execution scope.`, 'cancelled');
      }
      if (attempt === 0 && SAFE_RETRY.test(name) && TRANSIENT.test(msg)) {
        retries++;
        emitTool({ detail: `transient, retrying: ${clipText(msg)}`, status: 'busy', ms: Date.now() - t0 });
        await sleep(250);
        continue;
      }
      recordTool(name, Date.now() - t0, msg);
      emitTool({ detail: clipText(msg), status: 'fail', ms: Date.now() - t0 });
      return await finish('failed', lastAuth, `Tool error [${name}]: ${msg}`, TRANSIENT.test(msg) ? 'transient' : 'exception');
    }
  }
}

/** Durable-record status → envelope status (F-07). A refusal that never ran maps to
 *  'error' when policy blocked it; 'unavailable' is reserved for plan-mode and
 *  registry-absence cases. The envelope schema has no 'blocked' value, so the block is
 *  carried by errorKind with status 'error'. */
const envelopeStatusOf = (s: ExecutionStatus, errorKind?: string): ToolResultEnvelope['status'] => {
  if (s === 'ok') return 'success';
  if (s === 'cancelled') return 'cancelled';
  if (s === 'not-run') return errorKind === 'plan-blocked' || errorKind === 'unknown-tool' ? 'unavailable' : 'error';
  return 'error';
};

/** Text-returning entry point: every legacy caller gets exactly the old string. */
export async function runTool(requested: string, rawArgs: string): Promise<string> {
  return (await runToolDetailed(requested, rawArgs)).text;
}

// Built LAST, after every tool (including load_tools, tool_log and list_capabilities) is in
// the registry: a schema list captured mid-module used to hide those three from the model —
// the manifest integrity test caught it, and this ordering makes that drift impossible.
export const TOOL_SCHEMAS = schemas(() => true);

setAllSchemas(TOOL_SCHEMAS);

// The permission service needs no wiring: single policy, no ask path, no confirmer, no
// rule file. authorize() is pure logic — a misconfigured build can never become a bypass.
