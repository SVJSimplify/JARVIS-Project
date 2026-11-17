import type { TaskSpec } from './taskSpec';
import type { AgentKind } from './orchestrate';

/**
 * DELEGATION STRATEGY (Round 25 §3) — the code-controlled decision of WHETHER a task
 * benefits from multi-agent execution at all, and which shape it should take.
 *
 * The orchestrator (coordinator) remains the only orchestrator: this module never
 * executes anything and never spawns anything. It evaluates the TaskSpec the engine
 * already built and returns a STRATEGY plus the reasons, so delegation decisions are
 * explicit, reviewable and testable instead of an accident of prompt wording.
 *
 * Decision inputs (Round 25 §3):
 *  - task complexity (deliverables, acceptance criteria, constraints, length);
 *  - number of INDEPENDENT workstreams (explicit conjunctive clauses the spec already
 *    separates — never invented);
 *  - required specialist capabilities (mapped to registry agents);
 *  - expected benefit of parallel execution (≥2 independent read-only streams);
 *  - cost/latency implications (a model planning round is skipped for simple work);
 *  - risk of conflicting changes (write-write overlap forces serialized execution).
 *
 * The three strategies:
 *  - 'direct'                 — no agents: informational work is answered in the turn.
 *  - 'single_specialist'      — one scoped agent, one step + verify: no planning model
 *                               call, no fan-out (the common action task).
 *  - 'coordinated_multi_agent'- — a dependency-graph plan; independent read-only streams
 *                               run as parallel waves; writes stay serialized (Module E).
 *
 * Pure and deterministic: the same spec always yields the same strategy, so the
 * behavior is unit-testable without any model.
 */

export type DelegationStrategy = 'direct' | 'single_specialist' | 'coordinated_multi_agent';

export interface DelegationDecision {
  strategy: DelegationStrategy;
  /** Specialist for the single_specialist strategy (registry agent name). */
  kind?: AgentKind;
  /** Human-readable reasons for the decision (shown in the HUD and persisted on the task). */
  reasons: string[];
  /** Independent workstreams the task actually names (bounded; drives parallel waves). */
  workstreams: string[];
  /** True when at least two workstreams are read-only and can overlap safely. */
  parallelizable: boolean;
  /** 0–4 heuristic complexity score (used by tests and the HUD explanation). */
  complexity: number;
}

/** Explicit "and/then/also" workstream split: clauses the request itself separates. */
const SPLIT_RE = /\b(?:and also|also |as well as|separately|in addition|plus |at the same time|simultaneously|meanwhile)\b[, ]*/i;
/** Multi-part markers that suggest several independent research/comparison targets. */
const MULTI_TARGET_RE = /\b(compare|comparison|versus|vs\.?|each of|all of|several|multiple|every \w+|top \d+)\b/i;
/** Deep-work markers: tasks that genuinely need decomposition. */
const COMPLEX_RE = /\b(refactor|migrate|architect|redesign|investigate|debug|pipeline|integration|end-to-end|full|comprehensive|complete(?:ly)?|from scratch|and then|step by step)\b/i;

const KIND_FOR_CAPABILITY: Record<string, AgentKind> = {
  research: 'research',
  browser: 'browser',
  code: 'coder',
  write: 'general',
};

/**
 * ROUND 31 (§1.5→§4.1) — PLANNING DEPTH per complexity class. The classification made in
 * taskSpec.ts decides HOW MUCH planning a request deserves; explicit conjunctive
 * workstreams still override toward decomposition (never flatten multi-stream work).
 *  - simple / research / desktop → one scoped specialist (no planning model call)
 *  - multi_step / development / integration / long_running / approval_required → the
 *    dependency-graph planner (acceptance criteria ride along either way)
 */
const DECOMPOSE_FOR_COMPLEXITY: ReadonlySet<TaskSpec['complexity']> = new Set([
  'multi_step',
  'development',
  'integration',
  'long_running',
  'approval_required',
]);

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Split the request into explicit independent clauses (bounded, never invented). */
export function workstreamsOf(request: string): string[] {
  const text = String(request ?? '').trim();
  if (!text) return [];
  if (!SPLIT_RE.test(text)) return [];
  const parts = text
    .split(SPLIT_RE)
    .map((p) => p.trim())
    .filter((p) => p.length > 8);
  return parts.slice(0, 4).map((p) => clip(p, 90));
}

