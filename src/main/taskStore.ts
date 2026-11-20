import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson } from './store';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { TaskSpec } from './taskSpec';
import type { TaskProgressView } from './progressTypes';

/**
 * TASK STORE (Module B) — durable tasks with an explicit, code-enforced state machine.
 *
 * One JSON file per task under Jarvis-Files/brain/tasks/ (the proven durable pattern:
 * atomic writes on every transition, boot-time reconciliation of tasks that were mid-flight
 * when the process died). This is the ONE task system and the ONE execution engine for
 * multi-step work — no duplicate runtime, no competing store.
 *
 * The state machine is the Module C contract; it lives next to the store so both the
 * coordinator and the tests enforce the same legal transitions. The MODEL cannot set a
 * status: statuses change only through transition() from engine code.
 */

export type TaskStatus =
  | 'CREATED'
  | 'PLANNING'
  | 'READY'
  | 'RUNNING'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'WAITING_FOR_INPUT'
  | 'RETRYING'
  | 'FAILED'
  /** Round 26 Phase 6 (§6.1/6.4): suspended by the user; completed work preserved; resumable. */
  | 'PAUSED'
  /** Round 26 Phase 6: recovery/reconciliation in progress after an interruption. */
  | 'RECOVERING'
  | 'CANCELLED'
  | 'INTERRUPTED';

export const ACTIVE_STATUSES: TaskStatus[] = ['CREATED', 'PLANNING', 'READY', 'RUNNING', 'VERIFYING', 'WAITING_FOR_INPUT', 'RETRYING', 'RECOVERING'];
export const TERMINAL_STATUSES: TaskStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

