import { promises as fs } from 'fs';
import * as path from 'path';
import { completeOnce } from './llm';
import { getModel } from './settings';
import { agentAllows, noteDynamicRun, registerDynamicAgent } from './agentRegistry';
import { runSubagent, type Runner } from './subagent';
import { agentDefFor, AGENT_KINDS, isReadOnlyKind, type AgentKind } from './orchestrate';
import { decideDelegation, delegationSummary, type DelegationDecision } from './delegation';
import { agentBegin, agentEnd } from './agentTracker';
import type { ToolSchema } from './llm';
import type { Tool } from './toolTypes';
import { buildTaskSpec, specPrompt, type TaskSpec } from './taskSpec';
import { recommendToolsFor } from './capabilityManifest';
import {
  activeTasks,
  ACTIVE_STATUSES,
  appendStepDetail,
  claimTask,
  createTask,
  failedSteps,
  getTask,
  listTasks,
  markStep,
  nextEligibleSteps,
  persistTask,
  reconcileInterruptedSteps,
  releaseClaim,
  renewClaim,
  replanSteps,
  setNote,
  setSteps,
  setTaskVerdict,
  setVerification,
  stepsBlockedByFailure,
  stepsComplete,
  transition,
  appendStep,
  validatePlanGraph,
  type TaskRecord,
  type TaskStep,
} from './taskStore';
import { verifyAcceptance, applyReviewerVerdict, evaluateStepEvidence } from './verifier';
import { setStepVerification, validVerification, type StepVerification } from './taskStore';
import {
  deliveryGate,
  deliveryStatusLine,
  honestVerdictFor,
  initDeliverablesFromPlan,
  initDelivery,
  markCriteriaInProgress,
  noteDeliverableProgress,
  reconcileDeliveryAtResume,
  settleDelivery,
} from './delivery';
import { refreshProjectProfile, relevantProfileContext } from './projectProfile';
import { buildTaskMemoryContext, queueEpisode, processPendingEpisodes } from './episodicMemory';
import { FILES_ROOT, isInsideRoot, bindTaskWorkspace, unbindTaskWorkspace } from './workspace';
import { recordWorkflowEntry } from './workflowJournal';
import { emitActivity } from './modes';
import { detectProject, runCmd } from './verifyExec';
import { reconcileUnfinishedAtResume, unresolvedExecutionsFor, recordsForTask, recordReconciled, flushPendingOutcomes, runWithCallContext } from './toolRecord';

/**
 * TASK COORDINATOR (Module C) — code-controlled execution for multi-step work.
 *
 * The coordinator owns the loop for durable tasks: plan → checkpoint-free ordered steps
 * with sub-agents → VERIFY against acceptance criteria → complete honestly or revise
 * (bounded) → report. The model cannot skip a phase, declare a task complete, or run a
 * step whose dependencies are unfinished: every transition goes through the taskStore
 * state machine, and completion requires the verifier's pass.
 *
 * Boundaries with the rest of the engine (no duplicate systems):
 *  - Conversational single-step work keeps running in the provider turn loop.
 *  - There is exactly ONE task engine (this coordinator + the task store) and ONE command
 *    runner for verification (verifyExec.ts, policy-gated). No competing runtime exists.
 *  - Every tool call inside every step still flows through runTool → permission service
 *    → durable records, with the task/step ids attached via the call context.
 */

const MAX_CONCURRENT_TASKS = 2;
const STEP_RETRY = 1; // each step is retried once with its error before the task fails
const TASK_FIX_ROUNDS = 1; // a failed verification triggers at most one bounded revise round
const MAX_STEPS = 8;
/** Round 18 §5.2/§5.4: independent eligible steps run concurrently, bounded — 2
 *  concurrent steps × the sub-agents' own parallel tool calls keeps provider and
 *  machine load sane while still overlapping genuinely independent work. */
const MAX_PARALLEL_STEPS = 2;
/** Round 18 §5.5: at most one ADAPTIVE REPLAN per task (bounded, preserves completed
 *  work; the verification fix-round budget is separate). */
const REPLAN_BUDGET = 1;
/** Watchdog threshold: a RUNNING task with no heartbeat for this long is INTERRUPTED. */
let STEP_TIMEOUT_MS = 10 * 60_000;
/** F-18: the heartbeat renews the lease WHILE a step runs, not only at step boundaries.
 *  Deliberately far below STEP_TIMEOUT_MS and independent of it. */
let HEARTBEAT_MS = 60_000;
/** Round 20 (CHANGE 4): explicit execution-time bounds that the heartbeat CANNOT renew
 *  away. STEP_DEADLINE_MS bounds ONE step attempt (the runner's signal fires and the step
 *  is failed honestly — never silently left running forever). TASK_MAX_MS bounds the
 *  whole drive: a task that exceeds it fails with an explicit note instead of looping
 *  indefinitely. Both are generous enough for legitimate complex work (the per-step
 *  budget matches the old watchdog stall threshold; the task budget is 6× that). */
let STEP_DEADLINE_MS = 10 * 60_000;
const TASK_MAX_MS = 60 * 60_000;

/** Test hook: shrink the heartbeat and the stall threshold so lease/watchdog behavior is
 *  exercisable in milliseconds. Production timing stays heartbeat 60s / stall 10min. */
export const setCoordinatorTimingForTests = (heartbeatMs?: number, stallMs?: number): void => {
  if (heartbeatMs !== undefined) HEARTBEAT_MS = Math.max(5, heartbeatMs);
  if (stallMs !== undefined) STEP_TIMEOUT_MS = Math.max(20, stallMs);
};

/** Test hook (Round 20): shrink the per-step deadline and the task budget in milliseconds. */
export const setCoordinatorBudgetsForTests = (stepDeadlineMs?: number, taskMaxMs?: number): void => {
  if (stepDeadlineMs !== undefined) STEP_DEADLINE_MS = Math.max(20, stepDeadlineMs);
  if (taskMaxMs !== undefined) (coordinatorTiming as { taskMaxMs?: number }).taskMaxMs = taskMaxMs;
};
const coordinatorTiming: { taskMaxMs?: number } = {};
const taskBudgetMs = (): number => coordinatorTiming.taskMaxMs ?? TASK_MAX_MS;

/** Why a driver was aborted — task_cancel (user) vs task_pause (user) vs the stall
 *  watchdog. The distinction decides the state: a user cancellation is CANCELLED; a pause
 *  is PAUSED (resumable, completed work preserved); a watchdog takeover must leave the
 *  task INTERRUPTED (honest and resumable), never CANCELLED. */
const cancelReasons = new Map<string, 'user' | 'stall' | 'paused'>();

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

// ------------------------------------------------------------------ events (Module L)

const taskEvent = (t: TaskRecord, label: string, detail: string, status: 'busy' | 'ok' | 'fail' = 'busy'): void => {
  emitActivity({ kind: 'task', cid: `task-${t.id}`, label: `${label} · ${t.id}`, detail: clip(detail, 200), status });
};

const verifyEvent = (t: TaskRecord, detail: string, status: 'busy' | 'ok' | 'fail'): void => {
  emitActivity({ kind: 'verify', cid: `verify-${t.id}`, label: `Verification · ${t.id}`, detail: clip(detail, 240), status });
};

// --------------------------------------------------------------------- cancellation

const controllers = new Map<string, AbortController>();

/** Unique per-drive ownership identity: the owner string IS the lease credential (F-18).
 *  A driver that lost its lease can neither renew it nor release its successor's claim,
 *  because the stored owner will no longer match this string. */
