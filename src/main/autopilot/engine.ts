/**
 * PROJECT ENGINE (Round 22, §3.3–§3.7) — project-level orchestration over the ONE
 * Round 21 execution engine.
 *
 * ARCHITECTURAL CONTRACT (non-negotiable):
 *  - Every project task executes as a REAL durable JARVIS task through
 *    coordinator.startTaskWithSpec() — the shared launch path of the ordinary task
 *    system (same concurrency cap, same execution lease, same state machine, same
 *    verifier, same tool pipeline, same permission gate, same durable records). There
 *    is NO second coordinator, NO second agent engine, NO parallel tool runner and NO
 *    separate permission system here.
 *  - Dispatches are bounded by coordinatorCapacity() — the SAME global limit every
 *    other caller obeys. No separate project lane exists.
 *  - Failure recovery is bounded and honest: policy blocks are NEVER retried (a hard
 *    restriction cannot be waited out or bypassed through another agent, tool, process
 *    or browser); transient failures get a bounded retry with failure context; beyond
 *    the budget the project goes 'blocked' or 'failed' HONESTLY.
 *  - Completion is decided by EVIDENCE: durable task verdicts from the verifier +
 *    deliverables re-verified on disk. A project is never completed from stale cached
 *    state — the durable task store is authoritative.
 *  - Restart reconciliation recomputes every project from DURABLE records (never from
 *    memory), never duplicates completed work, and leaves interrupted work for an
 *    EXPLICIT resume.
 */

import { getModel } from '../settings';
import { completeOnce } from '../llm';
import { buildTaskSpec, type TaskSpec } from '../taskSpec';
import { getTask, type TaskRecord } from '../taskStore';
import { coordinatorCapacity, startTaskWithSpec, resumeTask as coordinatorResumeTask, cancelTask, type CoordinatorDeps } from '../coordinator';
import { emitActivity } from '../modes';
import { clipActivity } from '../activity';
import { FILES_ROOT } from '../workspace';
import { loadProjectProfile, relevantProfileContext } from '../projectProfile';
import {
  buildPlan,
  fallbackPlan,
  parseModelPlan,
  planningPrompt,
  repairPlan,
  validateProjectPlan,
  type ModelPlanner,
  type RawPlan,
} from './planner';
import { extractUnderstanding, mergeUnderstanding, understandingPrompt, type ModelUnderstanding } from './understanding';
import { requiredDeliverablesVerified, verifyProjectDeliverables } from './deliverables';
import { PROJECT_TEMPLATES } from './templates';
import {
  appendDurableEvents,
  createProject,
  getProject,
  listProjects,
  newProjectId,
  pushAttempt,
  pushEvent,
  pushPlanHistory,
  transitionProject,
  updateProject,
} from './store';
import type {
  DecisionRecord,
  ProjectEvent,
  ProjectRecord,
  ProjectStatus,
  ProjectTask,
  ProjectTaskState,
  ProjectUnderstanding,
} from './types';

const clip = (s: string, n: number): string => clipActivity(String(s ?? ''), n);

/** Dynamic readers: TS property-narrowing cannot see that settleTask() mutates the
 *  task in place, so comparisons go through these (honest runtime truth, no casts). */
const stateOf = (t: ProjectTask): ProjectTaskState => t.state;
const verdictOf = (t: TaskRecord): TaskRecord['verdict'] => t.verdict;

// --------------------------------------------------------------------------- timing

let TICK_MS = 1000;
/** Test hook: run the engine ticker at test speed. */
export const setAutopilotTimingForTests = (tickMs?: number): void => {
  if (tickMs !== undefined) TICK_MS = Math.max(20, tickMs);
};
/** Automatic replan budget per project (bounded, mirrors the coordinator's own REPLAN_BUDGET). */
const AUTO_REPLAN_BUDGET = 1;

// ---------------------------------------------------------------------------- deps

export interface AutopilotDeps {
  /** The ONE coordinator's dependency bundle (run/schemas) — project tasks run on it. */
  coordinator: CoordinatorDeps;
  /** Optional injected model planner (tests inject deterministic ones). */
  planner?: ModelPlanner;
  /** Optional injected model understanding pass (tests inject deterministic ones). */
  understanding?: (description: string) => Promise<ModelUnderstanding | null>;
  /** Optional injected replanner producing a RawPlan for the REMAINING work. */
  replanner?: (p: ProjectRecord, failedTasks: ProjectTask[]) => Promise<RawPlan | null>;
}

let engineDeps: AutopilotDeps | null = null;
/** Wire the engine to the real app's coordinator bundle (done once at tool registration). */
export const setAutopilotDeps = (deps: AutopilotDeps | null): void => {
  engineDeps = deps;
};
export const autopilotDeps = (): AutopilotDeps | null => engineDeps;

const needDeps = (what: string): AutopilotDeps => {
  if (!engineDeps) throw new Error(`NOT DONE: the project executor is not wired yet (${what}) — execution is unavailable in this context.`);
  return engineDeps;
};

// ----------------------------------------------------------------- model-backed calls

/** Default model understanding pass (deterministic floor when no model is configured). */
const modelUnderstanding: NonNullable<AutopilotDeps['understanding']> = async (description) => {
  const model = await getModel().catch(() => '');
  if (!model) return null;
  try {
    const r = await completeOnce(
      model,
      [
        { role: 'system', content: 'You extract structured project understanding. Reply with ONLY JSON.' },
        { role: 'user', content: understandingPrompt(description) },
      ],
      []
    );
    const m = r.content.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]) as ModelUnderstanding;
  } catch {
    return null;
  }
};

