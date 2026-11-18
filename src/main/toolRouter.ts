import type { ToolSchema } from './llm';
import { routeIntent, type IntentRoute } from './intentRouter';

interface Group {
  id: string;
  hint: string;
  re: RegExp;
  tools: string[];
}

/** Tools every request gets. Any tool not listed in a group is also always on, so nothing is ever lost. */
const CORE = [
  'get_current_time', 'tinyfish_search', 'tinyfish_fetch', 'web_search', 'web_browse', 'fetch_url', 'get_weather', 'calculate', 'remember', 'save_contact', 'find_contact',
  'list_memories', 'forget', 'tool_log', 'see_screen', 'ask_user', 'batch', 'task', 'research', 'parallel_tasks', 'chain', 'screen_text', 'click_text',
  'browser_play', 'browser_media', 'find_files', 'open_anything', 'read_document', 'read', 'load_tools', 'show_visual', 'quality_gate', 'decide', 'todo_write', 'write_file',
  'list_drives', 'bluetooth_scan', 'get_system_info', 'list_processes', 'schedule_task', 'list_scheduled', 'cancel_scheduled',
  'start_task', 'task_status', 'task_cancel', 'task_resume', 'list_tasks',
];

const GROUPS: Group[] = [
  {
    id: 'browser',
    hint: 'in-app browser: open, read, click, type, tabs, maps; native browser (your real Chrome/Edge): connect, background tabs, read, act',
    re: /\b(browse\w*|tabs?|web ?(site|page)|sites?|urls?|links?|open|go ?to|navigate|search|google|you ?tube|play|watch|videos?|maps?|directions?|amazon|reddit|wikipedia|github|spotify|twitter|click|scroll|close|dismiss|hide|http|login|log ?in|sign ?(in|up)|fill|form|submit|checkout|book|order|buy|upload|download|dropdown|select|type|\w+\.(com|org|net|in|io|ai))\b/i,
    tools: ['open_url', 'open_in_my_browser', 'browser_open', 'browser_search', 'browser_tabs', 'browser_switch_tab', 'browser_close_tab', 'browser_read', 'browser_snapshot', 'browser_click', 'browser_click_text', 'browser_hover', 'browser_type', 'browser_fill_form', 'browser_select', 'browser_check', 'browser_upload', 'browser_wait', 'browser_eval', 'browser_key', 'browser_scroll', 'browser_click_at', 'browser_drag', 'browser_see', 'browser_back', 'browser_forward', 'browser_dialog', 'browser_downloads', 'browser_reload', 'browser_close', 'close_my_browser_tab', 'list_my_browser_tabs', 'native_browser_status', 'native_browser_connect', 'native_browser_disconnect', 'native_browser_tabs', 'native_browser_open', 'native_browser_navigate', 'native_browser_read', 'native_browser_snapshot', 'native_browser_click', 'native_browser_type', 'native_browser_screenshot', 'native_browser_capture', 'native_browser_close_tab', 'native_browser_wait', 'native_browser_reconnect'],
  },
  {
    id: 'desktop',
    hint: 'apps, windows, keyboard, mouse, volume, clipboard, processes',
    re: /\b(app|launch|start|open|windows?|volume|louder|quieter|mute|brightness|lock|clipboard|copy|paste|type|press|click|close|minimi[sz]e|maxim\w+|screenshot|notepad|calculator|chrome|crome|edge|vs ?code|discord|whatsapp|pause|resume|next|previous|skip|song|music|system|cpu|battery|hud|stage|snap|focus|kill|process\w*)\b/i,
    tools: ['inspect_app', 'click_control', 'set_control_text', 'type_text', 'press_keys', 'click_at', 'close_app', 'launch_app', 'open_app', 'media_control', 'list_windows', 'focus_window', 'window_control', 'set_hud_mode', 'place_window', 'volume_control', 'set_brightness', 'lock_screen', 'clipboard_read', 'clipboard_write', 'take_screenshot', 'get_system_info', 'add_app', 'remove_app', 'list_custom_apps', 'scroll_at', 'drag_at', 'list_processes', 'stop_process'],
  },
  {
    id: 'files',
    hint: 'file discovery, disk/storage analysis, code editing, shell commands, git, GitHub issues/PRs/CI, Vercel deployments and diagnostics',
    re: /\b(files?|folders?|director(y|ies)|disk|storage|space|drive|largest|biggest|read|write|edit|code|bug|errors?|fix|debug|run|command|script|terminal|powershell|npm|git|github|pull ?request|\bpr\b|issue|ci|pipeline|deploy|deployment|vercel|tests?|build|project|repo|function|class|typescript|python|grep|patch|workspace|document|plan|todo|refactor|implement|install|\w+\.(ts|tsx|js|py|json|md|txt|css|html))\b/i,
    tools: ['analyze_storage', 'list_files', 'write_file', 'edit_file', 'open_file', 'glob', 'grep', 'multi_edit', 'apply_patch', 'run_command', 'diagnostics', 'code_search', 'skill', 'copy_file', 'make_dir', 'move_file', 'todo_write', 'todo_read', 'plan_enter', 'plan_exit', 'make_document', 'read_document', 'inspect_project', 'project_context', 'analyze_impact', 'github_status', 'github_list_repos', 'github_repo_details', 'github_list_branches', 'github_list_commits', 'github_get_commit', 'github_list_issues', 'github_get_issue', 'github_create_issue', 'github_list_pulls', 'github_get_pull', 'github_create_pull', 'github_list_workflow_runs', 'github_workflow_failures', 'vercel_status', 'vercel_list_projects', 'vercel_project_details', 'vercel_list_deployments', 'vercel_deployment_details', 'vercel_deployment_logs', 'vercel_deploy'],
  },
  {
    id: 'productivity',
    hint: 'timers, reminders, notes, briefing, recurring tasks',
    re: /\b(timers?|remind\w*|alarm|notes?|jot|briefing|brief me|morning|schedule|recurring|every (day|week|month)|tasks?)\b/i,
    tools: ['set_timer', 'list_timers', 'cancel_timer', 'add_note', 'read_notes', 'briefing', 'add_recurring_task', 'schedule_task', 'list_scheduled', 'cancel_scheduled'],
  },
];

