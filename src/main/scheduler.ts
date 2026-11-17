import * as fs from 'fs';
import type { Tool } from './toolTypes';
import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson } from './store';
import { emitActivity, getMode, notifyDirect } from './modes';

/**
 * Scheduled autonomous follow-ups — the capability that makes "re-check the price in 15
 * minutes and tell me if it dropped" actually happen instead of being politely forgotten.
 *
 * A scheduled task is a REAL turn run later: at the due time JARVIS wakes, receives the
 * task text (marked as self-scheduled so it works autonomously and ends with one verdict
 * line), uses its tools like in any turn, and the result lands in the session ledger like
 * every other turn. The task list persists in Jarvis-Files/scheduled.json and survives
 * restarts; anything that came due while the app was closed runs once at the next start.
 *
 * This module is pure logic and electron-free: index.ts injects the runner (provider.chat)
 * and the OS notifier at startup, exactly like modes.ts. One honest notification per task —
 * in background mode the turn's own end-of-task notification is the one, so this module
 * stays quiet and only logs.
 */

export interface ScheduledTask {
  id: string;
  task: string;
  /** Epoch ms when the task should run. */
  due: number;
  created: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  ranAt?: number;
  reply?: string;
  error?: string;
}

const STORE_FILE = `${FILES_ROOT}/scheduled.json`;
const MAX_PENDING = 20;
const MAX_TEXT = 500;
const MAX_MS = 30 * 24 * 3600 * 1000;
const TICK_MS = 15_000;

/** Prefixed onto the task text so the model knows nobody is watching and it must not ask questions. */
export const SCHEDULED_PREFIX =
  '[SCHEDULED FOLLOW-UP — you are running this because you scheduled it earlier at the user\'s request. ' +
  'The user may be away: work autonomously, use your tools, never ask questions, and end with one short verdict line stating what you found or did.]\n\n';

let tasks: ScheduledTask[] = [];
let loaded = false;
let runner: ((text: string, opts: { source: 'scheduled' }) => Promise<string>) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;
/** ROUND 28 (§1.2): ids claimed by the CURRENT tick — lets a later tick distinguish a
 *  task it is processing from one left 'running' by a crashed previous pass. */
let inFlight = new Set<string>();
/** ROUND 28 (§1.2): the scheduler stops WAITING on a turn after this long and settles it
 *  FAILED with an explicit outcome-unknown note (the turn's own tool receipts remain the
 *  durable evidence). A hung runner must never wedge the ticker — every later task would
 *  silently never run again. Test hook can shrink this. */
let TURN_TIMEOUT_MS = 15 * 60_000;

/** Test hook: shrink the turn-execution timeout so timeout behavior is exercisable in ms. */
export const setSchedulerTimingForTests = (turnTimeoutMs?: number): void => {
  if (turnTimeoutMs !== undefined) TURN_TIMEOUT_MS = Math.max(50, turnTimeoutMs);
};

/**
 * ROUND 28 (§1.2): bound a runner invocation. The racing timeout does NOT kill the
 * underlying turn (its authorized tool receipts keep landing in the ledger — that is the
 * durable evidence); it stops the SCHEDULER from waiting forever, which is what used to
 * leave tasks RUNNING indefinitely and block every later scheduled task.
 */
async function withTurnTimeout(p: Promise<string>, what: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(
          () => rej(new Error(`${what} exceeded its ${Math.round(TURN_TIMEOUT_MS / 1000)}s execution budget — the scheduler stopped waiting; the outcome is UNKNOWN and any side effects must be reconciled from the tool ledger`)),
          TURN_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function registerScheduledRunner(fn: (text: string, opts: { source: 'scheduled' }) => Promise<string>): void {
  runner = fn;
}

const newId = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const save = async (): Promise<void> => {
  try {
    await atomicWrite(STORE_FILE, JSON.stringify(tasks, null, 1));
  } catch (e) {
    console.warn('[scheduler] could not persist scheduled tasks:', e instanceof Error ? e.message : e);
  }
};

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  const parsed = await loadJson<unknown>(STORE_FILE, []);
  // Shape-check: a hand-edited or old file must not crash the ticker.
  tasks = (Array.isArray(parsed) ? parsed : []).filter(
    (t): t is ScheduledTask =>
      !!t &&
      typeof t === 'object' &&
      typeof (t as ScheduledTask).task === 'string' &&
      typeof (t as ScheduledTask).due === 'number' &&
      typeof (t as ScheduledTask).status === 'string'
  );
  // A crash mid-run must not wedge a task as 'running' forever.
  tasks.forEach((t) => {
    if (t.status === 'running') t.status = 'pending';
  });
}

/** Parse the tool's when-arguments to an epoch ms, or throw a user-readable error. */
export function parseWhen(args: { in_minutes?: unknown; at?: unknown }, now: number = Date.now()): number {
  const mins = Number(args.in_minutes);
  if (args.in_minutes !== undefined && args.in_minutes !== null && args.in_minutes !== '' && Number.isFinite(mins)) {
    if (mins < 1 || mins > MAX_MS / 60_000) throw new Error('in_minutes must be between 1 and 43200 (30 days). For sub-minute waits use set_timer.');
    return now + mins * 60_000;
  }
  const at = String(args.at ?? '').trim();
  if (!at) throw new Error('Give either in_minutes (number) or at (ISO date-time).');
  let due = Date.parse(at); // handles "2026-11-02T09:00", full ISO with Z/offset, and epoch strings
  if (Number.isNaN(due)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(at);
    if (!m) throw new Error(`Cannot understand the time "${at}". Use ISO like 2026-11-02T09:00 or in_minutes.`);
    due = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)).getTime();
  }
  if (Number.isNaN(due)) throw new Error(`Cannot understand the time "${at}".`);
  if (due < now - 60_000) throw new Error('That time is already in the past.');
  if (due > now + MAX_MS) throw new Error('Scheduled tasks run at most 30 days ahead. Use add_recurring_task for routines.');
  return due;
}

