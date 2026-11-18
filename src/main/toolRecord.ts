import { FILES_ROOT, setTaskIdGetter } from './workspace';
import { atomicAppend } from './store';
import { promises as fs } from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { isSecretKeyName, redactText, REDACTION_MARKER } from './redact';

/**
 * DURABLE TOOL EXECUTION RECORDS (Module G).
 *
 * toolLog.ts keeps a small in-memory ring for the `tool_log` tool; that is observability,
 * not evidence. This module is the durable half: every tool invocation that passes through
 * runTool — the single choke point — appends one record to a JSONL file under
 * Jarvis-Files/brain/toollog/, so tool executions survive restarts and can be audited,
 * reconciled after a crash, and tied to the task and agent that caused them.
 *
 * Deliberate scope: a record is EVIDENCE OF WHAT HAPPENED, not an idempotency mechanism.
 * Writing a record does not make an operation idempotent; idempotency keys are recorded
 * per tool so a future reconciliation pass can detect likely duplicates, and each tool's
 * actual semantics decide whether a repeat is safe.
 *
 * The sink is append-only JSONL (one JSON object per line, O_APPEND, fsynced): a crash
 * can cost the tail of the last line at most — never previously written records.
 *
 * PERSISTENCE CONTRACT (Round 20, CHANGE 1): every persistence operation reports whether
 * durable persistence actually SUCCEEDED (PersistenceOutcome.durable). Lenient callers
 * may ignore the verdict; the dispatch choke point and the recovery paths never do.
 * Outcomes of side-effecting calls go through the STRICT path (recordOutcome): when the
 * real outcome cannot be persisted, an explicit 'outcome_unknown' record is attempted
 * (the durable REQUIRES-RECONCILIATION marker), and as a last resort the real outcome is
 * retained in a bounded in-memory pending set that a controlled recovery flush retries —
 * a completion that is not durable is never silently reported as if it were.
 */

export type AuthDecision =
  | 'allowed' // no policy effect assessed (read-like action)
  | 'autonomous' // assessed but allowed: everything not hard-blocked runs automatically
  | 'blocked' // hard-blocked by policy (deletion, OS resources), cannot be overridden
  | 'plan-blocked' // plan mode is read-only
  | 'rule-denied'; // child-agent deletion backstop at the gate

export type ExecutionStatus =
  | 'ok'
  | 'soft-failed'
  | 'failed'
  | 'not-run'
  | 'cancelled'
  | 'started'
  | 'outcome_unknown'
  | 'reconciled';

export interface ToolExecutionRecord {
  id: string;
  /** Epoch ms when the call started. */
  t: number;
  /** Wall time from dispatch through durable outcome (0 for calls that never ran). */
  ms: number;
  /** Time waiting for an execution slot, distinct from actual process runtime. */
  queueWaitMs?: number;
  /** Child-process runtime, excluding scheduler wait and authorization/receipt overhead. */
  processMs?: number;
  processStatus?: string;
  processExitCode?: number | null;
  processPid?: number;
  tool: string;
  /** The name as the model requested it, when tool-name rescue changed it. */
  requested?: string;
  /** Which agent issued the call: 'main', or a child agent id like 'task:explore#3'. */
  agent: string;
  /** Owning durable task, when the call happened inside one. */
  taskId?: string;
  stepId?: string;
  /** Argument preview, clipped (values may be large; this is an audit, not a payload store). */
  args: string;
  auth: AuthDecision;
  status: ExecutionStatus;
  /** Result preview, or the error text for failures. */
  result?: string;
  /** Transient retries observed inside runTool (not model-driven retries). */
  retries: number;
  /** Stable key of (tool + normalized target), for duplicate detection by consumers. */
  idempotencyKey?: string;
}

const DIR = path.join(FILES_ROOT, 'brain', 'toollog');
const MAX_RESULT_CHARS = 400;
const MAX_ARGS_CHARS = 300;
const MEM_CAP = 500;
const PENDING_CAP = 200;
const FLUSH_INTERVAL_MS = 15_000;
const MAX_FLUSH_ATTEMPTS = 40; // bounded recovery: ~10 minutes of retries at 15 s cadence
let dirReady = false;

