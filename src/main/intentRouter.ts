export interface IntentRoute {
  id: string;
  label: string;
  confidence: 'high' | 'medium' | 'low';
  score: number;
  groups: string[];
  preferredTools: string[];
  guidance: string;
}

interface IntentRule {
  id: string;
  label: string;
  pattern: RegExp;
  weight: number;
  groups: string[];
  preferredTools: string[];
  guidance: string;
}

const RULES: IntentRule[] = [
  {
    id: 'storage_analysis',
    label: 'disk and storage analysis',
    pattern: /\b(?:disk ?space|storage|taking (?:up )?(?:the )?(?:most|maximum) space|what(?:'s| is) using (?:the )?(?:most|maximum) space|largest files|biggest files|drive usage|folder sizes|space on [a-z]:|files? (?:that|which) (?:take|takes|taking|uses?|are taking) up space|files? in [a-z]:)\b|\b[a-z]:/i,
    weight: 6,
    groups: ['files', 'system'],
    preferredTools: ['analyze_storage'],
    guidance: 'For disk/folder footprint questions, use analyze_storage once for the requested root. Do not improvise repeated PowerShell du commands or recursively call list_files.',
  },
  {
    id: 'file_discovery',
    label: 'file and folder discovery',
    pattern: /\b(?:find|locate|search|look for|which|what)\b.{0,45}\b(?:files?|folders?|directories|documents?|paths?)\b|\b(?:file|folder|directory)\b.{0,40}\b(?:named|called|containing|inside|under|in)\b/i,
    weight: 4,
    groups: ['files'],
    preferredTools: ['find_files', 'glob', 'grep', 'list_files', 'read'],
    guidance: 'Use the dedicated file-search tools with a bounded scope, then read only the matching files. Do not shell out for ordinary file discovery.',
  },
  {
    id: 'desktop_control',
    label: 'desktop and application control',
    pattern: /\b(?:desktop|window|screen|notepad|calculator|task manager|file explorer|volume|brightness|bluetooth|pairing|clipboard|cpu|memory usage|ram|battery|processes?|mouse|keyboard|vs ?code|chrome|edge|firefox|word|excel|outlook|powerpoint|discord|whatsapp|spotify)\b/i,
    weight: 3,
    groups: ['desktop'],
    preferredTools: ['inspect_app', 'list_windows', 'launch_app', 'click_control', 'set_control_text', 'type_text', 'press_keys', 'see_screen'],
    guidance: 'For a real desktop task, inspect the current app/window state first, prefer accessibility/UIA controls over coordinates, perform the smallest action, then re-observe.',
  },
  {
    id: 'media_control',
    label: 'music, video and media playback',
    pattern: /\b(?:play|pause|resume|stop|skip|next|previous|mute|unmute|seek|volume)\b.{0,45}\b(?:music|song|track|playlist|video|media|spotify|youtube|audio|podcast)\b|\b(?:music|song|track|playlist|video|media|spotify|youtube|audio|podcast)\b.{0,35}\b(?:play|pause|resume|stop|skip|next|previous|mute|unmute|seek)\b/i,
    weight: 4,
    groups: ['browser', 'desktop'],
    preferredTools: ['browser_play', 'browser_media', 'media_control'],
    guidance: 'Determine whether playback is in JINI’s in-app browser or a desktop app. Check playback state first, use the matching browser_media or system media_control capability, then verify the new state.',
  },
  {
    id: 'browser_interaction',
    label: 'browser interaction',
    pattern: /\b(?:browser|website|web ?page|url|youtube|tab|navigate|click|login|log ?in|form|upload|download|checkout|book|order|play video)\b/i,
    weight: 3,
    groups: ['browser'],
    preferredTools: ['browser_open', 'browser_snapshot', 'browser_read', 'browser_click', 'browser_fill_form', 'native_browser_status'],
    guidance: 'Distinguish the in-app browser from the user’s real browser. Research stays headless; open a visible browser only when the user asks to see or interact with it.',
  },
  {
    id: 'code_work',
    label: 'software and code work',
    pattern: /\b(?:code|coding|program|script|bug|stack trace|type ?error|compile|build|test suite|refactor|repository|repo|git|npm|typescript|javascript|python|api integration|pull request)\b/i,
    weight: 3,
    groups: ['files'],
    preferredTools: ['inspect_project', 'project_context', 'analyze_impact', 'read', 'grep', 'edit_file', 'diagnostics', 'run_command'],
    guidance: 'Inspect project structure and existing commands before editing. Use targeted reads/patches and the project’s own checks; reserve shell for work that genuinely needs a process.',
  },
  {
    id: 'research',
    label: 'research and comparison',
    pattern: /\b(?:research|look up|find out|latest|current|compare|comparison|benchmark|competitor|investigate|source|news|price|review|evaluate)\b/i,
    weight: 5,
    groups: [],
    preferredTools: ['search_and_read', 'tinyfish_search', 'tinyfish_fetch', 'fetch_url', 'code_search'],
    guidance: 'Prefer headless research and fetch source material only as deep as the answer requires. Cross-check material claims; do not open the visible browser for ordinary research.',
  },
  {
    id: 'memory',
    label: 'personal memory and preferences',
    pattern: /\b(?:remember|forget|memory|memories|preference|i prefer|i like|my usual|my name|contact|phone number|notes?|goal|habit)\b/i,
    weight: 3,
    groups: ['memory'],
    preferredTools: ['remember', 'find_memory', 'list_memories', 'add_note', 'read_notes', 'find_contact'],
    guidance: 'Use persistent memory only for durable preferences and facts; use notes for temporary information. Never infer a sensitive fact from context.',
  },
  {
    id: 'execution_diagnostics',
    label: 'JINI execution performance diagnostics',
    pattern: /\\b(?:tools?|commands?|processes?)\\b.{0,50}\\b(?:slow|slower|taking (?:forever|ages|too long)|stalled|hung|timeout|latency|queue|inconsistent|unreliable)\\b|\\b(?:queue|latency|timeouts?|scheduler|execution performance)\\b.{0,45}\\b(?:jini|tools?|commands?|agents?)\\b/i,
    weight: 5,
    groups: ['system'],
    preferredTools: ['execution_status', 'tool_log'],
    guidance: 'Inspect execution_status first for active/queued work and resource saturation, then tool_log for recent outcomes. Separate queue wait, process runtime, provider latency, timeout, and launch/policy errors before proposing a fix.',
  },
  {
    id: 'system',
    label: 'computer and system diagnostics',
    pattern: /\b(?:computer health|system info|hardware|cpu|ram|memory usage|battery|bluetooth|paired devices|running processes|drive capacity|disk usage|storage|files in [a-z]:)\b/i,
    weight: 4,
    groups: ['system', 'desktop'],
    preferredTools: ['get_system_info', 'list_drives', 'list_processes', 'analyze_storage', 'bluetooth_scan', 'execution_status'],
    guidance: 'Prefer purpose-built system and diagnostic tools over ad-hoc shell. Use analyze_storage for folder/drive footprints, list_processes for process inventories, and execution_status to inspect JINI execution queues.',
  },
  {
    id: 'integrations',
    label: 'external developer-service integration',
    pattern: /\b(?:github|git ?lab|vercel|netlify|deploy(?:ment)?|pull request|\bpr\b|issues?|workflow runs?|ci pipeline|webhook)\b/i,
    weight: 4,
    groups: ['integrations'],
    preferredTools: ['github_status', 'github_list_repos', 'github_list_branches', 'github_list_workflow_runs', 'vercel_status', 'vercel_list_deployments'],
    guidance: 'Inspect remote state before mutation; after creating or changing remote state, read it back and verify the exact result.',
  },
  {
    id: 'orchestration',
    label: 'multi-step or long-running work',
    pattern: /\b(?:audit|overhaul|upgrade|deep dive|in.?depth|massive|major|end[- ]to[- ]end|from scratch|multi.?step|multiple phases|background task|delegate|sub.?agent|parallel tasks|long.?running|project workflow|implement (?:a|the) full)\b/i,
    weight: 4,
    groups: ['orchestration'],
    preferredTools: ['start_task', 'parallel_tasks', 'task_status', 'task_resume', 'quality_gate', 'todo_write'],
    guidance: 'For multi-stage work, create a durable outcome plan, execute dependency-aware steps, parallelize independent read-only work only, persist state, and verify deliverables before declaring completion.',
  },
  {
    id: 'documents',
    label: 'document and visual deliverable',
    pattern: /\b(?:create|make|generate|export|convert|read|open)\b.{0,50}\b(?:document|docx|pdf|spreadsheet|xlsx|excel|slides|presentation|pptx|report|chart|diagram)\b/i,
    weight: 4,
    groups: ['documents', 'files'],
    preferredTools: ['make_document', 'read_document', 'write_file', 'show_visual'],
    guidance: 'Use structured document tools for office formats and validate the saved artifact by reopening it. Do not produce a file via shell when a dedicated renderer exists.',
  },
  {
    id: 'productivity',
    label: 'personal productivity',
    pattern: /\b(?:remind|reminder|timer|alarm|note|briefing|schedule|recurring|every day|every week|calendar)\b/i,
    weight: 3,
    groups: ['productivity'],
    preferredTools: ['set_timer', 'add_note', 'briefing', 'schedule_task', 'add_recurring_task'],
    guidance: 'Use the dedicated reminder, timer, note or scheduling operation rather than a shell command or an improvised background loop.',
  },
];

export function routeIntent(text: string): { primary: IntentRoute; secondary: IntentRoute[]; groups: string[]; prompt: string } {
  const source = String(text ?? '').trim();
  const scored = RULES
    .map((rule) => {
      const matches = source.match(new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`)) ?? [];
      return { rule, score: matches.length * rule.weight };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) {
    const primary: IntentRoute = {
      id: 'general',
      label: 'general assistant request',
      confidence: 'low',
      score: 0,
      groups: [],
      preferredTools: [],
      guidance: 'Use the fewest high-level tools that satisfy the actual goal. Ask only when ambiguity changes the action materially.',
    };
    return { primary, secondary: [], groups: [], prompt: '' };
  }

  const first = scored[0];
  const margin = first.score - (scored[1]?.score ?? 0);
  const confidence: IntentRoute['confidence'] = first.score >= 6 && margin >= 3 ? 'high' : first.score >= 3 ? 'medium' : 'low';
  const toRoute = (item: typeof first, level: IntentRoute['confidence']): IntentRoute => ({
    id: item.rule.id,
    label: item.rule.label,
    confidence: level,
    score: item.score,
    groups: item.rule.groups,
    preferredTools: item.rule.preferredTools,
    guidance: item.rule.guidance,
  });
  const primary = toRoute(first, confidence);
  const secondary = scored.slice(1, 3).map((item) => toRoute(item, item.score >= 3 ? 'medium' : 'low'));
  const groups = [...new Set([primary, ...secondary].flatMap((route) => route.groups))];
  if (/\b(?:audit|overhaul|upgrade|deep dive|in.?depth|massive|major|end[- ]to[- ]end|from scratch|multi.?step|multiple phases|long.?running)\b/i.test(source)) {
    groups.push('orchestration');
  }
  const prompt = [
    `REQUEST INTENT: ${primary.label} (${primary.confidence} confidence).`,
    primary.preferredTools.length ? `Preferred capabilities: ${primary.preferredTools.join(', ')}.` : '',
    primary.guidance,
    ...secondary.map((route) => `Related intent: ${route.label}. ${route.guidance}`),
    'Choose a high-level purpose-built capability before assembling low-level tools. Do not call multiple tools to achieve a result already returned by one complete tool.',
  ].filter(Boolean).join(' ');
  return { primary, secondary, groups, prompt };
}