/** Schedule a task. Exported for tests; the tool wraps it. */
export async function scheduleTask(task: string, when: { in_minutes?: unknown; at?: unknown }): Promise<ScheduledTask> {
  await load();
  const text = task.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!text) throw new Error('Say what to do at that time.');
  const pending = tasks.filter((t) => t.status === 'pending' || t.status === 'running');
  if (pending.length >= MAX_PENDING) throw new Error(`Already ${MAX_PENDING} tasks scheduled. Cancel one first (list_scheduled).`);
  const due = parseWhen(when);
  const t: ScheduledTask = { id: newId(), task: text, due, created: Date.now(), status: 'pending' };
  tasks.push(t);
  await save();
  return t;
}

export const listScheduled = async (): Promise<ScheduledTask[]> => {
  await load();
  return [...tasks].sort((a, b) => a.due - b.due);
};

export const cancelScheduled = async (id: string): Promise<string> => {
  await load();
  const t = tasks.find((x) => x.id === id && x.status === 'pending');
  if (!t) throw new Error(`No pending task with id ${id}. Call list_scheduled for the current ids.`);
  t.status = 'cancelled';
  await save();
  return `Cancelled: ${t.task}`;
};
const local = (ms: number): string => new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

// ------------------------------------------------------------- recurring tasks (R26 §6.5)

/**
 * USER-AUTHORIZED RECURRING OPERATIONS (Round 26, Phase 6 §6.5) — durable routines with
 * an explicit user-defined schedule ("run the project health check every morning").
 * They persist across restarts, run through the SAME injected runner and permission rules
 * as ordinary scheduled turns, respect resource limits (a bounded roster, ≤2 runs per
 * tick, strictly sequential), and record every execution — including failures.
 */

export type Recurrence =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; at: string; tz?: string }
  | { kind: 'weekly'; weekday: number; at: string; tz?: string };

export interface RecurringTask {
  id: string;
  task: string;
  every: Recurrence;
  enabled: boolean;
  nextDue: number;
  created: number;
  runCount: number;
  lastRunAt?: number;
  lastResult?: string;
  lastError?: string;
}

const RECURRING_FILE = `${FILES_ROOT}/recurring.json`;
const MAX_RECURRING = 12;
/** Resource bound: at most N recurring runs fire per tick (15s) — a burst of overdue
 *  routines cannot monopolize the engine. */
const MAX_RECURRING_RUNS_PER_TICK = 2;

let recurring: RecurringTask[] = [];
let recurringLoaded = false;

const loadRecurring = async (): Promise<RecurringTask[]> => {
  if (recurringLoaded) return recurring;
  recurringLoaded = true;
  const parsed = await loadJson<unknown>(RECURRING_FILE, []);
  recurring = (Array.isArray(parsed) ? parsed : []).filter(
    (t): t is RecurringTask =>
      !!t && typeof t === 'object' && typeof (t as RecurringTask).task === 'string' && !!(t as RecurringTask).every && typeof (t as RecurringTask).nextDue === 'number'
  );
  return recurring;
};

const saveRecurring = async (): Promise<void> => {
  try {
    await atomicWrite(RECURRING_FILE, JSON.stringify(recurring, null, 1));
  } catch (e) {
    console.warn('[scheduler] could not persist recurring tasks:', e instanceof Error ? e.message : e);
  }
};

// ------------------------------------------------------- durable recurring-run lifecycle (R27 §1.1)

/**
 * ROUND 27 (§1.1): every scheduled occurrence gets a DURABLE, identifiable execution
 * record with the lifecycle PENDING → RUNNING → COMPLETED / FAILED (plus CANCELLED and
 * RECOVERING for reconciliation). This closes the Round 26 crash-recovery gap where
 * `nextDue` was advanced and persisted BEFORE the run was recorded: a crash in that
 * window silently lost the occurrence. Now the occurrence identity is durable before
 * anything runs, so startup recovery can find it, reconcile it honestly, and never let
 * an occurrence silently disappear — without redesigning the scheduler.
 */
export type RecurringRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'recovering';

export interface RecurringRunRecord {
  id: string;
  /** The RecurringTask this occurrence belongs to. */
  routineId: string;
  /** The scheduled occurrence (the `nextDue` value this run was created for), epoch ms. */
  occurrence: number;
  status: RecurringRunStatus;
  /** When execution actually started (RUNNING was persisted). */
  startedAt?: number;
  finishedAt?: number;
  attempts: number;
  /** Execution reference: the clipped reply the runner produced. */
  reply?: string;
  error?: string;
  /** Recovery info: set when startup reconciliation touched this record. */
  recovered?: boolean;
  recoveryNote?: string;
}

const RUNS_FILE = `${FILES_ROOT}/recurring-runs.json`;
const MAX_RUN_RECORDS = 300;
const MAX_RUN_ATTEMPTS = 3;

let runRecords: RecurringRunRecord[] = [];
let runRecordsLoaded = false;

const loadRunRecords = async (): Promise<RecurringRunRecord[]> => {
  if (runRecordsLoaded) return runRecords;
  runRecordsLoaded = true;
  const parsed = await loadJson<unknown>(RUNS_FILE, []);
  runRecords = (Array.isArray(parsed ? parsed : []) ? (parsed as unknown[]) : []).filter(
    (r): r is RecurringRunRecord =>
      !!r && typeof r === 'object' && typeof (r as RecurringRunRecord).routineId === 'string' && typeof (r as RecurringRunRecord).occurrence === 'number' && typeof (r as RecurringRunRecord).status === 'string'
  );
  return runRecords;
};

