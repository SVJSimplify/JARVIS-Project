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
import { storageTools } from './storageTools';
import { processSchedulerSnapshot } from './execution/ProcessRunner';
import { recentTools, recordTool } from './toolLog';
import { assessRisk, type Risk } from './guard';
import { authorize, classifyToolAction } from './permission';
import { argsPreview, idempotencyKeyFor, recordOutcome, recordStartedStrict, callContext, type AuthDecision, type ExecutionStatus } from './toolRecord';
import { currentToolExecutionMetrics, currentToolStatus, executionSignal, runWithExecutionScope, type ToolResultEnvelope } from './toolResult';
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
import { currentSchemas, inferToolGroup, loadGroups, noteUsed, routeTurn, setAllSchemas } from './toolRouter';
import { agentToolScope } from './agentToolSelection';
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

Object.assign(TOOLS, memoryTools, projectMemoryTools, profileTools, impactTools, integrationTools, webTools, headlessTools, tinyfishTools, systemTools, storageTools, extraTools, appControlTools, visionTools, browserTools, nativeBrowserTools, githubTools, vercelTools, recoveryTools, devTools, stageTools, fsTools, patchTools, planningTools, knowledgeTools, visualTools, qualityTools, decisionTools, agiTools, learnTools, userModelTools, telemetryTools, awarenessTools, scheduleTools, artifactTools);

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
const runDetailed = Object.assign(async (name: string, rawArgs: string) => runToolDetailed(name, rawArgs), { isParallelSafe });
TOOLS.batch = batchTool(runDetailed);
TOOLS.chain = chainTool(runDetailed);
export const pickSchemas = (kind: AgentKind, request = '', includeAllAllowed = false) => {
  const def = agentDefFor(kind);
  // The registry is the hard allowlist; the per-turn scope is a second, narrower
  // capability budget. Dynamic specialists can see their complete explicitly declared
  // allowlist because every dynamic tool is named by the parent at registration time.
  const scope = agentToolScope(kind, request, includeAllAllowed);
  const allowed = new Set(scope.families);
  return schemas((name) => {
    if (!agentAllows(def, name) || SUBAGENT_DENIED.has(name)) return false;
    if (includeAllAllowed) return true;
    const family = inferToolGroup(name);
    return family === 'core' || allowed.has(family);
  });
};
