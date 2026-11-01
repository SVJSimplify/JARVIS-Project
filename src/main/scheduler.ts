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
let runner: ((text: string) => Promise<string>) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let ticking = false;

export function registerScheduledRunner(fn: (text: string) => Promise<string>): void {
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
};

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/**
 * Run every pending task whose time has come. Exported so tests can drive the clock;
 * startScheduler simply calls this on an interval. Never throws.
 */
export async function tick(now: number = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await load();
    const due = tasks.filter((t) => t.status === 'pending' && t.due <= now);
    if (!due.length) return;
    for (const t of due) t.status = 'running'; // claimed synchronously: an overlapping tick cannot double-run
    await save();
    await Promise.all(
      due.map(async (t) => {
        emitActivity({ kind: 'progress', label: 'Scheduled follow-up', detail: clip(t.task, 120), status: 'busy' });
        let status: ScheduledTask['status'] = 'done';
        let reply = '';
        let error: string | undefined;
        try {
          if (!runner) throw new Error('No runner registered — the scheduler was not started.');
          reply = (await runner(SCHEDULED_PREFIX + t.task)) ?? '';
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
      })
    );
  } catch (e) {
    console.warn('[scheduler] tick failed:', e instanceof Error ? e.message : e);
  } finally {
    ticking = false;
  }
}

/** Start the ticker and run anything that came due while the app was closed. */
export function startScheduler(): void {
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

/** Test helper: reset module state (the store file lives in the test tmpdir). */
export function resetSchedulerForTests(): void {
  tasks = [];
  loaded = false;
  runner = null;
  if (timer) clearInterval(timer);
  timer = null;
  ticking = false;
}