const saveRunRecords = async (): Promise<void> => {
  try {
    await atomicWrite(RUNS_FILE, JSON.stringify(runRecords, null, 1));
  } catch (e) {
    console.warn('[scheduler] could not persist recurring run records:', e instanceof Error ? e.message : e);
  }
};

/** Prune the oldest terminal records beyond the bound (a failed/pending record is never
 *  pruned — it is the evidence that something needs reconciliation). */
const pruneRunRecords = (): void => {
  if (runRecords.length <= MAX_RUN_RECORDS) return;
  const keep = runRecords.filter((r) => r.status === 'pending' || r.status === 'running');
  const terminal = runRecords.filter((r) => r.status !== 'pending' && r.status !== 'running').sort((a, b) => (b.finishedAt ?? b.occurrence) - (a.finishedAt ?? a.occurrence));
  runRecords = [...keep, ...terminal.slice(0, Math.max(0, MAX_RUN_RECORDS - keep.length))];
};

/** A run record already exists for this (routine, occurrence) — completed occurrences are
 *  never executed again (the dedupe key of the lifecycle). */
const findRunRecord = (routineId: string, occurrence: number): RecurringRunRecord | undefined =>
  runRecords.find((r) => r.routineId === routineId && r.occurrence === occurrence);

/** Startup recovery (R27 §1.1): reconcile every run record the process may have abandoned.
 *  - PENDING occurrences whose routine still wants them are re-armed for the next tick
 *    (the runner was never invoked — nothing can have executed).
 *  - RUNNING records abandoned by a crash are NOT rerun automatically (the turn may have
 *    produced external side effects through authorized tools): they settle as FAILED with
 *    an explicit recovery note, and the routine's next occurrence does the work.
 *  - Records of removed routines are cancelled. Never throws. */
export async function recoverRecurringRuns(): Promise<{ reArmed: number; reconciled: number; cancelled: number }> {
  await loadRunRecords();
  await loadRecurring();
  let reArmed = 0;
  let reconciled = 0;
  let cancelled = 0;
  const now = Date.now();
  for (const r of runRecords) {
    if (r.status === 'running') {
      r.status = 'failed';
      r.finishedAt = now;
      r.recovered = true;
      r.recoveryNote = 'interrupted by an application restart while running; the outcome is unknown — NOT rerun automatically because it may already have produced external side effects; the routine\'s next scheduled occurrence will do the work';
      r.error = r.error ?? 'interrupted by restart (outcome unknown)';
      reconciled++;
      const t = recurring.find((x) => x.id === r.routineId);
      if (t && !t.lastError) {
        t.lastRunAt = r.startedAt ?? r.occurrence;
        t.lastError = clip(r.recoveryNote, 200);
      }
    } else if (r.status === 'pending') {
      if (!recurring.some((x) => x.id === r.routineId)) {
        r.status = 'cancelled';
        r.finishedAt = now;
        r.recoveryNote = 'routine was removed before this occurrence ran';
        cancelled++;
      } else if (r.attempts >= MAX_RUN_ATTEMPTS) {
        r.status = 'failed';
        r.finishedAt = now;
        r.recovered = true;
        r.recoveryNote = `occurrence was created but never started after ${r.attempts} attempts — marked failed for investigation instead of retrying forever`;
        reconciled++;
      } else if (r.occurrence <= now) {
        // PENDING means RUNNING was never persisted, and RUNNING is always persisted
        // BEFORE the runner is invoked — so this occurrence has not executed. If the
        // schedule advanced past it (crash between the pre-commit and the run), pull the
        // routine back so the tick re-executes THIS occurrence instead of skipping it.
        const t = recurring.find((x) => x.id === r.routineId);
        if (t && t.enabled && t.nextDue > r.occurrence) {
          t.nextDue = r.occurrence;
          await saveRecurring();
        }
        reArmed++; // stays pending; the next tick's bounded pass executes it through the normal path
      } else {
        reArmed++; // future occurrence: durable identity already in place
      }
    }
  }
  if (reArmed + reconciled + cancelled > 0) await saveRunRecords();
  if (reconciled > 0) await saveRecurring();
  return { reArmed, reconciled, cancelled };
}

/** Execution history for the HUD/Control Center and the list_recurring tool. */
export const listRecurringRuns = async (routineId?: string): Promise<RecurringRunRecord[]> => {
  await loadRunRecords();
  const rows = routineId ? runRecords.filter((r) => r.routineId === routineId) : runRecords;
  return [...rows].sort((a, b) => b.occurrence - a.occurrence || (b.startedAt ?? 0) - (a.startedAt ?? 0));
};

/** Test helper: drop the run-record cache without deleting the store (restart simulation). */
export const dropRecurringRunCacheForTests = (): void => {
  runRecords = [];
  runRecordsLoaded = false;
};

const HHMM = /^(\d{1,2}):(\d{2})$/;

// ============================================================================
// ROUND 29 (§5.2) — TIMEZONE-AWARE RECURRENCE MATH
//
// The Round 26/27/28 `nextOccurrence` was DST-NAIVE: it did `d.setHours(9,0)` on the
// local clock, so "daily at 09:00" drifted by an hour after every DST transition and a
// 02:30 schedule either ran twice or never on transition days. The helpers below do the
// math on the target zone's WALL CLOCK using Intl (no new dependencies):
//
//   - a schedule names a wall-clock time in an IANA zone (default: the system zone);
//   - SKIPPED local times (spring-forward): the occurrence runs at the FIRST instant
//     whose wall clock is at-or-after the target (cron semantics — run after the gap);
//   - REPEATED local times (fall-back): the FIRST occurrence wins (the earlier instant);
//   - everything is pure and bounded (no unbounded search loops).
// Recurrence DATA is preserved through the migration: `tz` is an OPTIONAL field — old
// records without it load unchanged and keep running in the system zone (the zone their
// original nextDue values were computed in), so nothing is reinterpreted or lost.
// ============================================================================

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0=Sunday … 6=Saturday (getUTCDay convention). */
  weekday: number;
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The system IANA zone (where legacy DST-naive schedules effectively lived). */
export const SYSTEM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/**
 * Resolve the zone a recurrence runs in: an explicitly configured IANA name (validated —
 * an unknown zone is a user-visible error, never silently UTC), else the system zone.
 */
