/**
 * PROJECT PLANNER (Round 22, §3.2) — hierarchical plan generation, validation, repair.
 *
 * Generates milestones → tasks → (deliverable expectations) with dependencies, agent
 * kinds and acceptance criteria; VALIDATES the graph before anything executes; repairs
 * ONLY what is safe to repair and reports every repair (never silent); versions plans
 * and preserves previous versions durably (archivePlanVersion in store.ts).
 *
 * Validation detects (mirroring the Round 19 plan-graph contract of taskStore.ts, at
 * PROJECT scale):
 *   - dependency cycles
 *   - missing dependency references
 *   - duplicate task ids or titles where unique titles are required
 *   - invalid milestone references
 *   - tasks without meaningful completion criteria (no acceptance and no deliverable)
 *   - orphaned deliverables (producingTaskId not in the plan)
 *   - invalid structures (empty titles, empty plans, tasks outside any milestone)
 *
 * The model planner is INJECTED (tests inject deterministic planners; the engine passes
 * a completeOnce-based one). Without one, a deterministic fallback plan is built from
 * the understanding — a project can always be planned, and the plan always says what
 * it is.
 */

import type { AcceptanceCriterion } from '../taskSpec';
import { AGENT_KINDS, type AgentKind } from '../orchestrate';
import type { DeliverableExpectation, Milestone, ProjectTask, ProjectUnderstanding } from './types';