const newOwnerIdentity = (): string => `coordinator:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
/** Cancel a running coordinator task (the USER path). Finished steps stay recorded; the
 *  task reports how far it got. Watchdog takeovers do NOT go through this. */
export function cancelTask(id: string): boolean {
  const ctl = controllers.get(id);
  if (ctl) {
    cancelReasons.set(id, 'user');
    ctl.abort();
    return true;
  }
  return false;
}

/** Cancel every task this process is driving (the user said "stop"). Returns how many. */
export function cancelAllTasks(): number {
  let n = 0;
  for (const id of [...controllers.keys()]) if (cancelTask(id)) n++;
  return n;
}

/** Pause a running coordinator task (the USER path, Round 26 §6.4): the driver stops at
 *  the next boundary, mid-flight steps are reconciled honestly, completed work is
 *  preserved, and the task settles PAUSED — resumable with task_resume. */
export function pauseTask(id: string): boolean {
  const ctl = controllers.get(id);
  if (!ctl) return false;
  cancelReasons.set(id, 'paused');
  ctl.abort();
  return true;
}

// ----------------------------------------------------------------------- planning

/** A plan step as the planner emits it (Round 18 §5.1): a node in a dependency DAG. */
export interface PlanStep {
  title: string;
  detail: string;
  kind: AgentKind;
  /** Explicit dependencies. ABSENT = sequential (depends on the previous step); an
   *  EXPLICIT array (even []) is honored — that is how a planner declares steps
   *  independent and therefore parallel-eligible. */
  dependsOn?: string[];
  /** What the step must produce (injected into the step brief; verifier context). */
  expectedOutput?: string;
  /** Per-step retry budget (clamped to 3). */
  retryMax?: number;
  /** Round 26 Phase 3 (3.2): the step's own completion conditions (bounded). */
  acceptance?: string[];
  id?: string;
}

/** Round 25 §3: the delegation decision recorded on the task (HUD + status). */
export interface DelegationRecord {
  strategy: DelegationDecision['strategy'];
  kind?: AgentKind;
  reasons: string[];
  workstreams: string[];
  parallelizable: boolean;
  complexity: number;
  decidedAt: number;
}

const parsePlan = (text: string): PlanStep[] => {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]) as Array<Record<string, unknown>>;
    return (Array.isArray(v) ? v : [])
      .map((s) => ({
        title: String(s.title ?? '').trim().slice(0, 160),
        detail: String(s.detail ?? '').trim().slice(0, 4000),
        kind: AGENT_KINDS.includes(s.kind as AgentKind) ? (s.kind as AgentKind) : 'general',
        id: typeof s.id === 'string' && s.id.trim() ? s.id.trim().slice(0, 12) : undefined,
        dependsOn: Array.isArray(s.dependsOn) ? (s.dependsOn as unknown[]).map(String).slice(0, 6) : undefined,
        expectedOutput: typeof s.expectedOutput === 'string' && s.expectedOutput.trim() ? s.expectedOutput.trim().slice(0, 400) : undefined,
        acceptance: Array.isArray(s.acceptance) ? (s.acceptance as unknown[]).map((a) => String(a).slice(0, 200)).filter((a) => a.trim()).slice(0, 4) : undefined,
        retryMax: typeof s.retryMax === 'number' ? s.retryMax : undefined,
      }))
      .filter((s) => s.title)
      .slice(0, MAX_STEPS);
  } catch {
    return [];
  }
};

export function fallbackPlan(spec: TaskSpec): PlanStep[] {
  const steps: PlanStep[] = [];
  if (spec.capabilities.includes('research')) steps.push({ title: 'Gather the needed information', detail: `${spec.objective}\nResearch the facts this task needs and report them with sources.`, kind: 'research' });
  steps.push({ title: 'Do the work', detail: `${spec.objective}\n${spec.deliverables.length ? `Deliverables: ${spec.deliverables.join('; ')}.` : ''}${spec.constraints.length ? ` Constraints: ${spec.constraints.join('; ')}.` : ''}`, kind: spec.capabilities.includes('browser') ? 'browser' : 'general' });
  steps.push({ title: 'Verify the result', detail: `Check the deliverable against the acceptance criteria: ${spec.acceptance.map((a) => a.detail).join('; ') || 'the request was fulfilled'}. Report evidence, not intentions.`, kind: 'verifier' });
  return steps;
}

/** Model-driven plan with the deterministic floor. Exported for tests (inject the planner).
 *  Round 25 §3: `hints` carries the delegation strategy's workstream guidance so the
 *  planner marks genuinely independent streams parallel-eligible instead of guessing. */
export async function planTask(spec: TaskSpec, planner?: (spec: TaskSpec) => Promise<PlanStep[]>, hints?: string[], modelOverride?: string): Promise<PlanStep[]> {
  if (planner) return planner(spec);
  // Round 26 Phase 1 (1.4): the planner receives ONLY the profile sections relevant to
  // this request — bounded, task-aware, never the whole profile. No profile → no block;
  // a profile failure must never break planning.
  // ROUND 31 (§2.5): the planning read REFRESHES stale sections first (incremental —
  // only sections whose watched files changed are re-inspected), so a plan is never
  // built from project facts that the workspace has already outgrown. Presenting stale
  // project information as current fact is exactly what this prevents.
  const profileCtx = await refreshProjectProfile(FILES_ROOT)
    .then(({ profile }) => relevantProfileContext(profile, `${spec.request} ${spec.objective}`))
    .catch(() => '');
  // Round 26 Phase 2 (2.5): bounded, task-specific memory context — episodic lessons from
  // similar past work + relevant project memory. Empty when nothing is relevant.
  const memoryCtx = await buildTaskMemoryContext(`${spec.request} ${spec.objective}`, FILES_ROOT).catch(() => '');
  // ROUND 31 (§4.1): deterministic tool-selection guidance for THIS task — the planner
  // sees which tools/specialists fit the objective (and their verification duties), so
  // tool choice reflects capability and cost, not name matching.
  const toolHints = recommendToolsFor(spec);
  // ROUND 32 (§5.4): the VERIFIED DELIVERY chain — for substantial development work the
  // planner must order the work so conventions are read first, impact is analyzed before
  // edits, the project's OWN validation commands are used, and deliverables are verified
  // independently. The model cannot invent test suites or scripts that do not exist.
  const deliveryChain = spec.complexity === 'development' || spec.complexity === 'integration' || spec.complexity === 'long_running'
    ? 'VERIFIED DELIVERY CHAIN (order the steps to follow it): UNDERSTAND PROJECT → INSPECT ARCHITECTURE (read the conventions) → ANALYZE IMPACT (analyze_impact before significant code changes) → PLAN → IMPLEMENT (inside the project workspace) → VALIDATE (the project\'s OWN existing build/typecheck/test commands — never invent test suites or scripts) → REVIEW (check modified files for unnecessary changes) → VERIFY DELIVERABLES (confirm each requested output exists independently) → UPDATE STATE (milestones only from actual verified results). A successful build alone does not prove the requested product behavior exists.'
    : '';
  const model = modelOverride || await getModel().catch(() => '');
  if (!model) return fallbackPlan(spec);
  try {
    const r = await completeOnce(
      model,
      [
        {
          role: 'system',
          content:
            `You break one task into ${MAX_STEPS} or fewer sub-agent steps arranged as a DEPENDENCY GRAPH. Reply with ONLY a JSON array, each item {"id": "s1"-style unique id, "title": short imperative, "detail": complete self-contained instructions, "kind": "explore"|"research"|"general"|"document"|"browser"|"verifier"|"desktop"|"data"|"coder"|"reviewer"|"tester"|"planner", "dependsOn": [ids that MUST be fully done before this step starts], "expectedOutput": one line describing the concrete artifact or answer this step produces}. Use "desktop" to drive real applications (OCR/UIA) and "data" for compute-and-verify analysis. "coder" implements code changes; "reviewer" independently reviews a change (read-only); "tester" runs or designs tests; "planner" decomposes complex objectives. ` +
            'DEPENDENCY RULES: a step that needs another step\'s output MUST list it in dependsOn. Steps with NO unmet dependency may run in PARALLEL (up to 2 at a time) — so mark independent steps with an EXPLICIT empty dependsOn: [] and do NOT chain them artificially. If you omit dependsOn entirely the step is treated as sequential (it runs after the previous step). ' +
            'The FIRST step may explore what exists. The LAST step must have kind "verifier" and check the acceptance criteria. Use "document" only for DOCX/PDF/PPTX/XLSX production.',
        },
        {
          role: 'user',
          content: `${specPrompt(spec)}${profileCtx ? `\n\n${profileCtx}` : ''}${memoryCtx ? `\n\n${memoryCtx}` : ''}${toolHints.length ? `\n\nTOOL SELECTION GUIDANCE (from the capability registry — follow unless the task clearly calls for something else): ${toolHints.join('; ')}` : ''}${deliveryChain ? `\n\n${deliveryChain}` : ''}${hints?.length ? `\n\nDELEGATION ANALYSIS (from the coordinator): ${hints.join('; ')}` : ''}\n\nORIGINAL REQUEST: ${spec.request}`,
        },
      ],
      []
    );
    const planned = parsePlan(r.content);
    if (!planned.length) return fallbackPlan(spec);
    if (planned[planned.length - 1].kind !== 'verifier') planned.push(fallbackPlan(spec)[fallbackPlan(spec).length - 1]);
    return planned;
  } catch {
    return fallbackPlan(spec);
  }
}

// --------------------------------------------------------------------- step execution

/**
 * CONTROLLED CONTEXT PASSING (Round 25 §5) + Round 25.1 FIX #2 — verification PROVENANCE.
 * A step receives the results of the steps it explicitly depends on — nothing else. The
 * context is EXPLICIT (named per upstream step), TRACEABLE (it comes from the persisted
 * step results, never from free-form agent chatter), SCOPED (only dependsOn results,
 * clipped) and read-only. Agents never see each other's full transcripts, working state,
 * or unrelated steps' results.
 *
 * Round 25.1: each injected result now carries its VERIFICATION PROVENANCE from the
 * persisted per-step verification record (Round 20 CHANGE 5): VERIFIED results name the
 * verification method and evidence; anything else is explicitly marked UNVERIFIED /
 * FAILED / PARTIALLY VERIFIED — an upstream claim is never silently presented as
 * established fact, and the downstream agent is instructed to re-verify before relying
 * on it. No evidence is invented here: missing records read as unverified, failed or
 * skipped upstream work is never presented as a success, and the existing clipping and
 * size limits are preserved.
 */
export const upstreamResultsBlock = (t: TaskRecord, step: TaskStep): string => {
  const deps = step.dependsOn.map((id) => t.steps.find((s) => s.id === id)).filter((s): s is TaskStep => !!s && (s.status === 'done' || s.status === 'skipped') && !!s.result.trim());
  if (!deps.length) return '';
  const provenanceOf = (d: TaskStep): string => {
    if (d.status === 'skipped') return 'UPSTREAM STATUS: UNVERIFIED — SKIPPED (this step never ran; nothing in its text is evidence)';
    // Round 26 Phase 3: a record only counts when it verifies the step's CURRENT result —
    // a retried/changed output invalidates the old record (stale verification guard).
    const v = validVerification(d);
    if (!v) return 'UPSTREAM STATUS: UNVERIFIED — no verification record valid for this exact result (missing, stale, or superseded); treat its claims as unverified information, not established facts';
    if (v.status === 'verified') return `UPSTREAM STATUS: VERIFIED (${clip(v.method, 140)}${v.evidence.trim() ? `; evidence: ${clip(v.evidence, 200)}` : ''})`;
    if (v.status === 'failed') return `UPSTREAM STATUS: FAILED — verification did NOT pass (evidence: ${clip(v.evidence, 200)}); do not treat this result as a success`;
    if (v.status === 'unknown' || v.status === 'unresolved') return `UPSTREAM STATUS: UNVERIFIED — the outcome could not be confirmed (${clip(v.observed, 160)}); treat its claims as unverified information and re-check anything you build on it`;
    if (v.status === 'unverified') return `UPSTREAM STATUS: UNVERIFIED — the step's claims were not substantiated by independent evidence (${clip(v.observed, 160)}); re-check anything you build on it`;
    if (v.status === 'partial') return `UPSTREAM STATUS: PARTIALLY VERIFIED — some requirements have evidence, others do not (evidence: ${clip(v.evidence, 200)}); the unconfirmed parts are unverified information`;
    return `UPSTREAM STATUS: PARTIALLY VERIFIED (stage: ${v.status}; evidence: ${clip(v.evidence, 200)}) — the unconfirmed parts are unverified information`;
  };
  const lines = deps.map((d) => `RESULT OF "${d.title}" [${d.kind}] (${provenanceOf(d)}): ${clip(d.result.replace(/\s+/g, ' '), 900)}`);
  return [
    `UPSTREAM RESULTS (outputs of the steps this step depends on — use them, do not redo that work). ONLY results marked VERIFIED were checked by the engine; UNVERIFIED, FAILED or PARTIALLY VERIFIED results are claims, not established facts — re-verify anything you rely on:`,
    ...lines,
  ].join('\n');
};

const stepPrompt = (t: TaskRecord, step: { title: string; detail: string; outcomeUnknown?: boolean; expectedOutput?: string; acceptance?: string[] }, outcomeUnknownHint?: boolean, upstream?: string): string =>
  [
    `TASK: ${t.spec.objective}`,
    t.spec.request !== t.spec.objective ? `ORIGINAL REQUEST: ${clip(t.spec.request, 600)}` : '',
    `YOUR STEP: ${step.title}`,
    `STEP INSTRUCTIONS: ${step.detail}`,
    step.expectedOutput ? `EXPECTED OUTPUT: ${step.expectedOutput}` : '',
    step.acceptance?.length ? `COMPLETION CONDITIONS (this step is NOT done until these hold and you can show evidence):\n${step.acceptance.map((a) => `- ${a}`).join('\n')}` : '',
    upstream ? upstream : '',
    t.spec.constraints.length ? `CONSTRAINTS: ${t.spec.constraints.join('; ')}` : '',
    // F-20/idempotency: a step whose previous attempt was interrupted may have already
    // changed the world. The rerun must LOOK before it acts.
    outcomeUnknownHint || step.outcomeUnknown
      ? 'IMPORTANT: a previous attempt at this step was interrupted and its outcome is UNKNOWN. Some side effects may already have happened. First inspect the actual state with read-only tools (read, glob, list, task_status of files), reconcile what you find, and repeat ONLY the parts that verifiably did not happen.'
      : '',
    `You are one step of a coordinated task (${t.id}) whose plan is a dependency graph: steps that depend on yours run AFTER you, and up to ${MAX_PARALLEL_STEPS} independent steps may run at the same time — so only touch files and resources this step owns. Finish your step completely, verify your own work with tools, then write your FINAL REPORT.`,
    'Report format: "DONE:" what was produced (exact paths or facts); "VERIFIED:" how you checked it; "ISSUES:" anything left. If you could not complete the step, start the report with "FAILED:" and say exactly why.',
  ]
    .filter(Boolean)
    .join('\n\n');

export const stepReportFailed = (report: string): boolean => /^(FAILED:|PARTIAL:|Tool error|BLOCKED|Sub-agent failed)/.test(report.trim());

/**
 * ROUND 31 (§1.3) — DISCOVERY-DRIVEN PLAN ADAPTATION. A step agent that learns something
 * that changes the premise of the REMAINING work reports it on a "DISCOVERY:" line. The
 * coordinator (never the agent) decides what to do with it: the discovery is recorded as
 * a visible task event and injected into every not-yet-run step whose premise may have
 * changed, with an explicit reassessment instruction — the plan adapts to new information
 * instead of blindly continuing. Pure; exported for tests.
 */