export function resolveTimeZone(tz?: string): string {
  const candidate = tz?.trim();
  if (!candidate) return SYSTEM_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate });
    return candidate;
  } catch {
    throw new Error(`unknown time zone "${candidate.slice(0, 40)}" — use an IANA name such as "America/New_York", "Europe/Berlin" or "Asia/Kolkata"`);
  }
}

/** Wall-clock parts of an instant in a zone (Intl; hour 24 normalized to 0). */
export function zonedParts(epoch: number, tz: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  });
  const parts = dtf.formatToParts(new Date(epoch));
  const get = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : NaN;
  };
  const wd = parts.find((x) => x.type === 'weekday')?.value ?? 'Sun';
  let hour = get('hour');
  if (!Number.isFinite(hour) || hour === 24) hour = 0;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
    weekday: Math.max(0, WEEKDAY_NAMES.indexOf(wd.slice(0, 3))),
  };
}

/** The wall clock of `epoch` in `tz`, read back as a UTC timestamp (UTC arithmetic). */
const wallAsUtc = (epoch: number, tz: string): number => {
  const p = zonedParts(epoch, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
};

/** The zone's UTC offset at an instant, in ms (wall − epoch). */
const tzOffsetMs = (epoch: number, tz: string): number => wallAsUtc(epoch, tz) - epoch;

/**
 * The epoch at which the wall clock in `tz` reads the given local time.
 * - Converges with ≤3 offset corrections for real zones.
 * - SKIPPED local time (DST gap): returns the FIRST instant whose wall clock is
 *   at-or-after the target on that day (bounded 4-hour minute-walk to the transition).
 * - REPEATED local time (fall-back): returns the FIRST (earlier) occurrence.
 */
export function wallToEpoch(year: number, month: number, day: number, hh: number, mm: number, tz: string): number {
  const targetWall = Date.UTC(year, month - 1, day, hh, mm, 0);
  let epoch = targetWall - tzOffsetMs(targetWall, tz); // first approximation
  for (let i = 0; i < 3; i++) {
    const wall = wallAsUtc(epoch, tz);
    if (wall === targetWall) break;
    epoch += targetWall - wall; // correction step
  }
  const wallNow = wallAsUtc(epoch, tz);
  if (wallNow !== targetWall && wallNow > targetWall) {
    // DST gap: the corrected instant sits past the skipped time — walk back to the
    // transition (the first instant whose wall clock is at-or-after the target).
    let lo = epoch;
    for (let i = 0; i < 240; i++) {
      const prev = lo - 60_000;
      if (wallAsUtc(prev, tz) < targetWall) break;
      lo = prev;
    }
    return lo;
  }
  if (wallNow !== targetWall && wallNow < targetWall) {
    // defensive: nudge forward in bounded minute steps (should not persist after corrections)
    for (let i = 0; i < 240 && wallAsUtc(epoch, tz) < targetWall; i++) epoch += 60_000;
  }
  // Ambiguity (repeated wall clock): prefer the FIRST occurrence (the earlier instant).
  for (const back of [3_600_000, 5_400_000, 1_800_000]) {
    const earlier = epoch - back;
    if (earlier > 0 && wallAsUtc(earlier, tz) === targetWall) return earlier;
  }
  return epoch;
}

/** Next wall-clock occurrence (optionally pinned to a weekday) STRICTLY AFTER `from`. */
function nextWallOccurrence(hh: number, mm: number, weekday: number | null, from: number, tz: string): number {
  const f = zonedParts(from, tz);
  const fWallDate = Date.UTC(f.year, f.month - 1, f.day);
  const fWeekday = new Date(fWallDate).getUTCDay();
  const firstAdd = weekday === null ? 0 : (weekday - fWeekday + 7) % 7;
  const step = weekday === null ? 1 : 7;
  const lastAdd = weekday === null ? 14 : firstAdd + 14;
  for (let day = firstAdd; day <= lastAdd; day += step) {
    const wallDate = fWallDate + day * 86_400_000;
    const d = new Date(wallDate);
    const epoch = wallToEpoch(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hh, mm, tz);
    if (epoch > from) return epoch;
  }
  return from + 86_400_000; // unreachable in practice; bounded and honest
}

/** The next due time for a recurrence STRICTLY AFTER `from`. Timezone-aware (§5.2). */
export function nextOccurrence(every: Recurrence, from: number): number {
  if (every.kind === 'interval') return from + Math.max(5, Math.round(every.minutes)) * 60_000;
  const m = HHMM.exec(every.at);
  const hh = m ? Math.min(23, Number(m[1])) : 9;
  const mm = m ? Number(m[2]) : 0;
  const tz = resolveTimeZone(every.tz);
  return nextWallOccurrence(hh, mm, every.kind === 'weekly' ? every.weekday : null, from, tz);
}

/** Parse the user's schedule arguments into a Recurrence (bounded). `tz` is an optional
 *  IANA zone for daily/weekly schedules (§5.2) — validated HERE, at creation time. */
export function parseRecurrence(args: { every_minutes?: unknown; daily_at?: unknown; weekly?: unknown; at?: unknown; tz?: unknown }): Recurrence {
  const tz = typeof args.tz === 'string' && args.tz.trim() ? args.tz : undefined;
  if (tz) resolveTimeZone(tz); // throws an honest error for an unknown zone
  const mins = Number(args.every_minutes);
  if (args.every_minutes !== undefined && args.every_minutes !== null && args.every_minutes !== '' && Number.isFinite(mins)) {
    if (mins < 5) throw new Error('every_minutes must be at least 5 — routines that run more often than every 5 minutes are not allowed.');
    return { kind: 'interval', minutes: Math.min(Math.round(mins), 60 * 24 * 7) };
  }
  const dailyAt = String(args.daily_at ?? '').trim();
  if (dailyAt) {
    if (!HHMM.test(dailyAt)) throw new Error('daily_at must be HH:MM (24h), e.g. "09:00".');
    return { kind: 'daily', at: dailyAt, ...(tz ? { tz } : {}) };
  }
  const weekly = String(args.weekly ?? '').trim().toLowerCase();
  const at = String(args.at ?? '').trim();
  if (weekly && at) {
    const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const idx = names.indexOf(weekly) >= 0 ? names.indexOf(weekly) : /^[0-6]$/.test(weekly) ? Number(weekly) : -1;
    if (idx < 0) throw new Error('weekly must be a weekday name (e.g. monday) or 0-6 (0=Sunday).');
    if (!HHMM.test(at)) throw new Error('at must be HH:MM (24h) for a weekly routine.');
    return { kind: 'weekly', weekday: idx, at, ...(tz ? { tz } : {}) };
  }
  throw new Error('Give every_minutes (number ≥ 5), or daily_at "HH:MM", or weekly <weekday> with at "HH:MM".');
}

/** Add a recurring task. Exported for tests; the tool wraps it. */
export async function addRecurring(task: string, every: Recurrence): Promise<RecurringTask> {
  await loadRecurring();
  const text = task.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!text) throw new Error('Say what the routine should do.');
  if (recurring.length >= MAX_RECURRING) throw new Error(`Already ${MAX_RECURRING} recurring routines. Remove one first (list_recurring).`);
  const t: RecurringTask = {
    id: newId(),
    task: text,
    every,
    enabled: true,
    nextDue: nextOccurrence(every, Date.now()),
    created: Date.now(),
    runCount: 0,
  };
  recurring.push(t);
  await saveRecurring();
  return t;
}

