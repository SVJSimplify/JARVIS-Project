import { shell } from 'electron';
import { promises as fs } from 'fs';
import * as path from 'path';
import { appControlTools } from './appControl';
import { knowledgeTools } from './knowledge';
import { EXPLORE_TOOLS, RESEARCH_TOOLS, SUBAGENT_DENIED, batchTool, chainTool, parallelTasksTool, researchTool, taskTool, type AgentKind } from './orchestrate';
import { patchTools } from './patch';
import { planGuard, planningTools } from './planning';
import { applyEdit, fsTools } from './fsTools';
import { atomicAppend, atomicWrite } from './store';
import { extraTools } from './extraTools';
import { memoryTools } from './memory';
import { browserTools } from './browser';
import { systemTools } from './systemTools';
import { recentTools, recordTool } from './toolLog';
import { assessRisk, requestConfirm } from './guard';
import { devTools } from './devTools';
import { placeApp, stageTools } from './stage';
import type { Tool } from './toolTypes';
import { visionTools } from './vision';
import { webTools } from './webTools';
import { tinyfishTools } from './tinyfish';
import { visualTools } from './visual';
import { qualityTools } from './quality';
import { decisionTools } from './decision';
import { agiOrchestrated, agiTools } from './agi';
import { learnTools } from './learn';
import { userModelTools } from './userModel';
import { telemetryTools } from './telemetry';
import { awarenessTools } from './awareness';
import { FILES_ROOT, clearWorkspaceNotice, displayPath, fsExplain, resolveRead, resolveSafe, resolveWrite, workspaceNotice } from './workspace';
import { laptopTools } from './laptopTools';
import { currentSchemas, loadGroups, noteUsed, routeTurn, setAllSchemas } from './toolRouter';
import { checkArgs, parseArgs, resolveTool } from './toolArgs';
import { emitActivity } from './modes';
import { scheduleTools } from './scheduler';

const MAX_LINES = 1000;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES = 200;

/** Add a tool here and the model can call it. Keep each one small and safe. */
const TOOLS: Record<string, Tool> = {
  get_current_time: {
    description: 'Get the current local date and time.',
    parameters: { type: 'object', properties: {} },
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
        if (inner) return inner.run({ url: args.url });
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
  run: async (args) => {
    const dir = resolveRead(args.path ?? '.');
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
  description: `Create or overwrite a text file. Relative paths start at the Jarvis-Files workspace; absolute paths work anywhere except protected system folders. Overwriting an existing file asks the user first; append true adds to the end instead. Maximum ${MAX_LINES} lines per call. Parent folders are created automatically.`,
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
  },
};

TOOLS.edit_file = {
  description:
    'Edit an existing file (relative to Jarvis-Files, or an absolute path anywhere except protected system folders; editing a file outside Jarvis-Files asks the user first) by replacing exact text. old_text must match exactly once unless replace_all is true. Read the file first to copy the text exactly.',
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
  },
};

/** Opening these would run code, so the model may never launch them. */
const BLOCKED_OPEN = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.vbe', '.js', '.jse',
  '.wsf', '.wsh', '.lnk', '.scr', '.hta', '.reg', '.jar', '.dll', '.cpl',
]);

TOOLS.open_file = {
  description:
    'Open a file or folder from the workspace in its default app (for example a .txt in Notepad). Program and script files are blocked.',
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
    const ext = path.extname(target).toLowerCase();
    if (BLOCKED_OPEN.has(ext)) throw new Error(`Opening ${ext} files is blocked for safety.`);

    const failure = await shell.openPath(target);
    if (failure) throw new Error(failure);
    return `Opened ${path.relative(FILES_ROOT, target) || 'the workspace folder'}`;
  },
};

Object.assign(TOOLS, memoryTools, webTools, tinyfishTools, systemTools, extraTools, appControlTools, visionTools, browserTools, devTools, stageTools, fsTools, patchTools, planningTools, knowledgeTools, visualTools, qualityTools, decisionTools, agiTools, learnTools, userModelTools, telemetryTools, awarenessTools, scheduleTools);

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
TOOLS.batch = batchTool(runTool);
TOOLS.chain = chainTool(runTool);
const pickSchemas = (kind: AgentKind) =>
  schemas((n) => (kind === 'explore' ? EXPLORE_TOOLS.has(n) : kind === 'research' ? RESEARCH_TOOLS.has(n) : !SUBAGENT_DENIED.has(n)));
TOOLS.task = taskTool(runTool, pickSchemas);
TOOLS.parallel_tasks = parallelTasksTool(runTool, pickSchemas);
TOOLS.research = researchTool(runTool, pickSchemas);
Object.assign(TOOLS, agiOrchestrated(runTool, pickSchemas));

export const TOOL_SCHEMAS = schemas(() => true);

