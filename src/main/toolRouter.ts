import type { ToolSchema } from './llm';
import { routeIntent, type IntentRoute } from './intentRouter';

interface Group {
  id: string;
  hint: string;
  re: RegExp;
}

const CORE = [
  'get_current_time', 'calculate', 'ask_user', 'load_tools', 'list_capabilities',
  'tool_log', 'remember', 'find_contact', 'save_contact', 'browser_play', 'browser_media',
];

const GROUPS: Group[] = [
  { id: 'browser', hint: 'in-app browser and the user’s real Chrome/Edge session: navigate, inspect, click, type, tabs, forms, downloads and media', re: /\b(browser|website|web ?page|url|youtube|video|tab|navigate|maps?|directions?|amazon|reddit|wikipedia|spotify|twitter|login|log ?in|form|checkout|play (?:a )?(?:video|song))\b/i },
  { id: 'desktop', hint: 'desktop and application control: windows, apps, mouse, keyboard, screen, audio, display and hardware interaction', re: /\b(desktop|window|notepad|calculator|task manager|file explorer|volume|brightness|bluetooth|pairing|clipboard|cpu|memory usage|ram|battery|process(?:es)?|mouse|keyboard|vs ?code|chrome|edge|firefox|word|excel|outlook|powerpoint|discord|whatsapp|spotify|screenshot|screen|click (?:the )?(?:button|icon|app)|launch (?:the )?app)\b/i },
  { id: 'files', hint: 'files, folders, drive analysis, project/code inspection, editing, commands, builds, tests and workspace tools', re: /\b(files?|folders?|director(y|ies)|disk|storage|space|drive|largest|biggest|read|write|edit|code|bug|errors?|fix|debug|run|command|script|terminal|powershell|npm|git|tests?|build|project|repo|function|class|typescript|python|grep|patch|workspace|refactor|implement|install|\.tsx?\b|\.py\b)\b/i },
  { id: 'research', hint: 'headless web research, source retrieval, fact-checking, comparisons, news and weather', re: /\b(research|look up|find out|latest|current|compare|comparison|benchmark|competitor|investigate|sources?|news|price|reviews?|evaluate|weather|forecast)\b/i },
  { id: 'system', hint: 'computer health, drives, processes, storage, devices, hardware diagnostics and operating-system state', re: /\b(system info|computer info|hardware|disk|storage|drive|cpu|memory usage|ram|battery|bluetooth|paired devices|processes|running apps|largest files|space on)\b/i },
  { id: 'memory', hint: 'personal memory, preferences, contacts, notes, goals, habits and user profile', re: /\b(remember|forget|memory|memories|preference|i prefer|i like|my usual|my name|contact|phone number|address book|notes?|goal|habit)\b/i },
  { id: 'productivity', hint: 'timers, alarms, reminders, schedules, recurring tasks, daily briefings and personal routines', re: /\b(timer|alarm|remind\w*|reminder|schedule|recurring|every day|every week|every month|calendar|briefing|brief me)\b/i },
  { id: 'integrations', hint: 'GitHub, Vercel and connected developer/service integrations; inspect first and verify writes by reading back', re: /\b(github|git ?lab|pull ?request|\bpr\b|issue|vercel|netlify|deploy(?:ment)?|webhook|integration|repository|workflow run|ci pipeline)\b/i },
  { id: 'orchestration', hint: 'multi-step task planning, durable background tasks, delegation, parallel research, chains and verification', re: /\b(audit|overhaul|upgrade|deep dive|in.?depth|massive|major|end[- ]to[- ]end|from scratch|multi.?step|multiple phases|background task|delegate|sub.?agent|parallel tasks|long.?running|project workflow)\b/i },
  { id: 'documents', hint: 'create, read, convert and validate Word, PDF, Excel, PowerPoint and visual deliverables', re: /\b(document|docx|pdf|spreadsheet|xlsx|excel|slides|presentation|pptx|powerpoint|export|convert|report|visuali[sz]e|chart|diagram)\b/i },
  { id: 'advanced', hint: 'specialist and less frequently used capabilities; discover via list_capabilities and load only when required', re: /$a/ },
];

const core = new Set(CORE);
const groupOf = new Map<string, string>();
let all: ToolSchema[] = [];
let active = new Set<string>();
const recent: Array<Set<string>> = [];
let turnGroups = new Set<string>();
let touched = new Set<string>();
let currentIntent: { primary: IntentRoute; secondary: IntentRoute[]; groups: string[]; prompt: string } = routeIntent('');

const isOneOf = (name: string, values: readonly string[]): boolean => values.includes(name);

