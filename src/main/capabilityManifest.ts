import type { ToolSchema } from './llm';
import type { Tool } from './toolTypes';
import { AGENTS } from './agentRegistry';
import { HARD_LIMITS } from './policy';
import { coreToolNames, groupInfo } from './toolRouter';
import type { TaskSpec } from './taskSpec';

/**
 * RUNTIME CAPABILITY MANIFEST (spec: "The model must know its actual capabilities").
 *
 * This module is generated from the LIVE tool registry — never hand-maintained. It answers
 * three questions with code, not prose:
 *
 *   1. What can JARVIS actually do right now? (build → manifest)
 *   2. Is every tool the model is told about real, registered and handler-backed?
 *      (manifestIssues → [] means yes; the tests assert it)
 *   3. What are the hard limits? (policy.HARD_LIMITS, injected next to the tools)
 *
 * The manifest is rebuilt whenever the model's context is built (every system prompt), so a
 * tool registered late, a group loaded, or a runtime change is reflected on the next turn
 * without any manual step.
 *
 * parallelSafe is DECLARED, not inferred: a tool states it on its own definition, and this
 * module holds the reviewed execution contract (TESTED_PARALLEL) a tool must be a member of
 * before declaring it. manifestIssues fails loudly on any mismatch, so a new tool cannot
 * gain concurrency rights by naming accident, and an untested claim cannot ship.
 */

export interface CapabilityTool {
  name: string;
  /** Router group ('browser' | 'desktop' | 'files' | 'productivity') or 'core' when ungrouped. */
  group: string;
  /** First sentence of the tool's own description. */
  summary: string;
  required: string[];
  optional: string[];
  /** The tool's own explicit declaration (never name-inferred); only TESTED_PARALLEL members may set it. */
  parallelSafe: boolean;
}

/**
 * ROUND 31 (§4.2) — the reviewed EXTERNAL-STATE surface: every tool here performs an
 * action whose primary effect lands OUTSIDE the JARVIS workspace (another service, the
 * user's real browser, the OS, the desktop, scheduled future actions). Membership is
 * reviewed like TESTED_PARALLEL: manifestIssues fails if a member is not registered.
 * These are exactly the tools the permission architecture treats as consequential —
 * keeping the list generated (not prose) keeps tool-selection honest.
 */
export const EXTERNAL_STATE_TOOLS: ReadonlySet<string> = new Set([
  'run_command',
  'run_python',
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'move_file',
  'copy_file',
  'make_dir',
  'github_create_issue',
  'github_create_pull',
  'vercel_deploy',
  'browser_click',
  'browser_type',
  'browser_fill_form',
  'browser_upload',
  'browser_key',
  'browser_eval',
  'browser_close',
  'native_browser_click',
  'native_browser_type',
  'native_browser_open',
  'native_browser_navigate',
  'native_browser_connect',
  'native_browser_disconnect',
  'type_text',
  'press_keys',
  'click_text',
  'click_at',
  'click_control',
  'set_control_text',
  'launch_app',
  'close_app',
  'schedule_task',
  'add_recurring_task',
  'set_timer',
]);

/**
 * ROUND 31 (§4.1) — INTELLIGENT TOOL-SELECTION HINTS: a deterministic recommendation of
 * WHICH tools and specialists fit THIS task, derived from the spec's capability families
 * and complexity class. The planner receives these as explicit guidance so tool choice
 * reflects what each tool can actually accomplish (and its cost) — not name matching.
 * Returns [] for work that needs no specific recommendation.
 */
