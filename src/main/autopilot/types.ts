/**
 * PROJECT AUTOPILOT (Round 22) — type model.
 *
 * A project is a long-lived, user-visible unit of work above the durable task layer:
 * understanding → plan (milestones → tasks) → execution through the ONE Round 21
 * coordinator → deliverables verified against the disk → honest completion.
 *
 * Non-negotiable boundaries (Round 21 authoritative, never re-implemented here):
 *  - Project tasks are REAL durable tasks (taskStore/coordinator). There is no second
 *    coordinator, no second agent engine, no parallel tool runner and no separate
 *    permission system: every side effect flows through runTool → permission service
 *    → durable records exactly like ordinary JARVIS work.
 *  - Project records are USER DATA. Deletion of user data is hard restriction A of the
 *    single policy: this layer NEVER deletes, prunes or evicts project records, files,
 *    decisions, deliverables or plan history — not at startup, not in the background,
 *    not for "old" or "terminal" records, ever.
 *  - Path security stays in policy.ts/workspace.ts (tri-state classifyRealPath,
 *    resolveWrite, revalidateWriteTarget). The project layer adds no allowlist and no
 *    override; it performs no user-data writes of its own.
 */

import type { AcceptanceCriterion, TaskSpec } from '../taskSpec';
import type { AgentKind } from '../orchestrate';

// ----------------------------------------------------------------------- statuses

/** Project lifecycle. 'blocked' is an HONEST state: required work cannot proceed
 *  (policy block, permanent failure, exhausted recovery). It is terminal-until-user:
 *  only an explicit user action (resume with replan, requirement update) may leave it. */
export type ProjectStatus =
  | 'draft' // understanding + plan exist, never started
  | 'active' // scheduling/running
  | 'paused' // user-paused; running tasks may settle, nothing new dispatches
  | 'blocked' // honest blocked state (policy block / permanent failure / no recovery left)
  | 'completed' // every required milestone + deliverable ACTUALLY verified
  | 'failed' // terminal failure with the reason preserved
  | 'cancelled'; // user-cancelled; partial progress preserved verbatim

/** Execution state of ONE project task (distinct from the durable task's own status). */
export type ProjectTaskState =
  | 'pending' // not dispatched yet (dependencies, capacity)
  | 'running' // dispatched to the coordinator; durable task exists
  | 'completed' // durable task verdict === 'completed'
  | 'failed' // durable task failed permanently (non-policy)
  | 'blocked' // durable task hit a policy hard restriction — NEVER retried
  | 'interrupted' // durable task INTERRUPTED (restart/stall); needs explicit resume
  | 'skipped'; // cannot run in this plan version (its dependency chain failed)

export const TERMINAL_PROJECT_STATUSES: ProjectStatus[] = ['completed', 'failed', 'cancelled'];

// ------------------------------------------------------------------- understanding

export type ProjectCategory =
  | 'software'
  | 'content'
  | 'research'
  | 'data'
  | 'operations'
  | 'general';

export type ProjectComplexity = 'light' | 'standard' | 'complex';

/** The structured understanding of a natural-language project description.
 *  Every field is either user-derived, model-derived-with-source, or a DETERMINISTIC
 *  DEFAULT — the model is never trusted with invented certainty, and assumptions
 *  stay assumptions (labelled, never silently promoted to requirements). */
export interface ProjectUnderstanding {
  title: string;
  objective: string;
  summary: string;
  requirements: string[];
  constraints: string[];
  assumptions: string[];
  outOfScope: string[];
  successCriteria: string[];
  deliverables: string[];
  category: ProjectCategory;
  complexity: ProjectComplexity;
  /** Where each part came from: 'user' | 'model' | 'default' — honesty about provenance. */
  sources: UnderstandingSources;
  understoodAt: number;
}