/** Legal transitions. Anything not listed here is refused by transition(). */
export const LEGAL_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  CREATED: ['PLANNING', 'READY', 'CANCELLED', 'FAILED'],
  PLANNING: ['READY', 'WAITING_FOR_INPUT', 'RUNNING', 'CANCELLED', 'FAILED'],
  READY: ['PLANNING', 'RUNNING', 'CANCELLED', 'FAILED'],
  RUNNING: ['VERIFYING', 'WAITING_FOR_INPUT', 'RETRYING', 'READY', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'PAUSED', 'RECOVERING'],
  VERIFYING: ['COMPLETED', 'RUNNING', 'FAILED', 'CANCELLED', 'INTERRUPTED', 'PAUSED'],
  WAITING_FOR_INPUT: ['READY', 'RUNNING', 'CANCELLED', 'PAUSED'],
  RETRYING: ['RUNNING', 'FAILED', 'CANCELLED', 'PAUSED'],
  INTERRUPTED: ['READY', 'RUNNING', 'CANCELLED', 'RECOVERING'],
  /** Paused: user-suspended. Resume re-enters READY (the driver restarts it); cancel works. */
  PAUSED: ['READY', 'RUNNING', 'CANCELLED'],
  /** Recovering: reconciliation is running; it ends READY/RUNNING or honestly fails. */
  RECOVERING: ['READY', 'RUNNING', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export const canTransition = (from: TaskStatus, to: TaskStatus): boolean => LEGAL_TRANSITIONS[from]?.includes(to) ?? false;

export interface TaskStep {
  id: string;
  title: string;
  detail: string;
  /** Steps that must be COMPLETED (done) before this one may run. */
  dependsOn: string[];
  /** Registry agent that executes this step ('general' when unplanned). */
  kind: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  result: string;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  /** What this step must produce when it succeeds — injected into the step brief and
   *  used by the verifier as extra evidence context (Round 18 §5.1). */
  expectedOutput?: string;
  /** Per-step retry budget override (clamped to the coordinator's own ceiling). */
  retryMax?: number;
  /** Round 26 Phase 3 (3.2): the step's own completion conditions — every important step
   *  carries a defined completion condition, checked by the verifier and the evidence
   *  evaluation (bounded; the task-level criteria remain authoritative). */
  acceptance?: string[];
  /** F-20: set when the step was mid-flight during an interruption — its side effects
   *  may have happened without a record. A retried run must reconcile, not repeat blindly. */
  outcomeUnknown?: boolean;
  /** Interruption/reconciliation history note (bounded). */
  interruptions?: Array<{ at: number; reason: string }>;
  /** Round 20 (CHANGE 5): the evidence-based per-step verification record. */
  verification?: StepVerification;
}

export interface VerificationResult {
  checkedAt: number;
  passed: boolean;
  /** ROUND 35: the rows carry HOW each check observed reality (the verifier's
   *  CriterionCheck.method/observed) — the delivery engine turns them into evidence
   *  records with an honest direct/inferred source classification. Optional so older
   *  callers constructing plain rows still typecheck. */
  results: Array<{ criterion: string; pass: boolean; evidence: string; method?: string; observed?: string }>;
}

/**
 * PER-STEP VERIFICATION EVIDENCE (Round 20, CHANGE 5): the recorded distinction between
 * what a step INTENDED, what it DID, what its tools CLAIMED, what was actually OBSERVED,
 * HOW that observation was made, and the FINAL status that follows. A successful tool
 * invocation is never automatically a verified result: the status below is derived by
 * engine code from evidence, never from the report's confidence.
 */
export type StepVerificationStatus =
  | 'attempted'
  | 'executed'
  | 'completed'
  | 'verified'
  | 'failed'
  | 'unknown'
  | 'unresolved'
  /** Round 26 Phase 3 (3.6): some requirements have evidence, others do not. */
  | 'partial'
  /** Round 26 Phase 3 (3.6): no sufficient evidence exists — claims stay claims. */
  | 'unverified';

export interface StepVerification {
  checkedAt: number;
  /** What the step was supposed to produce (expectedOutput or the title). */
  intended: string;
  /** What the execution actually performed (tools + outcomes from the durable ledger). */
  action: string;
  /** What the tool/agent CLAIMED (the step report). */
  toolResult: string;
  /** What was independently observed after the run (disk checks, receipt reconciliation). */
  observed: string;
  /** How the observation was made (the verification method). */
  method: string;
  /** The concrete evidence lines backing the observed result. */
  evidence: string;
  /** Final status — never auto-promoted from the tool's own claim. */
  status: StepVerificationStatus;
  /** Round 26 Phase 3: digest of the step result this record verified — a retried or
   *  changed output invalidates the record (stale verification can never validate new
   *  output). Absent on pre-Round-26 records, which are therefore NOT trusted. */
  resultStamp?: string;
}

// ---------------------------------------------------------------------------------
// ROUND 35 — PROJECT DELIVERY STATE (Phases 1–3). The acceptance-criteria states, the
// deliverable records and the evidence records of ONE task live INSIDE its TaskRecord —
// the same JSON file, the same serialized save path, the ONE persistence model. This is
// not a second task database: a task without tracked delivery work simply leaves the
// field undefined, and every state below is written only by the coordinator/verifier
// engine code (never by the model), exactly like every other TaskRecord field.
// ---------------------------------------------------------------------------------

/** Round 35 Phase 1: lifecycle states of one acceptance criterion (the mandated vocabulary). */
export type DeliveryCriterionStatus = 'pending' | 'in_progress' | 'satisfied' | 'failed' | 'blocked' | 'not_applicable';

export interface DeliveryCriterion {
  /** Matches the spec's AcceptanceCriterion.id. */
  id: string;
  kind: string;
  detail: string;
  /** Mandatory criteria gate completion; optional improvements are tracked but never demanded. */
  mandatory: boolean;
  status: DeliveryCriterionStatus;
  updatedAt: number;
  /** Last human-readable check outcome (from the verifier's criterion check line). */
  lastCheck?: string;
  /** Evidence records backing the CURRENT state (ids into delivery.evidence). */
  evidenceIds: string[];
}

/** Round 35 Phase 2: lifecycle states of one deliverable (planned → … → verified/failed/skipped/blocked). */
export type DeliverableStatus = 'planned' | 'in_progress' | 'produced' | 'unverified' | 'verified' | 'failed' | 'skipped' | 'blocked';

export interface DeliveryDeliverable {
  id: string;
  description: string;
  /** Workspace-relative or absolute path when the deliverable is a concrete artifact. */
  path?: string;
  /** Other deliverable ids that must be settled first (mirrors the plan DAG). */
  dependsOn: string[];
  /** The plan step that produces this deliverable, when derived from the plan. */
  fromStep?: string;
  status: DeliverableStatus;
  updatedAt: number;
  producedAt?: number;
  /** Verification evidence for the CURRENT state (a produced artifact is never shown as verified without one). */
  verification?: { at: number; method: string; ok: boolean; evidence: string; receiptIds: string[] };
  /** Why it failed or what remains unverified. */
  failure?: string;
}

/** Round 35 Phase 3: one execution-evidence record — a pointer into EXISTING proof, never a second ledger. */
export type DeliveryEvidenceSource = 'receipt' | 'disk' | 'command' | 'reviewer' | 'user';

export interface DeliveryEvidence {
  id: string;
  /** What was checked. */
  what: string;
  source: DeliveryEvidenceSource;
  /** The durable tool-execution receipt this evidence points at (source 'receipt'/'command'). */
  receiptId?: string;
  tool?: string;
  /** The deliverable and/or criterion this evidence relates to. */
  deliverableId?: string;
  criterionId?: string;
  at: number;
  ok: boolean;
  /** Direct = independently observed (disk, command, receipt); inferred = derived from recorded text. */
  direct: boolean;
  detail: string;
  limits?: string;
  /** FRESHNESS (Phase 3): file-basis evidence is stale when the file's mtime moved past `basis.mtimeMs`. */
  basis?: { path?: string; mtimeMs?: number; at: number };
  stale?: boolean;
}

/** Round 35 Phase 4: the change inventory of a substantial workspace task (from the durable receipts). */
export interface DeliveryChangeSummary {
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  /** Check/verification commands that actually ran (tool + command + exit-0 flag). */
  commands: Array<{ tool: string; command: string; exit0: boolean }>;
  /** External operations performed through integration/browser surfaces. */
  externalOps: string[];
  /** Honest attribution statement (task receipts vs pre-existing/user changes). */
  attributionNote: string;
  /** Files the task wrote that were modified again AFTER the task's last write receipt (user/external). */
  userTouchedSuspects: string[];
  capturedAt: number;
}

/** Round 35 Phase 4: the lightweight pre-completion delivery review (all seven questions). */
export interface DeliveryReview {
  at: number;
  producedOutputs: string;
  criteriaState: string;
  unexpectedChanges: string;
  verificationFailures: string;
  unresolvedDeps: string;
  securityLimits: string;
  readyToHandOver: boolean;
}

/** The delivery block of ONE task — undefined for lightweight work (no overhead, no ceremony). */
export interface DeliveryState {
  criteria: DeliveryCriterion[];
  deliverables: DeliveryDeliverable[];
  evidence: DeliveryEvidence[];
  changes?: DeliveryChangeSummary;
  review?: DeliveryReview;
  updatedAt: number;
}

/** FNV-1a digest of a step result + its length — the verification stamp. */
export const stampStepResult = (result: string): string => {
  let h = 0x811c9dc5;
  const s = String(result ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, '0')}:${s.length.toString(36)}`;
};

/**
 * The verification record for a step ONLY when it matches the step's CURRENT result.
 * A retried or changed output invalidates the old record — it can no longer verify what
 * is there now. Persisted records whose stamp still matches survive restores untouched.
 */
export const validVerification = (s: TaskStep): StepVerification | undefined => {
  const v = s.verification;
  if (!v) return undefined;
  if (v.resultStamp !== stampStepResult(s.result)) return undefined;
  return v;
};

export interface TaskRecord {
  id: string;
  spec: TaskSpec;
  /** Provider model captured when the task is accepted. Model-picker changes affect new
   *  work only; a durable task continues with the model that owns its execution contract. */
  model?: string;
  status: TaskStatus;
  steps: TaskStep[];
  note: string;
  /** Final verdict, set only by the verifier path — never by the model. */
  verdict?: 'completed' | 'partial' | 'failed' | 'blocked' | 'no_action';
  verification?: VerificationResult;
  /** Execution claim: who is driving right now ('turn:<n>' | 'coordinator' | ''). */
  owner: string;
  ownerSince: number;
  /** F-18: unforgeable lease token minted at claim time. Only the holder may renew or
   *  release; a stale driver (replaced after a watchdog takeover) cannot resurrect its
   *  lease or clobber the new owner's heartbeat. */
  ownerToken?: string;
  /** Boot identity of the process that claimed the task (startup reconciliation proof). */
  ownerBootId?: string;
  retries: number;
  /** Adaptive-replan budget actually consumed (bounded; separate from verify fix rounds). */
  replans: number;
  /** Plan graph version — bumped by every adaptive replan (Round 18 §5.5). */
  planVersion: number;
  /** Bounded plan-version history for after-the-fact inspection. */
  planHistory: Array<{ at: number; version: number; summary: string }>;
  /**
   * Round 25 §3: the recorded DELEGATION DECISION — why this task runs the way it does
   * (direct / single_specialist / coordinated_multi_agent), decided by code (delegation.ts)
   * before planning, persisted for the HUD, task_status and after-the-fact review.
   * Structural shape (no import): it mirrors coordinator.DelegationRecord.
   */
  delegation?: {
    strategy: string;
    kind?: string;
    reasons: string[];
    workstreams: string[];
    parallelizable: boolean;
    complexity: number;
    decidedAt: number;
  };
  /** Bounded status history for after-the-fact inspection. */
  history: Array<{ at: number; from: TaskStatus; to: TaskStatus; note: string }>;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  /** ROUND 35: the task's project-delivery state (acceptance criteria, deliverables,
   *  evidence, change summary, review) — persisted WITH the record through the ONE save
   *  path, present only for substantial work. Written by engine code (delivery.ts via
   *  the coordinator), never by the model. */
  delivery?: DeliveryState;
}

const dir = (): string => path.join(FILES_ROOT, 'brain', 'tasks');
const MAX_TASKS = 60;
const MAX_HISTORY = 40;
const MAX_STEPS = 20;
const MAX_PLAN_HISTORY = 10;
/** Stale-claim threshold — deliberately much larger than the heartbeat interval
 *  (F-18): a live driver renews every HEARTBEAT_MS, so only a genuinely dead one ages
 *  past this. Heartbeat cadence and staleness are independent constants. */
export const STALE_OWNER_MS = 10 * 60 * 1000;
/** Unique identity of this process boot; disk rows claimed by any other boot are orphans. */
export const BOOT_ID = `boot${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const cache = new Map<string, TaskRecord>();
let loaded = false;
let seq = 0;

/**
 * Mutation notifier (live task progress): fired after EVERY successful save so the
 * HUD's task list can update in real time. The hook is injected (never imported) so
 * this module stays Electron-free; a throwing hook must not break the save that
 * triggered it.
 */
let changeNotifier: (() => void) | null = null;
export const setTaskChangeNotifier = (fn: (() => void) | null): void => {
  changeNotifier = fn;
};

const newId = (): string => {
  const t = Date.now().toString(36);
  return `T-${t}${++seq}${Math.random().toString(36).slice(2, 5)}`;
};

const fileOf = (id: string): string => path.join(dir(), `task-${id}.json`);

/** Per-task write serialization: two overlapping saves (a setNote racing a markStep) must
 *  never both touch the same tmp file — the second rename would hit ENOENT. */
const writeChains = new Map<string, Promise<unknown>>();

async function save(t: TaskRecord): Promise<void> {
  t.updatedAt = Date.now();
  const job = (writeChains.get(t.id) ?? Promise.resolve()).then(async () => {
    await fs.mkdir(dir(), { recursive: true });
    await atomicWrite(fileOf(t.id), JSON.stringify(t));
  });
  writeChains.set(
    t.id,
    job.catch(() => undefined)
  );
  try {
    changeNotifier?.();
  } catch {
    /* the progress mirror must never break the task being saved */
  }
  return job;
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir())).filter((f) => /^task-[\w-]+\.json$/.test(f)).sort();
  } catch {
    return;
  }
  for (const n of names.slice(-MAX_TASKS)) {
    const raw = await loadJson<TaskRecord | null>(path.join(dir(), n), null);
    if (!raw || typeof raw.id !== 'string' || !raw.spec || !Array.isArray(raw.steps)) continue;
    if (!raw.status || !LEGAL_TRANSITIONS[raw.status]) continue;
    // Boot reconciliation: a task that claims to be running IS interrupted — the process
    // that owned it no longer exists (single-process Electron; the boot id proves the
    // on-disk owner is not us). Honest, resumable, never silently "done".
    if (ACTIVE_STATUSES.includes(raw.status) && raw.status !== 'CREATED') {
      const from = raw.status;
      raw.status = 'INTERRUPTED';
      raw.owner = '';
      raw.ownerToken = undefined;
      raw.note = 'interrupted by an app restart; the coordinator may resume it';
      raw.history = [...(raw.history ?? []), { at: Date.now(), from, to: 'INTERRUPTED' as TaskStatus, note: 'boot reconciliation' }].slice(-MAX_HISTORY);
      // F-20: steps left 'running' by the dead process are reconciled to a retryable
      // state — the owner provably no longer holds a lease (different boot), so the
      // claim cannot be valid. Attempt history is preserved; the outcome is flagged
      // UNKNOWN, never silently reset to "never happened".
      for (const s of raw.steps) {
        if (s.status === 'running') {
          s.status = 'pending';
          s.outcomeUnknown = true;
          s.interruptions = [...(s.interruptions ?? []), { at: Date.now(), reason: 'orphaned by an app restart (previous owner is gone; outcome unknown)' }].slice(-5);
          if (s.result) s.result = `${s.result}\n[interrupted mid-run: outcome unknown; reconcile actual state before repeating side effects]`.slice(0, 4000);
        }
      }
      // ROUND 35 Phase 5: the delivery block is reconciled by the SAME boot pass — a dead
      // process cannot leave "in progress" claims behind: in-flight criteria revert to
      // pending and in-flight deliverables revert to planned. Produced/verified states are
      // receipt-backed and survive; the resume path re-checks their freshness.
      if (raw.delivery) {
        let deliveryChanged = false;
        for (const c of raw.delivery.criteria) {
          if (c.status === 'in_progress') {
            c.status = 'pending';
            c.updatedAt = Date.now();
            deliveryChanged = true;
          }
        }
        for (const d of raw.delivery.deliverables) {
          if (d.status === 'in_progress') {
            d.status = 'planned';
            d.updatedAt = Date.now();
            deliveryChanged = true;
          }
        }
        if (deliveryChanged) raw.delivery.updatedAt = Date.now();
      }
      await atomicWrite(path.join(dir(), n), JSON.stringify(raw)).catch(() => undefined);
    }
    cache.set(raw.id, raw);
    const m = /^T-(\w{6,})(\d+)/.exec(raw.id);
    if (m) {
      const n2 = Number(m[2]);
      if (n2 > seq) seq = n2;
    }
  }
}