export function recommendToolsFor(spec: TaskSpec): string[] {
  const hints: string[] = [];
  const caps = spec.capabilities;
  if (caps.includes('storage')) {
    hints.push('use analyze_storage once for the requested drive/folder; it returns capacity, top files and recursive folder sizes in one bounded scan — do not use repeated shell commands');
  } else if (caps.includes('files') && !caps.includes('write')) {
    hints.push('use find_files/glob/grep/list_files for discovery and read only the relevant matches; do not use run_command for ordinary filesystem inspection');
  }
  if (caps.includes('system')) {
    hints.push('prefer native system tools (get_system_info, list_processes, list_drives, bluetooth_scan) over ad-hoc PowerShell');
  }
  if (caps.includes('code') || spec.complexity === 'development') {
    hints.push('inspect_project first (stack/build/test commands), analyze_impact on any shared module before editing it, then coder for the change and its project checks (diagnostics/typecheck/build)');
  }
  if (spec.complexity === 'integration') {
    hints.push('verify integration state FIRST (github_status / vercel_status), use the github_*/vercel_* read tools before any write, and verify every external write through a read-back');
  }
  if (caps.includes('browser')) {
    hints.push('research and reading stay headless (tinyfish_search/tinyfish_fetch/search_and_read); browser_* actions only for interactions the task genuinely requires');
  }
  if (caps.includes('research')) {
    hints.push('search_and_read for multi-source synthesis; verify_claim before stating anything consequential');
  }
  if (spec.complexity === 'desktop') {
    hints.push('inspect_app before acting, click_control/set_control_text over blind coordinates, then re-observe with screen_text to verify');
  }
  if (spec.complexity === 'long_running') {
    hints.push('plan the work as a dependency graph; keep independent read-only steps parallel-eligible (dependsOn: [])');
  }
  if (spec.complexity === 'approval_required') {
    hints.push('high-risk work: state exactly what will change and its consequences before performing it; verification evidence is mandatory');
  }
  return hints.slice(0, 4);
}

export interface CapabilityManifest {
  generatedAt: string;
  toolCount: number;
  groups: Array<{ id: string; hint: string; toolCount: number }>;
  tools: CapabilityTool[];
  agents: Array<{ name: string; purpose: string; toolCount: number }>;
  runtime: { platform: string; os: string; node: string; electron: string; workspace: string };
  limits: string[];
  /** ROUND 31 (§4.2): the reviewed tools that CHANGE STATE BEYOND THE WORKSPACE —
   *  external services (GitHub/Vercel), the real browser, the desktop, the OS shell.
   *  Generated surface so prompts and planning can reason about side effects accurately
   *  instead of guessing from tool names. */
  externalStateTools: string[];
}

/**
 * The reviewed parallel-execution contract: every tool allowed to declare `parallelSafe:
 * true`. Membership means the tool has been reviewed as strictly read-only (observes, never
 * mutates) and is exercised by the runtime handler tests. A tool outside this set that
 * declares parallelSafe is a manifest ISSUE — adding a member here requires its own test
 * evidence (tests/runtimeHandlers.test.ts drives them through the real runTool chain).
 */
export const TESTED_PARALLEL: ReadonlySet<string> = new Set([
  'get_current_time',
  'list_files',
  'read',
  'glob',
  'grep',
  'code_search',
  'web_search',
  'web_browse',
  'search_and_read',
  'fetch_url',
  'get_weather',
  'tinyfish_search',
  'tinyfish_fetch',
  'calculate',
  'get_system_info',
  'clipboard_read',
  'find_contact',
  'find_memory',
  'read_notes',
  'list_memories',
  'list_timers',
  'list_custom_apps',
  'list_scheduled',
  'list_tasks',
  'list_drives',
  'list_processes',
  'execution_status',
  'list_my_browser_tabs',
  'browser_tabs',
  'browser_read',
  // Round 28 (Phase 2): NATIVE browser read-only tools — tab enumeration and page reads
  // are read-only observations over the connected session; concurrency-safe by contract.
  'native_browser_status',
  'native_browser_tabs',
  'native_browser_read',
  'native_browser_snapshot',
  'native_browser_screenshot',
  'native_browser_wait',
  // Round 28 (Phase 5): the recovery-engine STATUS projection — reads settings, open
  // issues and the recovery ledger; never mutates. Driven through the real runTool chain
  // by tests/runtimeHandlers.test.ts (probe evidence for membership).
  'ops_recovery_status',
  // Read-only impact analysis: scans exports/imports, never writes.
  'analyze_impact',
]);

type Registry = Record<string, Tool>;

const firstSentence = (description: string): string => {
  const m = /\S.*?(?:[.!?](?:\s|$))/.exec(description.trim().replace(/\s+/g, ' '));
  const s = (m?.[0] ?? description).trim();
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
};