export interface UnderstandingSources {
  title: 'user' | 'model' | 'default';
  objective: 'user' | 'model' | 'default';
  summary: 'model' | 'default';
  requirements: 'user' | 'model' | 'default';
  constraints: 'user' | 'model' | 'default';
  assumptions: 'user' | 'model' | 'default';
  outOfScope: 'user' | 'model' | 'default';
  successCriteria: 'model' | 'default';
  deliverables: 'user' | 'model' | 'default';
  category: 'model' | 'default';
  complexity: 'model' | 'default';
}

// -------------------------------------------------------------------------- plan

/** One milestone: a required, nameable chunk of the project whose completion is
 *  decided by ACTUAL verification, never by an agent's confidence. */
export interface Milestone {
  id: string;
  title: string;
  detail: string;
  /** Project-task ids that belong to this milestone. */
  taskIds: string[];
  /** Milestone-level acceptance criteria (verified at milestone completion). */
  acceptance: AcceptanceCriterion[];
  /** Deliverable expectations tied to this milestone (deliverable ids). */
  deliverableIds: string[];
}

/** One unit of project work. Execution goes through startTaskWithSpec() — a REAL
 *  durable JARVIS task with its own durable id, steps, agent activity, tool receipts
 *  and verification. The project layer only tracks and schedules; it never executes. */
export interface ProjectTask {
  id: string;
  title: string;
  /** Complete, self-contained brief for the executing agent. */
  detail: string;
  /** Registry agent kind for the step (orchestrate.AgentKind). */
  kind: AgentKind;
  /** Project-task ids that must be completed BEFORE this one dispatches. */
  dependsOn: string[];
  /** What this task must produce when it succeeds. */
  expectedOutput?: string;
  /** Acceptance criteria verified by the coordinator's verifier (Round 21 Module H). */
  acceptance: AcceptanceCriterion[];
  /** Deliverable ids this task is expected to produce. */
  deliverableIds: string[];
  /** Milestone this task belongs to (a task belongs to exactly one milestone). */
  milestoneId: string;
  /** Per-dispatch retry budget (bounded; policy blocks NEVER consume it). */
  retryMax: number;
  /** LIVE execution state (mirrors + extends the durable task's status). */
  state: ProjectTaskState;
  /** The DURABLE coordinator task id once dispatched (real JARVIS task). */
  taskId?: string;
  /** Bounded attempt history: dispatches, outcomes, failure classification. */
  attempts: Array<{
    at: number;
    taskId: string;
    outcome: 'completed' | 'failed' | 'blocked' | 'interrupted' | 'cancelled';
    reason?: string;
  }>;
  /** Last failure classification (engine-derived, evidence-quoted). */
  lastFailure?: { at: number; class: 'transient' | 'permanent' | 'policy-blocked'; evidence: string };
}

export interface DeliverableExpectation {
  id: string;
  name: string;
  /** Workspace-relative (FILES_ROOT) or absolute path where the artifact must exist. */
  path: string;
  /** Which project task produces it (must exist in the plan — no orphaned deliverables). */
  producingTaskId: string;
  /** File extension used by the format check (verifier.fileFormatOk). */
  format: string;
  required: boolean;
  /** Milestone this deliverable is tied to. */
  milestoneId: string;
}

/** ONE verified snapshot of a deliverable (append-only history; verification is
 *  re-run, never mutated — evidence stays auditable). */
export interface DeliverableVerification {
  at: number;
  exists: boolean;
  readable: boolean;
  bytes: number | null;
  formatOk: boolean | null; // null = no structural validator for this extension (honest unknown)
  formatEvidence: string;
  sha256: string | null;
  producingTaskId: string | null;
  /** The durable task that produced it has verdict 'completed'. */
  producedByVerifiedTask: boolean;
  verdict: 'verified' | 'missing' | 'unreadable' | 'invalid-format' | 'unverified';
  evidence: string;
}

// ----------------------------------------------------------------- decisions + events

export interface DecisionRecord {
  id: string;
  at: number;
  text: string;
  /** Id of the decision that supersedes this one (kept — history is never deleted). */
  supersededBy?: string;
  /** Ids of earlier decisions this one contradicts/revises (contradiction detection). */
  supersedes?: string[];
  source: 'user' | 'planner' | 'engine' | 'task';
}

