import type { ToolSchema } from './llm';
import { executionSessionId } from './toolResult';

type Family = {
  id: string;
  hint: string;
  cues: string[];
  patterns: RegExp[];
  minScore: number;
};

export interface IntentRoute {
  families: string[];
  scores: Record<string, number>;
  matchedCues: Record<string, string[]>;
  confidence: 'high' | 'medium' | 'low';
}

const CORE = new Set([
  'get_current_time',
  'calculate',
  'ask_user',
  'load_tools',
  'list_capabilities',
  'tool_log',
]);

/**
 * JINI capability routing.
 *
 * The router deliberately uses two stages:
 * 1. intent classification chooses capability families from the user's actual goal;
 * 2. the model chooses the concrete operation from only those families' live schemas.
 *
 * This is a routing hint, never an authorization boundary. Every call still passes through
 * runToolDetailed -> argument validation -> risk assessment -> permission gate -> durable
 * receipt -> execution -> durable outcome. A tool not surfaced here remains discoverable
 * through load_tools/list_capabilities.
 */
const FAMILIES: Family[] = [
  {
    id: 'research',
    hint: 'web research, current information, source comparison, fact checking, weather and public information',
    cues: ['research', 'look up', 'find out', 'latest', 'current information', 'news', 'compare sources', 'fact check', 'investigate', 'search the web', 'web search', 'prices', 'weather', 'reviews', 'competitors', 'sources'],
    patterns: [/^(web_search|web_browse|fetch_url|tinyfish_|search_and_read|get_weather|verify_claim|research_web)/],
    minScore: 2,
  },
  {
    id: 'browser',
    hint: "webpage interaction, personal accounts, authenticated sessions, tabs, forms and the user's connected Chrome or Edge",
    cues: ['open website', 'open webpage', 'my browser', 'my email', 'my inbox', 'my gmail', 'my outlook', 'check my email', 'open email', 'email account', 'logged in', 'already signed in', 'personal account', 'chrome tab', 'edge tab', 'click on website', 'fill form', 'submit form', 'log in', 'sign in', 'download from', 'upload to website', 'navigate to', 'interact with website', 'browser tab'],
    patterns: [/^(browser_|native_browser_|open_url$|open_in_my_browser$|close_my_browser_tab$|list_my_browser_tabs$)/],
    minScore: 2,
  },
  {
    id: 'desktop',
    hint: 'desktop apps, windows, keyboard/mouse actions, clipboard, audio, display and device controls',
    cues: ['desktop', 'open app', 'launch app', 'close app', 'switch window', 'focus window', 'volume', 'brightness', 'mute', 'keyboard', 'mouse', 'clipboard', 'press key', 'click on screen', 'windows settings', 'play music', 'pause music', 'bluetooth device'],
    patterns: [/^(inspect_app|click_control|set_control_text|type_text|press_keys|click_at|close_app|launch_app|open_app|media_control|list_windows|focus_window|window_control|set_hud_mode|place_window|volume_control|set_brightness|lock_screen|clipboard_|take_screenshot|add_app|remove_app|list_custom_apps|scroll_at|drag_at)/],
    minScore: 2,
  },
  {
    id: 'files',
    hint: 'local files and folders, read/write/edit, search, move/copy and workspace operations',
    cues: ['file', 'files', 'folder', 'directory', 'read file', 'write file', 'edit file', 'find file', 'search files', 'move file', 'copy file', 'rename file', 'organize files', 'workspace folder'],
    patterns: [/^(list_files|write_file|edit_file|open_file|glob$|grep$|multi_edit|apply_patch|copy_file|move_file|make_dir|read$|find_files|open_anything)/],
    minScore: 2,
  },
  {
    id: 'development',
    hint: 'software projects, source code, debugging, terminal commands, builds, tests, Git and code analysis',
    cues: ['code', 'coding', 'program', 'software', 'project', 'repository', 'repo', 'bug', 'fix', 'debug', 'build', 'website', 'web site', 'web app', 'fan site', 'fan website', 'web design', 'web development', 'create website', 'build website', 'landing page', 'frontend', 'front end', 'test suite', 'typescript', 'javascript', 'python', 'terminal', 'shell command', 'powershell', 'git', 'refactor', 'implement', 'compile', 'npm', 'install package', 'code review'],
    patterns: [/^(run_command|run_python|diagnostics|code_search|inspect_project|project_context|analyze_impact|plan_enter|plan_exit|skill$|todo_write|todo_read)/],
    minScore: 1.5,
  },
  {
    id: 'memory',
    hint: 'personal memory, conversation recall, preferences, people and contacts',
    cues: ['remember', 'forget', 'memory', 'memories', 'recall', 'what did i tell you', 'what do you know about me', 'my preference', 'previous conversation', 'contact', 'phone number'],
    patterns: [/^(remember|save_contact|find_contact|list_memories|forget|find_memory|memory_|contact_)/],
    minScore: 2,
  },
  {
    id: 'productivity',
    hint: 'reminders, timers, notes, briefings, recurring schedules and personal task tracking',
    cues: ['remind me', 'reminder', 'timer', 'alarm', 'schedule', 'calendar', 'recurring', 'every day', 'every week', 'daily', 'weekly', 'note', 'briefing', 'to do', 'task list'],
    patterns: [/^(set_timer|list_timers|cancel_timer|add_note|read_notes|briefing|add_recurring_task|schedule_task|list_scheduled|cancel_scheduled)/],
    minScore: 2,
  },
  {
    id: 'orchestration',
    hint: 'multi-step workflows, delegation, background tasks, parallel work and specialist agents',
    cues: ['delegate', 'subagent', 'multiple agents', 'parallel tasks', 'break this down', 'multi step', 'long running', 'coordinate', 'workflow', 'run this in background', 'autopilot', 'project plan'],
    patterns: [/^(batch|task$|parallel_tasks|chain$|start_task|task_status|task_cancel|task_resume|list_tasks|spawn_agent|run_playbook|autopilot_)/],
    minScore: 2,
  },
  {
    id: 'integrations',
    hint: 'connected services and APIs including GitHub, Vercel and external integrations',
    cues: ['github', 'pull request', 'merge request', 'issue tracker', 'vercel', 'deploy', 'deployment', 'connected app', 'integration', 'api connection', 'repository status', 'workflow run', 'ci status'],
    patterns: [/^(github_|vercel_|integration_|mcp_)/],
    minScore: 2,
  },
  {
    id: 'system',
    hint: 'computer health, hardware inventory, running processes, drives and operating-system diagnostics',
    cues: ['system information', 'computer specs', 'cpu usage', 'memory usage', 'battery', 'hardware', 'device inventory', 'running processes', 'process list', 'stop process', 'drives', 'bluetooth scan'],
    patterns: [/^(get_system_info|list_processes|stop_process|list_drives|bluetooth_scan|system_)/],
    minScore: 2,
  },
  {
    id: 'vision',
    hint: 'screen understanding, screenshots, visual inspection and visual output',
    cues: ['look at my screen', 'see my screen', 'read my screen', 'what is on screen', 'screenshot', 'screen text', 'inspect this image', 'visualize', 'show me visually'],
    patterns: [/^(see_screen|screen_text|click_text|show_visual|vision_|visual_)/],
    minScore: 2,
  },
  {
    id: 'documents',
    hint: 'create, read and transform documents, PDFs, presentations, spreadsheets and exports',
    cues: ['document', 'pdf', 'word document', 'docx', 'spreadsheet', 'excel', 'xlsx', 'presentation', 'powerpoint', 'pptx', 'export report', 'create a report', 'make a document'],
    patterns: [/^(make_document|read_document|artifact_|document_|pdf_|spreadsheet_|presentation_)/],
    minScore: 2,
  },
];