const paramNames = (tool: Tool): { required: string[]; optional: string[] } => {
  const params = tool.parameters as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  const props = Object.keys(params?.properties ?? {});
  const req = (params?.required ?? []).filter((r) => typeof r === 'string');
  return { required: req, optional: props.filter((p) => !req.includes(p)) };
};

/** Build the manifest from the live registry. Pure aside from process/runtime reads. */
export function buildCapabilityManifest(registry: Registry, schemas: ToolSchema[]): CapabilityManifest {
  const groups = groupInfo();
  const groupOf = new Map<string, string>();
  groups.forEach((g) => g.tools.forEach((t) => groupOf.set(t, g.id)));
  const names = new Set(Object.keys(registry));
  const tools: CapabilityTool[] = Object.entries(registry).map(([name, t]) => ({
    name,
    group: groupOf.get(name) ?? 'core',
    summary: firstSentence(t.description ?? ''),
    ...paramNames(t),
    parallelSafe: t.parallelSafe === true, // the tool's own declaration — nothing else
  }));
  void schemas; // parity between registry and schemas is asserted by manifestIssues, not duplicated here

  return {
    generatedAt: new Date().toISOString(),
    toolCount: tools.length,
    groups: [
      ...groups.map((g) => ({ id: g.id, hint: g.hint, toolCount: g.tools.length })),
      { id: 'core', hint: 'always available', toolCount: tools.filter((t) => t.group === 'core').length },
    ],
    tools,
    agents: Object.values(AGENTS).map((a) => ({
      name: a.name,
      purpose: firstSentence(a.description || a.responsibility),
      toolCount: typeof a.tools === 'function' ? -1 : a.tools.size,
    })),
    runtime: {
      platform: process.platform,
      os: `${process.platform} ${process.arch}`,
      node: process.versions.node ?? '',
      electron: process.versions.electron ?? 'n/a',
      workspace: 'Jarvis-Files',
    },
    limits: [...HARD_LIMITS],
    externalStateTools: [...EXTERNAL_STATE_TOOLS].filter((n) => names.has(n)).sort(),
  };
}

/**
 * Compact per-turn context block for the system prompt. Paired with the static usage guide
 * (TOOL_GUIDE): this part is GENERATED, so it can never drift from the registry.
 */