async function pruneOld(): Promise<void> {
  const all = [...cache.values()].filter((t) => TERMINAL_STATUSES.includes(t.status)).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const t of all.slice(MAX_TASKS / 2)) {
    cache.delete(t.id);
    await fs.rm(fileOf(t.id), { force: true }).catch(() => undefined);
  }
}

// ----------------------------------------------------------------------------- public API

export async function createTask(spec: TaskSpec, note = 'created', model?: string): Promise<TaskRecord> {
  await ensureLoaded();
  const now = Date.now();
  const t: TaskRecord = {
    id: newId(),
    spec,
    ...(model ? { model } : {}),
    status: 'CREATED',
    steps: [],
    note,
    owner: '',
    ownerSince: 0,
    retries: 0,
    replans: 0,
    planVersion: 1,
    planHistory: [],
    history: [],
    createdAt: now,
    updatedAt: now,
  };
  cache.set(t.id, t);
  await save(t);
  void pruneOld();
  return t;
}

export const getTask = async (id: string): Promise<TaskRecord | undefined> => {
  await ensureLoaded();
  return cache.get(id);
};

export const listTasks = async (): Promise<TaskRecord[]> => {
  await ensureLoaded();
  return [...cache.values()].sort((a, b) => b.updatedAt - a.updatedAt);
};