export const listRecurring = async (): Promise<RecurringTask[]> => {
  await loadRecurring();
  return [...recurring].sort((a, b) => a.nextDue - b.nextDue);
};

export const cancelRecurring = async (id: string): Promise<string> => {
  await loadRecurring();
  await loadRunRecords();
  const t = recurring.find((x) => x.id === id);
  if (!t) throw new Error(`No recurring routine with id ${id}. Call list_recurring for the current ids.`);
  recurring = recurring.filter((x) => x.id !== id);
  await saveRecurring();
  // ROUND 28 (§1.2): the cancellation race — occurrences already created for a routine
  // being removed are cancelled IMMEDIATELY (not just at the next startup recovery), so
  // no pending record outlives its routine and no duplicate execution window remains.
  let cancelled = 0;
  for (const r of runRecords) {
    if (r.routineId === id && (r.status === 'pending' || r.status === 'recovering')) {
      r.status = 'cancelled';
      r.finishedAt = Date.now();
      r.recoveryNote = 'routine was removed before this occurrence ran';
      cancelled++;
    }
  }
  if (cancelled) await saveRunRecords();
  return `Removed recurring routine: ${t.task}${cancelled ? ` (${cancelled} pending occurrence(s) cancelled with it)` : ''}`;
};

/** Test helper: drop the in-memory recurring cache WITHOUT deleting the store — the next
 *  call reloads from disk (restart simulation, unlike resetSchedulerForTests). */
export const dropRecurringCacheForTests = (): void => {
  recurring = [];
  recurringLoaded = false;
};

export const setRecurringEnabled = async (id: string, enabled: boolean): Promise<string> => {
  await loadRecurring();
  await loadRunRecords();
  const t = recurring.find((x) => x.id === id);
  if (!t) throw new Error(`No recurring routine with id ${id}.`);
  t.enabled = enabled;
  if (enabled && t.nextDue <= Date.now()) t.nextDue = nextOccurrence(t.every, Date.now());
  // ROUND 28 (§1.2): a disabled routine's created-but-unstarted occurrences are cancelled
  // with an honest note — they would otherwise linger PENDING forever (the tick skips
  // disabled routines), the exact "lost occurrence" window §1.2 names. Re-enabling creates
  // fresh occurrences from the new nextDue; nothing silently disappears.
  let cancelled = 0;
  if (!enabled) {
    for (const r of runRecords) {
      if (r.routineId === id && r.status === 'pending') {
        r.status = 'cancelled';
        r.finishedAt = Date.now();
        r.recoveryNote = 'routine was disabled before this occurrence ran';
        cancelled++;
      }
    }
  }
  await saveRecurring();
  if (cancelled) await saveRunRecords();
  return `Recurring routine ${enabled ? 'enabled' : 'disabled'}: ${t.task}${cancelled ? ` (${cancelled} pending occurrence(s) cancelled while disabled)` : ''}`;
};

/**
 * Run the recurring routines that are due (bounded per tick, strictly sequential), with a
 * DURABLE per-occurrence record (R27 §1.1): the record is persisted PENDING before
 * anything runs, flipped RUNNING before the runner is invoked, and settled COMPLETED or
 * FAILED afterwards — so every crash window leaves an honest, reconcilable state and a
 * completed occurrence is never executed twice. nextDue advancement stays consistent with
 * the execution record. Never throws.
 */