const STICKY_TURNS = 6;
const familyById = new Map(FAMILIES.map((f) => [f.id, f]));
let all: ToolSchema[] = [];
let familyOf = new Map<string, string>();
interface RouteSessionState {
  active: Set<string>;
  turnFamilies: Set<string>;
  touched: Set<string>;
  recent: Array<Set<string>>;
  lastRoute: IntentRoute;
}
const routeStates = new Map<string, RouteSessionState>();
const routeState = (): RouteSessionState => {
  const id = executionSessionId() ?? '__default__';
  let state = routeStates.get(id);
  if (!state) {
    state = { active: new Set<string>(), turnFamilies: new Set<string>(), touched: new Set<string>(), recent: [], lastRoute: { families: [], scores: {}, matchedCues: {}, confidence: 'low' } };
    routeStates.set(id, state);
  }
  return state;
};

const normalize = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const familyForTool = (name: string): string => {
  if (CORE.has(name)) return 'core';
  for (const family of FAMILIES) {
    if (family.patterns.some((pattern) => pattern.test(name))) return family.id;
  }
  return 'advanced';
};

export const setAllSchemas = (schemas: ToolSchema[]): void => {
  all = schemas;
  familyOf = new Map(schemas.map((schema) => [schema.function.name, familyForTool(schema.function.name)]));
  for (const state of routeStates.values()) rebuild(state);
};

