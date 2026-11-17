/**
 * AGENT REGISTRY (Module D) — one place where JARVIS's specialized agents are defined.
 *
 * Each agent is a CONTRACT, not just a prompt: what it is for, which tools it may use,
 * how far its permissions reach, how long it may run, how much context it may hold, what
 * its output must look like, and whether it may delegate further. The executor
 * (subagent.ts) and the delegation layer (orchestrate.ts) read their configuration from
 * here instead of scattering role constants — so adding or changing an agent is a
 * registry edit, never a hunt through execution code.
 *
 * Agents that already existed stay exactly as they are (general / explorer / researcher);
 * the registry formalises them and adds the two the architecture actually needs:
 * `document` (Module K artifact generation) and `verifier` (Module H acceptance checks).
 *
 * Round 25 (hybrid multi-agent): the five permanent SPECIALIST categories are explicit
 * registry entries with input/output contracts and failure strategies — research
 * (`researcher`), coding (`coder`), review (`reviewer`), testing (`tester`) and planning
 * (`planner`). They are subordinate execution/reasoning units of the ONE coordinator:
 * every call still flows through runTool → permission, budgets are enforced in the
 * executor, and none of them can delegate (delegationPolicy 'none').
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson } from './store';

export type ToolName = string;

export interface AgentDef {
  /** Registry key, also the delegation `agent:` value. */
  name: string;
  description: string;
  responsibility: string;
  /** The executor persona (subagent ROLES). */
  role: 'researcher' | 'explorer' | 'general' | 'documenter' | 'verifier' | 'operator';
  /** Tool allowlist: a set, or a predicate for open sets (e.g. "not subagent-denied"). */
  tools: Set<ToolName> | ((name: string) => boolean);
  /** Highest action classes this agent may ever request (children are narrowed further by the permission service). */
  maxActions: Array<'read' | 'write' | 'execute' | 'config'>;
  /** Executor round budget. */
  maxRounds: number;
  /** Wall-clock budget in ms; the executor reports an honest partial report at the end. */
  maxMs: number;
  /** Characters of tool output this agent tolerates before compaction. */
  contextBudgetChars: number;
  /** What the parent MUST hand this agent so it can work (Round 25 §2A input contract). */
  inputContract: string;
  /** The report shape the parent can rely on. */
  outputContract: string;
  /** What happens when the agent fails, times out or is cancelled (Round 25 §2A). */
  failureStrategy: string;
  /** Children may never spawn children today; the field exists so the policy is explicit. */
  delegationPolicy: 'none';
}

// ------------------------------------------------------------- shared tool allowlists

const READ_TOOLS = new Set([
  'read', 'list_files', 'glob', 'grep', 'find_files', 'read_document', 'get_current_time', 'get_system_info', 'list_windows', 'read_notes',
  'list_memories', 'find_memory', 'find_contact', 'calculate', 'tool_log', 'todo_read', 'list_timers', 'list_scheduled', 'list_drives', 'list_processes',
  // Round 31 (§2): project intelligence — read-only workspace understanding + impact analysis.
  'inspect_project', 'project_context', 'analyze_impact',
]);