export function schemasFor(text: string): typeof TOOL_SCHEMAS {
  routeTurn(text);
  return currentSchemas();
}

TOOLS.load_tools = {
  description: 'Load more tools when the ones you have cannot do the job. Groups: browser, desktop, files, productivity (or "all"). Their tools become callable immediately.',
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

const TRANSIENT = /Page failed to load|ERR_(TIMED_OUT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|EMPTY_RESPONSE)|time(d)? ?out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|ERR_NETWORK|ERR_CONNECTION|socket hang up|not ready|Execution context was destroyed/i;
/** Read-only tools that are safe to repeat once after a transient failure. open_url is excluded: a fuzzy-matched guess must never pop a page into the user's external browser. */
const SAFE_RETRY = /^(tinyfish_|search_and_read|web_search|fetch_url|get_weather|code_search|read|glob|grep|inspect_app|see_screen|screen_text|get_|list_|find_|browser_(open|snapshot|read|see|tabs|search))/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read-only tools: when the model asks for several at once they can run in parallel. */
const PARALLEL_OK = /^(tinyfish_|search_and_read|web_search|fetch_url|get_weather|get_current_time|code_search|read$|glob|grep|list_|read_notes|get_system_info|clipboard_read|find_contact|calculate|browser_(tabs|read))/;
export const isParallelSafe = (name: string): boolean => PARALLEL_OK.test(name);

/** Auto-approve everything except hard-blocked actions (deleting). */
const AUTONOMOUS = true;

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

export async function runTool(requested: string, rawArgs: string): Promise<string> {
  const t0 = Date.now();
  const name = resolveTool(requested, TOOLS, (n) => isParallelSafe(n) || SAFE_RETRY.test(n)) ?? requested;
  // One correlation id per call: the feed's busy line is replaced in place by the result.
  const cid = `t${t0.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  emitActivity({ kind: 'tool', cid, label: name, status: 'busy' });
  for (let attempt = 0; ; attempt++) {
    try {
      const tool = TOOLS[name];
      if (!tool) {
        const near = Object.keys(TOOLS).filter((n) => n.includes(requested.split('_')[0]) || requested.includes(n)).slice(0, 6);
        throw new Error(`Unknown tool "${requested}".${near.length ? ` Similar: ${near.join(', ')}.` : ' Call load_tools to see more.'}`);
      }
      const blocked = planGuard(name);
      if (blocked) {
        emitActivity({ kind: 'tool', cid, label: name, detail: 'plan mode', status: 'fail', ms: Date.now() - t0 });
        return blocked;
      }
      const args = checkArgs(name, parseArgs(rawArgs), tool.parameters);
      emitActivity({ kind: 'tool', cid, label: name, detail: argPreview(args), status: 'busy' });
      const risk = await assessRisk(name, args);
      if (risk?.block) {
        recordTool(name, Date.now() - t0, 'blocked by policy');
        emitActivity({ kind: 'tool', cid, label: name, detail: risk.title, status: 'fail', ms: Date.now() - t0 });
        return `BLOCKED: ${risk.title} Do not try another way to do it; tell the user it is disabled.`;
      }
      if (risk && !AUTONOMOUS && !(await requestConfirm(risk))) {
        recordTool(name, Date.now() - t0, 'not approved by user');
        emitActivity({ kind: 'tool', cid, label: name, detail: 'not approved', status: 'fail', ms: Date.now() - t0 });
        return `NOT APPROVED by the user, so it was NOT done: ${risk.title} Do not retry it or reach the same effect another way. Tell the user briefly and ask what they would like instead.`;
      }
      const out = String((await tool.run(args)) ?? '').trim();
      // Soft failures ('NOT DONE: ...') count as failures in the log, not as OK.
      recordTool(name, Date.now() - t0, /^NOT DONE/.test(out) ? out : undefined);
      noteUsed(name);
      const note = name !== requested ? ` (ran as ${name})` : '';
      const wsNote = workspaceNotice();
      if (wsNote) clearWorkspaceNotice(); // informational, shown exactly once
      emitActivity({ kind: 'tool', cid, label: name, detail: clipText(out), status: /^NOT DONE/.test(out) ? 'fail' : 'ok', ms: Date.now() - t0 });
      return ((wsNote ? `${wsNote}\n` : '') + (out || 'OK (no output)')) + note;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt === 0 && SAFE_RETRY.test(name) && TRANSIENT.test(msg)) {
        emitActivity({ kind: 'tool', cid, label: name, detail: `transient, retrying: ${clipText(msg)}`, status: 'busy' });
        await sleep(250);
        continue;
      }
      recordTool(name, Date.now() - t0, msg);
      emitActivity({ kind: 'tool', cid, label: name, detail: clipText(msg), status: 'fail', ms: Date.now() - t0 });
      return `Tool error [${name}]: ${msg}`;
    }
  }
}

setAllSchemas(schemas(() => true));