/** Assign every tool to one family. Unknown specialist tools fail closed into advanced. */
export function inferToolGroup(name: string): string {
  if (/^(browser_|native_browser_|open_in_my_browser$|close_my_browser_tab$|list_my_browser_tabs$|open_url$)/.test(name)) return 'browser';
  if (/^(github_|vercel_)/.test(name)) return 'integrations';
  if (/^(tinyfish_|web_)/.test(name) || isOneOf(name, ['search_and_read', 'fetch_url', 'get_weather', 'verify_claim'])) return 'research';
  if (/^(remember$|forget$|.*memory|.*memories|.*contact|.*profile|.*habit|.*goal|read_notes$|add_note$)/.test(name)) return 'memory';
  if (/^(start_task$|task$|task_|parallel_tasks$|chain$|batch$|research$|spawn_agent$|background_|todo_|plan_|quality_gate$|decide$|playbook_)/.test(name)) return 'orchestration';
  if (/^(set_timer$|list_timers$|cancel_timer$|schedule_task$|list_scheduled$|cancel_scheduled$|add_recurring_task$|briefing$)/.test(name)) return 'productivity';
  if (/^(make_document$|read_document$|artifact_|show_visual$|visual_|make_diagram$)/.test(name)) return 'documents';
  if (isOneOf(name, ['get_system_info', 'list_drives', 'list_processes', 'analyze_storage', 'bluetooth_scan', 'stop_process', 'execution_status', 'get_device_info', 'device_status', 'device_list'])) return 'system';
  if (/^(inspect_app$|click_control$|set_control_text$|type_text$|press_keys$|click_at$|close_app$|launch_app$|open_app$|media_control$|list_windows$|focus_window$|window_control$|set_hud_mode$|place_window$|volume_control$|set_brightness$|lock_screen$|clipboard_|take_screenshot$|screen_text$|click_text$|see_screen$|scroll_at$|drag_at$)/.test(name)) return 'desktop';
  if (isOneOf(name, ['read', 'list_files', 'write_file', 'edit_file', 'open_file', 'glob', 'grep', 'multi_edit', 'apply_patch', 'run_command', 'diagnostics', 'code_search', 'skill', 'copy_file', 'make_dir', 'move_file', 'find_files', 'open_anything', 'inspect_project', 'project_context', 'analyze_impact', 'project_profile', 'write_project_memory'])) return 'files';
  return 'advanced';
}

export const setAllSchemas = (schemas: ToolSchema[]): void => {
  all = schemas;
  groupOf.clear();
  for (const schema of all) {
    const name = schema.function.name;
    if (!core.has(name)) groupOf.set(name, inferToolGroup(name));
  }
  rebuild();
};

const rebuild = (): void => {
  active = new Set(all
    .map((schema) => schema.function.name)
    .filter((name) => core.has(name) || turnGroups.has(groupOf.get(name) ?? 'advanced')));
};

export function routeTurn(text: string): void {
  currentIntent = routeIntent(text);
  turnGroups = new Set();
  touched = new Set();
  GROUPS.forEach((group) => {
    if (group.re.test(text) || currentIntent.groups.includes(group.id)) {
      turnGroups.add(group.id);
      touched.add(group.id);
    }
  });
  recent.forEach((previous) => previous.forEach((id) => turnGroups.add(id)));
  rebuild();
}

export function noteUsed(name: string): void {
  const id = groupOf.get(name);
  if (!id) return;
  turnGroups.add(id);
  touched.add(id);
  rebuild();
}

export function endTurn(): void {
  recent.push(new Set(touched));
  while (recent.length > 2) recent.shift();
}

export const currentSchemas = (): ToolSchema[] => all.filter((schema) => active.has(schema.function.name));

export const unloadedGroups = (): string =>
  GROUPS.filter((group) => !turnGroups.has(group.id)).map((group) => group.id + ' (' + group.hint + ')').join('; ');

export function loadGroups(ids: unknown): string {
  const want = (Array.isArray(ids) ? ids : [ids]).map((x) => String(x).toLowerCase().trim());
  const hit = GROUPS.filter((group) => want.includes(group.id) || want.includes('all'));
  if (!hit.length) return 'Unknown group. Available: ' + GROUPS.map((group) => group.id).join(', ') + '.';
  hit.forEach((group) => {
    turnGroups.add(group.id);
    touched.add(group.id);
  });
  rebuild();
  return hit.map((group) => {
    const tools = [...groupOf.entries()].filter(([, id]) => id === group.id).map(([name]) => name);
    return group.id + ' loaded (' + tools.length + ' tools): ' + tools.join(', ');
  }).join('\n');
}

export const groupInfo = (): Array<{ id: string; hint: string; tools: string[] }> =>
  GROUPS.map((group) => ({
    id: group.id,
    hint: group.hint,
    tools: [...groupOf.entries()].filter(([, id]) => id === group.id).map(([name]) => name),
  }));

export const coreToolNames = (): string[] => [...core];
export const currentIntentPrompt = (): string => currentIntent.prompt;
export const currentIntentRoute = (): typeof currentIntent => currentIntent;