/**
 * THE persistence verdict (CHANGE 1): did the record actually reach the ledger?
 * `durable` is true ONLY after the fsynced append resolved. When the intended status
 * could not be persisted but a lower-risk marker did, `durableStatus` names what IS on
 * disk (e.g. 'outcome_unknown' — the requires-reconciliation state).
 */
export interface PersistenceOutcome {
  durable: boolean;
  durableStatus?: ExecutionStatus;
  error?: string;
}
const DURABLE = (status: ExecutionStatus): PersistenceOutcome => ({ durable: true, durableStatus: status });

/**
 * IN-MEMORY OUTCOME PRESERVATION (CHANGE 1 recovery behavior): when the ledger cannot be
 * written, the real outcome is retained here — bounded, deduplicated by (id,status) — and
 * a controlled recovery flush re-attempts persistence on a low-frequency timer and at
 * resume. The actual result of a side effect is never discarded just because the ledger
 * blinked; and nothing here ever re-runs the side effect itself.
 */
interface PendingOutcome {
  rec: ToolExecutionRecord;
  attempts: number;
  lastError: string;
}
const pendingOutcomes = new Map<string, PendingOutcome>();
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;

const rememberPending = (rec: ToolExecutionRecord, key: string, error: string): void => {
  if (!pendingOutcomes.has(key) && pendingOutcomes.size >= PENDING_CAP) {
    // Bounded memory: drop the OLDEST pending receipt (FIFO) — it stays in `recent`
    // (the in-memory mirror) and its started receipt, when one exists, still marks the
    // execution as unresolved on disk. The bound can never grow without limit.
    const oldest = pendingOutcomes.keys().next().value;
    if (oldest !== undefined) pendingOutcomes.delete(oldest);
  }
  pendingOutcomes.set(key, { rec, attempts: 0, lastError: error });
  scheduleFlush();
};

const scheduleFlush = (): void => {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flushPendingOutcomes();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.(); // a recovery timer must never keep the process alive
};

/**
 * CONTROLLED PERSISTENCE RECOVERY (CHANGE 1): re-attempt the pending outcome appends,
 * newest-important first, one bounded pass per call. Idempotent by construction — the
 * writtenReceiptKeys suppression makes a retry that already landed a no-op. Never
 * repeats the SIDE EFFECT; only the receipt write.
 */
export async function flushPendingOutcomes(): Promise<{ flushed: number; remaining: number }> {
  if (flushing) return { flushed: 0, remaining: pendingOutcomes.size };
  flushing = true;
  let flushed = 0;
  try {
    for (const [key, p] of [...pendingOutcomes.entries()]) {
      if (writtenReceiptKeys.has(key)) {
        pendingOutcomes.delete(key); // a parallel path already made it durable
        continue;
      }
      try {
        await persistRecord(p.rec);
        pendingOutcomes.delete(key);
        flushed++;
      } catch (e) {
        p.attempts++;
        p.lastError = e instanceof Error ? e.message : String(e);
        if (p.attempts >= MAX_FLUSH_ATTEMPTS) {
          // Give up loudly after the bounded budget: the warning is the observable trace.
          console.warn(`[toolRecord] outcome receipt ${key} could not be persisted after ${p.attempts} attempts: ${p.lastError}`);
          pendingOutcomes.delete(key);
        }
      }
    }
  } finally {
    flushing = false;
    if (!pendingOutcomes.size && flushTimer) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
  }
  return { flushed, remaining: pendingOutcomes.size };
}

/** Diagnostics/tests: outcomes currently held only in memory. */
export const pendingOutcomeCount = (): number => pendingOutcomes.size;
export const resetPendingOutcomesForTests = (): void => {
  pendingOutcomes.clear();
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
};

/**
 * IDEMPOTENT RECEIPT WRITES (Round 19, CHANGE 2): a receipt key (id + status) written
 * during THIS boot is never appended twice. A retried append after a partial failure or
 * a duplicated completion write therefore lands exactly once — the ledger stays an
 * append-only log of distinct facts, not of duplicate attempts to record the same fact.
 * (Across boots a repeated key is still tolerated: same id + same status IS the same
 * fact, and the query layer deduplicates by id.)
 */
const writtenReceiptKeys = new Set<string>();