async function runDueRecurring(now: number): Promise<void> {
  await loadRecurring();
  await loadRunRecords();
  const due = recurring
    .filter((t) => t.enabled && t.nextDue <= now)
    .filter((t) => {
      // an occurrence with a terminal record (completed/failed/cancelled) is already
      // handled — it is never executed again; pending/recovering records retry below
      const rec = findRunRecord(t.id, t.nextDue);
      return !rec || rec.status === 'pending' || rec.status === 'recovering';
    })
    .slice(0, MAX_RECURRING_RUNS_PER_TICK);
  for (const t of due) {
    const occurrence = t.nextDue; // the occurrence this run is created for — durable identity
    // 1. Durable occurrence identity FIRST: a record that outlives the process even if the
    //    crash lands anywhere below. An existing terminal record for the same occurrence
    //    means it was already handled — never executed again.
    const existing = findRunRecord(t.id, occurrence);
    if (existing && existing.status !== 'pending' && existing.status !== 'recovering') {
      // already completed/failed/cancelled for this occurrence: only advance the schedule
      t.nextDue = nextOccurrence(t.every, now);
      await saveRecurring();
      continue;
    }
    const record: RecurringRunRecord =
      existing ??
      ({
        id: `run-${occurrence.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        routineId: t.id,
        occurrence,
        status: 'pending',
        attempts: 0,
      } satisfies RecurringRunRecord);
    if (record.attempts >= MAX_RUN_ATTEMPTS) {
      // bounded retries: an occurrence that keeps failing to reach a RUNNING state is
      // settled FAILED for investigation instead of being retried forever
      record.status = 'failed';
      record.finishedAt = Date.now();
      record.recovered = true;
      record.recoveryNote = `occurrence was created but never started after ${record.attempts} attempts — marked failed instead of retrying forever`;
      t.nextDue = nextOccurrence(t.every, now);
      await saveRunRecords();
      await saveRecurring();
      continue;
    }
    record.attempts += 1;
    record.status = 'pending';
    if (!existing) runRecords.push(record);
    pruneRunRecords();
    await saveRunRecords();
    // 2. Pre-commit the next occurrence (existing anti-retrigger), now SAFE: even a crash
    //    before execution leaves the PENDING record to reconcile at startup.
    t.nextDue = nextOccurrence(t.every, now);
    await saveRecurring();
    // 3. RUNNING is durable BEFORE the side effect: an abandoned RUNNING record is the
    //    honest marker that the turn may have executed something.
    record.status = 'running';
    record.startedAt = Date.now();
    await saveRunRecords();
    let reply = '';
    try {
      if (!runner) throw new Error('No runner registered — the scheduler was not started.');
      emitActivity({ kind: 'progress', label: 'Recurring routine', detail: clip(t.task, 120), status: 'busy' });
      // ROUND 28 (§1.2): bounded waiting — a hung turn settles FAILED (outcome unknown)
      // instead of blocking the ticker forever. The turn's own tool receipts remain the
      // durable evidence for reconciliation.
      reply = (await withTurnTimeout(runner(SCHEDULED_PREFIX + t.task, { source: 'scheduled' }), `Recurring occurrence of "${clip(t.task, 60)}"`)) ?? '';
      if (!reply.trim()) reply = '(no reply produced)';
      t.runCount += 1;
      t.lastRunAt = Date.now();
      t.lastResult = clip(reply, 300);
      t.lastError = undefined;
      record.status = 'completed';
      record.reply = clip(reply, 300);
      record.error = undefined;
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const msg = clip(raw, 200);
      t.runCount += 1;
      t.lastRunAt = Date.now();
      t.lastError = msg;
      t.lastResult = undefined;
      record.status = 'failed';
      record.error = msg;
      record.reply = undefined;
      // ROUND 28 (§1.2): an outcome-unknown failure (timeout or interruption) is recorded
      // as such — it must never be silently retried as if nothing may have happened.
      if (/outcome is UNKNOWN|outcome unknown/i.test(raw)) {
        record.recovered = true;
        record.recoveryNote = 'execution ended with an UNKNOWN outcome; NOT rerun automatically — reconcile from the tool ledger before any retry';
      }
    }
    record.finishedAt = Date.now();
    await saveRunRecords();
    // failures are recorded (lastError) AND notified, exactly like one-shot failures
    if (t.lastError || getMode() !== 'background') {
      notifyDirect({
        title: t.lastError ? 'J.A.R.V.I.S — recurring routine failed' : 'J.A.R.V.I.S — recurring routine ran',
        body: clip(t.lastError || reply || t.task, 240),
        speakLine: clip(t.lastError || reply || '', 240),
        ok: !t.lastError,
        interrupted: false,
        task: clip(t.task, 160),
        reply: clip(reply, 300),
        steps: 1,
        failures: t.lastError ? 1 : 0,
        held: 0,
      });
    }
    await saveRecurring();
  }
}

export const scheduleTools: Record<string, Tool> = {
  schedule_task: {
    description:
      'Schedule a REAL follow-up task that JARVIS runs autonomously later — a price re-check, a deadline check that should act, a page to watch, tomorrow-morning work. At the due time it wakes, does the task with all tools, records it in the ledger and sends one notification with the verdict. Give either in_minutes (number, min 1) or at (ISO date-time like 2026-11-02T09:00). Tasks are real work, not reminders; use set_timer for plain reminders.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete, self-contained instruction, e.g. "Re-check the price of the ThinkPad X13 on the saved report\'s source page; if it fell more than ₹1,000, update the report and say so."' },
        in_minutes: { type: 'number', description: 'Run this many minutes from now.' },
        at: { type: 'string', description: 'Absolute time, ISO like 2026-11-02T09:00 (local).' },
      },
      required: ['task'],
    },
    run: async (args) => {
      const t = await scheduleTask(String(args.task ?? ''), { in_minutes: args.in_minutes, at: args.at });
      return `Scheduled (#${t.id}) for ${local(t.due)}: ${t.task}`;
    },
  },
  list_scheduled: {
    parallelSafe: true,
    description: 'List scheduled follow-up tasks: pending ones with ids and due times, plus the last finished ones with their outcomes.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const all = await listScheduled();
      const pending = all.filter((t) => t.status === 'pending');
      const finished = all.filter((t) => t.status !== 'pending').slice(-5);
      const pend = pending.length
        ? pending.map((t) => `#${t.id} — due ${local(t.due)}: ${t.task}`).join('\n')
        : 'Nothing pending.';
      const done = finished.length
        ? `\nRecent: ${finished.map((t) => `#${t.id} ${t.status} — ${clip(t.reply || t.error || t.task, 80)}`).join(' | ')}`
        : '';
      return pend + done;
    },
  },
  cancel_scheduled: {
    description: 'Cancel one pending scheduled task by id (from list_scheduled).',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: (args) => cancelScheduled(String(args.id ?? '')),
  },
  schedule_recurring: {
    description:
      'Create a durable RECURRING routine the user explicitly asked for ("run a project health check every morning", "review the repository issues weekly"). Persists across restarts, runs at each occurrence through the same authorized path as scheduled follow-ups, records every run (including failures), and can be disabled or removed at any time. Give ONE of: every_minutes (number ≥ 5), daily_at ("HH:MM" 24h), or weekly (weekday name) + at ("HH:MM"). Optionally tz (IANA zone, e.g. "America/New_York") makes daily/weekly schedules DST-correct in that zone; without tz the system zone is used.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete, self-contained instruction for each run.' },
        every_minutes: { type: 'number', description: 'Repeat every N minutes (min 5).' },
        daily_at: { type: 'string', description: 'Repeat daily at HH:MM (24h).' },
        weekly: { type: 'string', description: 'Weekday name (e.g. monday) or 0-6 (0=Sunday) — combine with at.' },
        at: { type: 'string', description: 'HH:MM (24h) for weekly routines.' },
        tz: { type: 'string', description: 'IANA time zone for daily/weekly schedules (e.g. "Asia/Kolkata"). Default: this machine\u2019s zone.' },
      },
      required: ['task'],
    },
    run: async (args) => {
      const every = parseRecurrence(args);
      const t = await addRecurring(String(args.task ?? ''), every);
      const zoneNote = every.kind !== 'interval' && every.tz ? ` in ${every.tz}` : '';
      const desc = every.kind === 'interval' ? `every ${every.minutes} min` : every.kind === 'daily' ? `daily at ${every.at}${zoneNote}` : `weekly on ${['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][every.weekday]} at ${every.at}${zoneNote}`;
      return `Recurring routine (#${t.id}) created: ${t.task} — ${desc}, next run ${local(t.nextDue)}. list_recurring / cancel_recurring manage it.`;
    },
  },
  list_recurring: {
    description: 'List recurring routines: schedule, next due time, enabled state, run count, the last recorded result or error, and recent per-occurrence execution records (durable lifecycle: pending → running → completed/failed).',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const all = await listRecurring();
      if (!all.length) return 'No recurring routines. schedule_recurring creates one at the user’s explicit request.';
      const runs = await listRecurringRuns();
      return all
        .map((t) => {
          const zoneNote = t.every.kind !== 'interval' && t.every.tz ? ` in ${t.every.tz}` : '';
          const desc = t.every.kind === 'interval' ? `every ${t.every.minutes} min` : t.every.kind === 'daily' ? `daily at ${t.every.at}${zoneNote}` : `weekly on ${['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][t.every.weekday]} at ${t.every.at}${zoneNote}`;
          const last = t.lastError ? `LAST RUN FAILED: ${t.lastError}` : t.lastResult ? `last run: ${clip(t.lastResult, 80)}` : 'never ran yet';
          const history = runs
            .filter((r) => r.routineId === t.id)
            .slice(0, 3)
            .map((r) => `${r.status}${r.recovered ? '(recovered)' : ''} occurrence ${local(r.occurrence)}${r.error ? `: ${clip(r.error, 60)}` : r.reply ? `: ${clip(r.reply, 60)}` : ''}`)
            .join(' | ');
          return `#${t.id} — ${desc}${t.enabled ? '' : ' [DISABLED]'} — next ${local(t.nextDue)} — ran ${t.runCount}x — ${last}${history ? `\n    recent occurrences: ${history}` : ''}\n    ${t.task}`;
        })
        .join('\n');
    },
  },
  cancel_recurring: {
    description: 'Manage one recurring routine by id (from list_recurring): mode "cancel" removes it, "disable" pauses it, "enable" resumes it.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, mode: { type: 'string', enum: ['cancel', 'disable', 'enable'] } }, required: ['id'] },
    run: async (args) => {
      const id = String(args.id ?? '').trim();
      const mode = String(args.mode ?? 'cancel');
      if (mode === 'disable') return setRecurringEnabled(id, false);
      if (mode === 'enable') return setRecurringEnabled(id, true);
      return cancelRecurring(id);
    },
  },
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Run every pending task whose time has come. Exported so tests can drive the clock;
 * startScheduler simply calls this on an interval. Never throws.
 *
 * F-13: due tasks run STRICTLY SEQUENTIALLY and tick awaits their completion. The old
 * Promise.all ran them concurrently — two scheduled turns raced each other, interleaved
 * tool writes and double-fired notifications. One at a time, in due order; each task's
 * outcome is persisted before the next starts, so a crash mid-tick cannot double-run the
 * later ones (they were still 'pending' when the process died).
 */