export function manifestForPrompt(manifest: CapabilityManifest): string {
  const byGroup = manifest.groups
    .filter((g) => g.toolCount > 0)
    .map((g) => `${g.id} ${g.toolCount}`)
    .join(', ');
  return [
    `CAPABILITIES (generated from the live tool registry): ${manifest.toolCount} tools registered and handler-backed — ${byGroup}. ` +
      'Every tool in your tool list is real and callable; if a needed tool is not loaded, call load_tools. Call list_capabilities for the full generated catalogue with parameters.',
    `AGENTS available for delegation: ${manifest.agents.map((a) => a.name).join(', ')}.`,
    `HARD LIMITS (code-enforced, identical on every route — no approval can lift them): ${manifest.limits.join(' ')}`,
    manifest.externalStateTools.length
      ? `EXTERNAL-STATE TOOLS (${manifest.externalStateTools.length} reviewed tools whose effect lands OUTSIDE the workspace — services, the real browser, the desktop, the OS, future scheduled actions; use them deliberately and verify their results): ${manifest.externalStateTools.join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Full catalogue text returned by the list_capabilities tool. Must stay under the provider's 12k tool-result truncation: the header and the HARD LIMITS tail are guaranteed, only the tool list can ever be shortened (with an explicit note). */
export function manifestReport(manifest: CapabilityManifest): string {
  const cap = 11500;
  const head = [
    `Capability manifest — generated ${manifest.generatedAt} · ${manifest.toolCount} tools · ${manifest.runtime.os} · electron ${manifest.runtime.electron}`,
    ...manifest.groups.map((g) => `[${g.id}] ${g.hint} (${g.toolCount})`),
    '',
  ].join('\n');
  const tail = [
    '',
    `Delegation agents: ${manifest.agents.map((a) => a.name).join(', ')}`,
    `HARD LIMITS: ${manifest.limits.join(' ')}`,
    `EXTERNAL-STATE TOOLS: ${manifest.externalStateTools.join(', ')}`,
  ].join('\n');
  const budget = cap - head.length - tail.length - 1;
  const tools = [...manifest.tools].sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [];
  for (const t of tools) {
    // Compact: with 150+ tools, one-line summaries cannot fit under the provider's tool-result
    // cap; the full catalogue stays name+group+required, and list_capabilities(group) returns
    // summaries for exactly the group asked about.
    const line = `${t.name} (${t.group})${t.required.length ? ` [required: ${t.required.join(', ')}]` : ''}`;
    if (lines.join('\n').length + line.length + 1 > budget) {
      lines.push(`… ${tools.length - lines.length} further tools omitted here — call list_capabilities with a group filter (browser, desktop, files, productivity, core) to see them.`);
      break;
    }
    lines.push(line);
  }
  return [head, ...lines].join('\n') + tail;
}

/**
 * Registry integrity: every name referenced anywhere (schemas sent to the model, router
 * groups, core list, agent allowlists) must exist in the registry with a description, a
 * parameters object and a run handler — and every required parameter must be declared.
 * The parallel-execution surface is also enforced here: a declared flag must be boolean,
 * and only tools in the reviewed TESTED_PARALLEL contract may claim it.
 *
 * What this check does NOT establish (and the runtime handler tests do): that a handler
 * produces a correct RESULT in the live runtime. Structural integrity is proven statically;
 * behavior is proven by tests/runtimeHandlers.test.ts, which drives the read-only surface
 * through the real runTool chain (classify → authorize → handler → record).
 */
export function manifestIssues(registry: Registry, schemas: ToolSchema[]): string[] {
  const issues: string[] = [];
  const names = new Set(Object.keys(registry));

  for (const [name, t] of Object.entries(registry)) {
    if (!t.run || typeof t.run !== 'function') issues.push(`${name}: registered without a runnable handler`);
    if (!t.description || !t.description.trim()) issues.push(`${name}: registered without a description`);
    const params = t.parameters as { type?: string; properties?: Record<string, unknown>; required?: string[] } | undefined;
    if (!params || params.type !== 'object' || !params.properties) issues.push(`${name}: parameters is not a schema object`);
    else for (const r of params.required ?? []) if (!(r in params.properties)) issues.push(`${name}: required param "${r}" is not declared in properties`);
    if (t.parallelSafe !== undefined && typeof t.parallelSafe !== 'boolean') issues.push(`${name}: parallelSafe is declared but not a boolean`);
    if (t.parallelSafe === true && !TESTED_PARALLEL.has(name)) issues.push(`${name}: declares parallelSafe without membership in the tested parallel-execution contract`);
  }

  for (const s of schemas) {
    const n = s.function?.name;
    if (!n) issues.push('a tool schema has no name');
    else if (!names.has(n)) issues.push(`schema "${n}" is sent to the model but not registered`);
    else {
      const t = registry[n];
      if (t.parameters && JSON.stringify(t.parameters) !== JSON.stringify(s.function.parameters))
        issues.push(`${n}: schema sent to the model differs from the registered parameters`);
    }
  }

  for (const n of TESTED_PARALLEL) if (!names.has(n)) issues.push(`tested-parallel contract references missing tool "${n}"`);
  // ROUND 31 (§4.2): the external-state contract must stay registered too.
  for (const n of EXTERNAL_STATE_TOOLS) if (!names.has(n)) issues.push(`external-state contract references missing tool "${n}"`);
  for (const n of coreToolNames()) if (!names.has(n)) issues.push(`core list references missing tool "${n}"`);
  for (const g of groupInfo()) for (const n of g.tools) if (!names.has(n)) issues.push(`group ${g.id} references missing tool "${n}"`);
  for (const a of Object.values(AGENTS)) {
    if (typeof a.tools !== 'function') for (const n of a.tools) if (!names.has(n)) issues.push(`agent ${a.name} allowlist references missing tool "${n}"`);
  }
  return issues;
}