export const activeTasks = async (): Promise<TaskRecord[]> => (await listTasks()).filter((t) => ACTIVE_STATUSES.includes(t.status));

/** Change status through the legal-transition gate. Throws on an illegal move. */
export async function transition(t: TaskRecord, to: TaskStatus, note = ''): Promise<TaskRecord> {
  if (!canTransition(t.status, to)) throw new Error(`Illegal task transition ${t.status} → ${to} (task ${t.id})`);
  const from = t.status;
  t.status = to;
  if (to === 'COMPLETED' || to === 'FAILED' || to === 'CANCELLED') t.endedAt = Date.now();
  if (to !== 'RUNNING') {
    /* owner retention handled by claim/release */
  }
  t.history = [...t.history, { at: Date.now(), from, to, note }].slice(-MAX_HISTORY);
  await save(t);
  return t;
}

/**
 * PLAN-NORMALIZATION (Round 18 §5.1): turn raw planner output into a validated DAG.
 *
 * Rules:
 *  - ids: the planner may supply ids; missing/duplicate ones become `s{n}` by position.
 *  - dependsOn: entries may be ids OR titles (both map to ids); unknown and self
 *    references are dropped.
 *  - A step whose `dependsOn` field is ABSENT depends on its immediate predecessor
 *    (sequential by default — the conservative semantics). An EXPLICIT `dependsOn`
 *    (even `[]`) is honored, which is how a planner declares steps independent and
 *    therefore parallel-eligible.
 *  - Cycles are impossible by construction: an edge to a LATER-positioned step is
 *    dropped (a planner may only depend on what comes before it), and a final pass
 *    drops any edge that would still create a cycle.
 */