const clip = (s: unknown, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ raw plan shapes

export interface RawTask {
  id?: string;
  title: string;
  detail?: string;
  kind?: string;
  milestone?: string;
  dependsOn?: string[];
  expectedOutput?: string;
  acceptance?: Array<{ kind?: string; detail: string; target?: string; min?: number }>;
  deliverables?: Array<{ name?: string; path?: string; format?: string; required?: boolean }>;
  retryMax?: number;
}

export interface RawMilestone {
  id?: string;
  title: string;
  detail?: string;
  acceptance?: Array<{ kind?: string; detail: string; target?: string; min?: number }>;
}

export interface RawPlan {
  milestones: RawMilestone[];
  tasks: RawTask[];
}

/** The injected model planner signature (tests inject; engine passes a model call). */
export type ModelPlanner = (u: ProjectUnderstanding) => Promise<RawPlan | null>;

// --------------------------------------------------------------------- acceptance

const CRITERION_KINDS: AcceptanceCriterion['kind'][] = ['file-exists', 'file-nonempty', 'file-format', 'command-passes', 'evidence-present', 'sources-present', 'custom'];

const sanitizeCriterion = (c: { kind?: string; detail: string; target?: string; min?: number }, i: number): AcceptanceCriterion | null => {
  const detail = clip(c?.detail, 200);
  if (!detail || detail.length < 5) return null;
  const kind = CRITERION_KINDS.includes(c?.kind as AcceptanceCriterion['kind']) ? (c.kind as AcceptanceCriterion['kind']) : 'custom';
  return {
    id: `${kind}-p${Math.random().toString(36).slice(2, 8)}${i}`,
    kind,
    detail,
    target: typeof c?.target === 'string' && c.target.trim() ? clip(c.target, 300) : undefined,
    min: typeof c?.min === 'number' && Number.isFinite(c.min) && c.min > 0 ? Math.round(c.min) : undefined,
  };
};

const sanitizeCriteria = (list: Array<{ kind?: string; detail: string; target?: string; min?: number }> | undefined): AcceptanceCriterion[] =>
  (Array.isArray(list) ? list : []).map(sanitizeCriterion).filter((c): c is AcceptanceCriterion => !!c).slice(0, 8);

// ------------------------------------------------------------------- plan building

export interface BuiltPlan {
  milestones: Milestone[];
  tasks: ProjectTask[];
  deliverables: DeliverableExpectation[];
  version: number;
}

let planSeq = 0;
const resetSeq = (): void => {
  planSeq = 0;
};
/** Test hook: reset id sequencing so plans built in tests have stable ids. */
export const resetPlannerForTests = (): void => resetSeq();

/** Build a validated, normalized plan from raw milestones+tasks. Pure; does NOT save. */
export function buildPlan(raw: RawPlan, previousVersion = 0): BuiltPlan {
  const milestones: Milestone[] = [];
  const seenMilestoneIds = new Set<string>();
  (Array.isArray(raw?.milestones) ? raw.milestones : []).slice(0, 8).forEach((m, i) => {
    const title = clip(m?.title, 120);
    if (!title) return;
    let id = clip(String(m?.id ?? ''), 24).replace(/[^\w-]/g, '') || `M-${i + 1}`;
    while (seenMilestoneIds.has(id) || /^P-/.test(id)) id = `M-${i + 1}-${planSeq++}`;
    seenMilestoneIds.add(id);
    milestones.push({
      id,
      title,
      detail: clip(m?.detail ?? title, 400),
      taskIds: [],
      acceptance: sanitizeCriteria(m?.acceptance),
      deliverableIds: [],
    });
  });
  if (!milestones.length) {
    milestones.push({ id: 'M-1', title: 'Delivery', detail: 'The single milestone that delivers the project.', taskIds: [], acceptance: [], deliverableIds: [] });
  }
  const milestoneById = new Map(milestones.map((m) => [m.id, m]));

  const tasks: ProjectTask[] = [];
  const seenIds = new Set<string>();
  const seenTitles = new Set<string>();
  const deliverables: DeliverableExpectation[] = [];
  const rawTasks = (Array.isArray(raw?.tasks) ? raw.tasks : []).slice(0, 40);
  // PRE-PASS: finalize ids and titles FIRST so dependency references (by id OR by
  // original title) can map to the final task identities in the build pass below.
  interface FinalSpec { raw: RawTask; id: string; title: string }
  const finalSpecs: FinalSpec[] = [];
  rawTasks.forEach((t, i) => {
    const title = clip(t?.title, 160);
    if (!title) return;
    let id = clip(String(t?.id ?? ''), 24).replace(/[^\w-]/g, '') || `PT-${i + 1}`;
    while (seenIds.has(id)) id = `PT-${i + 1}-${planSeq++}`;
    seenIds.add(id);
    // Duplicate titles are prohibited where identity matters: disambiguate with a
    // numbered suffix (the validation layer reports the original duplicate first).
    let finalTitle = title;
    if (seenTitles.has(norm(finalTitle))) {
      let n = 2;
      let candidate = `${title} (${n})`;
      while (seenTitles.has(norm(candidate))) candidate = `${title} (${++n})`;
      finalTitle = candidate;
    }
    seenTitles.add(norm(finalTitle));
    finalSpecs.push({ raw: t, id, title: finalTitle });
  });
  const idOfTitle = new Map<string, string>();
  for (const s of finalSpecs) idOfTitle.set(norm(s.title), s.id);

  finalSpecs.forEach((spec, i) => {
    const t = spec.raw;
    const id = spec.id;
    const finalTitle = spec.title;
    const kind = AGENT_KINDS.includes(t?.kind as AgentKind) ? (t.kind as AgentKind) : 'general';
    const milestone = milestoneById.get(clip(String(t?.milestone ?? ''), 24)) ?? milestoneById.get(milestones[Math.min(i, milestones.length - 1)].id)!;
    milestone.taskIds.push(id);
    const acceptance = sanitizeCriteria(t?.acceptance);
    const deliverableIds: string[] = [];
    for (const d of Array.isArray(t?.deliverables) ? t.deliverables : []) {
      const name = clip(d?.name, 80);
      const p = clip(d?.path, 300);
      if (!name || !p) continue;
      const did = `D-${planSeq++}-${deliverables.length + 1}`;
      deliverables.push({
        id: did,
        name,
        path: p,
        producingTaskId: id,
        format: clip(d?.format ?? p.split('.').pop() ?? '', 12),
        required: d?.required !== false,
        milestoneId: milestone.id,
      });
      deliverableIds.push(did);
      milestone.deliverableIds.push(did);
    }
    // DEPENDENCIES: entries may be ids OR original titles; resolvable ones map to the
    // final ids. UNRESOLVABLE and self references are kept VERBATIM so the validation
    // layer reports them and the repair layer drops them WITH A REPAIR LINE — planning
    // errors are never silently discarded at build time.
    const deps = (Array.isArray(t?.dependsOn) ? t.dependsOn : [])
      .map((d) => {
        const key = String(d).trim();
        if (!key) return '';
        if (finalSpecs.some((x) => x.id === key)) return key;
        return idOfTitle.get(norm(key)) ?? key; // unknown: kept for validation to report
      })
      .filter((d) => d);
    tasks.push({
      id,
      title: finalTitle,
      detail: clip(t?.detail ?? finalTitle, 4000),
      kind,
      dependsOn: [...new Set(deps)],
      expectedOutput: t?.expectedOutput ? clip(t.expectedOutput, 400) : undefined,
      acceptance,
      deliverableIds,
      milestoneId: milestone.id,
      retryMax: typeof t?.retryMax === 'number' && t.retryMax >= 0 ? Math.min(3, Math.round(t.retryMax)) : 1,
      state: 'pending',
      attempts: [],
    });
  });
  if (!tasks.length) {
    const m = milestones[0];
    m.taskIds.push('PT-1');
    tasks.push({
      id: 'PT-1',
      title: 'Do the work',
      detail: `Produce the project outcome: ${clip(m.detail, 200)}`,
      kind: 'general',
      dependsOn: [],
      acceptance: sanitizeCriteria(m.acceptance),
      deliverableIds: [],
      milestoneId: m.id,
      retryMax: 1,
      state: 'pending',
      attempts: [],
    });
  }
  return { milestones, tasks, deliverables, version: previousVersion + 1 };
}

// ---------------------------------------------------------------------- validation

export interface PlanIssue {
  kind: 'cycle' | 'missing-dep' | 'duplicate-id' | 'duplicate-title' | 'invalid-milestone' | 'no-criteria' | 'orphaned-deliverable' | 'invalid-structure';
  message: string;
  taskId?: string;
  milestoneId?: string;
}

export interface PlanValidation {
  issues: PlanIssue[];
  /** true when the plan can execute after repairs (or was already sound). */
  repairable: boolean;
}

/** THE project-plan validator. Pure; runs before every plan version activates. */
export function validateProjectPlan(milestones: Milestone[], tasks: ProjectTask[], deliverables: DeliverableExpectation[]): PlanValidation {
  const issues: PlanIssue[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const titleCount = new Map<string, number>();
  for (const t of tasks) titleCount.set(norm(t.title), (titleCount.get(norm(t.title)) ?? 0) + 1);
  const milestoneIds = new Set(milestones.map((m) => m.id));
  const duplicateId = new Set<string>();
  const idCount = new Map<string, number>();
  for (const t of tasks) idCount.set(t.id, (idCount.get(t.id) ?? 0) + 1);
  for (const [id, n] of idCount) if (n > 1) duplicateId.add(id);

  for (const t of tasks) {
    if (!t.title?.trim() || !t.milestoneId) issues.push({ kind: 'invalid-structure', message: `task "${clip(t.title, 40)}" has an invalid structure (empty title or missing milestone)`, taskId: t.id });
    if (duplicateId.has(t.id)) issues.push({ kind: 'duplicate-id', message: `duplicate task id "${t.id}"`, taskId: t.id });
    if ((titleCount.get(norm(t.title)) ?? 0) > 1 && tasks.length > 1) issues.push({ kind: 'duplicate-title', message: `duplicate task title "${clip(t.title, 60)}"`, taskId: t.id });
    for (const d of t.dependsOn) {
      if (!byId.has(d)) issues.push({ kind: 'missing-dep', message: `task "${clip(t.title, 40)}" depends on "${d}" which does not exist`, taskId: t.id });
      else if (d === t.id) issues.push({ kind: 'cycle', message: `task "${clip(t.title, 40)}" depends on itself`, taskId: t.id });
    }
    if (!milestoneIds.has(t.milestoneId)) issues.push({ kind: 'invalid-milestone', message: `task "${clip(t.title, 40)}" references milestone "${t.milestoneId}" which does not exist`, taskId: t.id });
    if (!t.acceptance.length && !t.deliverableIds.length)
      issues.push({ kind: 'no-criteria', message: `task "${clip(t.title, 40)}" has no acceptance criteria and no expected deliverable — completion could never be verified`, taskId: t.id });
  }
  for (const d of deliverables) {
    if (!byId.has(d.producingTaskId)) issues.push({ kind: 'orphaned-deliverable', message: `deliverable "${d.name}" (${d.path}) has producing task "${d.producingTaskId}" which does not exist`, taskId: d.producingTaskId });
    else if (!d.path?.trim()) issues.push({ kind: 'invalid-structure', message: `deliverable "${d.name}" has no output path` });
  }
  for (const m of milestones) {
    for (const tid of m.taskIds) if (!byId.has(tid)) issues.push({ kind: 'invalid-milestone', message: `milestone "${clip(m.title, 40)}" lists task "${tid}" which does not exist`, milestoneId: m.id });
    if (!m.taskIds.length) issues.push({ kind: 'invalid-structure', message: `milestone "${clip(m.title, 40)}" contains no tasks`, milestoneId: m.id });
  }
  if (!tasks.length) issues.push({ kind: 'invalid-structure', message: 'the plan contains no tasks' });

  // Cycle detection over the honored edges (DFS with colors), reported as node chains.
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const dfs = (u: string): void => {
    color.set(u, 1);
    stack.push(u);
    for (const v of byId.get(u)?.dependsOn ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 1) cycles.push([...stack.slice(stack.indexOf(v)), v]);
      else if (c === 0 && byId.has(v)) dfs(v);
    }
    stack.pop();
    color.set(u, 2);
  };
  for (const t of tasks) if ((color.get(t.id) ?? 0) === 0) dfs(t.id);
  for (const cyc of cycles) {
    const names = cyc.map((id) => byId.get(id)?.title ?? id);
    issues.push({ kind: 'cycle', message: `circular dependency: ${names.join(' → ')}` });
  }

  const structural = issues.filter((i) => i.kind === 'invalid-structure' && i.message.includes('the plan contains no tasks'));
  return { issues, repairable: issues.length === 0 || (structural.length === 0 && issues.every((i) => i.kind !== 'invalid-structure')) };
}

// ------------------------------------------------------------------ safe repair

export interface RepairReport {
  repairs: string[];
  milestones: Milestone[];
  tasks: ProjectTask[];
  deliverables: DeliverableExpectation[];
}

/**
 * Repair ONLY what is safe, and report every repair. Safe repairs:
 *  - drop dependency edges to nonexistent tasks (missing-dep);
 *  - drop self-edges;
 *  - break cycles by dropping the back-edge that closes the loop (the plan stays a DAG
 *    — identical to Round 21's normalizePlan discipline);
 *  - re-point tasks whose milestone id is invalid onto their positional milestone;
 *  - detach orphaned deliverables from the plan (REMOVED FROM THE CURRENT PLAN, not
 *    deleted from history — the archived plan versions keep the original);
 *  - add an evidence-present criterion to tasks without any verifiable completion
 *    criterion (a task must be verifiable to be honest; evidence-present is the minimal
 *    honest check, and it FAILS when no tool evidence exists).
 * Unsafe (never auto-repaired, surfaces as an issue): an empty plan.
 */
export function repairPlan(milestones: Milestone[], tasks: ProjectTask[], deliverables: DeliverableExpectation[]): RepairReport {
  const repairs: string[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const milestoneIds = new Set(milestones.map((m) => m.id));

  // 1. Dependency edges: drop missing/self references.
  for (const t of tasks) {
    const before = [...t.dependsOn];
    t.dependsOn = t.dependsOn.filter((d) => d !== t.id && byId.has(d));
    for (const d of before) if (!byId.has(d)) repairs.push(`dropped dependency "${clip(t.title, 40)}" → "${d}" (target does not exist)`);
      else if (d === t.id) repairs.push(`dropped self-dependency on "${clip(t.title, 40)}"`);
  }

  // 2. Cycles: find a cycle DIRECTLY on the edge graph (never parse report strings) and
  // drop the back-edge that closes it; repeat until acyclic (bounded) — the plan stays a
  // DAG, identical to Round 21's normalizePlan discipline, and every break is reported.
  const findCycle = (): string[] | null => {
    const color = new Map<string, 0 | 1 | 2>();
    const stack: string[] = [];
    let found: string[] | null = null;
    const dfs = (u: string): void => {
      if (found) return;
      color.set(u, 1);
      stack.push(u);
      for (const v of byId.get(u)?.dependsOn ?? []) {
        if (found) return;
        const c = color.get(v) ?? 0;
        if (c === 1 && stack.includes(v)) {
          found = [...stack.slice(stack.indexOf(v)), v];
          return;
        }
        if (c === 0 && byId.has(v)) dfs(v);
      }
      stack.pop();
      color.set(u, 2);
    };
    for (const t of tasks) {
      if (found) break;
      if ((color.get(t.id) ?? 0) === 0) dfs(t.id);
    }
    return found;
  };
  for (let guard = 0; guard < 16; guard++) {
    const cyc = findCycle();
    if (!cyc || cyc.length < 2) break;
    const from = byId.get(cyc[cyc.length - 2]);
    const to = cyc[cyc.length - 1];
    if (!from || !from.dependsOn.includes(to)) break;
    from.dependsOn = from.dependsOn.filter((d) => d !== to);
    repairs.push(`broke circular dependency by dropping edge "${clip(from.title, 40)}" → "${clip(byId.get(to)?.title ?? to, 40)}"`);
  }

  // 3. Invalid milestone references: re-point to a positional milestone.
  tasks.forEach((t, i) => {
    if (!milestoneIds.has(t.milestoneId)) {
      const fallback = milestones[Math.min(i, milestones.length - 1)];
      repairs.push(`task "${clip(t.title, 40)}" referenced unknown milestone "${t.milestoneId}" — re-pointed to "${fallback.id}"`);
      t.milestoneId = fallback.id;
    }
  });

  // 4. Milestone task lists must reference real tasks; tasks must appear in exactly one.
  const owned = new Map<string, string>(); // taskId -> milestoneId
  for (const m of milestones) {
    m.taskIds = m.taskIds.filter((tid) => byId.has(tid));
    for (const tid of m.taskIds) owned.set(tid, m.id);
  }
  for (const t of tasks) {
    const cur = owned.get(t.id);
    if (!cur) {
      const m = milestones.find((x) => x.id === t.milestoneId) ?? milestones[0];
      m.taskIds.push(t.id);
      owned.set(t.id, m.id);
      repairs.push(`task "${clip(t.title, 40)}" was outside every milestone — attached to "${m.id}"`);
    } else if (cur !== t.milestoneId) {
      t.milestoneId = cur;
    }
  }
  for (const m of milestones) {
    if (!m.taskIds.length) {
      const firstFree = tasks.find((t) => owned.get(t.id) === m.id) ?? tasks[0];
      if (firstFree) {
        m.taskIds.push(firstFree.id);
        firstFree.milestoneId = m.id;
        repairs.push(`milestone "${clip(m.title, 40)}" was empty — attached task "${clip(firstFree.title, 40)}"`);
      }
    }
  }

  // 5. Orphaned deliverables: detach from the CURRENT plan (history keeps the original).
  const liveDeliverables = deliverables.filter((d) => {
    if (byId.has(d.producingTaskId) && d.path?.trim()) return true;
    repairs.push(`detached orphaned deliverable "${d.name}" (producing task "${d.producingTaskId}" is not in the plan; expectation kept out of the active plan only)`);
    for (const m of milestones) m.deliverableIds = m.deliverableIds.filter((x) => x !== d.id);
    for (const t of tasks) t.deliverableIds = t.deliverableIds.filter((x) => x !== d.id);
    return false;
  });

  // 6. Tasks without verifiable completion criteria get the minimal honest check.
  for (const t of tasks) {
    if (!t.acceptance.length && !t.deliverableIds.length) {
      t.acceptance.push({
        id: `evidence-present-p${Math.random().toString(36).slice(2, 8)}`,
        kind: 'evidence-present',
        detail: `tool evidence in this task confirms "${clip(t.title, 60)}" actually happened`,
      });
      repairs.push(`added an evidence-present criterion to "${clip(t.title, 40)}" (no verifiable completion criteria were planned)`);
    }
  }

  return { repairs, milestones, tasks, deliverables: liveDeliverables };
}

// ------------------------------------------------------------------- fallback plan

/** The deterministic floor plan (used when no model planner is available/usable). */
export function fallbackPlan(u: ProjectUnderstanding): RawPlan {
  const tasks: RawTask[] = [];
  const deliverableNames = u.deliverables.length ? u.deliverables : ['the project outcome file'];
  tasks.push({
    id: 'PT-1',
    title: 'Prepare the groundwork',
    detail: `Project: ${u.title}. Objective: ${u.objective}. Gather/verify anything the work depends on${u.assumptions.length ? `; check the assumptions: ${u.assumptions.slice(0, 3).join('; ')}` : ''}.`,
    kind: u.category === 'research' ? 'research' : 'explore',
    milestone: 'M-1',
    dependsOn: [],
    acceptance: [{ kind: 'evidence-present', detail: 'the groundwork facts were verified with real tools' }],
  });
  tasks.push({
    id: 'PT-2',
    title: 'Do the core work',
    detail: `Project: ${u.title}. Objective: ${u.objective}. Requirements: ${u.requirements.join('; ')}. Constraints: ${u.constraints.join('; ') || 'none stated'}. Deliverables: ${deliverableNames.join('; ')}.`,
    kind: u.category === 'content' ? 'document' : u.category === 'data' ? 'data' : 'general',
    milestone: 'M-1',
    dependsOn: ['PT-1'],
    acceptance: [{ kind: 'evidence-present', detail: `the work for "${clip(u.objective, 80)}" is done and evidenced` }],
    deliverables: deliverableNames.slice(0, 3).map((n, i) => ({ name: `Primary deliverable ${i + 1}: ${clip(n, 40)}`, path: `projects/${u.category}/${u.title.toLowerCase().replace(/[^\w]+/g, '-').slice(0, 30)}/deliverable-${i + 1}.md`, format: 'md' })),
  });
  tasks.push({
    id: 'PT-3',
    title: 'Verify and close out',
    detail: `Verify the deliverables and the success criteria: ${u.successCriteria.join('; ')}. Report evidence, not intentions.`,
    kind: 'verifier',
    milestone: 'M-1',
    dependsOn: ['PT-2'],
    acceptance: [{ kind: 'evidence-present', detail: 'every deliverable was checked on disk and the results were reported honestly' }],
  });
  return {
    milestones: [{ id: 'M-1', title: 'Deliver the project', detail: u.objective, acceptance: [] }],
    tasks,
  };
}

// -------------------------------------------------------------- model output parse

/** Parse the model's plan JSON (untrusted). Returns null when nothing usable remains. */
export function parseModelPlan(text: string): RawPlan | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as Record<string, unknown>;
    const milestones = Array.isArray(v.milestones) ? (v.milestones as RawMilestone[]) : [];
    const tasks = Array.isArray(v.tasks) ? (v.tasks as RawTask[]) : [];
    if (!tasks.length) return null;
    return { milestones, tasks };
  } catch {
    return null;
  }
}