const clip = (s: string, n: number): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** In-memory mirror of recent records (bounded) for tool_log and queries without file reads. */
const recent: ToolExecutionRecord[] = [];
let writeFailed = false;

const dayFile = (t: number): string => {
  const d = new Date(t);
  const p = (n: number): string => String(n).padStart(2, '0');
  return path.join(DIR, `records-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`);
};

/**
 * THE persistence boundary, shared by every receipt writer. Appends one record and
 * observes the test probe. REJECTS on failure — the lenient/strict choice belongs to
 * the caller. Crash-injection tests hook `setRecordAppendFailureForTests` around this.
 *
 * ROUND 33 (Phase 4 §4.1/§4.2): the LAST-LINE redaction happens HERE — before the record
 * is durable, every receipt writer's args and result pass the centralized redactText, so
 * a secret-shaped substring (deploy-hook URL, bearer token, credential-bearing URL)
 * cannot reach the execution history through ANY writer, even one that forgot to
 * redact. The in-memory mirror gets the same treatment (it feeds tool_log and queries).
 */
async function persistRecord(rec: ToolExecutionRecord): Promise<void> {
  if (appendFailure) await appendFailure('before', rec); // may throw: crash BEFORE the record lands
  if (!dirReady) {
    await fs.mkdir(DIR, { recursive: true });
    dirReady = true;
  }
  const guarded: ToolExecutionRecord = {
    ...rec,
    args: redactText(rec.args),
    ...(rec.result !== undefined ? { result: redactText(rec.result) } : {}),
  };
  if (guarded.args !== rec.args || guarded.result !== rec.result) redactionsApplied++;
  const line = JSON.stringify(guarded);
  // O_APPEND: a crash can cost the tail of the last line, never earlier records.
  await atomicAppend(dayFile(guarded.t), `${line}\n`);
  writtenReceiptKeys.add(`${guarded.id}:${guarded.status}`);
  // Test probe: an awaitable "this record is now durable" signal. The probe gates
  // nothing in production (it is null); tests use it to prove the receipt lifecycle —
  // e.g. that a side effect cannot begin before its started receipt resolves.
  if (persistenceProbe) await persistenceProbe(dayFile(guarded.t), guarded);
  if (appendFailure) await appendFailure('after', guarded); // may throw: crash AFTER the record landed, BEFORE the caller continues
}

/**
 * One record per tool invocation. The lenient path: never throws into the caller, but —
 * since Round 20 (CHANGE 1) — still REPORTS the durability verdict instead of hiding it
 * (the previous warn-and-drop made a lost completion receipt indistinguishable from a
 * durable one). Outcome-critical callers use recordOutcome below.
 */
export function recordExecution(r: ToolExecutionRecord): Promise<PersistenceOutcome> {
  const rec: ToolExecutionRecord = {
    ...r,
    args: redactText(r.args),
    result: r.result !== undefined ? redactText(clip(r.result, MAX_RESULT_CHARS)) : undefined,
  };
  recent.push(rec);
  if (recent.length > MEM_CAP) recent.shift(); // the actual result stays available in memory
  // Idempotent duplicate suppression (Round 19): the same fact (id + status) is not
  // appended twice in one boot.
  const key = `${rec.id}:${rec.status}`;
  if (writtenReceiptKeys.has(key)) return Promise.resolve(DURABLE(rec.status));
  return persistRecord(rec)
    .then(() => DURABLE(rec.status))
    .catch((e) => {
      if (!writeFailed) {
        writeFailed = true; // warn once per process; the failure must be visible, not fatal
        console.warn('[toolRecord] could not persist tool execution records:', e instanceof Error ? e.message : e);
      }
      return { durable: false, error: e instanceof Error ? e.message : String(e) };
    });
}

/**
 * STRICT OUTCOME PERSISTENCE (CHANGE 1) — the one completion path for executions whose
 * result must be accounted for. Escalation order when the ledger fails:
 *   1. retry the real outcome once (transient append errors heal);
 *   2. when the side effect MAY have happened (a started receipt exists), persist an
 *      explicit 'outcome_unknown' record — the durable REQUIRES-RECONCILIATION marker —
 *      so a restart reconciles instead of assuming;
 *   3. keep the real outcome in the bounded in-memory pending set and schedule the
 *      controlled recovery flush.
 * The outcome is never silently downgraded, and a failed persistence never pretends the
 * action itself failed.
 */