export interface PlanInputStep {
  title: string;
  detail?: string;
  kind?: string;
  id?: string;
  dependsOn?: string[];
  expectedOutput?: string;
  /** Round 26 Phase 3 (3.2): the step's own completion conditions. */
  acceptance?: string[];
  retryMax?: number;
}

/**
 * PLAN GRAPH VALIDATION (Round 19, CHANGE 3): the explicit, reportable form of the
 * normalization rules. Every defect the repair below silently fixes is SURFACED here so
 * a malformed planner output is visible before execution instead of disappearing:
 *   - a dependency that references no existing step (unknown id/title) is DROPPED;
 *   - a self-reference is DROPPED;
 *   - a FORWARD reference (depending on a later step) is DROPPED — the plan stays a DAG
 *     by construction and the step keeps sequential semantics;
 *   - a declared CYCLE (steps whose explicit dependsOn edges form a loop when forward
 *     edges were honored) is DETECTED and reported — the output still cannot contain
 *     one, but the planner's inconsistent graph is named, never swallowed.
 * Pure: the same core drives normalizePlan and the tests.
 */
export interface PlanGraphReport {
  issues: string[];
  /** Declared cycles among explicit edges (each as "a -> b -> a"-style node list). */
  cycles: string[][];
}

export function validatePlanGraph(steps: PlanInputStep[]): PlanGraphReport {
  const clean = steps.slice(0, MAX_STEPS).filter((s) => String(s?.title ?? '').trim());
  const used = new Set<string>();
  const ids = clean.map((s, i) => {
    let id = String((s as { id?: unknown }).id ?? '').trim().replace(/[^\w-]/g, '').slice(0, 12);
    if (!id || used.has(id)) id = `s${i + 1}`;
    while (used.has(id)) id = `s${i + 1}-${used.size}`;
    used.add(id);
    return id;
  });
  const normTitle = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();
  const byTitle = new Map<string, string>();
  clean.forEach((s, i) => byTitle.set(normTitle(String(s.title)), ids[i]));
  const issues: string[] = [];
  clean.forEach((s, i) => {
    const raw = clean[i].dependsOn;
    if (raw === undefined) return;
    for (const d of Array.isArray(raw) ? raw : []) {
      const key = String(d).trim();
      const target = ids.includes(key) ? key : byTitle.get(normTitle(key)) ?? '';
      if (!target) {
        issues.push(`step "${String(s.title).slice(0, 40)}" depends on "${key.slice(0, 40)}" which does not exist (reference dropped)`);
        continue;
      }
      if (target === ids[i]) {
        issues.push(`step "${String(s.title).slice(0, 40)}" depends on itself (reference dropped)`);
        continue;
      }
      if (ids.indexOf(target) > i) {
        issues.push(`step "${String(s.title).slice(0, 40)}" depends on LATER step "${key.slice(0, 40)}" (forward reference dropped; the plan stays sequential for that step)`);
      }
    }
  });
  // CYCLE DETECTION over the honored edges (backward-only after the drops above can never
  // close a loop, so any cycle here comes from the planner's declared shape — detect it
  // on the edge set BEFORE the forward-edge drop as well, for the report).
  const declared = new Map<string, Set<string>>();
  clean.forEach((s, i) => {
    const raw = clean[i].dependsOn;
    const mine = new Set<string>();
    for (const d of Array.isArray(raw) ? raw : []) {
      const key = String(d).trim();
      const target = ids.includes(key) ? key : byTitle.get(normTitle(key)) ?? '';
      if (target && target !== ids[i]) mine.add(target);
    }
    declared.set(ids[i], mine);
  });
  const cycles: string[][] = [];
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const dfs = (u: string): void => {
    color.set(u, 1);
    stack.push(u);
    for (const v of declared.get(u) ?? []) {
      const c = color.get(v) ?? 0;
      if (c === 1) cycles.push([...stack.slice(stack.indexOf(v)), v]);
      else if (c === 0) dfs(v);
    }
    stack.pop();
    color.set(u, 2);
  };
  for (const id of ids) if ((color.get(id) ?? 0) === 0) dfs(id);
  for (const cyc of cycles) {
    const names = cyc.map((id) => clean[ids.indexOf(id)]?.title ?? id);
    issues.push(`circular dependency detected and broken: ${names.join(' → ')} (the loop cannot execute; each step in it keeps only its satisfiable dependencies)`);
  }
  return { issues, cycles };
}