/** Default model planner (deterministic fallback when no model is configured). */
const modelPlanner: ModelPlanner = async (u) => {
  const model = await getModel().catch(() => '');
  if (!model) return null;
  try {
    const r = await completeOnce(
      model,
      [
        { role: 'system', content: 'You plan projects as milestone/task graphs. Reply with ONLY JSON.' },
        { role: 'user', content: planningPrompt(u) },
      ],
      []
    );
    return parseModelPlan(r.content);
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------- event helpers

const evt = (kind: ProjectEvent['kind'], message: string, refs?: Record<string, string>): ProjectEvent => ({
  id: `E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  at: Date.now(),
  kind,
  message: clip(message, 400),
  refs,
});

const projectActivity = (p: ProjectRecord, label: string, detail: string, status: 'busy' | 'ok' | 'fail' = 'busy'): void => {
  emitActivity({ kind: 'task', cid: `proj-${p.id}`, label: `${label} · ${p.id}`, detail: clip(detail, 200), status });
};

// ------------------------------------------------------------- understanding + plan

/** Full understanding pass: deterministic floor + optional model merge. */
export async function understandProject(
  description: string,
  opts?: { understanding?: AutopilotDeps['understanding'] }
): Promise<ProjectUnderstanding> {
  const floor = extractUnderstanding(description);
  const modelCall = opts?.understanding ?? engineDeps?.understanding ?? modelUnderstanding;
  let model: ModelUnderstanding | null = null;
  try {
    model = await modelCall(description);
  } catch {
    model = null;
  }
  return mergeUnderstanding(floor, model);
}

/** Attach each milestone's acceptance criteria to the milestone's LAST task, so the
 *  criteria are verified by the coordinator's verifier inside a real durable task. */
function attachMilestoneCriteria(milestones: ProjectRecord['milestones'], tasks: ProjectTask[]): void {
  for (const m of milestones) {
    if (!m.acceptance.length) continue;
    const own = m.taskIds.map((id) => tasks.find((t) => t.id === id)).filter((t): t is ProjectTask => !!t);
    const last = own[own.length - 1];
    if (!last) continue;
    const have = new Set(last.acceptance.map((c) => c.detail.toLowerCase()));
    for (const c of m.acceptance) if (!have.has(c.detail.toLowerCase())) last.acceptance.push(c);
  }
}

/** Build + validate + repair + activate a plan version (shared by create/replan/template). */
function activatePlan(
  raw: RawPlan,
  previousVersion: number,
  opts?: { preserve?: ProjectRecord['tasks']; note?: string }
): ReturnType<typeof buildPlan> & { repairs: string[]; issues: string[]; preservedTaskIds: string[] } {
  let built = buildPlan(raw, previousVersion);
  const v1 = validateProjectPlan(built.milestones, built.tasks, built.deliverables);
  let repairs: string[] = [];
  if (v1.issues.length && v1.repairable) {
    const r = repairPlan(built.milestones, built.tasks, built.deliverables);
    repairs = r.repairs;
    built = { ...built, milestones: r.milestones, tasks: r.tasks, deliverables: r.deliverables };
  }
  const v2 = validateProjectPlan(built.milestones, built.tasks, built.deliverables);
  attachMilestoneCriteria(built.milestones, built.tasks);
  // Preserve completed work from the previous plan version (by normalized title, exactly
  // like taskStore.replanSteps preserves durable-task steps).
  const preservedTaskIds: string[] = [];
  if (opts?.preserve?.length) {
    const byTitle = new Map(built.tasks.map((t) => [t.title.toLowerCase().replace(/\s+/g, ' ').trim(), t]));
    const usedIds = new Set(built.tasks.map((t) => t.id));
    for (const old of opts.preserve) {
      if (old.state !== 'completed') continue;
      const key = old.title.toLowerCase().replace(/\s+/g, ' ').trim();
      const fresh = byTitle.get(key);
      if (fresh) {
        // Copy the completed execution state verbatim — replanning never redoes it.
        fresh.state = 'completed';
        fresh.taskId = old.taskId;
        fresh.attempts = [...old.attempts];
        fresh.acceptance = [...fresh.acceptance, ...old.acceptance.filter((c) => !fresh.acceptance.some((x) => x.detail === c.detail))];
        preservedTaskIds.push(fresh.id);
      } else {
        // Completed task absent from the new plan: append verbatim under its milestone.
        // The id is REMAPPED on collision (a new pending task may already use it); edges
        // pointing at remapped ids are dropped below — completed dependencies are
        // satisfied by definition, never re-run.
        let id = old.id;
        if (usedIds.has(id)) id = `${old.id}v${previousVersion + 1}`;
        while (usedIds.has(id)) id = `${id}x`;
        usedIds.add(id);
        const m = built.milestones.find((x) => x.id === old.milestoneId) ?? built.milestones[0];
        m.taskIds.push(id);
        built.tasks.push({ ...old, id, milestoneId: m.id, dependsOn: [] });
        preservedTaskIds.push(id);
      }
    }
    // Drop dependency edges whose target vanished during the remap.
    const live = new Set(built.tasks.map((t) => t.id));
    for (const t of built.tasks) t.dependsOn = t.dependsOn.filter((d) => live.has(d) && d !== t.id);
  }
  const issues = v2.issues.map((i) => i.message);
  return { ...built, repairs, issues, preservedTaskIds };
}

// ------------------------------------------------------------------------ creation

export interface CreateOptions {
  templateId?: string;
  planner?: ModelPlanner;
  understanding?: AutopilotDeps['understanding'];
}

/** Create a project from a natural-language description (understanding + plan v1). */
export async function createProjectFromDescription(description: string, opts?: CreateOptions): Promise<ProjectRecord> {
  const text = String(description ?? '').trim();
  if (!text) throw new Error('NOT DONE: a project needs a description.');
  const template = opts?.templateId ? PROJECT_TEMPLATES.find((t) => t.id === opts.templateId) : undefined;
  const u = await understandProject(text, { understanding: opts?.understanding });
  if (template) {
    // Template seed fills the deterministic defaults the description did not provide
    // (provenance stays honest: 'default' for anything neither user nor model supplied).
    u.requirements = [...u.requirements.filter((r) => r !== 'fulfil the request as described'), ...template.seed.requirements ?? []].slice(0, 12);
    u.constraints = [...new Set([...u.constraints, ...template.seed.constraints ?? []])].slice(0, 12);
    u.assumptions = [...new Set([...u.assumptions, ...template.seed.assumptions ?? []])].slice(0, 12);
    u.successCriteria = [...new Set([...u.successCriteria, ...template.seed.successCriteria ?? []])].slice(0, 12);
    u.deliverables = [...new Set([...u.deliverables, ...template.seed.deliverables ?? []])].slice(0, 12);
    if (u.sources.category === 'default') u.category = template.category;
    if (u.sources.complexity === 'default') u.complexity = template.complexity;
  }
  const planner = opts?.planner ?? engineDeps?.planner ?? modelPlanner;
  let raw: RawPlan | null = null;
  try {
    raw = await planner(u);
  } catch {
    raw = null;
  }
  if (!raw || !raw.tasks?.length) raw = fallbackPlan(u);
  const built = activatePlan(raw, 0);
  const now = Date.now();
  const p: ProjectRecord = {
    id: newProjectId(),
    title: u.title,
    status: 'draft',
    understanding: u,
    // ROUND 31 (§5.1): the project is bound to the workspace it was created in — every
    // brief, profile read and continuity reconstruction uses THIS root.
    workspace: FILES_ROOT,
    milestones: built.milestones,
    tasks: built.tasks,
    deliverables: built.deliverables,
    verifications: [],
    decisions: [],
    events: [],
    planVersion: built.version,
    planHistory: [{ version: built.version, at: now, note: 'initial plan', repairs: built.repairs }],
    replans: 0,
    request: text,
    createdAt: now,
    updatedAt: now,
  };
  // The full birth history is assembled BEFORE the first save and durably appended in
  // ONE batched write (appendDurableEvents) — creation stays atomic and cheap.
  p.events = [evt('created', `project created from the description (${clip(text, 120)})`)];
  p.events.push(evt('understood', `understanding: ${clip(u.objective, 160)} · category ${u.category} · complexity ${u.complexity} · sources ${JSON.stringify(u.sources)}`));
  p.events.push(evt('planned', `plan v${built.version}: ${built.milestones.length} milestone(s), ${built.tasks.length} task(s), ${built.deliverables.length} deliverable expectation(s)${built.repairs.length ? ` · repaired: ${built.repairs.slice(0, 3).join('; ')}` : ''}${built.issues.length ? ` · REMAINING ISSUES: ${built.issues.slice(0, 3).join('; ')}` : ''}`));
  if (built.issues.length) {
    p.events.push(evt('note', `plan validation reported ${built.issues.length} issue(s) that could NOT be safely repaired — review before executing`));
  }
  p.decisions.push({
    id: `D-${now.toString(36)}-1`,
    at: now,
    text: `planned as ${u.category}/${u.complexity} with ${built.milestones.length} milestone(s) and ${built.tasks.length} task(s)`,
    source: 'planner',
  });
  await createProject(p);
  await appendDurableEvents(p.id, p.events); // one fsynced append for the whole birth history
  projectActivity(p, 'Project planned', `${built.tasks.length} task(s) ready`, 'ok');
  return p;
}

/** Create a project from a BUILT-IN template (description optional). */
export async function createProjectFromTemplate(templateId: string, description?: string): Promise<ProjectRecord> {
  const t = PROJECT_TEMPLATES.find((x) => x.id === String(templateId ?? '').trim());
  if (!t) throw new Error(`NOT DONE: unknown template "${clip(String(templateId), 40)}". Available: ${PROJECT_TEMPLATES.map((x) => x.id).join(', ')}.`);
  return createProjectFromDescription(description?.trim() || `${t.name}: ${t.description}`, { templateId: t.id });
}

// -------------------------------------------------------------- task-spec bridge

/**
 * THE ONLY bridge from a project task into the durable task system: compose the brief
 * and build a REAL TaskSpec (Round 21 Module A). Acceptance criteria and deliverable
 * paths ride inside the spec — the coordinator's verifier checks them exactly like the
 * criteria of any ordinary task. No project-specific spec fields exist.
 */
export function buildProjectTaskSpec(p: ProjectRecord, task: ProjectTask, failureContext?: string): TaskSpec {
  const milestone = p.milestones.find((m) => m.id === task.milestoneId);
  const deliverables = task.deliverableIds
    .map((id) => p.deliverables.find((d) => d.id === id))
    .filter((d): d is NonNullable<typeof d> => !!d)
    .map((d) => `${d.name} → MUST exist at ${d.path}`);
  const request = [
    `PROJECT TASK ${task.id} — "${task.title}" of project "${p.title}" (${p.id}, milestone "${milestone?.title ?? task.milestoneId}").`,
    p.workspace ? `PROJECT WORKSPACE: ${p.workspace} (inspect and modify ONLY this project's files).` : '',
    `INSTRUCTIONS: ${task.detail}`,
    task.expectedOutput ? `EXPECTED OUTPUT: ${task.expectedOutput}` : '',
    deliverables.length ? `DELIVERABLE FILES (write them with the ordinary file tools inside the Jarvis-Files workspace): ${deliverables.join(' | ')}` : '',
    p.understanding.constraints.length ? `PROJECT CONSTRAINTS: ${p.understanding.constraints.join('; ')}` : '',
    failureContext ? `PREVIOUS ATTEMPT FAILED. FAILURE CONTEXT (understand it and use a different, correct approach):\n${failureContext}` : '',
    'Acceptance is verified mechanically against reality (files, commands, evidence). Produce REAL artifacts — a claim without the artifact fails.',
  ]
    .filter(Boolean)
    .join('\n\n');
  const spec = buildTaskSpec(request);
  // The project layer's own criteria ride on top of the deterministic floor's criteria.
  spec.acceptance = [...task.acceptance];
  if (deliverables.length) {
    for (const d of p.deliverables.filter((x) => task.deliverableIds.includes(x.id))) {
      spec.acceptance.push({
        id: `file-exists-${d.id.toLowerCase()}`,
        kind: 'file-exists',
        detail: `the deliverable "${d.name}" exists at ${d.path}`,
        target: d.path,
      });
    }
  }
  spec.deliverables = deliverables.length ? [...spec.deliverables, ...deliverables] : spec.deliverables;
  return spec;
}

// ----------------------------------------------------------------- failure classification

/** Markers that identify a POLICY hard-restriction block (the two Round 21 limits).
 *  Covers every canonical blocked message the gate/policy/workspace layers emit, plus
 *  the gate's uppercase 'BLOCKED:' prefix (checked case-sensitively below — the gate
 *  uses it exclusively for hard blocks; ordinary failures stay lowercase). */
const POLICY_BLOCK_RE =
  /deletion is disabled|deleting is disabled|deleting files is disabled|operating-system|OS-protected|OS resource|that location is protected|fails closed|hard restriction|read-only for JARVIS|cannot be confirmed to be outside|could not be resolved on the filesystem|do not try another way|disabled on this laptop|python code blocked|protected \(operating-system|blocked by policy/i;
const POLICY_BLOCK_PREFIX = /\bBLOCKED:/;

export interface FailureClassification {
  class: 'policy-blocked' | 'transient' | 'permanent';
  evidence: string;
}

/**
 * Classify a durable task failure FROM ITS DURABLE RECORD (note, steps, verification) —
 * evidence-quoted, never guessed. A policy block is terminal for that task: it is never
 * retried, never bypassed through another agent/tool/process/browser, and the project
 * goes 'blocked' honestly.
 */
export function classifyFailure(t: TaskRecord): FailureClassification {
  const parts: string[] = [t.note ?? '', ...(t.steps ?? []).map((s) => s.result ?? ''), ...(t.verification?.results ?? []).map((r) => r.evidence ?? ''), t.spec.request.slice(-400)];
  const hay = parts.join('\n');
  const m = hay.match(POLICY_BLOCK_RE) ?? (POLICY_BLOCK_PREFIX.test(hay) ? ['BLOCKED:'] : null);
  if (m) return { class: 'policy-blocked', evidence: clip(m[0], 160) };
  // Everything else: the coordinator already retried the step internally; a task-level
  // failure is treated as TRANSIENT for the project's bounded retry budget, and becomes
  // permanent when the budget is exhausted.
  const reason = (t.steps ?? []).find((s) => s.status === 'failed')?.result ?? t.note ?? 'the task failed';
  return { class: 'transient', evidence: clip(reason, 240) };
}

const attemptBudget = (t: ProjectTask): number => 1 + Math.min(3, Math.max(0, t.retryMax));

// ------------------------------------------------------------------------- execution

/** In-flight dispatch guard (prevents double dispatch across overlapping ticks). */
const dispatching = new Set<string>();

/** Settle ONE running project task against its DURABLE record. Returns the new state. */
async function settleTask(p: ProjectRecord, task: ProjectTask): Promise<ProjectTaskState | null> {
  if (!task.taskId) return null;
  const t = await getTask(task.taskId);
  if (!t) {
    // The durable record is gone (never our doing — the task store prunes its own old
    // terminal records per Round 21 behavior): honest interruption, no fabricated state.
    task.state = 'interrupted';
    pushAttempt(p, task.id, { at: Date.now(), taskId: task.taskId, outcome: 'interrupted', reason: 'durable task record not found' });
    pushEvent(p, evt('task-interrupted', `task "${clip(task.title, 60)}": durable record missing — marked interrupted, explicit resume required`, { taskId: task.id }));
    return 'interrupted';
  }
  if (t.verdict === 'completed') {
    task.state = 'completed';
    pushAttempt(p, task.id, { at: Date.now(), taskId: t.id, outcome: 'completed' });
    pushEvent(p, evt('task-completed', `task "${clip(task.title, 60)}" COMPLETED (durable ${t.id}, verified by acceptance checks)`, { taskId: task.id, durableTaskId: t.id }));
    return 'completed';
  }
  if (t.status === 'INTERRUPTED') {
    task.state = 'interrupted';
    pushAttempt(p, task.id, { at: Date.now(), taskId: t.id, outcome: 'interrupted', reason: clip(t.note, 160) });
    pushEvent(p, evt('task-interrupted', `task "${clip(task.title, 60)}" was interrupted (${clip(t.note, 120)}) — explicit resume required`, { taskId: task.id, durableTaskId: t.id }));
    return 'interrupted';
  }
  if (t.status === 'CANCELLED') {
    task.state = 'skipped';
    pushAttempt(p, task.id, { at: Date.now(), taskId: t.id, outcome: 'cancelled', reason: 'cancelled' });
    pushEvent(p, evt('note', `task "${clip(task.title, 60)}" was cancelled`, { taskId: task.id }));
    return 'skipped';
  }
  if (t.status === 'FAILED' || (t.status === 'COMPLETED' && t.verdict && verdictOf(t) !== 'completed')) {
    const cls = classifyFailure(t);
    task.lastFailure = { at: Date.now(), class: cls.class, evidence: cls.evidence };
    if (cls.class === 'policy-blocked') {
      // THE POLICY IS AUTHORITATIVE: a hard restriction is not a transient failure.
      // No retry, no alternative route, no second agent — the project blocks honestly.
      task.state = 'blocked';
      pushAttempt(p, task.id, { at: Date.now(), taskId: t.id, outcome: 'blocked', reason: cls.evidence });
      pushEvent(p, evt('task-blocked', `task "${clip(task.title, 60)}" hit a POLICY hard restriction and will NOT be retried: ${cls.evidence}`, { taskId: task.id, durableTaskId: t.id }));
      return 'blocked';
    }
    pushAttempt(p, task.id, { at: Date.now(), taskId: t.id, outcome: 'failed', reason: cls.evidence });
    const used = task.attempts.filter((a) => a.outcome !== 'completed').length;
    if (used < attemptBudget(task)) {
      task.state = 'pending'; // bounded retry with failure context injected at dispatch
      pushEvent(p, evt('recovery', `task "${clip(task.title, 60)}" failed (${cls.class}): ${cls.evidence} — retry ${used}/${attemptBudget(task)} scheduled with failure context`, { taskId: task.id }));
      return 'pending';
    }
    task.state = 'failed';
    pushEvent(p, evt('task-failed', `task "${clip(task.title, 60)}" FAILED permanently after ${used} attempt(s): ${cls.evidence}`, { taskId: task.id, durableTaskId: t.id }));
    return 'failed';
  }
  return null; // still running
}

/** The honest completion check: every task completed + every required deliverable verified. */
function projectComplete(p: ProjectRecord): boolean {
  return p.tasks.length > 0 && p.tasks.every((t) => t.state === 'completed') && requiredDeliverablesVerified(p);
}

/** Verify the deliverables of the given task (append-only evidence) and record events. */
async function verifyTaskDeliverables(p: ProjectRecord, task: ProjectTask): Promise<void> {
  if (!task.deliverableIds.length) return;
  const fresh = await verifyProjectDeliverables(p, { });
  for (const v of fresh) {
    const d = p.deliverables.find((x) => x.id && task.deliverableIds.includes(x.id) && x.producingTaskId === task.id);
    if (!d) continue;
    p.verifications.push(v);
    p.verifications = p.verifications.slice(-300);
    pushEvent(
      p,
      evt(v.verdict === 'verified' ? 'deliverable-verified' : 'deliverable-missing', `deliverable "${d.name}" (${d.path}): ${v.verdict} — ${v.evidence}`, { deliverableId: d.id, taskId: task.id })
    );
  }
}

/** Tick ONE project: settle running tasks, dispatch eligible work, check completion. */
export async function tickProject(p: ProjectRecord, depsIn?: AutopilotDeps): Promise<void> {
  const deps = depsIn ?? engineDeps;
  if (!deps) return;
  void depsIn;
  const dispatchable = p.status === 'active';
  let changed = false;

  // 1. Settle everything running (ALSO while paused: the durable truth advances anyway).
  for (const task of p.tasks) {
    if (task.state !== 'running' || !task.taskId) continue;
    const key = `${p.id}:${task.id}`;
    if (dispatching.has(key)) continue;
    const before = task.state;
    const next = await settleTask(p, task);
    if (next) {
      changed = task.state !== before || next !== before;
      if (stateOf(task) === 'completed') await verifyTaskDeliverables(p, task);
    }
  }

  // 2. Milestone completions (evidence-based).
  for (const m of p.milestones) {
    const own = m.taskIds.map((id) => p.tasks.find((t) => t.id === id)).filter((t): t is ProjectTask => !!t);
    const done = own.length > 0 && own.every((t) => t.state === 'completed');
    if (done && !requiredDeliverablesVerified(p, { milestoneId: m.id })) continue;
    if (done && !p.events.some((e) => e.kind === 'milestone-completed' && e.refs?.milestoneId === m.id)) {
      pushEvent(p, evt('milestone-completed', `milestone "${clip(m.title, 80)}" completed: ${own.length} task(s) verified, deliverables verified`, { milestoneId: m.id }));
      projectActivity(p, 'Milestone completed', m.title, 'ok');
      changed = true;
    }
  }

  // 3. Dispatch (only when the project is active; capacity comes from THE coordinator).
  if (dispatchable) {
    const cap = await coordinatorCapacity();
    let free = cap.free;
    for (const task of p.tasks) {
      if (free <= 0) break;
      if (task.state !== 'pending') continue;
      const depsOk = task.dependsOn.every((d) => p.tasks.find((t) => t.id === d)?.state === 'completed');
      if (!depsOk) continue;
      const key = `${p.id}:${task.id}`;
      if (dispatching.has(key)) continue;
      dispatching.add(key);
      try {
        const failureContext = task.attempts.filter((a) => a.outcome === 'failed').slice(-1)[0]?.reason;
        const spec = buildProjectTaskSpec(p, task, failureContext);
        // ROUND 31 (§2.4/§5.4): the executing agent receives the PROJECT-RELEVANT profile
        // facts of the project's OWN workspace (bounded, keyword-ranked — never the whole
        // profile, never another project's context). Load, not refresh: the coordinator's
        // planning read already refreshes stale sections.
        if (p.workspace) {
          const profileCtx = await loadProjectProfile(p.workspace)
            .then((prof) => (prof ? relevantProfileContext(prof, `${task.title} ${task.detail} ${p.understanding.objective}`) : ''))
            .catch(() => '');
          if (profileCtx) spec.request = `${spec.request}\n\n${profileCtx}`.slice(0, 8000);
        }
        const r = await startTaskWithSpec(spec, deps.coordinator);
        if (!r.ok || !r.id) {
          pushEvent(p, evt('note', `dispatch of "${clip(task.title, 50)}" refused: ${clip(r.message, 160)}`));
          continue;
        }
        task.taskId = r.id;
        task.state = 'running';
        p.lastExecutedAt = Date.now();
        pushEvent(p, evt('task-dispatched', `task "${clip(task.title, 60)}" dispatched to the durable coordinator as ${r.id} (${spec.acceptance.length} acceptance check(s))`, { taskId: task.id, durableTaskId: r.id }));
        projectActivity(p, 'Project task started', task.title, 'busy');
        changed = true;
        free -= 1;
      } finally {
        dispatching.delete(key);
      }
    }
  }

  // 4. Completion / honest blocking.
  if (projectComplete(p) && p.status === 'active') {
    await transitionProject(p, 'completed', `all ${p.tasks.length} task(s) verified and every required deliverable verified on disk`);
    projectActivity(p, 'Project completed', p.title, 'ok');
    changed = true;
  } else if (p.status === 'active' && p.tasks.some((t) => t.state === 'failed' || t.state === 'blocked')) {
    const failed = p.tasks.filter((t) => t.state === 'failed');
    const blocked = p.tasks.filter((t) => t.state === 'blocked');
    if (blocked.length) {
      const b = blocked[0];
      await transitionProject(p, 'blocked', `blocked by a POLICY hard restriction on task "${clip(b.title, 60)}": ${b.lastFailure?.evidence ?? 'policy block'} — the restriction is never retried or bypassed`);
      changed = true;
    } else if (failed.length && p.replans < AUTO_REPLAN_BUDGET) {
      // One bounded automatic replan of the REMAINING work (completed work preserved).
      const replanned = await replanProject(p.id, `automatic recovery replan after permanent failure(s): ${failed.map((f) => clip(f.title, 40)).join(', ')}`, { deps });
      if (replanned.ok) changed = true;
      else {
        await transitionProject(p, 'blocked', `task(s) failed permanently and no replan was available: ${replanned.reason ?? 'planner unavailable'}`);
        changed = true;
      }
    } else if (failed.length) {
      await transitionProject(p, 'blocked', `task(s) failed permanently after the bounded retry budget: ${failed.map((f) => clip(f.title, 60)).join(', ')} — replan to recover`);
      changed = true;
    }
  }

  if (changed) p.updatedAt = Date.now();
}

/** Per-project tick mutex. The store's RMW lock must NEVER be held ACROSS a tick: the
 *  tick itself can update the same project (its bounded recovery replan and its status
 *  transitions), which would deadlock a held withStoreLock. Ticks are serialized per
 *  project in-process instead; different projects tick concurrently and saves are
 *  serialized by the shared withStoreLock as everywhere else. */
const tickingProjects = new Set<string>();

/** Persist-after-tick wrapper: tickProject mutates the cached record in place; the
 *  trailing updateProject persists it through the SAME serialized write path as every
 *  other writer (atomic temp+fsync+rename, no lost updates). */
export async function runProjectTick(id: string, deps?: AutopilotDeps): Promise<void> {
  if (tickingProjects.has(id)) return;
  tickingProjects.add(id);
  try {
    const p = await getProject(id);
    if (!p) return;
    await tickProject(p, deps);
    await updateProject(id, () => undefined); // persist the mutated record
  } catch {
    /* one broken tick must not stop the engine; the next tick reconciles from durable truth */
  } finally {
    tickingProjects.delete(id);
  }
}

let ticker: ReturnType<typeof setInterval> | null = null;
/** Start/stop the global engine ticker (wired at app startup; harmless in tests). */
export const startAutopilotTicker = (): void => {
  if (ticker) return;
  ticker = setInterval(() => {
    void (async () => {
      try {
        const all = await listProjects();
        for (const p of all) {
          if (p.status === 'active' || p.status === 'paused') await runProjectTick(p.id);
        }
      } catch {
        /* a tick must never crash the process */
      }
    })();
  }, TICK_MS);
};
export const stopAutopilotTicker = (): void => {
  if (ticker) clearInterval(ticker);
  ticker = null;
};

// ------------------------------------------------------------------- user controls

/** Start (or continue) executing a project. Legal from draft/paused/blocked/active. */
export async function executeProject(id: string, depsIn?: AutopilotDeps): Promise<string> {
  const deps = depsIn ?? needDeps('project execution');
  const from = (await getProject(id))?.status;
  if (!from) throw new Error(`NOT DONE: no project ${id}.`);
  const legal: ProjectStatus[] = ['draft', 'paused', 'blocked', 'active'];
  if (!legal.includes(from)) throw new Error(`NOT DONE: project ${id} is ${from} and cannot be started.`);
  await updateProject(id, (p) => transitionProject(p, 'active', from === 'active' ? 'execution confirmed active' : 'execution started by the user'));
  await runProjectTick(id, deps);
  const p = await getProject(id);
  return `Project ${id} is executing: ${p?.tasks.filter((t) => t.state === 'completed').length ?? 0}/${p?.tasks.length ?? 0} task(s) already verified. Progress is durable — check project status any time.`;
}

/** Pause: nothing new dispatches; running durable tasks settle (never silently killed). */
export async function pauseProject(id: string): Promise<string> {
  await updateProject(id, (p) => transitionProject(p, 'paused', 'paused by the user; running tasks finish, nothing new dispatches'));
  return `Project ${id} paused. Running tasks are allowed to settle; no new task will start until you resume.`;
}

/** Resume: explicit. Interrupted durable tasks are RESUMED (never re-planned from scratch —
 *  the coordinator keeps their completed steps), then scheduling continues. */
export async function resumeProject(id: string, depsIn?: AutopilotDeps): Promise<string> {
  const deps = depsIn ?? needDeps('project resume');
  const p0 = await getProject(id);
  if (!p0) throw new Error(`NOT DONE: no project ${id}.`);
  if (p0.status !== 'paused' && p0.status !== 'blocked' && p0.status !== 'active')
    throw new Error(`NOT DONE: project ${id} is ${p0.status} — only paused, blocked or active (restart-reconciled) projects resume.`);
  // An ACTIVE project after a restart reconciliation may carry interrupted tasks; the
  // explicit resume action below is what re-drives them. Paused/blocked transition first.
  if (p0.status !== 'active') await updateProject(id, (p) => transitionProject(p, 'active', 'resumed explicitly by the user'));
  const resumedIds: string[] = [];
  await updateProject(id, async (p) => {
    if (p.status !== 'active') await transitionProject(p, 'active', 'resumed explicitly by the user');
    for (const task of p.tasks) {
      if (task.state !== 'interrupted' || !task.taskId) continue;
      const r = await coordinatorResumeTask(task.taskId, deps.coordinator);
      if (r.startsWith('Task')) {
        task.state = 'running';
        resumedIds.push(task.taskId);
        pushEvent(p, evt('task-resumed', `durable task ${task.taskId} resumed from its persisted plan (completed steps preserved, no replan)`, { taskId: task.id, durableTaskId: task.taskId }));
      } else {
        pushEvent(p, evt('note', `resume of durable task ${task.taskId} refused: ${clip(r, 160)}`, { taskId: task.id }));
        task.state = 'pending'; // will re-dispatch as a bounded retry with failure context
      }
    }
  });
  await runProjectTick(id, deps);
  return `Project ${id} resumed.${resumedIds.length ? ` ${resumedIds.length} interrupted durable task(s) resumed from their persisted plans.` : ''}`;
}

/** Cancel: stop the world NOW, keep every record. Never deletes anything. */
export async function cancelProject(id: string): Promise<string> {
  let cancelled = 0;
  await updateProject(id, async (p) => {
    for (const task of p.tasks) {
      if (task.state === 'running' && task.taskId) {
        if (cancelTask(task.taskId)) cancelled += 1;
        pushAttempt(p, task.id, { at: Date.now(), taskId: task.taskId, outcome: 'cancelled', reason: 'project cancelled by the user' });
        task.state = 'skipped';
      } else if (task.state === 'pending' || task.state === 'interrupted') {
        task.state = 'skipped';
        if (task.state === 'skipped') pushEvent(p, evt('note', `task "${clip(task.title, 50)}" will not run (project cancelled)`));
      }
    }
    await transitionProject(p, 'cancelled', `cancelled by the user after ${p.tasks.filter((t) => t.state === 'completed').length} verified task(s); all records preserved`);
  });
  return `Project ${id} cancelled${cancelled ? ` (${cancelled} running task(s) stopped at the next step boundary)` : ''}. All progress, events and deliverables are preserved.`;
}

// ------------------------------------------------------------------- replanning

export interface ReplanResult { ok: boolean; version?: number; reason?: string }

/**
 * Replan the REMAINING work into a NEW plan version. Completed tasks are preserved
 * verbatim (never re-executed); the previous version is archived durably BEFORE the
 * new one activates; validation runs on the new plan and only safe repairs are applied
 * (all reported). The engine's AUTOMATIC replans are bounded (AUTO_REPLAN_BUDGET);
 * user-triggered replans are explicit intent and additionally recorded as decisions.
 */
export async function replanProject(id: string, note: string, opts?: { deps?: AutopilotDeps; userTriggered?: boolean; extraRequirements?: string[]; removeRequirements?: string[] }): Promise<ReplanResult> {
  const deps = opts?.deps ?? needDeps('project replanning');
  const p0 = await getProject(id);
  if (!p0) throw new Error(`NOT DONE: no project ${id}.`);
  if (TERMINAL_CHECK.has(p0.status)) return { ok: false, reason: `project is ${p0.status}` };
  if (!opts?.userTriggered && p0.replans >= AUTO_REPLAN_BUDGET) return { ok: false, reason: 'the automatic replan budget is exhausted (bounded recovery)' };

  // Requirement updates ride along when provided (decision-recorded, contradiction-aware).
  if (opts?.extraRequirements?.length || opts?.removeRequirements?.length) {
    applyRequirementChanges(p0, opts.extraRequirements ?? [], opts.removeRequirements ?? []);
  }

  const remaining = p0.tasks.filter((t) => t.state !== 'completed');
  const failed = remaining.filter((t) => t.state === 'failed' || t.state === 'blocked');
  let raw: RawPlan | null = null;
  // One unified replanner shape: user-triggered replans may fall back to the full
  // model planner; automatic recovery replans use ONLY the injected deterministic one
  // (a bounded recovery must not depend on a live model being present).
  const replanCall: (p: ProjectRecord, failed: ProjectTask[]) => Promise<RawPlan | null> =
    opts?.userTriggered
      ? async (p) => ((deps.replanner ?? engineDeps?.planner ?? modelPlanner) as (u: ProjectRecord['understanding']) => Promise<RawPlan | null>)(p.understanding)
      : deps.replanner ?? (async () => null);
  try {
    raw = await replanCall(p0, failed);
  } catch {
    raw = null;
  }
  if (!raw || !raw.tasks?.length) {
    // Round 20 discipline, at project scale: a replanner that produced NOTHING is not a
    // strategy. An AUTOMATIC recovery without an injected replanner must NOT blind-carry
    // the failed work forward (that is the identical-plan trap — it just repeats the
    // failure); the honest bounded failure stands and the project blocks. A USER-triggered
    // replan is explicit intent: carrying the remaining work forward under a fresh,
    // re-validated version (with failure context) is exactly what the user asked for.
    if (!opts?.userTriggered) return { ok: false, reason: 'no replanner available for the automatic recovery (a blind retry adds nothing — replan explicitly to re-attempt)' };
    raw = {
      milestones: p0.milestones.map((m) => ({ id: m.id, title: m.title, detail: m.detail, acceptance: [] })),
      tasks: p0.tasks
        .filter((t) => t.state !== 'completed')
        .map((t) => ({
          id: t.id,
          title: t.title,
          detail: `${t.detail}${t.lastFailure ? `\n\nPREVIOUS ATTEMPT NOTE (${t.lastFailure.class}): ${t.lastFailure.evidence} — choose a DIFFERENT approach where it applies.` : ''}`,
          kind: t.kind,
          milestone: t.milestoneId,
          dependsOn: t.dependsOn.filter((d) => p0.tasks.find((x) => x.id === d)?.state === 'completed' ? false : true),
          expectedOutput: t.expectedOutput,
          acceptance: t.acceptance.map((c) => ({ kind: c.kind, detail: c.detail, target: c.target, min: c.min })),
          deliverables: t.deliverableIds.map((did) => {
            const d = p0.deliverables.find((x) => x.id === did);
            return d ? { name: d.name, path: d.path, format: d.format } : undefined;
          }).filter((d): d is { name: string; path: string; format: string } => !!d),
        })),
    };
    if (!raw.tasks.length) return { ok: false, reason: 'no remaining work to replan' };
  }

  // Archive the CURRENT version durably BEFORE activating the new one (history preserved).
  const before = p0.planVersion;
  const result = await updateProject(id, (p) => {
    const built = activatePlan(raw!, p.planVersion, { preserve: p.tasks, note });
    p.milestones = built.milestones;
    p.tasks = built.tasks;
    p.deliverables = built.deliverables;
    p.planVersion = built.version;
    pushPlanHistory(p, { version: built.version, at: Date.now(), note: clip(note || 'replan', 160), repairs: built.repairs });
    p.events.push(evt('plan-version', `plan v${before} → v${built.version}: ${built.tasks.length} task(s), ${built.preservedTaskIds.length} completed task(s) preserved verbatim${built.repairs.length ? `; repairs: ${built.repairs.slice(0, 3).join('; ')}` : ''}`));
    if (!opts?.userTriggered) p.replans += 1;
    p.decisions.push({
      id: `D-${Date.now().toString(36)}-r${p.planVersion}`,
      at: Date.now(),
      text: `replanned to v${built.version}: ${clip(note || 'recovery replan', 200)}`,
      source: opts?.userTriggered ? 'user' : 'engine',
    });
    p.status = p.status === 'active' ? 'active' : p.status; // transition validated elsewhere
    p.updatedAt = Date.now();
    return built.version;
  });
  return { ok: true, version: result };
}

const TERMINAL_CHECK = new Set<ProjectStatus>(['completed', 'failed', 'cancelled']);

/** Requirement updates: mutate understanding + decision records with contradiction marking. */
function applyRequirementChanges(p: ProjectRecord, added: string[], removed: string[]): void {
  const now = Date.now();
  const words = (s: string): Set<string> => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const jac = (a: string, b: string): number => {
    const A = words(a);
    const B = words(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter += 1;
    return inter / (A.size + B.size - inter);
  };
  for (const add of added) {
    const text = clip(String(add), 200);
    if (!text) continue;
    // CONTRADICTION DETECTION: a new requirement that heavily overlaps an earlier
    // decision/requirement supersedes it (marked, kept — history is never deleted).
    const superseded: string[] = [];
    for (const d of p.decisions) {
      if (!d.supersededBy && jac(text, d.text) > 0.6) {
        d.supersededBy = `D-${now.toString(36)}-u${p.decisions.length + 1}`;
        superseded.push(d.id);
      }
    }
    const rec: DecisionRecord = {
      id: `D-${now.toString(36)}-u${p.decisions.length + 1}`,
      at: now,
      text,
      source: 'user',
      supersedes: superseded.length ? superseded : undefined,
    };
    p.decisions.push(rec);
    p.understanding.requirements = [...p.understanding.requirements, text].slice(0, 16);
    p.events.push(evt('note', `requirement updated: "${text}"${superseded.length ? ` (supersedes ${superseded.length} earlier record(s))` : ''}`));
  }
  for (const rem of removed) {
    const key = clip(String(rem), 200);
    p.understanding.requirements = p.understanding.requirements.filter((r) => !r.toLowerCase().includes(key.toLowerCase()));
    p.decisions.push({ id: `D-${now.toString(36)}-x${p.decisions.length + 1}`, at: now, text: `requirement removed: "${key}"`, source: 'user' });
    p.events.push(evt('note', `requirement removed: "${key}"`));
  }
}

/** Explicit requirement update from the UI/tools (records decisions, triggers a user replan). */
export async function updateRequirements(id: string, patch: { add?: string[]; remove?: string[]; note?: string }): Promise<string> {
  const add = (Array.isArray(patch.add) ? patch.add : []).map((s) => clip(String(s), 200)).filter(Boolean);
  const remove = (Array.isArray(patch.remove) ? patch.remove : []).map((s) => clip(String(s), 200)).filter(Boolean);
  if (!add.length && !remove.length) throw new Error('NOT DONE: provide at least one requirement to add or remove.');
  await updateProject(id, (p) => {
    applyRequirementChanges(p, add, remove);
    p.events.push(evt('note', `requirements updated by the user${patch.note ? ` — ${clip(patch.note, 120)}` : ''}`));
  });
  const r = await replanProject(id, `requirements update: ${add.length} added, ${remove.length} removed`, { userTriggered: true });
  return `Requirements updated${r.ok ? ` and project replanned to v${r.version} (completed work preserved)` : ` (replan: ${r.reason ?? 'unavailable'})`}.`;
}

// ------------------------------------------------------------ restart reconciliation

export interface ReconcileReport {
  projects: number;
  recompleted: number;
  interrupted: number;
  blocked: number;
  completed: number;
}

/**
 * RESTART RECONCILIATION (§3.6/§7): recompute every non-terminal project from the
 * DURABLE task records — the in-memory task state is never authoritative when the
 * durable store disagrees. Interrupted work stays interrupted (EXPLICIT resume);
 * completed work is never re-dispatched; deliverables are RE-VERIFIED on disk.
 */
export async function reconcileOnStartup(): Promise<ReconcileReport> {
  const report: ReconcileReport = { projects: 0, recompleted: 0, interrupted: 0, blocked: 0, completed: 0 };
  const all = await listProjects();
  for (const p0 of all) {
    if (TERMINAL_CHECK.has(p0.status)) continue;
    report.projects += 1;
    try {
      await updateProject(p0.id, async (p) => {
        for (const task of p.tasks) {
          if (!task.taskId) continue; // never dispatched: pending stays pending
          const t = await getTask(task.taskId);
          if (!t) {
            if (task.state === 'running') {
              task.state = 'interrupted';
              pushEvent(p, evt('task-interrupted', `durable record for "${clip(task.title, 50)}" not found after restart — interrupted, explicit resume required`, { taskId: task.id }));
              report.interrupted += 1;
            }
            continue;
          }
          if (t.verdict === 'completed' && task.state !== 'completed') {
            // The DURABLE store says completed — the cache was stale. Trust the record.
            task.state = 'completed';
            pushAttempt(p, task.id, { at: Date.now(), taskId: t.id, outcome: 'completed', reason: 'reconciled from the durable record at restart' });
            pushEvent(p, evt('recovery', `reconciled "${clip(task.title, 60)}" → completed from the durable task record (no work duplicated)`, { taskId: task.id, durableTaskId: t.id }));
            report.recompleted += 1;
          } else if (t.status === 'INTERRUPTED' && task.state !== 'interrupted') {
            task.state = 'interrupted';
            pushEvent(p, evt('task-interrupted', `"${clip(task.title, 50)}" was interrupted by the restart — explicit resume required`, { taskId: task.id }));
            report.interrupted += 1;
          } else if (t.status === 'FAILED' && task.state === 'running') {
            const cls = classifyFailure(t);
            if (cls.class === 'policy-blocked') {
              task.state = 'blocked';
              task.lastFailure = { at: Date.now(), class: 'policy-blocked', evidence: cls.evidence };
              report.blocked += 1;
              pushEvent(p, evt('task-blocked', `reconciled "${clip(task.title, 50)}" → blocked by a policy hard restriction (${cls.evidence}) — never retried`, { taskId: task.id }));
            } else {
              task.state = 'pending';
              task.lastFailure = { at: Date.now(), class: cls.class, evidence: cls.evidence };
              pushEvent(p, evt('recovery', `reconciled "${clip(task.title, 50)}" → pending (bounded retry available; failure context preserved)`, { taskId: task.id }));
            }
          } else if (t.status === 'CANCELLED' && task.state === 'running') {
            task.state = 'skipped';
          }
        }
        // Deliverables of now-completed tasks are re-verified on disk (honest evidence).
        for (const task of p.tasks) {
          if (task.state === 'completed' && task.deliverableIds.length) await verifyTaskDeliverables(p, task);
        }
        // Project completion from DURABLE truth + fresh disk verification only.
        if (projectComplete(p) && p.status !== 'completed') {
          await transitionProject(p, 'completed', 'reconciled complete from durable task records + fresh deliverable verification');
          report.completed += 1;
        } else if (p.tasks.some((t) => t.state === 'blocked') && p.status !== 'blocked') {
          const b = p.tasks.find((t) => t.state === 'blocked')!;
          await transitionProject(p, 'blocked', `reconciled after restart: task "${clip(b.title, 60)}" is policy-blocked (${b.lastFailure?.evidence ?? 'policy block'})`);
          report.blocked += 1;
        }
        p.updatedAt = Date.now();
      });
    } catch {
      /* one broken project must not stop the reconciliation of the others */
    }
  }
  return report;
}

// ---------------------------------------------------------------------- status text

/** Ground-truth status block for tools/UI: derived from the record + durable truth. */
export function projectStatusText(p: ProjectRecord): string {
  const done = p.tasks.filter((t) => t.state === 'completed').length;
  const lines = [
    `PROJECT ${p.id} [${p.status}] — ${p.title} (plan v${p.planVersion})`,
    `${done}/${p.tasks.length} task(s) completed · ${p.milestones.length} milestone(s) · ${p.deliverables.length} deliverable expectation(s)`,
    p.workspace ? `WORKSPACE: ${p.workspace}` : '',
    p.blockReason ? `BLOCKED/FAILED: ${p.blockReason}` : '',
    ...p.milestones.map((m) => {
      const own = m.taskIds.map((id) => p.tasks.find((t) => t.id === id)).filter((t): t is ProjectTask => !!t);
      const d = own.filter((t) => t.state === 'completed').length;
      return `  ${m.id} [${d}/${own.length}] ${m.title}`;
    }),
    ...p.tasks.map((t) => `  ${t.id} [${t.state}${t.taskId ? ` · durable ${t.taskId}` : ''}] ${clip(t.title, 70)}${t.lastFailure ? ` — last failure (${t.lastFailure.class}): ${clip(t.lastFailure.evidence, 100)}` : ''}`),
    `DELIVERABLES: ${p.deliverables.length ? p.deliverables.map((d) => clip(d.name, 30)).join(', ') : 'none planned'}`,
    `DECISIONS: ${p.decisions.length} on record · EVENTS: ${p.events.length} embedded (full history durable on disk)`,
  ];
  return lines.filter(Boolean).join('\n');
}

// ------------------------------------------------------- continuity + suggestions (R31)

/**
 * ROUND 31 (§5.4) — PROJECT CONTINUITY BRIEFING: reconstruct what a returning user (or a
 * fresh planning context) needs to know, from PERSISTED state only — never from invented
 * progress. Distinguishes actual persisted facts (verified tasks, verified deliverables)
 * from expectations (pending plan items). Bounded and deterministic.
 *
 * ROUND 32 (§4.4) — WORKFLOW CONTINUITY: the briefing also distinguishes UNKNOWN
 * external outcomes (side effects whose result was never confirmed — from the durable
 * workflow journal) and names the LAST DURABLE CHECKPOINT, so a resumed project and the
 * task coordinator agree on actual state. A milestone is never called complete because a
 * model once reported DONE: only verified task states count.
 */
export function projectBriefing(p: ProjectRecord, workflow?: { unknownOutcomes: number; lastCheckpoint?: string }): string {
  const completed = p.tasks.filter((t) => t.state === 'completed');
  const remaining = p.tasks.filter((t) => t.state === 'pending' || t.state === 'running' || t.state === 'interrupted');
  const failed = p.tasks.filter((t) => t.state === 'failed' || t.state === 'blocked' || t.state === 'skipped');
  const verifiedDeliverables = new Set(p.verifications.filter((v) => v.verdict === 'verified').map((v) => v.producingTaskId));
  const verifiedCount = p.deliverables.filter((d) => verifiedDeliverables.has(d.producingTaskId)).length;
  const decisions = p.decisions.filter((d) => !d.supersededBy).slice(-5);
  // "What changed since the last session": the durable events of the most recent activity
  // window (bounded to the last 10) — the honest reconstruction, not a fabricated diff.
  const recentEvents = p.events.slice(-10);
  const currentMilestone = p.milestones.find((m) => {
    const own = m.taskIds.map((id) => p.tasks.find((t) => t.id === id)).filter((t): t is ProjectTask => !!t);
    return own.length > 0 && own.some((t) => t.state !== 'completed');
  });
  const lines = [
    `PROJECT BRIEFING — ${p.title} (${p.id}) [${p.status}], plan v${p.planVersion}`,
    `WHAT IT IS: ${clip(p.understanding.objective, 220)}`,
    p.workspace ? `WORKSPACE: ${p.workspace}` : '',
    `WHERE IT STANDS: ${completed.length}/${p.tasks.length} task(s) verified complete · ${verifiedCount}/${p.deliverables.length} deliverable(s) verified on disk · ${failed.length} failed/blocked/skipped`,
    currentMilestone ? `CURRENT MILESTONE: ${currentMilestone.title} (${currentMilestone.taskIds.length} task(s))` : 'CURRENT MILESTONE: none open',
    completed.length ? `COMPLETED WORK: ${completed.map((t) => clip(t.title, 50)).slice(0, 6).join(' · ')}` : 'COMPLETED WORK: none yet',
    remaining.length ? `REMAINING: ${remaining.map((t) => `${clip(t.title, 50)} (${t.state})`).slice(0, 6).join(' · ')}` : 'REMAINING: nothing pending',
    failed.length ? `NEEDS ATTENTION: ${failed.map((t) => `${clip(t.title, 44)}${t.lastFailure ? ` — ${clip(t.lastFailure.evidence, 80)}` : ''}`).slice(0, 4).join(' · ')}` : '',
    workflow?.unknownOutcomes ? `UNKNOWN EXTERNAL OUTCOMES: ${workflow.unknownOutcomes} side effect(s) whose result was never confirmed — RECONCILE against the real external system before retrying or trusting the recorded state` : '',
    workflow?.lastCheckpoint ? `LAST DURABLE CHECKPOINT: ${clip(workflow.lastCheckpoint, 180)}` : '',
    decisions.length ? `KEY DECISIONS: ${decisions.map((d) => clip(d.text, 80)).join(' · ')}` : '',
    recentEvents.length ? `RECENT ACTIVITY:\n${recentEvents.map((e) => `  ${new Date(e.at).toISOString().slice(0, 16).replace('T', ' ')} [${e.kind}] ${clip(e.message, 110)}`).join('\n')}` : '',
    `NEXT RECOMMENDED ACTION: ${nextActionSuggestion(p, workflow?.unknownOutcomes ?? 0)}`,
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * ROUND 31 (§5.5) — the next sensible action, derived from the record's ACTUAL state.
 * Suggestions only: nothing here executes anything, and a consequential action is never
 * taken just because a project objective exists — the user stays in control. Pure.
 *
 * ROUND 32 (§4.4): unknown external outcomes outrank routine dispatch — an unresolved
 * side effect must be reconciled against the real system before anything else runs.
 */
export function nextActionSuggestion(p: ProjectRecord, unknownOutcomes = 0): string {
  if (unknownOutcomes > 0) return `reconcile ${unknownOutcomes} unknown external outcome(s) against the real system FIRST — a side effect whose result was never confirmed must be verified (or explicitly abandoned) before any retry or further dispatch`;
  const blocked = p.tasks.filter((t) => t.state === 'blocked');
  if (p.status === 'blocked' && blocked.length)
    return `review the policy block on "${clip(blocked[0].title, 50)}" (${clip(blocked[0].lastFailure?.evidence ?? p.blockReason ?? 'policy restriction', 90)}) — a block is only lifted by an explicit user decision`;
  if (p.status === 'draft') return 'review the plan and start it with project_execute when ready';
  if (p.status === 'paused') return 'resume with project_resume when you want work to continue';
  const failed = p.tasks.filter((t) => t.state === 'failed');
  if (failed.length) return `replan the remaining work (project_replan) to recover from "${clip(failed[0].title, 50)}"`;
  const interrupted = p.tasks.filter((t) => t.state === 'interrupted');
  if (interrupted.length) return `resume the interrupted task "${clip(interrupted[0].title, 50)}" (project_resume)`;
  if (p.status === 'active') {
    const pending = p.tasks.filter((t) => t.state === 'pending');
    if (pending.length) return `dispatched work continues automatically — next up: "${clip(pending[0].title, 50)}"`;
    if (p.tasks.some((t) => t.state === 'running')) return 'running tasks are settling — check project_status for live progress';
  }
  if (p.status === 'completed') return 'project verified complete — nothing outstanding';
  const stale = Date.now() - p.updatedAt > 14 * 86_400_000;
  if (stale) return 'no activity for over two weeks — re-verify the deliverables (project_deliverables) before relying on recorded state';
  return 'check project_status for the exact remaining work';
}