export async function tick(now: number = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await load();
    // ROUND 28 (§1.2): a task left 'running' by a CRASHED PREVIOUS PASS (an exception
    // escaped the per-task processing below) is reclaimed — within one process, load()'s
    // startup reset cannot fire again, and without this the wedged task would never run.
    // inFlight distinguishes the CURRENT pass's claims from the stale ones.
    const stale = tasks.filter((t) => t.status === 'running' && !inFlight.has(t.id));
    if (stale.length) {
      for (const t of stale) {
        t.status = 'pending';
        t.error = clip(`${t.error ?? ''} reclaimed: a previous execution pass crashed before this task settled`.trim(), 200) || t.error;
      }
      await save();
    }
    const due = tasks.filter((t) => t.status === 'pending' && t.due <= now).sort((a, b) => a.due - b.due);
    // Round 26 Phase 6: even with no one-shot work due, recurring routines may be —
    // the recurring pass runs on every tick before any early return.
    if (!due.length) {
      await runDueRecurring(now);
      return;
    }
    for (const t of due) t.status = 'running'; // claimed synchronously: an overlapping tick cannot double-run
    inFlight = new Set(due.map((t) => t.id));
    await save();
    for (const t of due) {
      try {
        emitActivity({ kind: 'progress', label: 'Scheduled follow-up', detail: clip(t.task, 120), status: 'busy' });
        let status: ScheduledTask['status'] = 'done';
        let reply = '';
        let error: string | undefined;
        try {
          if (!runner) throw new Error('No runner registered — the scheduler was not started.');
          // ROUND 28 (§1.2): bounded waiting here too — one hung follow-up must never
          // block the whole scheduled-task lane (and every later due task) forever.
          reply = (await withTurnTimeout(runner(SCHEDULED_PREFIX + t.task, { source: 'scheduled' }), `Scheduled follow-up "${clip(t.task, 60)}"`)) ?? '';
          if (!reply.trim()) reply = '(no reply produced)';
        } catch (e) {
          status = 'failed';
          error = e instanceof Error ? e.message : String(e);
        }
        t.status = status;
        t.ranAt = Date.now();
        t.reply = clip(reply, 400);
        t.error = error ? clip(error, 200) : undefined;
        emitActivity({
          kind: 'progress',
          label: status === 'done' ? 'Scheduled follow-up complete' : 'Scheduled follow-up failed',
          detail: clip(reply || error || '', 200),
          status: status === 'done' ? 'ok' : 'fail',
        });
        // One honest notification per task — except in background mode, where the turn's own
        // end-of-task notification already fired (a second one would be noise, not honesty).
        if (status === 'failed' || getMode() !== 'background') {
          notifyDirect({
            title: status === 'done' ? 'J.A.R.V.I.S — scheduled follow-up' : 'J.A.R.V.I.S — scheduled follow-up failed',
            body: clip(reply || error || t.task, 240),
            speakLine: clip(reply || error || '', 240),
            ok: status === 'done',
            interrupted: false,
            task: clip(t.task, 160),
            reply: clip(reply, 300),
            steps: 1,
            failures: status === 'done' ? 0 : 1,
            held: 0,
          });
        }
        await save();
      } catch (taskErr) {
        // ROUND 28 (§1.2): per-task isolation — an unexpected error while settling ONE
        // task must not leave the REST of the claimed tasks 'running' forever.
        console.warn('[scheduler] task settlement failed:', taskErr instanceof Error ? taskErr.message : taskErr);
        if (t.status === 'running') {
          t.status = 'pending';
          t.error = clip(`execution pass error: ${taskErr instanceof Error ? taskErr.message : String(taskErr)}`, 200);
          await save();
        }
      }
    }
    // Round 26 Phase 6: recurring routines due now (bounded, sequential, every run recorded).
    await runDueRecurring(now);
  } catch (e) {
    console.warn('[scheduler] tick failed:', e instanceof Error ? e.message : e);
  } finally {
    inFlight = new Set();
    ticking = false;
  }
}