export function classifyIntent(input: string): IntentRoute {
  const text = normalize(input);
  const scores: Record<string, number> = {};
  const matchedCues: Record<string, string[]> = {};
  for (const family of FAMILIES) {
    const matched = family.cues.filter((cue) => {
      const normalizedCue = normalize(cue);
      return normalizedCue.includes(' ') ? text.includes(normalizedCue) : new RegExp('(^| )' + normalizedCue + '( |$)').test(text);
    });
    const score = matched.reduce((sum, cue) => sum + (cue.includes(' ') ? 2.5 : 1.5), 0);
    scores[family.id] = score;
    if (matched.length) matchedCues[family.id] = matched;
  }
  const families = FAMILIES
    .filter((family) => scores[family.id] >= family.minScore)
    .sort((a, b) => scores[b.id] - scores[a.id])
    .map((family) => family.id);
  const max = families.length ? scores[families[0]] : 0;
  return {
    families,
    scores,
    matchedCues,
    confidence: max >= 5 ? 'high' : max >= 2.5 ? 'medium' : 'low',
  };
}

/** Merge current utterance with durable goal context before lexical routing. The model then performs semantic operation selection from these bounded schemas. */
export function resolveIntent(input: string, goalContext = ''): IntentRoute {
  const route = classifyIntent(input);
  const contextRoute = goalContext ? classifyIntent(goalContext) : { families: [], scores: {}, matchedCues: {}, confidence: 'low' as const };
  const scores: Record<string, number> = { ...route.scores };
  const matchedCues: Record<string, string[]> = { ...route.matchedCues };
  for (const [family, score] of Object.entries(contextRoute.scores)) {
    if (score > 0 && !route.families.includes(family)) scores[family] = Math.max(scores[family] ?? 0, Math.min(3, score));
    if (contextRoute.matchedCues[family]) matchedCues[family] = [...new Set([...(matchedCues[family] ?? []), ...contextRoute.matchedCues[family]])];
  }
  const families = FAMILIES.filter((f) => (scores[f.id] ?? 0) >= f.minScore).sort((a,b) => (scores[b.id] ?? 0) - (scores[a.id] ?? 0)).map((f) => f.id);
  const top = families.length ? scores[families[0]] : 0;
  return { families, scores, matchedCues, confidence: top >= 5 ? 'high' : top >= 2.5 ? 'medium' : 'low' };
}