/** Tools that change files or run code — the write/execute ceiling for builder agents. */
const CODE_TOOLS = ['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'run_command', 'run_python', 'diagnostics'] as const;

/** Shared failure/cancellation wording (identical mechanics for every agent: the
 *  coordinator's signal governs, retries are bounded, nothing outlives its mandate). */
const FAIL = 'on failure or timeout: report honestly what is DONE and what is NOT (never a silent partial); on cancellation: stop at once, leave finished work in place, record no new side effects';

const WEB_TOOLS = new Set(['tinyfish_search', 'tinyfish_fetch', 'web_search', 'web_browse', 'fetch_url', 'search_and_read', 'code_search', 'get_weather']);

/**
 * Tools that put the full-screen browser panel on the user's screen. Sub-agents are
 * invisible workers: NONE of them may ever open the visible panel (the main agent keeps
 * that for explicit "show me" requests). Sub-agents read the web headlessly instead.
 */
const PANEL_OPENERS = new Set(['browser_open', 'browser_search', 'browser_play']);

const BROWSER_READ_TOOLS = new Set([
  'browser_open', 'browser_read', 'browser_snapshot', 'browser_tabs', 'browser_search', 'browser_see', 'browser_scroll', 'browser_wait',
  'browser_back', 'browser_forward', 'browser_reload', 'browser_click', 'browser_click_text', 'browser_type', 'browser_fill_form',
  'browser_select', 'browser_check', 'browser_key', 'browser_hover',
]);

/** Round 28 (Phase 2): NATIVE browser tools a browser-kind sub-agent may use — operate
 *  tabs ONLY against an ALREADY-connected session. Connecting, disconnecting and
 *  reconnecting the user's real browser are explicit user decisions kept to the main
 *  agent and the UI (a sub-agent must never establish or drop that session). */
const NATIVE_BROWSER_TOOLS = new Set([
  'native_browser_status', 'native_browser_tabs', 'native_browser_open', 'native_browser_navigate', 'native_browser_read',
  'native_browser_snapshot', 'native_browser_click', 'native_browser_type', 'native_browser_screenshot', 'native_browser_close_tab', 'native_browser_wait',
]);

// ---------------------------------------------------------------------------- the registry

export const AGENTS: Record<string, AgentDef> = {
  general: {
    name: 'general',
    description: 'The default worker: makes requested changes with the smallest correct edit, then verifies its own work.',
    responsibility: 'Implement one self-contained job end to end: read before writing, edit, verify, report honestly.',
    role: 'general',
    tools: (n) => !['task', 'research', 'parallel_tasks', 'background_start', 'verify_claim', 'ask_user', 'plan_enter', 'plan_exit', 'see_screen', 'browser_see', ...PANEL_OPENERS].includes(n),
    maxActions: ['read', 'write', 'execute'],
    maxRounds: 30,
    maxMs: 10 * 60_000,
    contextBudgetChars: 60_000,
    inputContract: 'ONE self-contained job: complete instructions, every constraint, the exact files/scope this step owns, and the results of any upstream steps it depends on.',
    outputContract: 'DONE: what changed (exact paths); VERIFIED: how it was checked; ISSUES: anything left. Or FAILED: why.',
    failureStrategy: FAIL,
    delegationPolicy: 'none',
  },
  explorer: {
    name: 'explorer',
    description: 'Read-only investigator: locates files, code and facts inside the machine; never modifies anything.',
    responsibility: 'Find and explain: exact paths and line numbers, a conclusion, no modifications.',
    role: 'explorer',
    tools: new Set([...READ_TOOLS, ...WEB_TOOLS, 'skill']),
    maxActions: ['read'],
    maxRounds: 24,
    maxMs: 6 * 60_000,
    contextBudgetChars: 40_000,
    inputContract: 'A precise question about files, code or machine state; the search scope; what a useful answer names (paths, line numbers).',
    outputContract: 'FOUND: bullets with path:line and one-line meanings; ANSWER: the conclusion. Under 300 words.',
    failureStrategy: FAIL,
    delegationPolicy: 'none',
  },
  researcher: {
    name: 'researcher',
    description: 'Web researcher: searches, reads pages, cross-checks and reports with source URLs.',
    responsibility: 'Answer a research question from live pages with evidence, dates and honest gaps.',
    role: 'researcher',
    tools: new Set([...WEB_TOOLS, 'get_current_time', 'calculate', 'read', 'find_files', 'read_document']),
    maxActions: ['read'],
    maxRounds: 10,
    maxMs: 6 * 60_000,
    contextBudgetChars: 50_000,
    inputContract: 'ONE self-contained research question with all context and constraints; recency expectations; what counts as a sufficient answer.',
    outputContract: 'ANSWER: 2-5 sentences; EVIDENCE: one bullet per fact, each ending in (source URL); CONFLICTS/GAPS: what is uncertain. Under 350 words.',
    failureStrategy: FAIL,
    delegationPolicy: 'none',
  },
  document: {
    name: 'document',
    description: 'Artifact producer: generates DOCX/PDF/PPTX/XLSX files through the artifact service and validates them.',
    responsibility: 'Turn content into a validated document artifact; never claim success before the file passes validation.',
    role: 'documenter',
    tools: new Set([...READ_TOOLS, ...WEB_TOOLS, 'write_file', 'edit_file', 'make_document', 'read_document']),
    maxActions: ['read', 'write'],
    maxRounds: 16,
    maxMs: 6 * 60_000,
    contextBudgetChars: 60_000,
    inputContract: 'The full document content or its sources, the target format and path, and any template constraints.',
    outputContract: 'DONE: artifact path, format, and the validation result line; ISSUES: anything the validator flagged.',
    failureStrategy: FAIL,
    delegationPolicy: 'none',
  },
  browser: {
    name: 'browser',
    description: 'Web operator for sub-agents: reads and acts on pages with the hidden browser tools; may act on the in-app panel only if it is ALREADY open (it can never open it — opening the visible panel is the main agent\'s job).',
    responsibility: 'Complete the requested web job without anything appearing on screen: headless readers first, panel tools only against an already-open panel.',
    role: 'general',
    tools: (n) => (BROWSER_READ_TOOLS.has(n) && !PANEL_OPENERS.has(n)) || NATIVE_BROWSER_TOOLS.has(n) || WEB_TOOLS.has(n) || READ_TOOLS.has(n) || n === 'browser_close' || n === 'browser_close_tab' || n === 'browser_upload' || n === 'browser_click_at' || n === 'browser_dialog' || n === 'browser_downloads',
    maxActions: ['read', 'write'],
    maxRounds: 20,
    maxMs: 6 * 60_000,
    contextBudgetChars: 40_000,
    inputContract: 'The exact web job (pages, actions, expected end state) and any credentials context ALREADY authorized by the user\'s request.',
    outputContract: 'DONE: the page state reached (title/URL) and what was acted on; ISSUES: what could not be completed.',
    failureStrategy: FAIL,
    delegationPolicy: 'none',
  },
  verifier: {
    name: 'verifier',
    description: 'Independent acceptance checker: verifies a deliverable against its acceptance criteria and reports evidence.',
    responsibility: 'Check reality — files exist and reopen, commands pass, sources were fetched — without trusting the worker’s claims.',
    role: 'verifier',
    tools: new Set([...READ_TOOLS, 'run_command', 'make_document' /* read-only use: validators */, 'browser_read', 'browser_tabs']),
    maxActions: ['read', 'execute'],
    maxRounds: 12,
    maxMs: 4 * 60_000,
    contextBudgetChars: 40_000,
    inputContract: 'The deliverable (paths/claims) and EACH acceptance criterion to check, with the command or file each check needs.',
    outputContract: 'CHECKED: one line per criterion with PASS/FAIL and the evidence; VERDICT: PASS or FAIL. No fixes, only truth.',
    failureStrategy: FAIL,
    delegationPolicy: 'none',
  },
  desktop: {
    name: 'desktop',
    description: 'Desktop operator: drives real applications through screenshots, OCR, UI Automation and keyboard/mouse — observe first, act, then verify on screen.',
    responsibility: 'Complete the requested desktop workflow: identify the window, act with the smallest reliable interaction, re-observe the screen and report the actual result (Round 18 §9).',
    role: 'operator',
    tools: new Set([
      'see_screen', 'screen_text', 'click_text', 'click_at', 'type_text', 'press_keys', 'scroll_at', 'drag_at',
      'list_windows', 'focus_window', 'inspect_app', 'click_control', 'set_control_text', 'launch_app', 'close_app',
      'take_screenshot', 'place_window', 'get_current_time', 'read', 'list_files',
    ]),
    maxActions: ['read', 'write', 'execute'],
    maxRounds: 20,
    maxMs: 6 * 60_000,
    contextBudgetChars: 40_000,
    inputContract: 'The target application/window, the exact workflow, and what the correct end state looks like on screen.',
    outputContract: 'DONE: the state reached (window/app and what changed on screen); VERIFIED: what you re-observed (screen_text/see_screen) after acting; ISSUES: dialogs, focus problems, anything incomplete. Or FAILED: why.',
    failureStrategy: FAIL,
    delegationPolicy: 'none',
  },
  data: {
    name: 'data',
    description: 'Data analyst: computes, cross-checks and produces verified numbers/tables from files, documents or research results.',
    responsibility: 'Turn raw material into checked analysis: compute with tools (never mental arithmetic), sanity-check totals, save outputs, report the numbers with their provenance.',
    role: 'general',
    tools: new Set([...READ_TOOLS, 'calculate', 'run_python', 'write_file', 'read_document', 'make_document']),
    maxActions: ['read', 'write', 'execute'],
    maxRounds: 16,
    maxMs: 6 * 60_000,
    contextBudgetChars: 50_000,
    inputContract: 'The raw material (file paths, tables, prior results) and the exact analysis question with its tolerances.',
    outputContract: 'DONE: the analysis result (exact numbers/paths); VERIFIED: how each number was computed/re-checked; ISSUES: gaps or unverified inputs. Or FAILED: why.',
    failureStrategy: FAIL,
    delegationPolicy: 'none',
  },

  // ------------------------------------------------- Round 25 permanent specialists
  // The five specialist CATEGORIES the hybrid architecture names, as registry entries:
  // research = researcher (above), coding = coder, review = reviewer, testing = tester,
  // planning = planner. Same executor, same permission gate, same budgets mechanics —
  // adding one is (and stays) a registry edit, never a new subsystem.

  coder: {
    name: 'coder',
    description: 'Coding specialist: implements, debugs and modifies code with the smallest correct change, then proves it (diagnostics/tests/build).',
    responsibility: 'Make one change set correctly: read before writing, keep the edit minimal, run the project\'s own checks, fix what the change breaks.',
    role: 'general',
    tools: new Set([...READ_TOOLS, ...WEB_TOOLS, ...CODE_TOOLS, 'skill', 'code_search']),
    maxActions: ['read', 'write', 'execute'],
    maxRounds: 30,
    maxMs: 10 * 60_000,
    contextBudgetChars: 60_000,
    inputContract: 'The change request with file/scope boundaries, the results of upstream steps it depends on, and the verification command the result must survive.',
    outputContract: 'DONE: exact files changed and how; VERIFIED: the diagnostics/tests/build results; ISSUES: anything left. Or FAILED: why.',
    failureStrategy: FAIL,
    delegationPolicy: 'none',
  },
  reviewer: {
    name: 'reviewer',
    description: 'Independent code reviewer: reviews a change for correctness, quality and defects — READ-ONLY, never fixes, never rubber-stamps.',
    responsibility: 'Review the named diff/files against the stated intent: concrete defects with path:line, severity and why; no rewrites, no direct edits.',
    role: 'verifier',
    tools: new Set([...READ_TOOLS, 'diagnostics', 'code_search']),
    maxActions: ['read'],
    maxRounds: 12,
    maxMs: 4 * 60_000,
    contextBudgetChars: 40_000,
    inputContract: 'The change under review (files or diff), the intent it should serve, and any project conventions to judge against.',
    outputContract: 'REVIEW: findings as bullets, each with path:line, severity (blocker/major/minor) and one-line why; VERDICT: APPROVE or CHANGES_NEEDED. Under 300 words.',
    failureStrategy: FAIL,
    delegationPolicy: 'none',
  },
  tester: {
    name: 'tester',
    description: 'Testing specialist: designs and runs verification for a change — executes the existing suites, adds focused tests, reports real results.',
    responsibility: 'Prove the work: run the relevant tests/diagnostics, design the missing focused test when a behavior is unverified, report pass/fail with actual output.',
    role: 'general',
    tools: new Set([...READ_TOOLS, ...CODE_TOOLS, 'skill']),
    maxActions: ['read', 'write', 'execute'],
    maxRounds: 24,
    maxMs: 8 * 60_000,
    contextBudgetChars: 50_000,
    inputContract: 'What must hold after the change (behaviors/criteria), where the tests live, and the commands that run them.',
    outputContract: 'DONE: tests run/added with their real pass/fail output; VERIFIED: what each result proves; ISSUES: untested behaviors. Or FAILED: why.',
    failureStrategy: FAIL,
    delegationPolicy: 'none',
  },
  planner: {
    name: 'planner',
    description: 'Planning specialist: decomposes a complex objective into a dependency-aware step graph — analysis only, no side effects.',
    responsibility: 'Turn one objective into a minimal ordered plan: independent steps marked parallelizable, dependencies explicit, each step self-contained with its expected output.',
    role: 'general',
    tools: new Set([...READ_TOOLS, ...WEB_TOOLS, 'todo_write']),
    maxActions: ['read'],
    maxRounds: 12,
    maxMs: 4 * 60_000,
    contextBudgetChars: 50_000,
    inputContract: 'The objective verbatim, the constraints, what already exists (files/repos/projects), and any completed work that must not be redone.',
    outputContract: 'PLAN: a JSON array of steps, each {"id","title","detail","kind","dependsOn","expectedOutput"}; ASSUMPTIONS: what you had to assume. Under 500 words.',
    failureStrategy: FAIL,
    delegationPolicy: 'none',
  },
};

export const AGENT_NAMES = Object.keys(AGENTS);

// ------------------------------------------------------- dynamic task-specific agents (R17)

/**
 * DYNAMIC AGENTS (Pillar 2, §8.2): when a task needs a specialist the static roster does
 * not cover, the orchestrator registers a temporary agent HERE — the SAME registry, the
 * SAME executor, the SAME authorization boundary. There is no second runtime.
 *
 * Hard properties of every dynamic agent:
 *  - bounded: budgets are clamped below the static maximums, never above;
 *  - no delegation: delegationPolicy stays 'none' and delegation tools are stripped;
 *  - no new authorization path: the tool list can only NARROW what the registry already
 *    exposes (the permission service still judges every call);
 *  - lifecycle-tracked: parent, creation time and run state are recorded; entries are
 *    pruned so the registry cannot grow unbounded.
 */

const DELEGATION_TOOLS = new Set(['task', 'research', 'parallel_tasks', 'batch', 'chain', 'background_start', 'verify_claim', 'spawn_agent', 'ask_user', 'start_task']);
const DYNAMIC_MAX_ROUNDS = 24;
const DYNAMIC_MAX_MS = 8 * 60_000;
const DYNAMIC_MAX_CONTEXT = 60_000;
const MAX_DYNAMIC_AGENTS = 8;
const DYNAMIC_TTL_MS = 24 * 60 * 60_000;

export interface DynamicAgentSpec {
  name: string;
  purpose: string;
  /** Tools this specialist may use; delegation tools are stripped automatically. */
  tools: string[];
  /** Report shape the parent can rely on. */
  outputContract?: string;
  maxRounds?: number;
  maxMs?: number;
}

export interface DynamicAgentRecord {
  def: AgentDef;
  parent: string;
  createdAt: number;
  runs: number;
}

const dynamicAgents = new Map<string, DynamicAgentRecord>();

// ---------------------------------------------------------- dynamic roster persistence (R25 §8)
// The dynamic roster used to be memory-only: a restart silently forgot every task-specific
// specialist, so a resumed task could not name (or reuse) the agents it had registered.
// The roster is now persisted through the SAME durable store every other engine state uses
// (atomic JSON under brain/agents/) — no second persistence system, just the existing
// atomicWrite pattern. Recovery: entries are TTL-pruned on restore; a restored entry is
// byte-identical to its pre-restart definition so resumed work sees the same specialist.

const DYNAMIC_ROSTER_FILE = (): string => path.join(FILES_ROOT, 'brain', 'agents', 'dynamic.json');

/** The on-disk row shape: the def with its Set allowlist serialized as a plain array. */
interface PersistedDynamicAgent {
  name: string;
  parent: string;
  createdAt: number;
  runs: number;
  def: Omit<AgentDef, 'tools'> & { tools: string[] };
}

/** The in-order persistence chain: each roster write appends to it, so concurrent
 *  mutations land on disk in mutation order and a stale snapshot can never win. */
let persistChain: Promise<boolean> = Promise.resolve(false);

/** Persist the CURRENT dynamic roster.
 *
 * ROUND 25.1 FIX #3 — the write is SERIALIZED and OBSERVABLE. Every call snapshots the
 * roster SYNCHRONOUSLY (the state its triggering mutation just produced) and appends the
 * actual write to a promise chain, so two concurrent mutations can never land their
 * writes out of order — an older snapshot can never overwrite a newer one on disk (that
 * stale-write race is exactly what could resurrect a retired agent or roll a run count
 * back). Persistence must still never break execution, so failures resolve to `false`
 * instead of throwing; callers that must KNOW durability happened await
 * `dynamicRosterPersistState()` instead of trusting fire-and-forget. */
export function persistDynamicAgents(): Promise<boolean> {
  let payload: { savedAt: number; agents: PersistedDynamicAgent[] };
  try {
    // JSON cannot hold a Set: the allowlist is serialized as an array and rebuilt
    // (re-validated) on restore — a restored entry is equivalent, never a blind copy.
    payload = {
      savedAt: Date.now(),
      agents: [...dynamicAgents.values()].map((r): PersistedDynamicAgent => ({
        name: r.def.name,
        parent: r.parent,
        createdAt: r.createdAt,
        runs: r.runs,
        def: { ...r.def, tools: [...(r.def.tools as Set<string>)] },
      })),
    };
  } catch {
    return Promise.resolve(false);
  }
  const write = persistChain.then(async (): Promise<boolean> => {
    try {
      await fs.mkdir(path.dirname(DYNAMIC_ROSTER_FILE()), { recursive: true });
      await atomicWrite(DYNAMIC_ROSTER_FILE(), JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  });
  persistChain = write; // the inner try/catch means the chain never rejects
  return write;
}

/** The in-order tail of the roster persistence chain: resolves with the outcome of the
 *  most recent roster write (and of every write before it, in order). `false` before the
 *  first write completes — nothing is durably saved yet — and after a FAILED write, so a
 *  caller is never told a change is durable when it is not. Awaiting this after any
 *  register / retire / run-count change observes that change's persistence. */
export const dynamicRosterPersistState = (): Promise<boolean> => persistChain;

/**
 * Restore the persisted dynamic roster at boot (Round 25 §8): TTL-pruned, shape-validated,
 * collision-safe (a name that now collides with a permanent agent or an existing entry is
 * skipped, never fatal). Returns how many specialists were restored.
 */
export async function restoreDynamicAgents(): Promise<number> {
  const raw = await loadJson<{ savedAt?: number; agents?: Array<Omit<PersistedDynamicAgent, 'def'> & { def: Omit<AgentDef, 'tools'> & { tools?: unknown } }> } | null>(DYNAMIC_ROSTER_FILE(), null).catch(() => null);
  const list = Array.isArray(raw?.agents) ? raw!.agents! : [];
  let restored = 0;
  for (const row of list.slice(0, MAX_DYNAMIC_AGENTS)) {
    try {
      if (!row || typeof row.name !== 'string' || !row.def || row.def.name !== row.name) continue;
      if (Date.now() - Number(row.createdAt ?? 0) > DYNAMIC_TTL_MS) continue; // expired: pruned, not restored
      if (AGENTS[row.name] || dynamicAgents.has(row.name)) continue;
      // A persisted def is NOT trusted blindly: the tool allowlist must be a non-empty
      // array of tool names; delegation tools are stripped again (they can never come
      // back through a restore), and the budgets are re-clamped to the dynamic ceilings.
      const tools = Array.isArray(row.def.tools)
        ? (row.def.tools as unknown[]).filter((t): t is string => typeof t === 'string' && t.length > 0 && !DELEGATION_TOOLS.has(t)).slice(0, 16)
        : [];
      if (!tools.length) continue;
      const def: AgentDef = {
        ...row.def,
        tools: new Set(tools),
        maxRounds: clamp(Number(row.def.maxRounds), DYNAMIC_MAX_ROUNDS, 3),
        maxMs: clamp(Number(row.def.maxMs), DYNAMIC_MAX_MS, 30_000),
        contextBudgetChars: DYNAMIC_MAX_CONTEXT,
        delegationPolicy: 'none',
      };
      dynamicAgents.set(row.name, { def, parent: String(row.parent ?? 'restored'), createdAt: Number(row.createdAt ?? Date.now()), runs: Number(row.runs ?? 0) });
      restored++;
    } catch {
      /* one bad row never blocks the rest of the roster */
    }
  }
  return restored;
}

const clamp = (v: number | undefined, max: number, floor: number): number =>
  Math.max(floor, Math.min(Math.round(Number(v) || max), max));

/** Register a temporary specialist. Throws on garbage input instead of degrading silently. */
export function registerDynamicAgent(spec: DynamicAgentSpec, parent: string): AgentDef {
  // Prune first so a long session cannot exceed the cap through stale entries.
  for (const [k, rec] of dynamicAgents) {
    if (Date.now() - rec.createdAt > DYNAMIC_TTL_MS) dynamicAgents.delete(k);
  }
  if (dynamicAgents.size >= MAX_DYNAMIC_AGENTS)
    throw new Error(`Dynamic agent limit reached (${MAX_DYNAMIC_AGENTS}). Reuse an existing specialist or let one expire.`);
  const base = String(spec.name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  const name = base ? `dyn_${base}` : `dyn_task${dynamicAgents.size + 1}`;
  // Collide with a permanent agent under EITHER spelling (raw or dyn_-prefixed), and
  // with an ALREADY-REGISTERED dynamic specialist (Round 18 §6.4: duplicate proposals
  // must reuse the existing specialist, not silently duplicate work — the coordinator
  // surfaces the refusal and the step retries or reuses).
  if (AGENTS[name] || AGENTS[base]) throw new Error(`Agent name "${base}" collides with a permanent agent; pick another.`);
  if (dynamicAgents.has(name) || dynamicAgents.has(`dyn_${base}`))
    throw new Error(`Specialist "${base}" is already registered for this session; reuse it instead of duplicating the work.`);
  const tools = (Array.isArray(spec.tools) ? spec.tools : []).filter((t): t is string => typeof t === 'string' && t.length > 0 && !DELEGATION_TOOLS.has(t)).slice(0, 16);
  if (!tools.length) throw new Error('A dynamic agent needs at least one tool from the capability registry.');
  const def: AgentDef = {
    name,
    description: `Task-specific specialist (${parent}): ${String(spec.purpose ?? '').slice(0, 160)}`,
    responsibility: String(spec.purpose ?? 'Complete the assigned objective and report evidence.').slice(0, 400),
    role: 'general',
    tools: new Set(tools),
    maxActions: ['read', 'write', 'execute'],
    maxRounds: clamp(spec.maxRounds, DYNAMIC_MAX_ROUNDS, 3),
    maxMs: clamp(spec.maxMs, DYNAMIC_MAX_MS, 30_000),
    contextBudgetChars: DYNAMIC_MAX_CONTEXT,
    inputContract: 'Complete self-contained instructions for ONE bounded job, including what to report back.',
    outputContract: String(spec.outputContract ?? 'DONE: what was produced (paths/facts); VERIFIED: how; ISSUES: what remains. Or FAILED: why.'),
    failureStrategy: FAIL,
    delegationPolicy: 'none',
  };
  dynamicAgents.set(name, { def, parent, createdAt: Date.now(), runs: 0 });
  // Round 25 §8: the roster survives a restart — persisted best-effort on every change.
  void persistDynamicAgents();
  return def;
}

/** Test hook: clear the dynamic roster between tests (disk row removed by the caller). */
export const resetDynamicAgentsForTests = (): void => dynamicAgents.clear();

/** Look up a dynamic agent (undefined for unknown/non-dynamic names). */
export const getDynamicAgent = (name: string): DynamicAgentRecord | undefined => dynamicAgents.get(String(name ?? ''));

/** A dynamic agent was used: lifecycle tracking. ROUND 25.1 FIX #3: the run count is part
 *  of the persisted roster, so every real bump persists (serialized, observable via
 *  dynamicRosterPersistState); an unknown name changes nothing and writes nothing. */
export const noteDynamicRun = (name: string): void => {
  const rec = dynamicAgents.get(String(name ?? ''));
  if (rec) {
    rec.runs++;
    void persistDynamicAgents();
  }
};

/** A dynamic agent's roster entry can be retired once its work is settled (Round 25 §2B
 *  cleanup). ROUND 25.1 FIX #3: the removal is PERSISTED (serialized, observable via
 *  dynamicRosterPersistState) so a restart cannot resurrect the retired agent; an unknown
 *  name is a no-op that writes nothing. */
export const retireDynamicAgent = (name: string): boolean => {
  const removed = dynamicAgents.delete(String(name ?? ''));
  if (removed) void persistDynamicAgents();
  return removed;
};

/** Registry introspection for the model and the manifest. */
export const listDynamicAgents = (): Array<{ name: string; parent: string; purpose: string; tools: string[]; runs: number; ageMs: number }> =>
  [...dynamicAgents.values()].map((r) => ({
    name: r.def.name,
    parent: r.parent,
    purpose: r.def.responsibility.slice(0, 120),
    tools: [...(r.def.tools as Set<string>)],
    runs: r.runs,
    ageMs: Date.now() - r.createdAt,
  }));

/** Resolve a registry entry; unknown names degrade to `general` (never an error). */
export const resolveAgent = (name: string | undefined): AgentDef => AGENTS[name ?? ''] ?? dynamicAgents.get(String(name ?? ''))?.def ?? AGENTS.general;

/** May this agent call this tool? (Registry allowlist is the FIRST gate; the permission service is the second.) */
export const agentAllows = (a: AgentDef, tool: string): boolean =>
  typeof a.tools === 'function' ? a.tools(tool) : a.tools.has(tool);

/** The prompt block describing an agent for its executor system message. */
export const agentPrompt = (a: AgentDef): string =>
  [`ROLE: ${a.name}. ${a.responsibility}`, `You may use only your own tools; report format: ${a.outputContract}`].join('\n');