export function parseDiscoveries(report: string): string[] {
  const out: string[] = [];
  for (const m of report.matchAll(/^\s*DISCOVERY:\s*(.{10,300})$/gim)) {
    const d = (m[1] ?? '').replace(/\s+/g, ' ').trim();
    if (d && !out.includes(d)) out.push(d);
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * Propagate discoveries to pending steps: only steps that have NOT started receive the
 * note, and it is advisory (reassess and say so) rather than an order to redo work —
 * structural plan changes still go through the bounded replan machinery.
 */
async function propagateDiscoveries(t: TaskRecord, discoveries: string[]): Promise<void> {
  if (!discoveries.length) return;
  const pending = t.steps.filter((s) => s.status === 'pending');
  if (!pending.length) return;
  const note = `DISCOVERED (from an earlier step's report): ${discoveries.join(' | ')} — reassess whether this step's premise still holds before acting; if the discovery changed what SHOULD happen, say so explicitly in your report instead of executing an outdated premise.`;
  for (const s of pending.slice(0, 4)) {
    await appendStepDetail(t, s.id, note);
  }
  taskEvent(t, 'Plan input updated', `${discoveries.length} discovery(ies) from finished steps were passed to ${Math.min(4, pending.length)} pending step(s) for reassessment`, 'busy');
}

// ------------------------------------------------------------------- the driver loop

/** Max subtask proposals honored per step — delegation stays bounded (§6.3). */
const MAX_SUBTASKS_PER_STEP = 2;

interface SubtaskProposal {
  name: string;
  purpose: string;
  instructions: string;
  tools: string[];
}

/**
 * Parse "SUBTASK: {json}" proposal lines from a step report. Invalid or incomplete
 * proposals are skipped; at most MAX_SUBTASKS_PER_STEP are honored. The step agent can
 * only PROPOSE — registration and execution are the coordinator's decision.
 */
export function parseSubtaskProposals(report: string): SubtaskProposal[] {
  // Round 19 (CHANGE 4, delegation depth): proposals are honored ONLY from the step
  // agent's own report. The coordinator-appended "SUBTASK RESULTS" block (which quotes
  // subtask output and may itself contain proposal-shaped lines) is EXCLUDED, so a
  // delegated agent can never inject another delegation through its quoted results.
  const ownReport = report.split(/\n\s*SUBTASK RESULTS \(coordinator-mediated\):/)[0] ?? report;
  const out: SubtaskProposal[] = [];
  for (const m of ownReport.matchAll(/^\s*SUBTASK:\s*(\{.*)$/gim)) {
    if (out.length >= MAX_SUBTASKS_PER_STEP) break;
    try {
      // The JSON object may run to end of line; salvage the first balanced object.
      const raw = m[1];
      const end = raw.indexOf('}');
      if (end < 0) continue;
      const v = JSON.parse(raw.slice(0, end + 1)) as Record<string, unknown>;
      const name = String(v.name ?? '').trim();
      const instructions = String(v.instructions ?? '').trim();
      if (!name || !instructions) continue;
      out.push({
        name: name.slice(0, 32),
        purpose: String(v.purpose ?? 'Bounded subtask proposed by the step.').slice(0, 200),
        instructions: instructions.slice(0, 4000),
        tools: Array.isArray(v.tools) ? (v.tools as unknown[]).map(String).slice(0, 12) : ['read', 'list_files', 'glob', 'grep'],
      });
    } catch {
      // a malformed proposal is skipped — delegation must never break the step
    }
  }
  return out;
}

/**
 * DELEGATION DEPTH (Round 19, CHANGE 4): exactly one level of hierarchical delegation is
 * honored. A step agent may PROPOSE subtasks; the coordinator registers and runs them;
 * the subtask results are appended to the step report AFTER proposal parsing, so a
 * subtask's own "SUBTASK:" lines are never honored — deeper help goes through the
 * coordinator again (a new step/plan), never through recursive agent creation.
 */
export const DELEGATION_DEPTH = 1;

/** File extensions that mark a token as a claimed deliverable path. */
const DELIVERABLE_EXT = /(?:[\w.@-]+\/)*[\w.@-]+\.(?:txt|md|json|csv|xlsx?|docx?|pdf|pptx|html?|log)\b/gi;

/**
 * The file deliverables CLAIMED by a step report (Round 26 Phase 3). The report's own
 * DELIVERABLE CHECK block (appended by the coordinator) is excluded so already-refuted
 * paths are not counted as fresh claims. Claimed ≠ verified — evaluateStepEvidence
 * re-inspects these on disk before any VERIFIED status exists.
 */
export const claimedDeliverables = (report: string): string[] =>
  [...new Set(((report.split(/\n\s*\[DELIVERABLE CHECK:/)[0] ?? report).match(DELIVERABLE_EXT) ?? []).map((t) => t.trim()))].slice(0, 6);

/**
 * §6.4: verify a DONE report's claimed file deliverables against the disk (workspace-
 * relative paths resolve against FILES_ROOT). Returns the report unchanged when every
 * claim checks out (or nothing was claimed); otherwise appends an explicit DELIVERABLE
 * CHECK block naming what was not found — honest evidence, never a silent pass.
 */
export async function checkStepDeliverables(report: string): Promise<string> {
  if (!/^DONE:/im.test(report.trim())) return report;
  const claimed = [...new Set((report.match(DELIVERABLE_EXT) ?? []).map((t) => t.trim()))].slice(0, 6);
  if (!claimed.length) return report;
  const missing: string[] = [];
  for (const tok of claimed) {
    const p = path.isAbsolute(tok) ? tok : path.join(process.env.JARVIS_FILES_ROOT ?? '.', tok);
    try {
      const st = await fs.stat(p);
      if (!st.isFile()) missing.push(tok);
    } catch {
      missing.push(tok);
    }
  }
  if (!missing.length) return report;
  return `${report}\n\n[DELIVERABLE CHECK: ${claimed.length - missing.length}/${claimed.length} claimed file(s) verified on disk — NOT FOUND: ${missing.join(', ')}. The claim is unsupported until the files exist.]`;
}

/**
 * SUBTASK RESULT RECONCILIATION (Round 19, CHANGE 4 requirement 6): when several agents
 * worked on one step, their results may CONTRADICT each other — one reports a file
 * produced, another reports it missing. The coordinator does not guess: it checks the
 * claimed paths against the DISK and appends an authoritative verdict. Returns '' when
 * nothing conflicted.
 */
export async function reconcileSubtaskResults(results: string[]): Promise<string> {
  const claims = new Map<string, { saidProduced: boolean; saidMissing: boolean }>();
  for (const r of results) {
    const produced = /created|written|saved|exists|DONE/i.test(r);
    const missing = /does not exist|not found|no such|missing|NOT DONE|REFUSED\/FAILED|FAILED:/i.test(r);
    for (const raw of [...new Set((r.match(DELIVERABLE_EXT) ?? []).map((t) => t.trim()))].slice(0, 6)) {
      const rec = claims.get(raw) ?? { saidProduced: false, saidMissing: false };
      rec.saidProduced ||= produced;
      rec.saidMissing ||= missing;
      claims.set(raw, rec);
    }
  }
  const verdicts: string[] = [];
  for (const [p, c] of claims) {
    if (!c.saidProduced || !c.saidMissing) continue;
    const full = path.isAbsolute(p) ? p : path.join(process.env.JARVIS_FILES_ROOT ?? '.', p);
    const exists = await fs.stat(full).then((st) => st.isFile(), () => false);
    verdicts.push(`${p}: agents DISAGREED (one reported it produced, another reported it missing). Ground truth from disk: the file ${exists ? 'EXISTS' : 'does NOT exist'}.`);
  }
  return verdicts.length
    ? `\n\n[COORDINATOR RECONCILIATION — contradictory agent results were verified against disk:\n${verdicts.join('\n')}]`
    : '';
}

/**
 * Run ONE step to a settled done/failed status: bounded retries with the error context,
 * a heartbeat while it runs, and the Round 18 §4.4 reconciliation settlement for any
 * unknown-outcome executions this rerun just re-inspected. Failure-isolated: throws
 * only for task-level cancellation/lease loss; a step error becomes a FAILED report.
 */
async function runOneStep(t: TaskRecord, step: TaskStep, deps: CoordinatorDeps, signal: AbortSignal, _lease: Lease): Promise<void> {
  const kind = (step.kind as AgentKind) ?? 'general';
  const def = agentDefFor(kind);
  // Round 25 §9: ONE correlation id for the whole step's agent run — the tracker row,
  // the activity feed and the durable ledger all name the same execution.
  const runId = `step:${t.id}:${step.id}`;
  // Round 25 §9: the coordinator records the assignment ITSELF (which agent, why) so the
  // agent row exists from the moment the step starts — even when a test/alternative
  // runner replaces the executor. The real executor re-begins the SAME id (one row).
  const why = `step "${step.title}" (${kind}) of task ${t.id}${t.delegation ? ` — delegated: ${t.delegation.strategy}` : ''}`;
  agentBegin({ id: runId, agent: def.name, kind, taskId: t.id, stepId: step.id, why });
  // Round 25 §5: scoped upstream context — ONLY the persisted results of this step's
  // own dependencies, clipped, read-only. Never another agent's transcript.
  const upstream = upstreamResultsBlock(t, step);
  const retryBudget = Math.min(3, Math.max(0, step.retryMax ?? STEP_RETRY));
  // Round 20 (CHANGE 4): a per-step wall-clock deadline, independent of the heartbeat.
  // The STEP signal (task signal + deadline) is what the RUNNER sees — a deadline abort
  // makes the sub-agent wrap up honestly instead of running forever — while the task
  // signal alone still governs the cancellation checks below (a step deadline is a
  // FAILED step, never a CANCELLED task).
  const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(STEP_DEADLINE_MS)]);
  let deadlineHit = false;
  const onDeadline = (): void => {
    deadlineHit = true;
  };
  stepSignal.addEventListener('abort', onDeadline, { once: true });
  const runOnce = async (prompt: string, isRetry: boolean): Promise<string> => {
    const report = deps.stepRunner
      ? // ROUND 28 (durable receipts): a stepRunner-driven step runs under the SAME call
        // context as the sub-agent path, so its tool calls are attributed to this task in
        // the execution ledger — verification and evidence projections see them.
        await runWithCallContext({ agent: `step:${step.id}`, taskId: t.id, stepId: step.id }, () => deps.stepRunner!(prompt, kind, t, step.id, stepSignal))
      : await runSubagent(prompt, deps.schemas(kind), deps.run, {
          agent: def.name,
          signal: stepSignal,
          taskId: t.id,
          stepId: step.id,
          runId,
          model: t.model,
          why: `step "${step.title}" (${kind}) of task ${t.id}${t.delegation ? ` — delegated: ${t.delegation.strategy}` : ''}`,
        });
    return clip(String(report ?? '').trim() || (isRetry ? 'FAILED: empty retry report.' : 'FAILED: empty report.'), 4000);
  };
  let report = '';
  const settleCancelled = (): never => {
    agentEnd(runId, 'cancelled', 'task cancelled while the step was mid-flight; outcome unknown');
    throw new Error('cancelled');
  };
  try {
    report = await runOnce(stepPrompt(t, step, step.outcomeUnknown, upstream), false);
  } catch (e) {
    if (signal.aborted) settleCancelled();
    agentEnd(runId, 'failed', clip(String(e instanceof Error ? e.message : e), 160));
    report = `FAILED: ${e instanceof Error ? e.message : String(e)}`;
  }
  // Round 18 §14 D: a step that finishes AFTER its driver lost the window (watchdog
  // takeover / cancellation) must NOT settle a status — its outcome is unknown by
  // definition, and the interruption reconciliation owns it.
  if (signal.aborted) settleCancelled();
  for (let retry = 0; stepReportFailed(report) && retry < retryBudget && !signal.aborted; retry++) {
    await transition(t, 'RETRYING', `step "${step.title}" failed; retrying (${retry + 1}/${retryBudget})`).catch(() => undefined);
    try {
      report = await runOnce(`${stepPrompt(t, step, undefined, upstream)}\n\nYour previous attempt failed with:\n${clip(report, 1200)}\nUnderstand why, then do the step a different, correct way.`, true);
    } catch (e) {
      if (signal.aborted) settleCancelled();
      agentEnd(runId, 'failed', clip(String(e instanceof Error ? e.message : e), 160));
      report = `FAILED: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  if (deadlineHit && !signal.aborted && stepReportFailed(report)) {
    report = `FAILED: the step exceeded its ${Math.round(STEP_DEADLINE_MS / 1000)}s execution deadline and was stopped honestly. Partial progress: ${report}`;
  }
  const failed = stepReportFailed(report);
  // Round 18 §6.4 — RESULT QUALITY: a DONE report that claims file deliverables gets its
  // claims checked against the disk. If EVERY claimed path is missing (a likely
  // fabrication), the step retries ONCE with the evidence; a still-unsupported claim
  // stays in the result, flagged, rather than passing silently.
  if (!failed) {
    const flagged = await checkStepDeliverables(report);
    if (flagged !== report) {
      const retryReport = await runOnce(`${stepPrompt(t, step)}\n\nYour report claimed deliverables that are NOT on disk:\n${clip(flagged.slice(report.length), 600)}\nRe-check with read-only tools and either produce the missing files or correct your report.`, true).catch(() => flagged);
      const reflagged = await checkStepDeliverables(retryReport);
      report = reflagged; // whatever it is now, the flag travels with the result
    }
  }
  // Round 18 §6.3 — COORDINATOR-MEDIATED HIERARCHICAL DELEGATION: a step agent may
  // PROPOSE subtasks in its report ("SUBTASK: {...}" lines). The PROPOSAL is all the
  // agent can do: the coordinator validates, registers the dynamic specialist in the ONE
  // registry, runs it under the SAME task signal and receipts, and appends the findings.
  // Agents never spawn agents (spawn_agent stays SUBAGENT_DENIED for children) and the
  // dynamic-agent cap still bounds the roster.
  if (!failed && !signal.aborted) {
    const proposals = parseSubtaskProposals(report);
    if (proposals.length) {
      const results: string[] = [];
      for (const st of proposals) {
        try {
          const def = registerDynamicAgent({ name: st.name, purpose: st.purpose, tools: st.tools }, `step:${t.id}:${step.id}`);
          noteDynamicRun(def.name);
          const toolsForChild = deps.schemas('general').filter((schema) => agentAllows(def, schema.function.name));
          const out = deps.subtaskRunner
            ? await deps.subtaskRunner(def.name, st.instructions, signal)
            : await runSubagent(st.instructions, toolsForChild, deps.run, { agent: def.name, signal, taskId: t.id, stepId: step.id, runId: `subtask:${t.id}:${step.id}:${def.name}`, why: `subtask proposed by step "${step.title}": ${clip(st.purpose, 100)}` });
          results.push(`SUBTASK ${def.name} (${clip(st.purpose, 120)}) →\n${clip(String(out ?? '').trim() || '(no report)', 1200)}`);
        } catch (e) {
          results.push(`SUBTASK ${st.name} REFUSED/FAILED: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (results.length) {
        // Round 19 (CHANGE 4): combined results are validated — contradictory claims
        // about the same deliverable are resolved against the disk, never averaged.
        const reconciliation = await reconcileSubtaskResults(results);
        report = `${report}\n\nSUBTASK RESULTS (coordinator-mediated):\n${results.join('\n\n')}${reconciliation}`;
        // Round 19 (CHANGE 4 requirement 7): a FAILED delegation must not silently
        // complete the step. A report that still claims DONE while a delegated agent
        // failed is downgraded to PARTIAL — an honest failure the scheduler acts on —
        // with the full report text preserved for the retry/replan path.
        const delegationFailed = results.some((r) => /REFUSED\/FAILED/.test(r));
        if (delegationFailed && /^DONE:/i.test(report.trim())) {
          report = `PARTIAL: a delegated subtask did not complete; the step's own claims below are unverified for that part.\n${report}`;
        }
      }
    }
  }
  const failedFinal = stepReportFailed(report);
  await markStep(t, step.id, { status: failedFinal ? 'failed' : 'done', result: report });
  // Round 25 §9: the coordinator's classification is authoritative for the tracker row.
  agentEnd(runId, failedFinal ? 'failed' : 'done', clip(report, 160));
  // Round 20 (CHANGE 5) + Round 26 Phase 3 (3.6): the per-step EVIDENCE record — intended
  // vs performed vs claimed vs observed vs method vs evidence vs final status — now derived
  // by evaluateStepEvidence from the durable ledger and a fresh disk re-inspection of the
  // report's claimed deliverables. THE RULE: the agent's assertion of completion is NOT
  // evidence of completion. A DONE report with no supporting evidence stays UNVERIFIED;
  // partial evidence is PARTIAL; unresolved receipts stay UNKNOWN; only real evidence
  // (deliverables on disk, a recorded successful check command, fetched sources) verifies.
  const unresolvedNow = await unresolvedExecutionsFor(t.id, step.id, t.createdAt).catch(() => []);
  const stepLedger = (await recordsForTask(t.id, t.createdAt).catch(() => [])).filter((r) => r.stepId === step.id);
  const claimedPaths = claimedDeliverables(report);
  const missingPaths: string[] = [];
  let verifiedPaths = 0;
  for (const tok of claimedPaths) {
    // Deliverable-claim resolution: a workspace-relative claim resolves against FILES_ROOT;
    // a claim that CLIPPED an absolute workspace path ('tmp/jarvis…/out/x.md') is
    // reconstructed only when the result stays inside the workspace (never stat arbitrary
    // paths just because report text contained them).
    const rel = path.join(FILES_ROOT, tok);
    const clippedAbs = path.resolve(path.sep, tok);
    const candidates = isInsideRoot(clippedAbs) ? [rel, clippedAbs] : [rel];
    let ok = false;
    for (const p of candidates) {
      ok = await fs.stat(p).then((st) => st.isFile(), () => false);
      if (ok) break;
    }
    if (ok) verifiedPaths++;
    else missingPaths.push(tok);
  }
  const evidenceEval = evaluateStepEvidence({
    report,
    failed: failedFinal,
    unresolved: unresolvedNow,
    ledger: stepLedger,
    claimedPaths,
    verifiedPaths,
    missingPaths,
  });
  // ROUND 35 (Phase 2/3): the same facts update the task's DELIVERABLE records — a
  // produced artifact is recorded as produced, a disk-verified one as verified WITH the
  // write receipts as evidence, a missing claimed artifact as unverified. The agent's
  // report alone never verifies anything here.
  await noteDeliverableProgress(t, step, report, {
    claimedPaths,
    verifiedPaths,
    missingPaths,
    ledger: stepLedger,
    stepFailed: failedFinal,
  }).catch(() => undefined);
  const verification: StepVerification = {
    checkedAt: Date.now(),
    intended: clip(step.expectedOutput ?? step.title, 300),
    action: stepLedger.length
      ? `${stepLedger.length} execution(s): ${[...new Set(stepLedger.map((r) => `${r.tool}→${r.status}`))].slice(0, 8).join(', ')}`
      : 'no tool executions recorded for this step',
    toolResult: clip(report, 600),
    observed: evidenceEval.observed,
    method: evidenceEval.method,
    evidence: clip(evidenceEval.evidence, 600),
    status: evidenceEval.status,
  };
  await setStepVerification(t, step.id, verification).catch(() => undefined);
  // Round 18 §4.4: this run just RE-INSPECTED the world for every execution whose
  // outcome was unknown (the outcomeUnknown brief / RECONCILE FIRST guidance). Settle
  // each lingering receipt with what the run observed — an unknown outcome never stays
  // unresolved after a real look, and recovery never treats it as a blank check.
  const unresolved = await unresolvedExecutionsFor(t.id, step.id, t.createdAt).catch(() => []);
  for (const rec of unresolved) {
    await recordReconciled(
      rec.id,
      { tool: rec.tool, agent: 'coordinator', taskId: t.id, stepId: step.id },
      `step "${step.title}" ran and ${failedFinal ? 'FAILED after inspecting the actual state' : 'verified the actual state'}; the outcome is accounted for by the run report`
    );
  }
  // ROUND 35 (Phase 5): this run just re-inspected the actual world for every
  // unknown-outcome execution and settled its receipts (Round 18 §4.4 machinery) — the
  // step's own uncertainty marker is reconciled WITH them, so the completion gate reads
  // current truth instead of a stale "outcome unknown" left over from a previous
  // interruption. A fresh interruption re-sets the flag through the existing machinery.
  if (step.outcomeUnknown) {
    step.outcomeUnknown = false;
    await persistTask(t);
  }
  taskEvent(t, failedFinal ? 'Step failed' : 'Step done', `${step.title} — ${clip(report, 120)}`, failedFinal ? 'fail' : 'ok');
}

/**
 * ADAPTIVE REPLAN (§5.5): after failures blocked the remaining work, build a NEW plan
 * version from what actually happened. Completed steps are preserved verbatim
 * (replanSteps matches by title); the replanner sees the full history. Requires an
 * injected replanner (tests) or a live model — without either, the honest bounded
 * failure stands (blind retry adds nothing).
 */
async function replanAfterFailure(t: TaskRecord, deps: CoordinatorDeps, signal: AbortSignal, failed: TaskStep[]): Promise<boolean> {
  if (t.replans >= REPLAN_BUDGET) return false;
  const context = [
    `OBJECTIVE: ${t.spec.objective}`,
    `ORIGINAL REQUEST: ${clip(t.spec.request, 500)}`,
    `COMPLETED STEPS (their results are preserved and must NOT be redone):\n${t.steps.filter((s) => s.status === 'done' || s.status === 'skipped').map((s) => `- ${s.title}: ${clip(s.result, 300)}`).join('\n') || '(none)'}`,
    `FAILED STEPS:\n${failed.map((s) => `- ${s.title}: ${clip(s.result, 400)}`).join('\n')}`,
    `BLOCKED STEPS (dependent on the failures):\n${stepsBlockedByFailure(t).map((s) => `- ${s.title}: ${clip(s.detail, 200)}`).join('\n') || '(none)'}`,
  ].join('\n\n');
  let plan: PlanStep[] | null = null;
  if (deps.replanner) {
    plan = await deps.replanner(t, failed).catch(() => null);
  } else {
    const model = t.model || await getModel().catch(() => '');
    if (!model) return false;
    try {
      const r = await completeOnce(
        model,
        [
          {
            role: 'system',
            content:
              'You replan a partially completed task whose current strategy failed. Produce a NEW plan for the REMAINING work only. NEVER include a step redoing completed work. Understand WHY the failed steps failed and choose a different, correct strategy. Reply with ONLY a JSON array of steps, each {"title", "detail", "kind": "explore"|"research"|"general"|"document"|"browser"|"verifier"|"desktop"|"data"|"coder"|"reviewer"|"tester"|"planner", "dependsOn": [ids] (explicit [] for steps that can run in parallel), "expectedOutput"}. The last step must verify the acceptance criteria.',
          },
          { role: 'user', content: context },
        ],
        [],
        signal
      );
      plan = parsePlan(r.content);
      if (plan && !plan.length) plan = null;
    } catch {
      plan = null;
    }
  }
  if (!plan || !plan.length) return false;
  // Round 20 (CHANGE 4): IDENTICAL-PLAN GUARD. A replanner that returns essentially the
  // same remaining work has not changed strategy — burning the replan budget on it would
  // just repeat the failure. The remaining (pending/failed) titles are compared as a
  // normalized set: identical ⇒ the replan is refused and the honest bounded failure
  // stands, without consuming the budget.
  const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const remaining = new Set(t.steps.filter((s) => s.status === 'pending' || s.status === 'failed').map((s) => norm(s.title)));
  const proposed = plan.map((s) => norm(s.title));
  if (remaining.size > 0 && proposed.length === remaining.size && proposed.every((p) => remaining.has(p))) {
    taskEvent(t, 'Replan refused', 'the replanner returned the same remaining steps — no new strategy to try', 'fail');
    return false;
  }
  await replanSteps(t, plan);
  taskEvent(t, `Plan revised (v${t.planVersion})`, t.planHistory[t.planHistory.length - 1]?.summary ?? '', 'busy');
  return true;
}

/**
 * WRITE-SAFE WAVE CONSTRUCTION (Round 25.1 FIX #1): the read-only / write-capable
 * distinction is ENFORCED here, at scheduling time — never left to agent descriptions
 * or prompts. Classification comes from the registry's structural action ceiling
 * (`isReadOnlyKind` reads `maxActions`, the same ceiling the permission service
 * enforces), so a registry change automatically changes scheduling safety.
 *
 * Rules when forming a wave from the eligible steps (plan order, FIFO — no reordering):
 *  - read-only steps may share a wave (bounded by MAX_PARALLEL_STEPS) when their
 *    dependencies and the other safety conditions permit;
 *  - a write-capable step NEVER shares a wave with anything: every step works in the
 *    ONE shared workspace, so a concurrent step could observe a half-written state and
 *    two writers could clobber each other — the writer runs alone;
 *  - a wave that has started collecting read-only steps stops at the first
 *    write-capable step; that writer leads the NEXT wave.
 *
 * Dependency ordering, cancellation, timeouts, the global concurrency gate and the
 * parallelism limit are untouched: this only constrains WHICH eligible steps may share
 * a wave. Exported for focused regression tests.
 */
export const writeSafeWave = (eligible: TaskStep[]): TaskStep[] => {
  if (!eligible.length) return [];
  const [first, ...rest] = eligible;
  if (!isReadOnlyKind((first.kind as AgentKind) ?? 'general')) return [first]; // write-capable: solo wave
  const wave = [first];
  for (const step of rest) {
    if (wave.length >= MAX_PARALLEL_STEPS) break;
    if (!isReadOnlyKind((step.kind as AgentKind) ?? 'general')) break; // a writer never joins readers
    wave.push(step);
  }
  return wave;
};

/**
 * THE WAVE SCHEDULER (Round 18 §5.2–§5.5): dependency-aware execution over the plan DAG.
 * Each iteration claims the lease, takes EVERY currently-eligible step (bounded by
 * MAX_PARALLEL_STEPS and, since Round 25.1, by write-safety — see writeSafeWave), runs
 * them concurrently with failure isolation, and repeats.
 * A failed step blocks only its dependent branch — unrelated branches still run.
 * When failures block the rest, one bounded adaptive replan may rebuild the remaining
 * plan (preserving completed work) before the task is failed honestly.
 */
async function driveSteps(t: TaskRecord, deps: CoordinatorDeps, signal: AbortSignal, lease: Lease): Promise<boolean> {
  for (let guard = 0; guard < t.steps.length * 3 + 4; guard++) {
    if (signal.aborted) throw new Error('cancelled');
    // Round 20 (CHANGE 4): a whole-task wall-clock budget the heartbeat cannot renew away.
    // A looping/planing task fails explicitly instead of running indefinitely; the budget
    // is generous (1 h) so legitimate complex work is never cut off arbitrarily.
    if (Date.now() - t.createdAt > taskBudgetMs()) {
      await transition(t, 'FAILED', `task exceeded its ${Math.round(taskBudgetMs() / 60000)}-minute execution-time budget (bounded planning/execution loop prevention)`).catch(() => undefined);
      await setVerdict(t, 'failed');
      taskEvent(t, 'Task failed', 'execution-time budget exceeded', 'fail');
      return false;
    }
    // F-18: ownership identity required — a driver that lost its lease stops driving.
    if (!(await renewClaim(t, lease.owner))) throw new Error('execution lease lost; another owner took over');
    const eligible = nextEligibleSteps(t);
    if (!eligible.length) break; // nothing runnable: done, or blocked behind failures
    const wave = writeSafeWave(eligible);
    for (const step of wave) {
      await markStep(t, step.id, { status: 'running' });
      taskEvent(t, 'Step started', step.title, 'busy');
    }
    setNote(
      t,
      wave.length === 1
        ? `step ${t.steps.indexOf(wave[0]) + 1}/${t.steps.length}: ${wave[0].title}`
        : `parallel wave: ${wave.map((s) => s.title).join(' + ')}`
    );
    // F-18: the heartbeat covers the WHOLE wave, so healthy long steps are never
    // mistaken for a dead driver.
    const hb = setInterval(() => {
      void renewClaim(t, lease.owner).catch(() => undefined);
    }, HEARTBEAT_MS);
    try {
      // Failure-isolated: runOneStep never throws except for task-level cancel/lease.
      await Promise.all(wave.map((step) => runOneStep(t, step, deps, signal, lease)));
    } finally {
      clearInterval(hb); // heartbeat resources are always cleaned up
    }
    // Round 25 §7 — WAVE-LEVEL RESULT RECONCILIATION: parallel agents can produce
    // contradictory claims about the same deliverable (one says written, one says
    // missing). The coordinator does not average or vote: it checks the claimed paths
    // against the DISK and appends an authoritative verdict to each wave result, so the
    // verifier (and the user) sees the contradiction AND its ground-truth resolution.
    if (!signal.aborted) {
      const waveResults = wave.map((s) => t.steps.find((x) => x.id === s.id)?.result ?? '').filter((r) => r.trim());
      const reconciliation = waveResults.length >= 2 ? await reconcileSubtaskResults(waveResults) : '';
      if (reconciliation) {
        for (const s of wave) {
          const st = t.steps.find((x) => x.id === s.id);
          if (st?.result) st.result = `${st.result}${reconciliation}`.slice(0, 4000);
        }
        await persistTask(t);
        taskEvent(t, 'Wave results reconciled', clip(reconciliation.replace(/[\n\]]/g, ' '), 180), 'busy');
      }
    }
    // ROUND 31 (§1.3): discoveries reported by finished steps adapt the REMAINING plan —
    // pending steps are told to reassess their premises against new information instead
    // of blindly continuing. Bounded (≤4 pending steps, ≤3 discoveries).
    if (!signal.aborted) {
      const discoveries = wave
        .map((s) => t.steps.find((x) => x.id === s.id)?.result ?? '')
        .flatMap((r) => parseDiscoveries(r));
      await propagateDiscoveries(t, discoveries);
    }
    // A retry inside the wave moved the task to RETRYING; settle it back to RUNNING so
    // the later VERIFYING transition stays legal (the state machine has no RETRYING →
    // VERIFYING edge by design).
    if (t.status === 'RETRYING') await transition(t, 'RUNNING', 'wave finished').catch(() => undefined);
  }
  if (stepsComplete(t)) return true;
  // Not everything could be scheduled. If failures are blocking branches, one bounded
  // adaptive replan gets a chance to rebuild the remaining plan before we fail.
  const failed = failedSteps(t);
  if (failed.length && !signal.aborted && (await replanAfterFailure(t, deps, signal, failed))) {
    return driveSteps(t, deps, signal, lease); // continue on the new plan version (replan budget bounds the recursion)
  }
  // Round 20 (CHANGE 4): SKIP PROPAGATION with an honest account. With no replan left,
  // pending steps whose dependencies failed can NEVER run — leaving them 'pending'
  // forever is a lie of an unfinished engine. They become 'skipped' with the reason
  // recorded, so the successful branches are preserved and verification still decides
  // the task's fate against the acceptance criteria.
  const blocked = stepsBlockedByFailure(t);
  for (const s of blocked) {
    s.status = 'skipped';
    s.result = `SKIPPED: a dependency failed (${failed.map((f) => f.title).slice(0, 2).join('; ')}) and no replan budget remains — this branch can never run in this plan version.`;
    s.endedAt = Date.now();
  }
  if (blocked.length) {
    await persistTask(t);
    taskEvent(t, 'Branches skipped', `${blocked.length} step(s) blocked by failed dependencies were marked skipped`, 'fail');
  }
  if (stepsComplete(t)) return true; // every branch accounted for: verification decides
  const stuck = t.steps.find((s) => s.status === 'pending' || s.status === 'running');
  await transition(
    t,
    'FAILED',
    `steps could not be scheduled (blocked at "${stuck?.title ?? '?'}"${failed.length ? `; ${failed.length} step(s) failed` : ''})`
  );
  // Round 25 §8: this terminal state carries its verdict too (honest completion state).
  await setVerdict(t, 'failed');
  return false;
}

// -------------------------------------------------------------------- verification

async function verifyTask(t: TaskRecord, signal: AbortSignal): Promise<boolean> {
  await transition(t, 'VERIFYING', 'acceptance checks');
  verifyEvent(t, `${t.spec.acceptance.length || 'no'} criterion(a)`, 'busy');
  // command-passes criteria run against the DETECTED project (one implementation, in
  // verifyExec.ts); a criterion without a concrete command uses the project's first script.
  const facts = await detectProject().catch(() => null);
  const runCommand = facts ? (cmd: string) => runCmd(cmd, facts.root, 300_000) : undefined;
  const targets: Record<string, string> = {};
  for (const c of t.spec.acceptance) {
    if (c.kind === 'command-passes' && !c.target && facts?.scripts.length) targets[c.id] = `npm run ${facts.scripts[0]}`;
  }
  // Mechanical checks first: files, formats, commands, sources, evidence.
  // Round 20 (CHANGE 4): verifyAcceptance runs EXACTLY ONCE — the old flow ran it a
  // second time with the reviewer verdict folded in, re-executing verification commands
  // and re-stat'ing files (double cost, flaky second outcomes). applyReviewerVerdict now
  // folds the independent review into the already-computed results; it can only lower.
  let v = t.spec.acceptance.length
    ? await verifyAcceptance(t.spec.acceptance, t.id, t.createdAt, { runCommand, targets })
    : { checkedAt: Date.now(), passed: true, results: [{ criterion: '(no acceptance criteria)', pass: true, evidence: 'step reports stand as the evidence; the reviewer may still fail it' }] };
  // Independent reviewer (bounded): a second opinion that can only lower the verdict.
  if (!signal.aborted) {
    try {
      const model = t.model || await getModel();
      if (model) {
        const r = await completeOnce(
          model,
          [
            {
              role: 'system',
              content:
                'You review finished work against its goal INDEPENDENTLY — never approve another agent\'s claims without checking them. Consider: (1) was the requested objective actually achieved; (2) are important requirements MISSING; (3) does the implementation fit the existing architecture and conventions described in the reports; (4) were files modified that the task did not need to touch; (5) are there obvious regressions or contradictions between step reports; (6) can the result be verified from the evidence given. Do not accept "DONE" as proof — look for the evidence. List concrete flaws or missing parts, then end with "VERDICT: PASS" or "VERDICT: FAIL". Be specific and short.',
            },
            {
              role: 'user',
              content: `GOAL: ${t.spec.objective}\n\nACCEPTANCE:\n${t.spec.acceptance.map((a) => `- ${a.detail}`).join('\n') || '- the request was fulfilled'}\n\nSTEP REPORTS:\n${t.steps.map((s) => `${s.title}: ${clip(s.result, 700)}`).join('\n')}`,
            },
          ],
          [],
          signal
        );
        v = applyReviewerVerdict(v, r.content.trim().slice(0, 400));
      }
    } catch {
      /* reviewer unavailable: the mechanical result stands (never invents a failure) */
    }
  }
  await setVerification(t, v);
  // ROUND 35 (Phase 1/3/4): settle the persisted delivery block — criterion states from
  // these verification results (index-aligned), evidence records pointing at the receipts
  // and disk checks behind each result, the deliverable dependency gate, the change
  // summary and the lightweight delivery review. Everything is written by ENGINE code
  // from the verification outcome, never from a model claim.
  await settleDelivery(t).catch(() => undefined);
  verifyEvent(t, v.results.map((r) => `${r.pass ? 'PASS' : 'FAIL'} ${r.criterion}`).join(' · '), v.passed ? 'ok' : 'fail');
  return v.passed;
}

// ------------------------------------------------------------------------ the driver

interface Lease {
  /** Unique per-drive identity; the owner string IS the lease credential. */
  owner: string;
}

async function drive(t: TaskRecord, deps: CoordinatorDeps, signal: AbortSignal, lease: Lease, opts: { replan: boolean }): Promise<void> {
  try {
    // Round 25 §3 — DELEGATION DECISION: the coordinator decides BEFORE planning whether
    // this work needs multi-agent execution at all, records WHY on the task, and only
    // pays for a planning model call when the strategy actually benefits from one.
    // The decision never executes anything — planning and execution stay in the ONE loop.
    const decision = decideDelegation(t.spec);
    t.delegation = { strategy: decision.strategy, kind: decision.kind, reasons: decision.reasons, workstreams: decision.workstreams, parallelizable: decision.parallelizable, complexity: decision.complexity, decidedAt: Date.now() };
    await persistTask(t);
    emitActivity({ kind: 'agent', cid: `delegate-${t.id}`, label: `Delegation: ${decision.strategy}`, detail: delegationSummary(decision), status: 'busy', taskId: t.id });

    // F-19: a resumed task keeps its persisted plan and its completed steps. Only a
    // fresh start (or a task that never got a plan) plans here.
    if (opts.replan || !t.steps.length) {
      await transition(t, 'PLANNING', 'planning steps');
      taskEvent(t, 'Planning', t.spec.objective, 'busy');
      // Round 25 §3/§11: simple self-contained work runs ONE scoped specialist + verify
      // — a deterministic plan, no planning model call. Complex/multi-stream work gets
      // the model planner with the delegation analysis as explicit hints. An INJECTED
      // planner (tests, the project autopilot) always wins: deterministic callers
      // explicitly control planning, so the shortcut never bypasses them.
      const steps =
        decision.strategy !== 'coordinated_multi_agent' && decision.kind && !deps.planner
          ? singleSpecialistPlan(t.spec, decision.kind)
          : await planTask(t.spec, deps.planner, [...decision.reasons, ...(decision.workstreams.length ? [`independent workstreams: ${decision.workstreams.join(' | ')}`] : []), ...(decision.parallelizable ? ['mark the independent read-only streams with dependsOn: [] so they can run as parallel waves'] : [])], t.model);
      // Round 19 (CHANGE 3): the plan graph is VALIDATED before execution — missing,
      // self and forward references and declared cycles are repaired by normalization
      // and REPORTED here, never silently swallowed.
      const report = validatePlanGraph(steps);
      await setSteps(t, steps);
      // ROUND 35 (Phase 2): deliverable records are derived from the plan's promised
      // outputs (the dependency shape mirrors the plan DAG).
      await initDeliverablesFromPlan(t).catch(() => undefined);
      taskEvent(t, 'Plan ready', steps.map((s) => `${s.kind}: ${s.title}`).join(' → '), 'ok');
      if (report.issues.length)
        taskEvent(t, 'Plan graph repaired', report.issues.slice(0, 4).join(' · ').slice(0, 240), 'busy');
    } else {
      taskEvent(t, 'Resuming plan', `${t.steps.filter((s) => s.status === 'done').length}/${t.steps.length} steps already done`, 'ok');
    }
    await transition(t, 'RUNNING', opts.replan ? 'executing steps' : 'executing remaining steps');
    taskEvent(t, 'Execution started', `${t.steps.length} step(s)`, 'busy');
    // ROUND 35 (Phase 1): the tracked acceptance criteria are now genuinely in progress —
    // this is the only place 'in_progress' is set (execution is actually running) and it
    // never downgrades a satisfied criterion from an earlier verification round.
    await markCriteriaInProgress(t).catch(() => undefined);

    const ok = await driveSteps(t, deps, signal, lease);
    if (!ok) return; // driveSteps already transitioned + recorded the failure

    const passed = await verifyTask(t, signal);
    // ROUND 35 (Phase 1): THE COMPLETION GATE. Verification passing is necessary but no
    // longer sufficient — the task completes only when the persisted delivery block shows
    // every mandatory criterion satisfied and every mandatory file deliverable verified.
    // A gate that is partial/blocked/failed produces the HONEST verdict (partial, blocked
    // or failed) instead of a success claim, and still gets its one bounded revise round.
    const gate = deliveryGate(t);
    // 'untracked' (no criteria or deliverables) is the lightweight path: verification alone decides.
    if (passed && (gate.state === 'complete' || gate.state === 'untracked')) {
      await transition(t, 'COMPLETED', 'verified; delivery gate satisfied');
      await setVerdict(t, 'completed');
      // Round 19 (CHANGE 10): the completion event carries the outcome account, so the
      // report is grounded in what the engine measured, not in a confident reply.
      taskEvent(t, 'Task completed', `${t.spec.objective} · ${outcomeSummary(t)}`, 'ok');
      return;
    }
    if (passed && gate.state !== 'complete') {
      taskEvent(t, 'Delivery gate open', gate.unsatisfied.join(' · ') || 'tracked deliverables not yet verified', 'fail');
    }
    // One bounded revise round: APPEND a fix step carrying the verification evidence
    // (append, never replace — finished steps keep their status). The delivery gate's
    // unsatisfied list is part of the fix brief so the revise round targets the real gaps.
    if (!signal.aborted && t.retries < TASK_FIX_ROUNDS) {
      t.retries++;
      await appendStep(t, {
        title: 'Fix verification failures',
        detail: `The verification FAILED. Fix the problems and make the checks pass.\n\nVERIFICATION RESULTS:\n${v_Results(t)}${gate.unsatisfied.length ? `\n\nUNSATISFIED DELIVERY REQUIREMENTS (the task cannot complete until these hold with real evidence):\n${gate.unsatisfied.map((u) => `- ${u}`).join('\n')}` : ''}`,
        kind: 'general',
      });
      await transition(t, 'RUNNING', 'revise round after failed verification');
      const ok2 = await driveSteps(t, deps, signal, lease);
      if (!ok2) return;
      const passed2 = await verifyTask(t, signal);
      const gate2 = deliveryGate(t);
      const completed2 = passed2 && (gate2.state === 'complete' || gate2.state === 'untracked');
      await transition(t, completed2 ? 'COMPLETED' : 'FAILED', completed2 ? 'verified after revision; delivery gate satisfied' : `delivery gate ${gate2.state} after the revise round${gate2.unsatisfied.length ? `: ${gate2.unsatisfied.slice(0, 3).join('; ')}` : ''}`);
      // Round 25 §8: BOTH terminal outcomes carry their verdict — a task that failed
      // after its revise round used to end with no verdict at all (honest-state gap).
      // ROUND 35: the failing verdict is the HONEST one — 'partial' when real progress
      // was made with real gaps, 'blocked' when uncertainty remains, 'failed' otherwise.
      await setVerdict(t, completed2 ? 'completed' : honestVerdictFor(gate2));
      taskEvent(t, completed2 ? 'Task completed' : 'Task not fully delivered', completed2 ? t.spec.objective : `${gate2.satisfiedCount}/${gate2.mandatoryCount} delivery requirement(s) satisfied — ${gate2.unsatisfied.slice(0, 2).join('; ')}`, completed2 ? 'ok' : 'fail');
      return;
    }
    await transition(t, 'FAILED', `delivery gate ${gate.state}: ${gate.unsatisfied.slice(0, 3).join('; ') || 'verification failed'}`);
    await setVerdict(t, honestVerdictFor(gate));
    taskEvent(t, 'Task not fully delivered', `${gate.satisfiedCount}/${gate.mandatoryCount} delivery requirement(s) satisfied — honest partial/failure, never a false success`, 'fail');
  } catch (e) {
    const cancelled = signal.aborted || (e instanceof Error && (e.message === 'cancelled' || e.message.startsWith('execution lease lost')));
    if (cancelled) {
      // F-13/F-18: WHO cancelled decides the honest terminal state. The user's
      // task_cancel is CANCELLED; a watchdog takeover or a lost lease leaves the task
      // INTERRUPTED (resumable) — never silently converted to a terminal state.
      if (cancelReasons.get(t.id) === 'paused') {
        // Round 26 Phase 6 (§6.4): a PAUSE is not a cancellation — mid-flight steps are
        // reconciled honestly (unknown outcomes stay unknown), completed work is preserved
        // and the task settles PAUSED, resumable. No verdict is set.
        await reconcileInterruptedSteps(t, 'paused by the user while the step was mid-flight; outcome unknown').catch(() => undefined);
        await transition(t, 'PAUSED', 'paused by the user — completed steps are preserved; resume to continue').catch(() => undefined);
        taskEvent(t, 'Task paused', `${t.steps.filter((s) => s.status === 'done').length}/${t.steps.length} steps done — resume with task_resume`, 'busy');
      } else if (cancelReasons.get(t.id) === 'user') {
        // Round 19 (CHANGE 9): steps the wave left mid-flight are settled HONESTLY —
        // back to retryable with an UNKNOWN outcome — instead of being shown as
        // forever 'running' under a terminal task.
        await reconcileInterruptedSteps(t, 'cancelled by the user while the step was mid-flight; outcome unknown').catch(() => undefined);
        await transition(t, 'CANCELLED', 'cancelled by the user').catch(() => undefined);
        await setVerdict(t, 'failed').catch(() => undefined);
        taskEvent(t, 'Task cancelled', t.note, 'fail');
      } else {
        await transition(t, 'INTERRUPTED', 'interrupted: the driver lost its execution window; resume to continue').catch(() => undefined);
        await reconcileInterruptedSteps(t, 'driver interrupted (stall watchdog or lease takeover); outcome of the running step is unknown');
        taskEvent(t, 'Task interrupted', 'resumable — completed steps are preserved', 'fail');
      }
    } else {
      await transition(t, 'FAILED', `failed: ${e instanceof Error ? e.message : String(e)}`).catch(() => undefined);
      await setVerdict(t, 'failed').catch(() => undefined);
      taskEvent(t, 'Task failed', t.note, 'fail');
    }
  } finally {
    await releaseClaim(t, lease.owner).catch(() => undefined);
    controllers.delete(t.id);
    cancelReasons.delete(t.id);
  }
}

/** TaskRecord.verdict is set ONLY here — by the engine, from real verification outcomes. */
const setVerdict = async (t: TaskRecord, v: NonNullable<TaskRecord['verdict']>): Promise<void> => {
  await setTaskVerdict(t, v);
  // ROUND 32 (§4.1): the durable workflow journal records the CHECKPOINT — the last
  // settled state a resume can trust — and the task's workspace binding is released.
  void recordWorkflowEntry({
    kind: 'checkpoint',
    taskId: t.id,
    stage: 'task-verdict',
    detail: `task ${t.id} settled ${t.status} (${v}): ${t.steps.filter((s) => s.status === 'done').length}/${t.steps.length} steps done${t.verification ? `, acceptance ${t.verification.passed ? 'PASSED' : 'FAILED'}` : ''}`,
    outcome: v === 'completed' ? 'executed-verified' : v === 'failed' ? 'failed' : undefined,
  });
  unbindTaskWorkspace(t.id);
  // Round 26 Phase 2: durable EPISODIC MEMORY — what the engine OBSERVED about finished
  // work (never the agent's self-assessment alone). Fire-and-forget with observable
  // failure: recording an episode must never break the task loop.
  if (v === 'no_action') return; // nothing was attempted — no lesson to store
  const kinds = [...new Set(t.steps.map((s) => s.kind))];
  const failed = t.steps.filter((s) => s.status === 'failed');
  const lesson =
    v === 'completed'
      ? t.verification?.passed
        ? 'approach verified; reusable for similar requests'
        : undefined
      : failed.length
        ? `failed at: ${clip(failed[0]?.result ?? 'unknown cause', 220)}`
        : undefined;
  const evidence = t.verification
    ? `${t.verification.passed ? 'acceptance checks PASSED' : 'acceptance checks FAILED'} (${t.verification.results.filter((r) => r.pass).length}/${t.verification.results.length} criteria)`
    : t.steps.some((s) => s.verification)
      ? 'per-step verification records present'
      : undefined;
  // Round 27 §1.5: DURABLE episodic recording — the episode is first written to the
  // pending-episode outbox (atomic, crash-safe), then drained into the episodic store by
  // a bounded background pass. A crash after task completion can no longer silently lose
  // the memory of the work, and memory failures still never change task completion.
  void queueEpisode({
    taskId: t.id,
    request: t.spec.request || t.spec.objective,
    verdict: v,
    outcome: clip(t.note || t.spec.objective, 300),
    approach: kinds.length ? `plan of ${t.steps.length} step(s): ${kinds.join(', ')}` : 'direct execution',
    lesson,
    evidence,
    origin: 'observed',
  })
    .then((r) => {
      if (!r.queued) console.warn(`[coordinator] episode not queued for ${t.id}: ${r.error ?? 'unknown reason'}`);
      return processPendingEpisodes();
    })
    .catch((e) => console.warn(`[coordinator] episode recording failed for ${t.id}:`, e instanceof Error ? e.message : e));
};

/**
 * Round 25 §3: the deterministic SINGLE-SPECIALIST plan for simple, self-contained work —
 * one scoped specialist does the job, one verifier checks the acceptance criteria.
 * Two steps, zero planning model calls, no fan-out: the cheapest honest execution.
 */
export function singleSpecialistPlan(spec: TaskSpec, kind: AgentKind): PlanStep[] {
  return [
    {
      title: 'Do the work',
      detail: `${spec.objective}\n${spec.deliverables.length ? `Deliverables: ${spec.deliverables.join('; ')}.` : ''}${spec.constraints.length ? ` Constraints: ${spec.constraints.join('; ')}.` : ''}`,
      kind,
    },
    {
      title: 'Verify the result',
      detail: `Check the deliverable against the acceptance criteria: ${spec.acceptance.map((a) => a.detail).join('; ') || 'the request was fulfilled'}. Report evidence, not intentions.`,
      kind: 'verifier',
    },
  ];
}

const v_Results = (t: TaskRecord): string => (t.verification?.results ?? []).map((r) => `${r.pass ? 'PASS' : 'FAIL'} — ${r.criterion}: ${r.evidence}`).join('\n') || '(no results)';

// ------------------------------------------------------------------- public interface

export interface CoordinatorDeps {
  run: Runner;
  schemas: (kind: AgentKind) => ToolSchema[];
  /** Test hook: deterministic planner. */
  planner?: (spec: TaskSpec) => Promise<PlanStep[]>;
  /** Round 18 §5.5: deterministic adaptive replanner (tests). Return null/[] to refuse. */
  replanner?: (t: TaskRecord, failed: TaskStep[]) => Promise<PlanStep[] | null>;
  /** Round 18 §6.3: test hook replacing the sub-subtask executor. */
  subtaskRunner?: (agentName: string, instructions: string, signal: AbortSignal) => Promise<string>;
  /** Test hook: replaces the sub-agent executor for one step. */
  stepRunner?: (prompt: string, kind: AgentKind, t: TaskRecord, stepId: string, signal: AbortSignal) => Promise<string>;
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Start a durable task from a user request. Deduplicates against active tasks with the
 * same request, enforces the concurrency cap, claims ownership, and drives asynchronously.
 */
export async function startTask(request: string, deps: CoordinatorDeps): Promise<string> {
  const spec = buildTaskSpec(request);
  if (spec.kind === 'informational') return 'NOT DONE: that request is a question — answer it directly instead of starting a task.';
  // ROUND 31 (§1.2): ambiguity decides the route. 'blocking' cannot proceed safely at
  // all; 'clarify' asks exactly one question; 'assumable' proceeds WITH its recorded
  // assumptions surfaced to the user; 'clear' just starts.
  if (spec.needsClarification && spec.clarification) {
    return spec.ambiguity === 'blocking'
      ? `NEEDS INPUT (cannot proceed safely): ${spec.clarification}`
      : `NEEDS INPUT: ${spec.clarification}`;
  }
  const r = await launchSpec(spec, deps, { dedupe: true });
  if (r.ok && spec.assumptions.length) {
    return `${r.message} Proceeding on explicit assumption(s): ${spec.assumptions.join('; ')}.`;
  }
  return r.message;
}

export interface StartedTask {
  ok: boolean;
  /** The DURABLE task id (real taskStore record) when accepted. */
  id?: string;
  message: string;
}

/**
 * Round 22 (Project Autopilot): start a durable task from a PRE-BUILT TaskSpec — the one
 * sanctioned bridge for PROJECT tasks into the ONE coordinator. Same acceptance flow as
 * startTask: concurrency cap, execution-lease claim, asynchronous drive with planning,
 * verification and honest verdicts. Returns the durable task id so the project layer can
 * track the REAL record (never a project-local imitation).
 *
 * Dedupe is OFF by default: two different projects may legitimately run identical briefs
 * (multi-project isolation). Callers that want the interactive-turn duplicate protection
 * pass { dedupe: true }.
 */
export async function startTaskWithSpec(spec: TaskSpec, deps: CoordinatorDeps, opts?: { dedupe?: boolean }): Promise<StartedTask> {
  return launchSpec(spec, deps, { dedupe: opts?.dedupe === true });
}

/**
 * ROUND 27 (§2.3): RETRY an eligible FAILED task. The original record is history — never
 * mutated — so its evidence, failures and verdict stay exactly what they were; the retry
 * is a NEW durable task from the SAME spec, run through the normal plan → execute →
 * verify pipeline with its own bounded retries and verification. A task the USER
 * cancelled is not retryable (that would override an explicit user decision); capacity
 * limits still apply. Steps whose outcome is UNKNOWN were already reconciled inside the
 * old task; the fresh task re-derives everything from the CURRENT workspace state.
 *
 * ROUND 28 (§1.5): a FAILED task that still carries steps with UNKNOWN outcomes (a tool
 * execution that started but was never recorded complete) is NOT retryable until that
 * uncertainty is reconciled — blindly re-running the same brief could duplicate an
 * external side effect whose first execution may already have landed. The honest paths
 * are task_resume (which runs the RECONCILE FIRST machinery) or a new request.
 */
export async function retryTask(id: string, deps: CoordinatorDeps): Promise<string> {
  const t = await getTask(id);
  if (!t) return `NOT DONE: no task ${id}.`;
  if (t.status === 'CANCELLED') return `NOT DONE: task ${id} was cancelled by the user — start it again with a new request instead of overriding that decision.`;
  if (t.status !== 'FAILED') return `NOT DONE: task ${id} is ${t.status}, not FAILED. Paused/interrupted work resumes with task_resume (completed steps are preserved).`;
  const unresolved = t.steps.filter((s) => s.outcomeUnknown);
  if (unresolved.length)
    return `NOT DONE: task ${id} has ${unresolved.length} step(s) whose external outcome is UNKNOWN (${unresolved
      .slice(0, 3)
      .map((s) => s.title)
      .join('; ')}). Retrying now could repeat an external side effect that already happened. Resume it with task_resume first — the resume reconciles the unfinished executions and injects RECONCILE FIRST guidance — or start a fresh request.`;
  const res = await startTaskWithSpec({ ...t.spec, request: t.spec.request, createdAt: Date.now() }, deps, { dedupe: true });
  if (!res.ok || !res.id) return res.message;
  await appendTaskNote(res.id, `retry of failed task ${t.id} (verdict: ${t.verdict ?? 'none'}); the original record and its evidence are preserved unchanged`);
  taskEvent(t, 'Task retry started', `${t.id} → ${res.id}`, 'busy');
  return `${res.message} Original task ${t.id} stays as the failure record.`;
}

/** Bounded one-line note on a task (used by retry provenance). */
async function appendTaskNote(id: string, addition: string): Promise<void> {
  const t = await getTask(id);
  if (!t) return;
  await setNote(t, clip(`${t.note} — ${addition}`, 400));
}

/** Shared launch path for startTask/startTaskWithSpec (behavior unchanged for startTask). */
async function launchSpec(spec: TaskSpec, deps: CoordinatorDeps, opts: { dedupe: boolean }): Promise<StartedTask> {
  const active = await activeTasks();
  if (opts.dedupe) {
    const same = active.find((t) => norm(t.spec.request).slice(0, 200) === norm(spec.request).slice(0, 200));
    if (same) return { ok: false, id: same.id, message: `NOT DONE: task ${same.id} is already running with this request (${same.note}). Check task_status instead of starting a duplicate.` };
  }
  if (active.length >= MAX_CONCURRENT_TASKS) return { ok: false, message: `NOT DONE: ${active.length} tasks are already running. Wait for one to finish or cancel it with task_cancel.` };
  const modelAtAcceptance = await getModel().catch(() => '');
  const t = await createTask(spec, 'queued', modelAtAcceptance || undefined);
  // ROUND 35 (Phase 1): the acceptance criteria are tracked in the task's own persisted
  // delivery block from the moment the task exists — derived ONLY from the spec (nothing
  // invented, nothing dropped; the original request stays verbatim in spec.request).
  await initDelivery(t);
  await transition(t, 'READY', 'accepted');
  // ROUND 32 (§4.3): a project brief's "PROJECT WORKSPACE:" line binds this durable task
  // to its project workspace — the tool-execution layer then enforces the boundary
  // (path traversal, symlink escapes and cross-project access are refused at the
  // resolvers). Binding comes ONLY from the engine's brief, never from model args.
  await bindWorkspaceFromBrief(t.id, spec.request);
  const ctl = new AbortController();
  controllers.set(t.id, ctl);
  const owner = newOwnerIdentity();
  const claimed = await claimTask(t, owner);
  if (!claimed) {
    await transition(t, 'CANCELLED', 'could not claim the task it just created').catch(() => undefined);
    unbindTaskWorkspace(t.id);
    return { ok: false, message: 'NOT DONE: the task could not claim execution ownership. Try again.' };
  }
  void drive(t, deps, ctl.signal, { owner }, { replan: true });
  return {
    ok: true,
    id: t.id,
    message: `Task ${t.id} started: ${spec.objective} (${spec.risk} risk, ${spec.acceptance.length} acceptance check(s)). Track with task_status; the engine plans, executes with scoped agents, verifies against the acceptance criteria and reports — the verdict comes from checks, not promises.`,
  };
}

/**
 * ROUND 32 (§4.3): bind a task to its project workspace from the durable brief. The
 * ONLY producer of the "PROJECT WORKSPACE:" line is the autopilot engine's task-spec
 * bridge (buildProjectTaskSpec), which copies it from ProjectRecord.workspace — the
 * binding therefore reflects the persisted project record, not anything the model typed
 * at call time. Returns the bound root (for logging/diagnostics).
 */
export async function bindWorkspaceFromBrief(taskId: string, brief: string): Promise<string | undefined> {
  const m = brief.match(/^PROJECT WORKSPACE:\s*(.+?)\s*\(/m) ?? brief.match(/^PROJECT WORKSPACE:\s*(.+?)\s*$/m);
  const root = m?.[1]?.trim();
  if (!root) return undefined;
  await bindTaskWorkspace(taskId, root);
  return root;
}

/**
 * Round 22 (Project Autopilot): scheduler-visible coordinator capacity. The project
 * engine uses this to bound its dispatches to the SAME global concurrency limit every
 * other caller obeys (MAX_CONCURRENT_TASKS) — there is no separate project lane.
 */
export async function coordinatorCapacity(): Promise<{ active: number; max: number; free: number }> {
  const active = await activeTasks();
  return { active: active.length, max: MAX_CONCURRENT_TASKS, free: Math.max(0, MAX_CONCURRENT_TASKS - active.length) };
}

/**
 * Resume an interrupted task after a restart or a stall (F-19): the PERSISTED plan and
 * completed steps are kept — no replanning, no repeated completed work. Steps left
 * 'running' by the dead driver are reconciled to retryable with an unknown outcome
 * (F-20) before anything re-runs, and every tool execution with an UNKNOWN outcome is
 * written into its step's brief as RECONCILE FIRST guidance — the rerun must inspect the
 * real state and repeat only what verifiably did not happen.
 */
export async function resumeTask(id: string, deps: CoordinatorDeps): Promise<string> {
  const t = await getTask(id);
  if (!t) return `NOT DONE: no task ${id}.`;
  // Round 26 Phase 6: PAUSED and RECOVERING tasks resume like interrupted ones — the
  // completed steps stay, the remaining plan continues.
  if (t.status !== 'INTERRUPTED' && t.status !== 'PAUSED' && t.status !== 'RECOVERING')
    return `NOT DONE: task ${id} is ${t.status}, not paused, recovering or interrupted.`;
  // Round 20 (CHANGE 1): a resume is a recovery point — first give the controlled
  // persistence flush a chance to land any outcome receipts that were held in memory
  // because the ledger was failing (bounded pass; never repeats a side effect).
  const flushed = await flushPendingOutcomes().catch(() => ({ flushed: 0, remaining: -1 }));
  const owner = newOwnerIdentity();
  const claimed = await claimTask(t, owner);
  if (!claimed) return `NOT DONE: task ${id} is already claimed (${t.owner}) with a fresh lease.`;
  // The old owner provably cannot hold a valid lease any more (the claim was just taken
  // from a dead/interrupted driver), so reconciling its orphaned running steps is safe.
  const reconciled = await reconcileInterruptedSteps(t, 'reconciled at resume: previous driver was interrupted; outcome unknown');
  // Idempotency reconciliation (Round 18 §4.4; Round 19 CHANGE 2): tool executions that
  // started but never completed — the exact operations whose outcome is UNKNOWN — are
  // CLASSIFIED (idempotency class, recovery verdict) and settled with durable
  // 'reconciled' records, then written into their step's brief so the rerun driver
  // cannot miss them. The classification is derived centrally (toolRecord), never per-call.
  const unknown = await reconcileUnfinishedAtResume(t.id, t.createdAt).catch(() => []);
  for (const item of unknown) {
    if (!item.stepId) continue;
    await appendStepDetail(
      t,
      item.stepId,
      `RECONCILE FIRST (${item.idempotency}): a previous ${item.tool} execution (${item.args}) has UNKNOWN outcome — ${item.verdict}.`
    );
  }
  await transition(t, 'READY', 'resumed after interruption');
  // ROUND 32 (§4.3): a resumed project task re-binds to its project workspace (the
  // binding is per execution context and a restart cleared it).
  await bindWorkspaceFromBrief(t.id, t.spec.request);
  // ROUND 35 (Phase 5): the delivery block resumes with the task — in-flight claims
  // revert to honest non-claims, evidence freshness is re-checked, and the summary names
  // exactly how much completed work the resume preserves.
  const deliveryNote = await reconcileDeliveryAtResume(t, unknown.length).catch(() => '');
  const ctl = new AbortController();
  controllers.set(t.id, ctl);
  void drive(t, deps, ctl.signal, { owner }, { replan: false });
  const done = t.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const firstOpen = t.steps.findIndex((s) => s.status === 'pending' || s.status === 'running');
  const from = firstOpen >= 0 ? firstOpen + 1 : t.steps.length;
  return `Task ${id} resumed from step ${from}; resumed WITHOUT replanning — ${done}/${t.steps.length} steps were already completed and are preserved.${reconciled.length ? ` ${reconciled.length} interrupted step(s) reconciled (outcome unknown — the rerun will verify actual state before repeating anything).` : ''}${unknown.length ? ` ${unknown.length} tool execution(s) have UNKNOWN outcomes (started but never recorded complete): ${unknown.map((u) => u.tool).slice(0, 5).join(', ')}. Their effects must be verified against the real world before any retry.` : ''}${flushed.flushed > 0 ? ` ${flushed.flushed} previously in-memory outcome receipt(s) were flushed to the ledger during recovery.` : ''}${deliveryNote ? ` ${deliveryNote}.` : ''} Continuing from "${t.steps[firstOpen]?.title ?? 'verification'}".`;
}

/** One-line status block for the model and the HUD. */
export function taskStatusText(t: TaskRecord, verbose = false): string {
  const done = t.steps.filter((s) => s.status === 'done').length;
  const head = `TASK ${t.id} [${t.status}] — ${t.spec.objective}`;
  const lines = [
    head,
    `${done}/${t.steps.length} steps done${t.note ? ` · ${t.note}` : ''}`,
    ...(t.delegation ? [`DELEGATION: ${t.delegation.strategy}${t.delegation.kind ? ` (${t.delegation.kind})` : ''} — ${t.delegation.reasons.join('; ')}`] : []),
    ...t.steps.map((s, i) => `  ${i + 1}. [${s.status}] ${s.title}${s.status === 'failed' && s.result ? ` — ${clip(s.result, 160)}` : ''}`),
  ];
  if (t.verification) {
    lines.push(`VERIFICATION: ${t.verification.passed ? 'PASSED' : 'FAILED'}`);
    for (const r of t.verification.results) lines.push(`  ${r.pass ? 'PASS' : 'FAIL'} — ${r.criterion}: ${clip(r.evidence, verbose ? 200 : 90)}`);
  }
  // ROUND 35 (Phase 6): the persisted delivery state is part of the ground-truth status —
  // criteria, deliverables, evidence and the completion gate, never optimistic numbers.
  const deliveryLine = deliveryStatusLine(t);
  if (deliveryLine) lines.push(deliveryLine);
  if (t.verdict) lines.push(`VERDICT: ${t.verdict}`);
  // Round 19 (CHANGE 10): the outcome vocabulary is part of every status view.
  lines.push(outcomeSummary(t));
  return lines.filter(Boolean).join('\n');
}

/**
 * OUTCOME VOCABULARY (Round 19, CHANGE 10) — the code-computed account of what actually
 * happened, in the mandated terms:
 *   ATTEMPTED  — steps the engine actually started (attempts > 0);
 *   EXECUTED   — steps that ran to a settled outcome (done or failed);
 *   COMPLETED  — steps whose result stands (done or skipped);
 *   VERIFIED   — whether the acceptance verification PASSED (or has not run);
 *   FAILED     — steps that failed;
 *   UNRESOLVED — steps never run, still running, or left with an UNKNOWN outcome.
 * Every number is derived from PERSISTED state — never from the model's confidence — and
 * a task is never reported completed without its verification source being named.
 */
export function outcomeSummary(t: TaskRecord): string {
  const attempted = t.steps.filter((s) => s.attempts > 0).length;
  const executed = t.steps.filter((s) => s.status === 'done' || s.status === 'failed').length;
  const completed = t.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  const failed = t.steps.filter((s) => s.status === 'failed').length;
  const unresolved = t.steps.filter((s) => s.status === 'pending' || s.status === 'running' || s.outcomeUnknown).length;
  const verified = t.verification ? (t.verification.passed ? 'verified (acceptance checks passed)' : 'NOT verified (acceptance checks failed)') : 'not verified (verification has not run)';
  const verdict = t.verdict ? ` · verdict: ${t.verdict}` : '';
  // Round 26 Phase 3 (3.6): per-step verification states are counted, not assumed —
  // only records valid for the step's CURRENT result count (stale records never inflate).
  const vCounts = { verified: 0, partial: 0, unverified: 0, other: 0 };
  for (const s of t.steps) {
    const v = validVerification(s);
    if (!v) continue;
    if (v.status === 'verified') vCounts.verified++;
    else if (v.status === 'partial') vCounts.partial++;
    else if (v.status === 'unverified' || v.status === 'unknown' || v.status === 'unresolved') vCounts.unverified++;
    else vCounts.other++;
  }
  const stepVerdicts =
    vCounts.verified + vCounts.partial + vCounts.unverified + vCounts.other > 0
      ? ` · steps verified/partial/unverified: ${vCounts.verified}/${vCounts.partial}/${vCounts.unverified}`
      : '';
  return `OUTCOMES: attempted ${attempted}/${t.steps.length} · executed ${executed} · completed ${completed} · failed ${failed} · unresolved ${unresolved} · ${verified}${stepVerdicts}${verdict}`;
}

/**
 * Stall detection: a RUNNING task whose lease was not renewed within the step timeout is
 * marked INTERRUPTED (honest state, resumable) and its driver is aborted. This is a
 * WATCHDOG takeover — it must never surface as CANCELLED (F-13/F-18): the driver's
 * catch distinguishes by cancelReasons. Called from a watchdog interval.
 */
export async function checkStalls(now = Date.now()): Promise<string[]> {
  const stale: string[] = [];
  for (const t of await activeTasks()) {
    if (t.status !== 'RUNNING' || !t.owner) continue;
    if (now - t.ownerSince > STEP_TIMEOUT_MS) {
      cancelReasons.set(t.id, 'stall');
      await transition(t, 'INTERRUPTED', 'execution stalled: no heartbeat within the step budget').catch(() => undefined);
      await releaseClaim(t, t.owner).catch(() => undefined);
      controllers.get(t.id)?.abort();
      stale.push(t.id);
    }
  }
  return stale;
}

// --------------------------------------------------------------------------- tools

const latest = async (id?: unknown): Promise<TaskRecord | undefined> => {
  const all = await listTasks();
  if (id !== undefined) return all.find((t) => t.id === String(id));
  return all.sort((a, b) => b.updatedAt - a.updatedAt)[0];
};

export const coordinatorTools = (deps: CoordinatorDeps): Record<string, Tool> => ({
  start_task: {
    description:
      'Start an AUTONOMOUS durable task for a multi-step request: the coordinator plans steps, runs each with a scoped sub-agent, verifies the result against acceptance criteria (files re-checked, commands run, sources counted) and reports honestly. Returns at once; track with task_status. Use for concrete work with a deliverable; questions are answered directly instead. Every allowed request starts immediately — payments, purchases and credentials included; there is no confirmation step.',
    parameters: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'The complete request, verbatim, with every requirement and constraint.' },
      },
      required: ['request'],
    },
    run: (args) => startTask(String(args.request ?? ''), deps),
  },
  task_status: {
    description: 'Ground-truth status of a durable task (or the latest): every step, the verification results per criterion and the verdict. Never guess task progress; read it here.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, verbose: { type: 'boolean' } } },
    run: async (args) => {
      const t = await latest(args.id);
      if (!t) return args.id !== undefined ? `NOT DONE: no task ${String(args.id)}.` : 'No tasks have been started.';
      return taskStatusText(t, args.verbose === true);
    },
  },
  task_cancel: {
    description: 'Cancel a running durable task by id. Finished steps stay recorded; the task reports exactly how far it got.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async (args) => {
      const t = await getTask(String(args.id ?? ''));
      if (!t) return `NOT DONE: no task ${String(args.id ?? '')}.`;
      if (!cancelTask(t.id)) return `Task ${t.id} is not being driven right now (status ${t.status}).`;
      return `Task ${t.id} cancellation requested; it stops at the next step boundary and task_status will show how far it got.`;
    },
  },
  task_pause: {
    description: 'Pause a running durable task by id (Round 26): execution stops at the next step boundary, completed steps are preserved, and the task settles PAUSED — resumable later with task_resume. Use task_cancel instead to finish it for good.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: async (args) => {
      const t = await getTask(String(args.id ?? ''));
      if (!t) return `NOT DONE: no task ${String(args.id ?? '')}.`;
      if (t.status === 'PAUSED') return `Task ${t.id} is already paused; resume it with task_resume.`;
      if (!pauseTask(t.id)) return `Task ${t.id} is not being driven right now (status ${t.status}) — nothing to pause.`;
      return `Task ${t.id} pause requested; it stops at the next step boundary and stays resumable (task_resume).`;
    },
  },
  task_resume: {
    description: 'Resume a paused, recovering or interrupted durable task (after a pause, a restart or a stall) from where it stopped.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (args) => resumeTask(String(args.id ?? ''), deps),
  },
  task_retry: {
    description: 'Retry an eligible FAILED durable task by id: starts a NEW task from the same request through the normal plan → execute → verify pipeline. The failed record is preserved unchanged as history (evidence and verdict stay). Cancelled tasks are refused (that was an explicit user decision); paused/interrupted tasks should be resumed with task_resume instead.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (args) => retryTask(String(args.id ?? ''), deps),
  },
  list_tasks: {
    parallelSafe: true,
    description: 'List durable tasks: active ones with progress, recent ones with their verdicts.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const all = await listTasks();
      if (!all.length) return 'No durable tasks recorded.';
      const active = all.filter((t) => ACTIVE_STATUSES.includes(t.status) || t.status === 'INTERRUPTED');
      const done = all.filter((t) => !active.includes(t)).slice(0, 6);
      return [
        active.length ? `ACTIVE:\n${active.map((t) => taskStatusText(t).split('\n').slice(0, 2).join(' · ')).join('\n')}` : 'Nothing active.',
        done.length ? `RECENT:\n${done.map((t) => `- ${t.id} [${t.status}] ${clip(t.spec.objective, 80)}`).join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
});

/**
 * Project verify scripts for command-passes criteria, from the shared project detector
 * (verifyExec.ts — one implementation, no duplication). Returns [] when no project is detected.
 */
export async function projectVerifyCommand(): Promise<string | undefined> {
  const facts = await detectProject();
  if (!facts || !facts.scripts.length) return undefined;
  return `npm run ${facts.scripts[0]}`;
}

export { runCmd };