/** Start the ticker and run anything that came due while the app was closed.
 *  R27 §1.1: startup recovery FIRST — recurring occurrences that were created but never
 *  started are re-armed, RUNNING occurrences abandoned by a crash are reconciled honestly
 *  (never silently rerun), and nothing disappears. */
export function startScheduler(): void {
  void recoverRecurringRuns()
    .then((r) => {
      if (r.reconciled || r.cancelled) console.log(`[scheduler] recurring-run recovery: ${r.reconciled} reconciled, ${r.cancelled} cancelled, ${r.reArmed} re-armed`);
    })
    .catch((e) => console.warn('[scheduler] recurring-run recovery failed:', e instanceof Error ? e.message : e));
  void tick().then(() => {
    const late = tasks.filter((t) => t.status === 'pending' && t.due <= Date.now());
    if (late.length) console.log(`[scheduler] ${late.length} task(s) came due while JARVIS was closed — running now.`);
  });
  if (timer) clearInterval(timer);
  timer = setInterval(() => void tick(), TICK_MS);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test helper: reset module state AND the persisted store, so tasks of one test file
 *  cannot leak into the next (a pending task scheduled by an earlier test used to wake
 *  inside a later test's tick and fire its notification). */
export function resetSchedulerForTests(): void {
  tasks = [];
  loaded = false;
  runner = null;
  if (timer) clearInterval(timer);
  timer = null;
  ticking = false;
  inFlight = new Set();
  try {
    fs.rmSync(STORE_FILE, { force: true }); // sync: a later load() in the same tick must not re-read the old file
  } catch {
    /* nothing to clean */
  }
  recurring = [];
  recurringLoaded = false;
  try {
    fs.rmSync(RECURRING_FILE, { force: true });
  } catch {
    /* nothing to clean */
  }
  runRecords = [];
  runRecordsLoaded = false;
  try {
    fs.rmSync(RUNS_FILE, { force: true });
  } catch {
    /* nothing to clean */
  }
}