export function normalizePlan(steps: PlanInputStep[]): TaskStep[] {
  // Round 19 (CHANGE 3): validation runs FIRST so malformed plans are reported (the
  // coordinator surfaces validatePlanGraph's issues); the repair below is unchanged in
  // behavior — unknown/self/forward references are dropped, edges only point backward.
  const clean: PlanInputStep[] = steps.slice(0, MAX_STEPS).filter((s) => String(s?.title ?? '').trim());
  // ids: planner-supplied (sanitized, deduplicated) or positional.
  const used = new Set<string>();
  const ids: string[] = clean.map((s, i) => {
    let id = String((s as { id?: unknown }).id ?? '').trim().replace(/^s(\d+)$/i, (m) => `s${m.slice(1)}`).replace(/[^\w-]/g, '').slice(0, 12);
    if (!id || used.has(id)) id = `s${i + 1}`;
    // A positional id already taken by an explicit one shifts to the next free slot.
    while (used.has(id)) id = `s${i + 1}-${used.size}`;
    used.add(id);
    return id;
  });
  const normTitle = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();
  const byTitle = new Map<string, string>();
  clean.forEach((s, i) => byTitle.set(normTitle(String(s.title)), ids[i]));
  const out: TaskStep[] = clean.map((s, i) => ({
    id: ids[i],
    title: String(s.title).trim().slice(0, 160),
    detail: String(s.detail ?? s.title).slice(0, 4000),
    dependsOn: [],
    kind: String(s.kind ?? 'general').slice(0, 20),
    status: 'pending' as const,
    result: '',
    attempts: 0,
    expectedOutput: s.expectedOutput ? String(s.expectedOutput).slice(0, 400) : undefined,
    acceptance: Array.isArray(s.acceptance)
      ? (s.acceptance as unknown[]).map((a) => String(a).slice(0, 200)).filter((a) => a.trim()).slice(0, 4)
      : undefined,
    retryMax: typeof s.retryMax === 'number' && s.retryMax >= 0 ? Math.min(3, Math.round(s.retryMax)) : undefined,
  }));
  // Dependency edges.
  out.forEach((s, i) => {
    const raw = clean[i].dependsOn;
    if (raw === undefined) {
      s.dependsOn = i > 0 ? [out[i - 1].id] : []; // sequential default
      return;
    }
    const mapped = (Array.isArray(raw) ? raw : []).map((d) => {
      const key = String(d).trim();
      return ids.includes(key) ? key : byTitle.get(normTitle(key)) ?? '';
    }).filter((d) => d && d !== s.id);
    // Only earlier steps may be depended on (kills cycles by construction).
    s.dependsOn = [...new Set(mapped)].filter((d) => out.findIndex((x) => x.id === d) < i);
  });
  return out;
}
/**
 * Replace the step list (planning output), shape-checked, capped and normalized into a
 * dependency DAG (Round 18 §5.1). Used for the FIRST plan of a task — every step starts
 * pending. For adaptive replans that must PRESERVE completed work, use replanSteps().
 */
export async function setSteps(t: TaskRecord, steps: Array<Partial<TaskStep> & { title: string; kind?: string }>): Promise<TaskRecord> {
  t.steps = normalizePlan(steps as PlanInputStep[]);
  await save(t);
  return t;
}

/**
 * ADAPTIVE REPLAN (Round 18 §5.5): replace the plan with a new version WITHOUT
 * discarding completed work. Existing steps are matched by normalized title: a step
 * that is already done/skipped keeps its status, result and id; pending/failed steps
 * keep their identity but take the new plan's shape; brand-new steps start pending.
 * planVersion is bumped and the change recorded in planHistory.
 */
export async function replanSteps(t: TaskRecord, steps: PlanInputStep[]): Promise<TaskRecord> {
  const next = normalizePlan(steps);
  const normTitle = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const oldByTitle = new Map<string, TaskStep>();
  for (const s of t.steps) oldByTitle.set(normTitle(s.title), s);
  let maxSeq = 0;
  for (const s of t.steps) {
    const m = /^s(\d+)/.exec(s.id);
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
  }
  const merged: TaskStep[] = [];
  const usedIds = new Set<string>();
  // Round 20 (CHANGE 4): reserve the ids of completed steps that will be preserved
  // verbatim BEFORE assigning ids to new steps — otherwise a replanned step's positional
  // id can collide with a preserved step's id (two steps with the same id would corrupt
  // scheduling and execution records).
  const keptTitles = new Set(next.map((s) => normTitle(s.title)));
  const preserved = t.steps.filter((s) => (s.status === 'done' || s.status === 'skipped') && !keptTitles.has(normTitle(s.title)));
  for (const p of preserved) usedIds.add(p.id);
  for (const s of next) {
    const prev = oldByTitle.get(normTitle(s.title));
    if (prev && (prev.status === 'done' || prev.status === 'skipped')) {
      // Completed work survives verbatim — replanning must never redo it.
      merged.push({ ...prev, dependsOn: s.dependsOn.filter((d) => d !== prev.id) });
      usedIds.add(prev.id);
      continue;
    }
    if (prev) s.id = prev.id; // pending/failed steps keep their identity across the replan
    while (usedIds.has(s.id)) s.id = `s${++maxSeq}`;
    usedIds.add(s.id);
    // Round 20 (CHANGE 4): a replan must NEVER launder away a step's recovery state.
    // Unknown side-effect outcomes, interruption history and attempt counts survive the
    // merge for pending/failed steps — otherwise a new plan would repeat a side effect
    // whose previous outcome was never accounted for.
    if (prev) {
      if (prev.outcomeUnknown) s.outcomeUnknown = true;
      if (prev.interruptions?.length) s.interruptions = prev.interruptions;
      s.attempts = Math.max(s.attempts ?? 0, prev.attempts ?? 0);
    }
    merged.push(s);
  }
  // Round 20 (CHANGE 4): completed work survives even when the replanner returns ONLY the
  // remaining work (which is what the replan prompt instructs). Old done/skipped steps
  // absent from the new plan are appended verbatim — dropping them would silently lose
  // execution history, results and verification evidence (the exact defect the spec
  // forbids). Their ids were reserved above; their edges are cleaned by the remap pass.
  for (const p of preserved) merged.push({ ...p });
  // Remap dependency ids that pointed at steps which changed identity.
  const idMap = new Map<string, string>();
  for (const s of next) {
    const prev = oldByTitle.get(normTitle(s.title));
    if (prev && s.id !== prev.id) idMap.set(prev.id, s.id);
  }
  for (const s of merged)
    s.dependsOn = [...new Set(s.dependsOn.map((d) => idMap.get(d) ?? d).filter((d) => d !== s.id && merged.some((m) => m.id === d)))];
  t.steps = merged;
  t.planVersion += 1;
  t.replans += 1;
  const summary = `v${t.planVersion}: ${merged.filter((s) => s.status === 'done').length} done / ${merged.length} steps — ${steps.map((s) => String(s.title).slice(0, 40)).join(' → ').slice(0, 160)}`;
  t.planHistory = [...(t.planHistory ?? []), { at: Date.now(), version: t.planVersion, summary }].slice(-MAX_PLAN_HISTORY);
  await save(t);
  return t;
}