export interface ProjectEvent {
  id: string;
  at: number;
  kind:
    | 'created'
    | 'understood'
    | 'planned'
    | 'plan-repaired'
    | 'plan-version'
    | 'task-dispatched'
    | 'task-completed'
    | 'task-failed'
    | 'task-blocked'
    | 'task-interrupted'
    | 'task-resumed'
    | 'deliverable-verified'
    | 'deliverable-missing'
    | 'milestone-completed'
    | 'recovery'
    | 'paused'
    | 'resumed'
    | 'cancelled'
    | 'completed'
    | 'failed'
    | 'note';
  message: string;
  /** Optional structured pointers (task id, milestone id, deliverable id). */
  refs?: Record<string, string>;
}

export interface PlanVersion {
  version: number;
  at: number;
  note: string;
  milestones: Milestone[];
  tasks: ProjectTask[];
  deliverables: DeliverableExpectation[];
  /** Repairs applied when this version was built (validated, never silent). */
  repairs: string[];
  /** Project-task ids whose completed work this version PRESERVES verbatim. */
  preservedTaskIds: string[];
}

// ------------------------------------------------------------------------ project

export interface ProjectRecord {
  id: string;
  title: string;
  status: ProjectStatus;
  understanding: ProjectUnderstanding;
  /** ROUND 31 (§5.1/§5.4): the workspace this project is ASSOCIATED WITH (absolute root,
   *  captured at creation). Task briefs, profile context and continuity briefings are
   *  built against THIS workspace — context never mixes between unrelated projects.
   *  Optional for records created before Round 31 (they load unchanged, workspaceless). */
  workspace?: string;
  /** CURRENT plan (latest version — also the live task list). */
  milestones: Milestone[];
  tasks: ProjectTask[];
  deliverables: DeliverableExpectation[];
  /** Deliverable verification history (append-only per deliverable). */
  verifications: DeliverableVerification[];
  decisions: DecisionRecord[];
  events: ProjectEvent[];
  /** Full plan-version history (bounded here; durable archive files keep everything). */
  planVersion: number;
  planHistory: Array<{ version: number; at: number; note: string; repairs: string[] }>;
  /** Recovery bookkeeping: bounded replan budget consumed by the engine. */
  replans: number;
  /** Description the user gave, verbatim. */
  request: string;
  createdAt: number;
  updatedAt: number;
  /** Why the project is blocked/failed (honest, evidence-quoting). */
  blockReason?: string;
  /** When the last execution activity happened (restart reconciliation display). */
  lastExecutedAt?: number;
}

// ----------------------------------------------------------------------- templates

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  category: ProjectCategory;
  complexity: ProjectComplexity;
  /** Seed understanding fields (deterministic defaults overridable by the user text). */
  seed: Partial<Pick<ProjectUnderstanding, 'requirements' | 'constraints' | 'successCriteria' | 'deliverables' | 'assumptions'>>;
  milestones: Array<{
    id?: string;
    title: string;
    detail: string;
    tasks: Array<{
      id?: string;
      title: string;
      detail: string;
      kind: AgentKind;
      dependsOn?: string[];
      expectedOutput?: string;
      acceptance?: Array<{ kind: AcceptanceCriterion['kind']; detail: string; target?: string; min?: number }>;
      deliverables?: Array<{ name: string; path: string; format: string }>;
    }>;
    acceptance?: Array<{ kind: AcceptanceCriterion['kind']; detail: string; target?: string; min?: number }>;
  }>;
}

// -------------------------------------------------------------------- task-spec bridge

/** Build the durable TaskSpec for a project task (the ONLY bridge into the coordinator). */
export interface ProjectTaskSpecInput {
  project: ProjectRecord;
  task: ProjectTask;
  /** Failure context injected into the brief on retries (bounded recovery, §3.6). */
  failureContext?: string;
}

export type { TaskSpec, AcceptanceCriterion, AgentKind };
