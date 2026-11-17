/**
 * PROJECT VIEWS (Round 22, §3.8) — bounded, shape-safe projections of project records
 * for the IPC surface. Views are read-only; they never mutate, never leak credentials
 * (project records never contain any) and never expose raw unbounded payloads.
 *
 * Pagination is NON-DESTRUCTIVE: pages select which records are RETURNED to the UI, and
 * every hidden project stays fully on disk and loadable (listProjects returns all of
 * them; a hidden project is one page away, or one search hit away).
 */

import { listProjects, readDurableEvents, getProject } from './store';
import { deliverableStatusLine } from './deliverables';
import { nextActionSuggestion, projectBriefing } from './engine';
import { lastCheckpoint, sideEffectsFor } from '../workflowJournal';
import type { ProjectEvent, ProjectRecord, ProjectStatus, ProjectTaskState } from './types';

export interface ProjectSummaryView {
  id: string;
  title: string;
  status: ProjectStatus;
  category: string;
  complexity: string;
  planVersion: number;
  createdAt: number;
  updatedAt: number;
  tasksTotal: number;
  tasksCompleted: number;
  tasksBlocked: number;
  tasksFailed: number;
  milestones: Array<{ id: string; title: string; done: number; total: number; /** ROUND 31 (§5.2): honest milestone state — derived from ITS tasks, never a percentage. */ state: 'completed' | 'in_progress' | 'blocked' | 'pending' }>;
  deliverables: number;
  deliverablesVerified: number;
  blockReason?: string;
  /** ROUND 31 (§5.1): the workspace this project is associated with. */
  workspace?: string;
  /** ROUND 31 (§5.5): the next sensible action, derived from real state — suggestion only. */
  nextAction: string;
}

export interface ProjectTaskView {
  id: string;
  title: string;
  state: ProjectTaskState;
  kind: string;
  milestoneId: string;
  dependsOn: string[];
  durableTaskId?: string;
  acceptanceCount: number;
  deliverableIds: string[];
  attempts: number;
  lastFailure?: { at: number; class: string; evidence: string };
  expectedOutput?: string;
}

export interface ProjectDetailView {
  summary: ProjectSummaryView;
  objective: string;
  summaryText: string;
  requirements: string[];
  constraints: string[];
  assumptions: string[];
  outOfScope: string[];
  successCriteria: string[];
  request: string;
  understandingSources: Record<string, string>;
  tasks: ProjectTaskView[];
  deliverables: Array<{ id: string; name: string; path: string; format: string; required: boolean; producingTaskId: string; milestoneId: string; statusLine: string }>;
  decisions: Array<{ id: string; at: number; text: string; source: string; supersededBy?: string; supersedes?: string[] }>;
  events: ProjectEvent[];
  planHistory: Array<{ version: number; at: number; note: string; repairs: string[] }>;
  replans: number;
  /** ROUND 31 (§5.4): the continuity briefing — what it is, what stands, what remains,
   *  decisions, recent activity and the recommended next action. Persisted state only. */
  briefing: string;
}

const clip = (s: string, n: number): string => String(s ?? '').slice(0, n);

/**
 * ROUND 32 (§4.4) — WORKFLOW CONTINUITY for one project: the unknown external outcomes
 * and the last durable checkpoint of the project's durable tasks, read from the workflow
 * journal (persisted evidence, not model claims). Bounded reads; failures read as
 * "nothing recorded" — never as verified success.
 */
export async function workflowContinuity(p: ProjectRecord): Promise<{ unknownOutcomes: number; lastCheckpoint?: string }> {
  const durableTaskIds = new Set(p.tasks.map((t) => t.taskId).filter((x): x is string => !!x));
  if (!durableTaskIds.size) return { unknownOutcomes: 0 };
  const [effects, checkpoint] = await Promise.all([
    sideEffectsFor({}, 60).catch(() => []),
    Promise.all([...durableTaskIds].map((id) => lastCheckpoint({ taskId: id }).catch(() => undefined))),
  ]);
  const unknown = effects.filter((e) => e.outcome === 'unknown' || e.kind === 'unknown-outcome').length;
  const checkpoints = checkpoint.filter((c): c is NonNullable<typeof c> => !!c).sort((a, b) => b.at - a.at);
  const last = checkpoints[0];
  return { unknownOutcomes: unknown, lastCheckpoint: last ? `${new Date(last.at).toISOString().slice(0, 16).replace('T', ' ')} — ${last.stage}: ${last.detail}` : undefined };
}

/** Alias used by the autopilot tools (§4.4 continuity in project_briefing). */
export const projectWorkflowContinuity = workflowContinuity;