/** Add ONE step after the existing ones (the revise path must not reset finished steps). */
export async function appendStep(t: TaskRecord, step: { title: string; detail: string; kind?: string }): Promise<TaskStep> {
  const id = `s${t.steps.length + 1}`;
  const s: TaskStep = {
    id,
    title: String(step.title).slice(0, 160),
    detail: String(step.detail).slice(0, 4000),
    dependsOn: [],
    kind: String(step.kind ?? 'general').slice(0, 20),
    status: 'pending',
    result: '',
    attempts: 0,
  };
  t.steps = [...t.steps, s].slice(0, MAX_STEPS + 2);
  await save(t);
  return s;
}

export async function markStep(t: TaskRecord, stepId: string, patch: Partial<Pick<TaskStep, 'status' | 'result'>>): Promise<void> {
  const s = t.steps.find((x) => x.id === stepId);
  if (!s) return;
  if (patch.status !== undefined) s.status = patch.status;
  if (patch.result !== undefined) s.result = String(patch.result).slice(0, 4000);
  if (patch.status === 'running') s.startedAt = Date.now();
  if (patch.status === 'done' || patch.status === 'failed') s.endedAt = Date.now();
  if (patch.status !== undefined && patch.status !== 'pending') s.attempts++;
  await save(t);
}

/** Round 20 (CHANGE 5): persist a step's evidence-based verification record.
 *  Round 26 Phase 3: the record is stamped with the digest of the step's CURRENT result —
 *  the stamp is what later lets validVerification() reject stale records after a retry. */
export async function setStepVerification(t: TaskRecord, stepId: string, v: StepVerification): Promise<void> {
  const s = t.steps.find((x) => x.id === stepId);
  if (!s) return;
  s.verification = { ...v, resultStamp: stampStepResult(s.result) };
  await save(t);
}

export async function setVerification(t: TaskRecord, v: VerificationResult): Promise<void> {
  t.verification = v;
  await save(t);
}

/** Append recovery guidance to a step's brief (no attempt/status side effects). */
export async function appendStepDetail(t: TaskRecord, stepId: string, addition: string): Promise<void> {
  const s = t.steps.find((x) => x.id === stepId);
  if (!s || !addition) return;
  s.detail = `${s.detail}\n\n${addition}`.slice(0, 4000);
  await save(t);
}

/** The final verdict is set ONLY by the engine's verification path, never by the model. */
export async function setTaskVerdict(t: TaskRecord, v: NonNullable<TaskRecord['verdict']>): Promise<void> {
  t.verdict = v;
  await save(t);
}

export async function setNote(t: TaskRecord, note: string): Promise<void> {
  t.note = note.slice(0, 300);
  await save(t);
}

/** Round 20 (CHANGE 4): persist in-place step mutations made by the coordinator (e.g.
 *  batch skip propagation) through the same serialized write path as every other save. */
export async function persistTask(t: TaskRecord): Promise<void> {
  await save(t);
}

// ------------------------------------------------------- execution ownership (claims)

/**
 * Claim exclusive execution of a task. Returns the LEASE TOKEN (truthy) on success, or
 * null when someone else holds a FRESH claim: a second turn or a resumed boot cannot
 * double-run the same task. Stale claims (older than STALE_OWNER_MS) are broken — their
 * owner died with its process. The token is required by renew/release, so a driver that
 * lost its lease can neither renew it nor release the successor's claim (F-18).
 */