export async function recordOutcome(
  r: ToolExecutionRecord,
  opts: { sideEffectMayHaveRun: boolean }
): Promise<PersistenceOutcome> {
  const rec: ToolExecutionRecord = {
    ...r,
    args: redactText(r.args),
    result: r.result !== undefined ? redactText(clip(r.result, MAX_RESULT_CHARS)) : undefined,
  };
  recent.push(rec);
  if (recent.length > MEM_CAP) recent.shift();
  const key = `${rec.id}:${rec.status}`;
  if (writtenReceiptKeys.has(key)) return DURABLE(rec.status);
  try {
    await persistRecord(rec);
    return DURABLE(rec.status);
  } catch (first) {
    // CRASH-AFTER-DURABLE window: persistRecord registered the key BEFORE the caller saw
    // the failure — the record IS on disk. Never append it a second time.
    if (writtenReceiptKeys.has(key)) return DURABLE(rec.status);
    const err1 = first instanceof Error ? first.message : String(first);
    try {
      await persistRecord(rec); // one controlled retry of the real record
      return DURABLE(rec.status);
    } catch (second) {
      const err2 = second instanceof Error ? second.message : String(second);
      if (opts.sideEffectMayHaveRun && rec.status !== 'outcome_unknown') {
        // The world may hold the effect but the ledger holds nothing: write the explicit
        // unknown marker so recovery inspects instead of assuming.
        try {
          await persistRecord({
            ...rec,
            status: 'outcome_unknown',
            result: clip(`outcome UNKNOWN: the ${rec.status} receipt could not be persisted (${clip(err2, 120)}); reconciliation required`, MAX_RESULT_CHARS),
          });
          pendingOutcomes.set(key, { rec, attempts: 0, lastError: err2 }); // keep trying for the real record too
          return { durable: true, durableStatus: 'outcome_unknown', error: err2 };
        } catch (third) {
          rememberPending(rec, key, third instanceof Error ? third.message : String(third));
          return { durable: false, error: `outcome and unknown-marker both unpersistable: ${err1}; ${third instanceof Error ? third.message : String(third)}` };
        }
      }
      rememberPending(rec, key, err2);
      return { durable: false, error: err2 };
    }
  }
}

/** Explicit lifecycle operations (CHANGE 1): one name per outcome, one shared strict path. */
export function recordCompleted(r: ToolExecutionRecord): Promise<PersistenceOutcome> {
  return recordOutcome({ ...r, status: 'ok' }, { sideEffectMayHaveRun: true });
}
export function recordFailedExecution(r: ToolExecutionRecord): Promise<PersistenceOutcome> {
  return recordOutcome({ ...r, status: 'failed' }, { sideEffectMayHaveRun: true });
}
export function recordCancelledExecution(r: ToolExecutionRecord): Promise<PersistenceOutcome> {
  return recordOutcome({ ...r, status: 'cancelled' }, { sideEffectMayHaveRun: true });
}
export function recordUnknownOutcome(r: Omit<ToolExecutionRecord, 'ms' | 'status' | 'retries'>): Promise<PersistenceOutcome> {
  return recordOutcome(
    { ...r, ms: 0, status: 'outcome_unknown', retries: 0, result: clip(r.result ?? 'outcome unknown', MAX_RESULT_CHARS) },
    { sideEffectMayHaveRun: true }
  );
}

let persistenceProbe: ((file: string, rec: ToolExecutionRecord) => Promise<void>) | null = null;
/** TEST-ONLY: observe/gate the durability point of every persisted record. */
export const setRecordPersistenceProbeForTests = (fn: ((file: string, rec: ToolExecutionRecord) => Promise<void>) | null): void => {
  persistenceProbe = fn;
};

type CrashPhase = 'before' | 'after';
let appendFailure: ((phase: CrashPhase, rec: ToolExecutionRecord) => Promise<void> | void) | null = null;
/**
 * TEST-ONLY crash injection (Round 19, CHANGE 2): make the record append fail at a
 * chosen side of the persistence boundary. 'before' = the record never lands (the
 * operation must not run); 'after' = the record IS on disk but the caller sees a
 * failure (the exact crash window between "durable" and "acted upon").
 */