const STICKY_TURNS = 2;
/** Always loaded so the tool set does not change from turn to turn for web and app control. */
const ALWAYS_ON = ['browser', 'desktop'];
const core = new Set(CORE);
const groupOf = new Map<string, string>();
GROUPS.forEach((g) => g.tools.forEach((t) => groupOf.set(t, g.id)));

let all: ToolSchema[] = [];
let active = new Set<string>();
const recent: Array<Set<string>> = [];
let turnGroups = new Set<string>();
// Groups this turn actually triggered (text match, tool use, explicit load). Only these stay sticky;
// saving the inherited ones instead made every group ever loaded sticky forever.
let touched = new Set<string>();
let currentIntent: { primary: IntentRoute; secondary: IntentRoute[]; groups: string[]; prompt: string } = routeIntent('');

export const setAllSchemas = (s: ToolSchema[]): void => {
  all = s;
};

const grouped = (name: string): boolean => groupOf.has(name);

/** Pick the tool set for a new turn: core + ungrouped + groups the text names + groups used in the last turns. */
export function routeTurn(text: string): void {
  currentIntent = routeIntent(text);
  turnGroups = new Set(ALWAYS_ON);
  touched = new Set();
  GROUPS.forEach((g) => {
    if (g.re.test(text) || currentIntent.groups.includes(g.id)) {
      turnGroups.add(g.id);
      touched.add(g.id);
    }
  });
  recent.forEach((r) => r.forEach((id) => turnGroups.add(id)));
  rebuild();
}

function rebuild(): void {
  active = new Set(all.map((s) => s.function.name).filter((n) => core.has(n) || !grouped(n) || turnGroups.has(groupOf.get(n) ?? '')));
}

/** Called after every tool call: a tool outside the active set pulls in its whole group, and the group is remembered. */
export function noteUsed(name: string): void {
  const id = groupOf.get(name);
  if (!id) return;
  turnGroups.add(id);
  touched.add(id);
  rebuild();
}

export function endTurn(): void {
  recent.push(new Set(touched));
  while (recent.length > STICKY_TURNS) recent.shift();
}

export const currentSchemas = (): ToolSchema[] => all.filter((s) => active.has(s.function.name));

/** Names of groups not currently loaded, for the prompt and for load_tools. */
export const unloadedGroups = (): string =>
  GROUPS.filter((g) => !turnGroups.has(g.id)).map((g) => `${g.id} (${g.hint})`).join('; ');

export function loadGroups(ids: unknown): string {
  const want = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x).toLowerCase().trim());
  const hit = GROUPS.filter((g) => want.includes(g.id) || want.includes('all'));
  if (!hit.length) return `Unknown group. Available: ${GROUPS.map((g) => g.id).join(', ')}.`;
  hit.forEach((g) => {
    turnGroups.add(g.id);
    touched.add(g.id);
  });
  rebuild();
  return hit.map((g) => `${g.id} loaded: ${g.tools.join(', ')}`).join('\n');
}

/** Group definitions for the runtime capability manifest (id, hint, tool names). */
export const groupInfo = (): Array<{ id: string; hint: string; tools: string[] }> =>
  GROUPS.map((g) => ({ id: g.id, hint: g.hint, tools: [...g.tools] }));

/** Core tool names for manifest validation. */
export const coreToolNames = (): string[] => [...core];


/** Compact intent decision injected beside the live tool schemas for this turn. */
export const currentIntentPrompt = (): string => currentIntent.prompt;
export const currentIntentRoute = (): typeof currentIntent => currentIntent;