export function routeTurn(input: string): void {
  const state = routeState();
  state.lastRoute = classifyIntent(input);
  state.turnFamilies = new Set(state.lastRoute.families);
  state.touched = new Set(state.lastRoute.families);
  state.recent.forEach((families) => families.forEach((id) => state.turnFamilies.add(id)));
  rebuild(state);
}

function rebuild(state: RouteSessionState): void {
  state.active = new Set(
    all
      .map((schema) => schema.function.name)
      .filter((name) => CORE.has(name) || state.turnFamilies.has(familyOf.get(name) ?? 'advanced'))
  );
}

export function noteUsed(name: string): void {
  const state = routeState();
  const family = familyOf.get(name);
  if (!family || family === 'advanced') return;
  state.turnFamilies.add(family);
  state.touched.add(family);
  rebuild(state);
}

export function endTurn(): void {
  const state = routeState();
  state.recent.push(new Set(state.touched));
  while (state.recent.length > STICKY_TURNS) state.recent.shift();
}

export const currentSchemas = (): ToolSchema[] => {
  const state = routeState();
  return all.filter((schema) => state.active.has(schema.function.name));
};

export const unloadedGroups = (): string => {
  const state = routeState();
  return FAMILIES.filter((family) => !state.turnFamilies.has(family.id)).map((family) => `${family.id} (${family.hint})`).concat(
    [...familyOf.values()].some((family) => family === 'advanced') && !state.turnFamilies.has('advanced')
      ? ['advanced (specialist and less commonly used capabilities)']
      : []
  ).join('; ');
};

export function loadGroups(ids: unknown): string {
  const requested = (Array.isArray(ids) ? ids : [ids]).map((value) => String(value).toLowerCase().trim());
  const loadAll = requested.includes('all');
  const valid = new Set([...FAMILIES.map((family) => family.id), 'advanced']);
  const unknown = requested.filter((id) => id !== 'all' && !valid.has(id));
  if (unknown.length) return `Unknown group(s): ${unknown.join(', ')}. Available: ${[...valid].join(', ')}.`;
  const hit = loadAll ? [...valid] : requested;
  hit.forEach((id) => {
    const state = routeState();
    state.turnFamilies.add(id);
    state.touched.add(id);
  });
  rebuild(routeState());
  return hit.map((id) => {
    const names = all.filter((schema) => familyOf.get(schema.function.name) === id).map((schema) => schema.function.name);
    return `${id} loaded (${names.length} tools): ${names.join(', ') || 'no registered tools'}`;
  }).join('\n');
}

export const groupInfo = (): Array<{ id: string; hint: string; tools: string[] }> => [
  ...FAMILIES.map((family) => ({
    id: family.id,
    hint: family.hint,
    tools: all.filter((schema) => familyOf.get(schema.function.name) === family.id).map((schema) => schema.function.name),
  })),
  {
    id: 'core',
    hint: 'always available',
    tools: all.filter((schema) => CORE.has(schema.function.name)).map((schema) => schema.function.name),
  },
  {
    id: 'advanced',
    hint: 'specialist and less commonly used capabilities; load only when needed',
    tools: all.filter((schema) => familyOf.get(schema.function.name) === 'advanced').map((schema) => schema.function.name),
  },
];

export const coreToolNames = (): string[] => [...CORE];

export const routeSummary = (): string => {
  const lastRoute = routeState().lastRoute;
  const selected = lastRoute.families.length
    ? lastRoute.families.map((id) => `${id} (${lastRoute.scores[id].toFixed(1)})`).join(', ')
    : 'no specialist family confidently matched';
  const cues = Object.entries(lastRoute.matchedCues)
    .map(([id, values]) => `${id}: ${values.slice(0, 4).join(', ')}`)
    .join('; ');
  return `Intent routing: ${selected}. Confidence: ${lastRoute.confidence}.${cues ? ` Signals: ${cues}.` : ''} The model must still choose the specific tool based on the user's requested outcome; load another family when needed.`;
};