export const setRecordAppendFailureForTests = (fn: ((phase: CrashPhase, rec: ToolExecutionRecord) => Promise<void> | void) | null): void => {
  appendFailure = fn;
};

/**
 * RECONCILIATION SETTLEMENT: after recovery actually inspected the world for an
 * UNKNOWN-outcome execution (a 'started' record with no twin), append a 'reconciled'
 * record under the SAME id. Round 20 (CHANGE 1): the settlement goes through the strict
 * path — a reconciliation that silently failed to persist would leave the question
 * open while every later query believed it closed. Nothing executed here, so a
 * persistence failure keeps the record pending without an unknown-marker fallback.
 */
export function recordReconciled(
  id: string,
  ctx: { tool: string; agent: string; taskId?: string; stepId?: string },
  verdict: string
): Promise<PersistenceOutcome> {
  return recordOutcome(
    {
      id,
      t: Date.now(),
      ms: 0,
      tool: ctx.tool,
      agent: ctx.agent || 'recovery',
      taskId: ctx.taskId,
      stepId: ctx.stepId,
      args: '(reconciliation)',
      auth: 'autonomous',
      status: 'reconciled',
      result: clip(`RECONCILED: ${verdict}`, MAX_RESULT_CHARS),
      retries: 0,
    },
    { sideEffectMayHaveRun: false }
  );
}

/**
 * IDEMPOTENCY RECEIPT, phase 1 (pre-execution): a 'started' record with the correlation id
 * lands BEFORE the tool runs. The completion record with the same id follows when the
 * outcome is known. A crash between the two leaves a 'started' record with no twin —
 * that is the explicit OUTCOME UNKNOWN state: recovery must reconcile it (inspect the
 * world) instead of assuming failure and blindly repeating the side effect.
 *
 * Round 18 (§4.1): the receipt lifecycle is STARTED → SUCCEEDED/FAILED/CANCELLED, with
 * both appends AWAITED by the dispatch choke point — the started record is durable
 * before the side effect begins, the outcome record before the result is reported.
 * (CREATED/PREPARED are folded into the single awaited append: it is atomic, so a crash
 * mid-append costs the record — the safe "never started" direction — never a half
 * state.) OUTCOME_UNKNOWN is the durable gap state; RECONCILED settles it after real
 * inspection (recordReconciled).
 */
export function recordStarted(r: Omit<ToolExecutionRecord, 'ms' | 'status' | 'result' | 'retries'>): Promise<PersistenceOutcome> {
  return recordExecution({
    ...r,
    ms: 0,
    status: 'started',
    result: 'execution started; outcome pending',
    retries: 0,
  });
}

/**
 * STRICT started receipt (Round 19, CHANGE 2 requirement 6): resolves only once the
 * 'started' record is DURABLE, and REJECTS when it could not be persisted. The dispatch
 * choke point must refuse to execute a side effect whose receipt did not land — a
 * lenient append (warn-and-continue) would run consequences with no evidence trail.
 * Duplicate suppression applies: a re-issued strict write for an already-durable
 * (id, 'started') pair resolves without a second append.
 */
export async function recordStartedStrict(r: Omit<ToolExecutionRecord, 'ms' | 'status' | 'result' | 'retries'>): Promise<void> {
  const rec: ToolExecutionRecord = {
    ...r,
    ms: 0,
    status: 'started',
    result: 'execution started; outcome pending',
    retries: 0,
  };
  recent.push(rec);
  if (recent.length > MEM_CAP) recent.shift();
  const key = `${rec.id}:${rec.status}`;
  if (writtenReceiptKeys.has(key)) return; // already durable this boot
  // STRICT: ANY failure to append — including a post-append crash window — rejects. The
  // caller could not observe the append resolve, so the only safe assumption is that the
  // receipt is not durably confirmed: the side effect must not run (fail closed).
  await persistRecord(rec);
}

/**
 * Reconciliation query: durable records of one task whose outcome is still UNKNOWN —
 * 'started' records that never got their completion twin (matched by id). Used by
 * recovery paths (resume, verification) to distinguish "never ran" from "ran but the
 * record is missing".
 */