/** The planning prompt (exported for the engine's model call and for tests). */
export const planningPrompt = (u: ProjectUnderstanding): string =>
  [
    'You plan a project: MILESTONES and TASKS as a dependency graph. Reply with ONLY JSON:',
    '{"milestones": [{"id": "M-1"-style, "title", "detail", "acceptance": [{"kind": "file-exists"|"file-nonempty"|"file-format"|"command-passes"|"evidence-present"|"sources-present"|"custom", "detail", "target?", "min?"}]}],',
    ' "tasks": [{"id": "PT-1"-style unique, "title", "detail": COMPLETE self-contained instructions, "kind": "explore"|"research"|"general"|"document"|"browser"|"verifier"|"desktop"|"data"|"coder"|"reviewer"|"tester"|"planner",',
    '  "milestone": the milestone id, "dependsOn": [task ids that MUST be fully done first], "expectedOutput": one line,',
    '  "acceptance": [{"kind", "detail", "target?", "min?"}], "deliverables": [{"name", "path": relative path under the Jarvis-Files workspace where the artifact MUST be written, "format"}]}]}.',
    'Rules: every task needs at least one acceptance criterion or deliverable; no dependency cycles; a task that needs another task output MUST list it in dependsOn; independent tasks declare explicit dependsOn: [].',
    'The LAST task of the project must have kind "verifier" and check the success criteria.',
    '',
    `PROJECT: ${u.title}`,
    `OBJECTIVE: ${u.objective}`,
    `REQUIREMENTS: ${u.requirements.join('; ') || 'as described'}`,
    `CONSTRAINTS: ${u.constraints.join('; ') || 'none stated'}`,
    `SUCCESS CRITERIA: ${u.successCriteria.join('; ')}`,
    `DELIVERABLES: ${u.deliverables.join('; ') || 'as appropriate'}`,
    `CATEGORY: ${u.category} · COMPLEXITY: ${u.complexity}`,
  ].join('\n');