/**
 * The delegation decision. Deterministic floor: cheap heuristics over the structured
 * spec, no model call. Complexity score: deliverables + acceptance + constraints +
 * length + depth markers, clamped to 0–4.
 */
export function decideDelegation(spec: TaskSpec): DelegationDecision {
  const reasons: string[] = [];
  const lower = `${spec.request}\n${spec.objective}`.toLowerCase();

  // Informational work never spawns agents (the coordinator already refuses these; the
  // decision records WHY so the behavior is observable).
  if (spec.kind === 'informational') {
    return { strategy: 'direct', reasons: ['informational request: answered directly without agents'], workstreams: [], parallelizable: false, complexity: 0 };
  }

  // Complexity: bounded composite signal (acceptance weight capped so a single file
  // deliverable's 3 mechanical criteria do not inflate simple work into "complex").
  let complexity = 0;
  complexity += Math.min(1, spec.deliverables.length * 0.5);
  complexity += Math.min(1, spec.acceptance.length * 0.3);
  complexity += Math.min(0.5, spec.constraints.length * 0.25);
  complexity += spec.request.length > 400 ? 0.5 : 0;
  if (COMPLEX_RE.test(lower)) complexity += 1;
  if (spec.capabilities.includes('code')) complexity += 0.5;
  complexity = Math.max(0, Math.min(4, Math.round(complexity)));

  // Independent workstreams: explicit conjunctive markers only — never a fabricated split.
  const workstreams = workstreamsOf(spec.request);
  const multiTarget = MULTI_TARGET_RE.test(lower);

  // Capability match: the first registry specialist the spec's capabilities name.
  const kind: AgentKind = spec.capabilities.map((c) => KIND_FOR_CAPABILITY[c]).find(Boolean) ?? 'general';

  // Write-conflict risk: several workstreams that all write must NOT run in parallel
  // (one shared workspace — Module E). Read-only streams may overlap.
  const readOnlyKind = kind === 'research' || kind === 'browser' || kind === 'explore' || kind === 'reviewer' || kind === 'planner';
  const parallelizable = workstreams.length >= 2 && readOnlyKind;

  // --- the decision ---
  // ROUND 31: the complexity CLASS decides the default depth (§1.5); the legacy numeric
  // score and the explicit workstream/multi-target signals still override toward
  // decomposition. Never the other way: a classified-complex request is never flattened.
  const decompose = DECOMPOSE_FOR_COMPLEXITY.has(spec.complexity) || complexity > 1 || workstreams.length >= 2 || multiTarget;
  if (!decompose) {
    reasons.push(`${spec.complexity} work (complexity ${complexity}): one scoped ${kind} agent, no planning round`);
    return { strategy: 'single_specialist', kind, reasons, workstreams, parallelizable: false, complexity };
  }
  if (DECOMPOSE_FOR_COMPLEXITY.has(spec.complexity)) {
    reasons.push(`complexity class "${spec.complexity}": decomposition and staged verification pay`);
  }
  reasons.push(
    workstreams.length >= 2
      ? `${workstreams.length} independent workstreams named by the request`
      : multiTarget
        ? 'the request spans several targets — decomposition pays'
        : `complex work (complexity ${complexity}/4): decomposition and staged verification pay`
  );
  if (parallelizable) reasons.push('independent streams are read-only: they run as parallel waves');
  else if (workstreams.length >= 2) reasons.push('write-capable streams share one workspace: they run sequentially to avoid conflicting changes');
  reasons.push(`specialists required: ${[...new Set([kind, 'verifier'])].join(', ')}`);
  return { strategy: 'coordinated_multi_agent', kind, reasons, workstreams, parallelizable, complexity };
}

/** The decision as a one-line HUD/status string. */
export const delegationSummary = (d: DelegationDecision): string =>
  `${d.strategy}${d.kind ? ` (${d.kind})` : ''} — ${d.reasons.join('; ')}`;