export async function unknownOutcomeRecords(taskId: string, sinceTs = 0, days = 3): Promise<ToolExecutionRecord[]> {
  const all = await recordsForTask(taskId, sinceTs, days);
  const startedOnly = all.filter((r) => r.status === 'started');
  const finishedIds = new Set(all.filter((r) => r.status !== 'started').map((r) => r.id));
  return startedOnly.filter((r) => !finishedIds.has(r.id));
}

/** Statuses that settle an execution's outcome (its completion twin has landed). */
const SETTLED_STATUSES = new Set<ExecutionStatus>(['ok', 'soft-failed', 'failed', 'cancelled', 'not-run', 'reconciled']);

/**
 * UNRESOLVED EXECUTIONS (F-20/idempotency) — every record of one task (optionally one
 * step) whose outcome is UNKNOWN: an 'outcome_unknown' record, or a 'started' record
 * that never got its completion twin under the SAME id. A later record with the same id
 * carrying a settled status closes the question. Ordered by time, deduplicated by id, so
 * recovery paths see exactly the operations the world may have seen — and nothing else.
 */
export async function unresolvedExecutionsFor(taskId: string, stepId?: string, sinceTs = 0, days = 3): Promise<ToolExecutionRecord[]> {
  const all = (await recordsForTask(taskId, sinceTs, days)).filter((r) => stepId === undefined || r.stepId === stepId);
  const settledIds = new Set(all.filter((r) => SETTLED_STATUSES.has(r.status)).map((r) => r.id));
  const seen = new Set<string>();
  const out: ToolExecutionRecord[] = [];
  for (const r of all) {
    const unknown = r.status === 'outcome_unknown' || r.status === 'started';
    if (!unknown || settledIds.has(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

// ------------------------------------------------------------------ restart reconciliation

/**
 * CENTRAL IDEMPOTENCY CLASSIFICATION (Round 19, CHANGE 2): the ONE place that decides how
 * recovery may treat a repeat of each tool. Derived from tool semantics, not from a
 * caller's mood:
 *   'read-only'      — observes only (no receipt is written for these anyway);
 *   'idempotent'     — a repeat with the same arguments converges to the same state
 *                      (full-content overwrite); recovery MAY re-run after inspection;
 *   'non-idempotent' — a repeat compounds (appends, edits, commands, browser/desktop
 *                      actions, network sends); recovery must NEVER auto-repeat — it
 *                      inspects the real state and repeats only verifiably-missing parts.
 * Unknown tools classify fail-closed as non-idempotent.
 */
export type IdempotencyClass = 'read-only' | 'idempotent' | 'non-idempotent';

const IDEMPOTENT_TOOLS = new Set(['write_file', 'make_dir', 'set_control_text']); // full-content overwrite converges
const NON_IDEMPOTENT_TOOLS = new Set([
  'edit_file', 'multi_edit', 'apply_patch', 'append_file', 'copy_file', 'move_file', 'make_document',
  'run_command', 'run_python', 'launch_app', 'open_url', 'open_in_my_browser', 'open_anything', 'open_file',
  'remember', 'save_contact', 'add_recurring_task', 'project_save', 'schedule_task', 'set_timer',
  'browser_open', 'browser_search', 'browser_play', 'browser_click', 'browser_click_text', 'browser_type',
  'browser_fill_form', 'browser_select', 'browser_check', 'browser_key', 'browser_upload', 'browser_eval',
  'click_text', 'click_at', 'click_control', 'type_text', 'press_keys', 'scroll_at', 'drag_at',
  'send_message', 'post', 'purchase', 'pay',
]);

export function toolIdempotencyClass(tool: string): IdempotencyClass {
  if (IDEMPOTENT_TOOLS.has(tool)) return 'idempotent';
  if (NON_IDEMPOTENT_TOOLS.has(tool)) return 'non-idempotent';
  return 'non-idempotent'; // fail closed: an unclassified side-effecting tool never auto-repeats
}

/**
 * THE SIX RESTART STATES (CHANGE 2): classify an unfinished execution against its ledger
 * evidence. Only the ledger is consulted — a verdict about the WORLD comes exclusively
 * from a later real inspection (recordReconciled after a run that looked).
 */
export type UnfinishedState =
  | 'not_started' // no started receipt: nothing may have happened (the safe repeat case)
  | 'started_unknown' // started receipt with no twin: the operation MAY be executing or dead — outcome UNKNOWN
  | 'executing_unknown' // alias surfaced for readers: same ledger evidence as started_unknown, mid-flight at crash time
  | 'completed_missing_receipt' // the world shows the effect but no completion record exists (found only by inspection)
  | 'failed'
  | 'cancelled';

export function classifyUnfinished(rec: ToolExecutionRecord): {
  state: UnfinishedState;
  idempotency: IdempotencyClass;
  verdict: string;
} {
  const idempotency = toolIdempotencyClass(rec.tool);
  // A 'started' record without its completion twin is, by ledger evidence, an operation
  // whose outcome is UNKNOWN: it may have completed (completion lost in the crash) or
  // never have run (crash between receipt and execution). The recovery contract is the
  // same either way — INSPECT the real state; never assume; never blindly repeat.
  const state: UnfinishedState = 'started_unknown';
  const verdict =
    idempotency === 'idempotent'
      ? `outcome UNKNOWN: ${rec.tool} is idempotent (full-content overwrite), so after inspecting the real state the operation may be repeated only if its intended result is verifiably absent`
      : `outcome UNKNOWN: ${rec.tool} is NOT idempotent, so the operation must NEVER be auto-repeated — inspect the real state first and repeat only the parts that verifiably did not happen`;
  return { state, idempotency, verdict };
}

/**
 * RESTART RECONCILIATION (CHANGE 2): every 'started' record of recent day files that
 * never received its completion twin gets an explicit, classified 'reconciled' record —
 * written at RESUME time, before anything re-runs. The reconciliation is a statement
 * about LEDGER state and recovery policy; it is never a claim that the world was
 * checked (the step's rerun does that, guided by the verdict text).
 */
export async function reconcileUnfinishedAtResume(taskId: string, sinceTs = 0, days = 3): Promise<Array<{ id: string; tool: string; stepId?: string; args: string; state: UnfinishedState; idempotency: IdempotencyClass; verdict: string }>> {
  // unresolvedExecutionsFor covers BOTH ledger shapes of an unknown outcome: a 'started'
  // record with no twin AND an explicit 'outcome_unknown' record (Round 16's seed shape).
  const unfinished = await unresolvedExecutionsFor(taskId, undefined, sinceTs, days);
  const out: Array<{ id: string; tool: string; stepId?: string; args: string; state: UnfinishedState; idempotency: IdempotencyClass; verdict: string }> = [];
  for (const rec of unfinished) {
    const c = classifyUnfinished(rec);
    await recordReconciled(
      rec.id,
      { tool: rec.tool, agent: 'recovery', taskId: rec.taskId, stepId: rec.stepId },
      c.verdict
    );
    out.push({ id: rec.id, tool: rec.tool, stepId: rec.stepId, args: rec.args, state: c.state, idempotency: c.idempotency, verdict: c.verdict });
  }
  return out;
}

/** Durable records for one day, read back from disk (used by reconciliation and tests). */
export async function recordsForDay(t: number): Promise<ToolExecutionRecord[]> {
  const out: ToolExecutionRecord[] = [];
  let text: string;
  try {
    text = await fs.readFile(dayFile(t), 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const v = JSON.parse(s) as ToolExecutionRecord;
      if (v && typeof v.tool === 'string' && typeof v.t === 'number') out.push(v);
    } catch {
      // A torn final line after a crash is expected and skipped; earlier lines survive.
    }
  }
  return out;
}

/**
 * All durable records of one task, from the last `days` day files (default 3). This is the
 * task's EVIDENCE LEDGER on disk: the verifier reads it instead of trusting any report.
 */
export async function recordsForTask(taskId: string, sinceTs = 0, days = 3): Promise<ToolExecutionRecord[]> {
  const out: ToolExecutionRecord[] = [];
  const now = new Date();
  for (let d = 0; d < days; d++) {
    const dayMs = now.getTime() - d * 24 * 3600 * 1000;
    for (const r of await recordsForDay(dayMs)) {
      if (r.taskId === taskId && r.t >= sinceTs) out.push(r);
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export const recentExecutions = (count = 20, failedOnly = false): ToolExecutionRecord[] =>
  recent.filter((r) => !failedOnly || r.status !== 'ok').slice(-count);

/** Context of WHO is calling, set by the provider/turn loop and sub-agents.
 *  AsyncLocalStorage keeps concurrent child agents isolated: each child's calls carry its
 *  own agent/task ids even when several children run in parallel inside one turn. */
interface CallContext {
  agent: string;
  taskId?: string;
  stepId?: string;
}
const als = new AsyncLocalStorage<CallContext>();

/** Run `fn` (and everything it awaits) with a call context. Returns fn's result. */
export async function runWithCallContext<T>(ctx: CallContext, fn: () => Promise<T>): Promise<T> {
  const parent = als.getStore();
  return als.run(
    {
      agent: ctx.agent || parent?.agent || 'main',
      taskId: ctx.taskId ?? parent?.taskId,
      stepId: ctx.stepId ?? parent?.stepId,
    },
    fn
  );
}

export const setCallContext = (c: Partial<CallContext>): void => {
  const cur = als.getStore() ?? { agent: 'main' };
  als.enterWith({ agent: c.agent ?? cur.agent, taskId: c.taskId ?? cur.taskId, stepId: c.stepId ?? cur.stepId });
};
export const resetCallContext = (agent = 'main'): void => {
  als.enterWith({ agent });
};
export const callContext = (): CallContext => als.getStore() ?? { agent: 'main' };

// ROUND 32 (§4.3): the workspace boundary layer needs the AMBIENT task id of every tool
// call, but workspace.ts must not import this module (it already imports workspace — a
// cycle). The getter is injected once here: the resolvers read the current task id from
// the same call context every tool call already carries.
setTaskIdGetter(() => als.getStore()?.taskId);

/** Stable audit key for duplicate detection: tool + first resource-ish argument. */
export const idempotencyKeyFor = (tool: string, args: Record<string, unknown>): string => {
  const target =
    (args.path as string) ??
    (args.from as string) ??
    (args.url as string) ??
    (args.window as string) ??
    (args.name as string) ??
    (typeof args.command === 'string' ? args.command.slice(0, 80) : '') ??
    '';
  return `${tool}:${clip(String(target ?? ''), 120)}`;
};

/**
 * ROUND 29 (§1.3): SECRET redaction for receipt arguments. Receipts are durable and
 * auditable — a password, token or credential-shaped value must never land in them.
 * ROUND 33 (Phase 4): the classifier is CENTRALIZED in redact.ts (one truth for every
 * surface), the key-name list covers credential-shaped URL arguments (a Vercel deploy-hook
 * URL is a bearer secret — `hook_url` is redacted on EVERY receipt), and the per-tool list
 * keeps its explicit entries. Redaction happens BEFORE the record is written: a started
 * receipt written before the tool runs can never contain the secret. Masking is total.
 * A redaction counter feeds the Operations Center (real redactions observed, never invented).
 */
const TOOL_REDACT_ARGS: Record<string, string[]> = {
  // typed form values are frequently credentials — the durable receipt never stores them
  native_browser_type: ['text'],
  // ROUND 33 (§4.1): the deploy-hook URL is a BEARER SECRET — never in any receipt
  vercel_deploy: ['hook_url'],
};
let redactionsApplied = 0;
/** ROUND 33 (§6): how many secret values redaction actually removed (Ops Center). */
export const redactionHealth = (): { applied: number } => ({ applied: redactionsApplied });

const redactValue = (tool: string | undefined, key: string, value: string): string => {
  if (isSecretKeyName(key)) {
    redactionsApplied++;
    return REDACTION_MARKER;
  }
  if (tool && TOOL_REDACT_ARGS[tool]?.includes(key)) {
    redactionsApplied++;
    return REDACTION_MARKER;
  }
  return value;
};

export const argsPreview = (args: Record<string, unknown>, tool?: string): string =>
  clip(
    Object.entries(args)
      .slice(0, 4)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? redactValue(tool, k, v) : JSON.stringify(v) ?? ''}`)
      .join(' '),
    MAX_ARGS_CHARS
  );

/** Test/diagnostics helper: how many records are in the in-memory mirror. */
export const recordCount = (): number => recent.length;