export async function toSummaryView(p: ProjectRecord): Promise<ProjectSummaryView> {
  const completed = p.tasks.filter((t) => t.state === 'completed').length;
  const verifiedDeliverables = new Set(p.verifications.filter((v) => v.verdict === 'verified').map((v) => v.producingTaskId));
  const workflow = await workflowContinuity(p);
  return {
    id: p.id,
    title: clip(p.title, 120),
    status: p.status,
    category: p.understanding.category,
    complexity: p.understanding.complexity,
    planVersion: p.planVersion,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    tasksTotal: p.tasks.length,
    tasksCompleted: completed,
    tasksBlocked: p.tasks.filter((t) => t.state === 'blocked').length,
    tasksFailed: p.tasks.filter((t) => t.state === 'failed').length,
    milestones: p.milestones.map((m) => {
      const own = m.taskIds.map((id) => p.tasks.find((t) => t.id === id)).filter((t): t is ProjectRecord['tasks'][number] => !!t);
      const done = own.filter((t) => t.state === 'completed').length;
      // ROUND 31 (§5.2): milestone state from ACTUAL task states — blocked means a
      // dispatchable task failed/blocked and the rest cannot proceed; progress is never
      // an arbitrary percentage.
      const failedOrBlocked = own.filter((t) => t.state === 'failed' || t.state === 'blocked').length;
      const state: 'completed' | 'in_progress' | 'blocked' | 'pending' =
        own.length > 0 && done === own.length ? 'completed' : failedOrBlocked > 0 && done < own.length ? 'blocked' : done > 0 ? 'in_progress' : own.some((t) => t.state === 'running' || t.state === 'pending') ? 'in_progress' : 'pending';
      return { id: m.id, title: clip(m.title, 80), done, total: own.length, state };
    }),
    deliverables: p.deliverables.length,
    deliverablesVerified: p.deliverables.filter((d) => verifiedDeliverables.has(d.producingTaskId)).length,
    blockReason: p.blockReason ? clip(p.blockReason, 400) : undefined,
    workspace: p.workspace ? clip(p.workspace, 200) : undefined,
    nextAction: nextActionSuggestion(p, workflow.unknownOutcomes),
  };
}

export async function toDetailView(p: ProjectRecord, durableEvents?: ProjectEvent[]): Promise<ProjectDetailView> {
  const summary = await toSummaryView(p);
  const workflow = await workflowContinuity(p);
  return {
    summary,
    objective: clip(p.understanding.objective, 400),
    summaryText: clip(p.understanding.summary, 1200),
    requirements: p.understanding.requirements.slice(0, 16),
    constraints: p.understanding.constraints.slice(0, 16),
    assumptions: p.understanding.assumptions.slice(0, 16),
    outOfScope: p.understanding.outOfScope.slice(0, 16),
    successCriteria: p.understanding.successCriteria.slice(0, 16),
    request: clip(p.request, 4000),
    understandingSources: p.understanding.sources as unknown as Record<string, string>,
    tasks: p.tasks.map((t) => ({
      id: t.id,
      title: clip(t.title, 160),
      state: t.state,
      kind: t.kind,
      milestoneId: t.milestoneId,
      dependsOn: [...t.dependsOn],
      durableTaskId: t.taskId,
      acceptanceCount: t.acceptance.length,
      deliverableIds: [...t.deliverableIds],
      attempts: t.attempts.length,
      lastFailure: t.lastFailure ? { at: t.lastFailure.at, class: t.lastFailure.class, evidence: clip(t.lastFailure.evidence, 200) } : undefined,
      expectedOutput: t.expectedOutput ? clip(t.expectedOutput, 200) : undefined,
    })),
    deliverables: p.deliverables.map((d) => ({
      id: d.id,
      name: clip(d.name, 80),
      path: clip(d.path, 300),
      format: clip(d.format, 12),
      required: d.required,
      producingTaskId: d.producingTaskId,
      milestoneId: d.milestoneId,
      statusLine: deliverableStatusLine(p, d),
    })),
    decisions: p.decisions.map((d) => ({ id: d.id, at: d.at, text: clip(d.text, 300), source: d.source, supersededBy: d.supersededBy, supersedes: d.supersedes })),
    events: durableEvents?.length ? durableEvents.slice(-100) : p.events.slice(-100),
    planHistory: p.planHistory.slice(-20),
    replans: p.replans,
    briefing: projectBriefing(p, workflow),
  };
}

export interface ProjectListResult {
  total: number;
  offset: number;
  limit: number;
  projects: ProjectSummaryView[];
  /** Status buckets across ALL projects (pagination-independent). */
  counts: Record<ProjectStatus | 'all', number>;
}

/** Non-destructive pagination + search over ALL projects (nothing is ever filtered out
 *  of persistence — only out of one page). */
export async function listProjectViews(opts?: { offset?: number; limit?: number; query?: string; status?: ProjectStatus }): Promise<ProjectListResult> {
  const all = await listProjects();
  const counts: Record<string, number> = { all: all.length };
  for (const p of all) counts[p.status] = (counts[p.status] ?? 0) + 1;
  const q = (opts?.query ?? '').trim().toLowerCase();
  let filtered = all;
  if (opts?.status) filtered = filtered.filter((p) => p.status === opts.status);
  if (q) filtered = filtered.filter((p) => `${p.title} ${p.understanding.objective} ${p.request}`.toLowerCase().includes(q));
  const offset = Math.max(0, Math.floor(opts?.offset ?? 0));
  const limit = Math.min(50, Math.max(1, Math.floor(opts?.limit ?? 12)));
  const views = await Promise.all(filtered.slice(offset, offset + limit).map((p) => toSummaryView(p)));
  return {
    total: filtered.length,
    offset,
    limit,
    projects: views,
    counts: counts as ProjectListResult['counts'],
  };
}

/** One detail view (with the FULL durable event history folded in). */
export async function projectDetailView(id: string): Promise<ProjectDetailView | null> {
  const p = await getProject(id);
  if (!p) return null;
  const durable = await readDurableEvents(id).catch(() => [] as ProjectEvent[]);
  return toDetailView(p, durable);
}