export async function claimTask(t: TaskRecord, owner: string): Promise<string | null> {
  await ensureLoaded();
  if (t.owner && t.owner !== owner && Date.now() - t.ownerSince < STALE_OWNER_MS) return null;
  const token = `tk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  t.owner = owner;
  t.ownerSince = Date.now();
  t.ownerToken = token;
  t.ownerBootId = BOOT_ID;
  await save(t);
  return token;
}

/** Heartbeat (F-18): only the CURRENT lease holder can move the expiry forward. Returns
 *  false when the lease was lost (stolen or released) — the caller must stop driving.
 *  The token is validated only when supplied: unique owner strings are the primary
 *  identity (a driver that lost ownership can neither renew nor release), and the token
 *  adds a second credential so a stale in-process reference cannot touch a successor's
 *  claim. A 2-arg call (owner check only) is the watchdog/reconciliation shape. */
export const renewClaim = async (t: TaskRecord, owner: string, token?: string): Promise<boolean> => {
  if (t.owner !== owner) return false;
  if (token !== undefined && t.ownerToken && token !== t.ownerToken) return false;
  t.ownerSince = Date.now();
  await save(t);
  return true;
};

export const releaseClaim = async (t: TaskRecord, owner: string, token?: string): Promise<void> => {
  if (t.owner !== owner) return;
  if (token !== undefined && t.ownerToken && token !== t.ownerToken) return;
  t.owner = '';
  t.ownerToken = undefined;
  await save(t);
};

/** Reconcile steps left 'running' by a dead driver (F-20): they become retryable with
 *  outcomeUnknown set, attempt history preserved and the interruption reason recorded.
 *  Only runs when the task is NOT currently claimed by a live lease (boot path or resume
 *  path before claiming). Returns the reconciled step ids. */
export async function reconcileInterruptedSteps(t: TaskRecord, reason: string): Promise<string[]> {
  const ids: string[] = [];
  for (const s of t.steps) {
    if (s.status !== 'running') continue;
    s.status = 'pending';
    s.outcomeUnknown = true;
    s.interruptions = [...(s.interruptions ?? []), { at: Date.now(), reason }].slice(-5);
    if (s.result) s.result = `${s.result}\n[interrupted mid-run: outcome unknown; reconcile actual state before repeating side effects]`.slice(0, 4000);
    ids.push(s.id);
  }
  if (ids.length) await save(t);
  return ids;
}

// ------------------------------------------------------------------- step scheduling

/** A step is eligible when every dependency is done. Pure; exported for tests. */
export const stepEligible = (t: TaskRecord, step: TaskStep): boolean =>
  step.status === 'pending' && step.dependsOn.every((d) => t.steps.find((s) => s.id === d)?.status === 'done');

export const nextEligibleSteps = (t: TaskRecord): TaskStep[] => t.steps.filter((s) => stepEligible(t, s));

/** Steps that failed — the honest blockers of their dependent branches. */
export const failedSteps = (t: TaskRecord): TaskStep[] => t.steps.filter((s) => s.status === 'failed');

/** Pending steps blocked by a failed dependency (they can never become eligible). */
export const stepsBlockedByFailure = (t: TaskRecord): TaskStep[] =>
  t.steps.filter((s) => s.status === 'pending' && s.dependsOn.some((d) => t.steps.find((x) => x.id === d)?.status === 'failed'));

/** The work is schedulable while at least one step can still run and none is failed. */
export const stepsComplete = (t: TaskRecord): boolean => t.steps.length > 0 && t.steps.every((s) => s.status === 'done' || s.status === 'skipped');

/** Prompt block: where every task stands, injected into the system prompt. */
export async function getTaskPrompt(): Promise<string> {
  const all = await listTasks();
  const active = all.filter((t) => ACTIVE_STATUSES.includes(t.status));
  const recent = all.filter((t) => TERMINAL_STATUSES.includes(t.status) && Date.now() - t.updatedAt < 30 * 60_000).slice(0, 3);
  const lines = active.map((t) => {
    const done = t.steps.filter((s) => s.status === 'done').length;
    return `- [${t.id}] ${t.status} — ${t.spec.objective.slice(0, 120)} (${done}/${t.steps.length} steps)${t.note ? ` · ${t.note}` : ''}`;
  });
  const doneLines = recent.map((t) => `- [${t.id}] ${t.status} (${t.verdict ?? '?'}) — ${t.spec.objective.slice(0, 100)}`);
  if (!lines.length && !doneLines.length) return '';
  return [
    'DURABLE TASKS (persisted ground truth; answer progress questions from here, never guess):',
    ...lines,
    ...doneLines.map((l) => `${l} (recently finished)`),
  ].join('\n');
}

/** Project a record for the HUD's live task list (bounded, shape-safe). */
export function taskToView(t: TaskRecord): TaskProgressView {
  return {
    id: t.id,
    objective: String(t.spec?.objective ?? '').slice(0, 200),
    status: t.status,
    note: String(t.note ?? '').slice(0, 160),
    done: t.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length,
    total: t.steps.length,
    steps: t.steps.slice(0, 22).map((s) => ({ title: String(s.title ?? '').slice(0, 160), status: s.status })),
    updatedAt: t.updatedAt,
  };
}

/** Live views for the HUD: active tasks first, then the newest finished ones. */
export async function taskViews(): Promise<TaskProgressView[]> {
  const all = await listTasks();
  const active = all.filter((t) => ACTIVE_STATUSES.includes(t.status));
  const recent = all.filter((t) => !ACTIVE_STATUSES.includes(t.status) && Date.now() - t.updatedAt < 30 * 60_000);
  return [...active, ...recent].slice(0, 8).map(taskToView);
}

/** Wait for all queued atomic task writes before simulating a process restart in tests. */
export const flushTaskStoreForTests = async (): Promise<void> => {
  await Promise.all([...writeChains.values()]);
};

/** Test helper. */
export const resetTaskStoreForTests = (): void => {
  cache.clear();
  loaded = false;
  seq = 0;
  setTaskChangeNotifier(null);
};
