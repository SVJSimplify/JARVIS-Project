import { runtimeEvents } from './runtimeEvents';
import type {
  AgentProgressView,
  ProgressSnapshot,
  ProgressStep,
  TaskProgressView,
  TurnProgress,
} from './progressTypes';

/**
 * LIVE TASK PROGRESS — the always-on mirror of what JARVIS is doing.
 *
 * Every activity event, turn transition and durable-task mutation is folded into
 * one small snapshot and pushed to the HUD on the dedicated `jarvis-progress`
 * channel — in BOTH interaction modes. That is the whole point: background mode
 * keeps its silence contract for the activity feed, speech and notifications (see
 * modes.ts), but "where is JARVIS in the task list right now" must answer in real
 * time either way.
 *
 * Design rules inherited from the rest of the engine:
 *  - Electron-free: the push channel and the mode getter are injected, so unit
 *    tests need no mocks and the module can never touch the UI directly.
 *  - Never throws: a broken sink, a malformed event or a failing provider must
 *    not break the work being reported (every entry point is guarded).
 *  - Bounded: turn steps and tasks are capped and clipped, so a 60-round turn or
 *    a 250-step burst cannot balloon memory or the wire.
 *  - Fresh on subscribe: `getProgressSnapshot()` serves the cached state, so a
 *    renderer that reloads mid-task sees the truth on first paint.
 */

type PushSink = (channel: string, payload: unknown) => void;
type ModeGetter = () => 'interactive' | 'background';
type Provider<T> = () => Promise<T[]>;

export interface ProgressConfig {
  /** Push channel to the HUD (sendToHud in the app). Must never be relied on to work. */
  sink?: PushSink;
  /** Current interaction mode, read at push time. */
  mode?: ModeGetter;
  /** While busy, re-push the snapshot at this interval so the UI can never go stale. 0 = off (tests). */
  keepaliveMs?: number;
}

const STEP_CAP = 30;
const TASK_CAP = 6;
const LABEL_CAP = 140;
const DETAIL_CAP = 200;
const NOW_STALE_MS = 5 * 60_000; // a "now" line with no event for 5 minutes is pruned when idle

const clip = (s: unknown, n: number): string => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

// ---------------------------------------------------------------- module state

let sink: PushSink = () => undefined;
let modeOf: ModeGetter = () => 'interactive';
let updatedAt = 0;

/** Mirror of the modes.ts ActivityEvent fields this module relies on (structural, no import). */
export interface ActivityMirror {
  id?: number;
  t?: number;
  cid?: string;
  kind?: string;
  label?: string;
  detail?: string;
  status?: 'busy' | 'ok' | 'fail' | 'held';
  ms?: number;
}

interface NowLine {
  label: string;
  detail?: string;
  status: ProgressStep['status'];
  since: number;
}
let nowLine: NowLine | null = null;
let turn: TurnProgress | null = null;
/**
 * Round 23: REAL per-step statuses for the open turn, keyed by step key. The `steps`
 * array above is a bounded RENDER WINDOW (the newest rows) — computing done/failed from
 * it used to freeze the visible progress at the window size (~30 tools). The stats map
 * covers every row the turn ever had, so counters stay honest at any scale.
 */
const turnStepStats = new Map<string, ProgressStep['status']>();
const tasks = new Map<string, TaskProgressView>();
/** Finished tasks/agents last touched before this instant belong to an unrelated earlier
 *  request and are hidden from the board (active ones always show). */
let boardEpoch = 0;
/** Extra snapshot listeners (the paired-phone link) — the SAME snapshot the HUD gets. */
const listeners = new Set<(s: ProgressSnapshot) => void>();
export const onProgress = (fn: (s: ProgressSnapshot) => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

const STOPWORDS = new Set('a an the to of in on for and or with my me i it this that is are be do can you please jini now then just'.split(' '));
const words = (t: string): Set<string> => new Set(t.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((w) => !STOPWORDS.has(w)) ?? []);
const FOLLOW_UP = /^\s*(?:and|also|then|now|next|continue|keep going|go on|again|retry|try again|do it|same|that|it|this|those|them|yes|ok(?:ay)?|instead|fix (?:it|that)|what about)\b/i;
/** Is `next` a continuation of `prev` (follow-up wording, or meaningful word overlap within 10 min)? */
export function isRelatedRequest(prev: { task: string; endedAt?: number; startedAt: number } | null, next: string, now = Date.now()): boolean {
  if (!prev) return false;
  if (now - (prev.endedAt ?? prev.startedAt) > 10 * 60_000) return false;
  if (FOLLOW_UP.test(next)) return true;
  const a = words(prev.task);
  const b = words(next);
  if (!a.size || !b.size) return false;
  let shared = 0;
  for (const w of b) if (a.has(w)) shared++;
  return shared / Math.min(a.size, b.size) >= 0.34;
}

/** Round 23: live invocation summary provider (wired from index.ts to invocations.ts). */
let invocationsProvider: (() => ProgressSnapshot['invocations']) | null = null;
export const setInvocationProvider = (fn: (() => ProgressSnapshot['invocations']) | null): void => {
  invocationsProvider = fn;
};

/** Round 25: live agent-execution provider (wired from index.ts to agentTracker.ts). */
let agentsProvider: (() => AgentProgressView[]) | null = null;
export const setAgentProvider = (fn: (() => AgentProgressView[]) | null): void => {
  agentsProvider = fn;
};

let tasksProvider: Provider<TaskProgressView> | null = null;
let keepalive: ReturnType<typeof setInterval> | null = null;

// ------------------------------------------------------------------- snapshot

const ACTIVE_TASK = new Set(['CREATED', 'PLANNING', 'READY', 'RUNNING', 'VERIFYING', 'WAITING_FOR_INPUT', 'RETRYING']);

/** A turn is "open" until its end hook freezes it; the ended turn is kept only for the linger view. */
const turnOpen = (): boolean => turn !== null && !turn.endedAt;

const hasActiveWork = (): boolean =>
  turnOpen() ||
  [...tasks.values()].some((t) => ACTIVE_TASK.has(t.status));

/** One immutable snapshot of the current state. */
export function getProgressSnapshot(): ProgressSnapshot {
  let invocations: ProgressSnapshot['invocations'];
  try {
    invocations = invocationsProvider?.() ?? undefined;
  } catch {
    invocations = undefined; // a broken counter provider must not break the snapshot
  }
  let agents: AgentProgressView[] | undefined;
  try {
    const list = agentsProvider?.() ?? [];
    agents = Array.isArray(list) ? list : undefined;
  } catch {
    agents = undefined; // a broken agent tracker must not break the snapshot
  }
  return {
    mode: modeOf(),
    busy: hasActiveWork(),
    now: nowLine && Date.now() - nowLine.since < NOW_STALE_MS ? { ...nowLine } : null,
    turn: turn ? { ...turn, steps: [...turn.steps] } : null,
    tasks: [...tasks.values()]
      .filter((t) => ACTIVE_TASK.has(t.status) || t.updatedAt >= boardEpoch)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, TASK_CAP),
    ...(agents && (agents = agents.filter((a) => a.status === 'running' || a.status === 'waiting' || (a.endedAt ?? a.startedAt) >= boardEpoch)).length ? { agents } : {}),
    ...(invocations ? { invocations } : {}),
    updatedAt,
  };
}

function push(): void {
  try {
    updatedAt = Date.now();
    const snap = getProgressSnapshot();
    sink('jarvis-progress', snap);
    runtimeEvents.emit('progress.updated', { updatedAt: snap.updatedAt, busy: snap.busy });
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch {
        /* a broken listener must not starve the others */
      }
    }
  } catch {
    /* a dead renderer must never break the work being reported */
  }
}

// ------------------------------------------------------------------ lifecycle

export function initProgress(cfg: ProgressConfig = {}): void {
  sink = cfg.sink ?? (() => undefined);
  modeOf = cfg.mode ?? (() => 'interactive');
  if (keepalive) {
    clearInterval(keepalive);
    keepalive = null;
  }
  if (cfg.keepaliveMs && cfg.keepaliveMs > 0) {
    keepalive = setInterval(() => {
      // Re-push only while there is something to watch: an idle app stays quiet.
      if (hasActiveWork()) push();
    }, Math.max(2000, cfg.keepaliveMs));
  }
}

/** Test helper: reset every piece of module state. */
export function resetProgressForTests(): void {
  if (keepalive) clearInterval(keepalive);
  keepalive = null;
  nowLine = null;
  turn = null;
  turnStepStats.clear();
  tasks.clear();
  tasksProvider = null;
  agentsProvider = null;
  boardEpoch = 0;
  listeners.clear();
  updatedAt = 0;
}

// -------------------------------------------------------------- turn tracking

/** modes.ts beginTurn hook — opens a fresh checklist for the new request. */
export function noteTurnStart(task: string): void {
  const now = Date.now();
  if (turn && isRelatedRequest(turn, task, now)) {
    // A follow-up continues the same checklist: earlier steps stay, the turn re-opens.
    turn = { ...turn, task: clip(task, 160), outcome: 'running', endedAt: undefined };
  } else {
    // An unrelated request starts a clean board: previous turn, finished tasks and agents clear.
    turn = { task: clip(task, 160), startedAt: now, outcome: 'running', steps: [], done: 0, failed: 0, calls: 0 };
    turnStepStats.clear();
    boardEpoch = now;
  }
  runtimeEvents.emit('turn.started', { task: clip(task, 160), at: now });
  push();
}

/** modes.ts endTurn hook — freezes the checklist with the honest outcome. */
export function noteTurnEnd(res: { failed?: boolean; interrupted?: boolean } = {}): void {
  if (!turn || turn.endedAt) return; // a turn ends once; late double-calls are ignored
  turn.endedAt = Date.now();
  turn.outcome = res.interrupted ? 'interrupted' : res.failed ? 'fail' : 'ok';
  runtimeEvents.emit('turn.ended', { outcome: turn.outcome, at: turn.endedAt });
  push();
}

// -------------------------------------------------------------- step tracking

const stepKeyOf = (e: ActivityMirror): string => {
  if (e.cid) return e.cid;
  return `${e.kind ?? 'event'}:${clip(e.label, 40)}`;
};

/** Real totals over EVERY row the turn ever had (never the display window). */
function recountTurn(): void {
  if (!turn) return;
  let done = 0;
  let failed = 0;
  for (const status of turnStepStats.values()) {
    if (status === 'ok') done++;
    else if (status === 'fail') failed++;
  }
  turn.done = done;
  turn.failed = failed;
  turn.calls = turnStepStats.size;
}

/** Upsert one checklist row; returns the mutated turn (or null when no turn is open). */
function upsertStep(e: ActivityMirror): void {
  if (!turn || turn.endedAt) return; // activity outside a turn (task sub-agents) shows in `now` + its own sections
  const status: ProgressStep['status'] = e.status === 'busy' ? 'running' : (e.status ?? 'running');
  const key = stepKeyOf(e);
  turnStepStats.set(key, status);
  const found = turn.steps.find((s) => s.key === key);
  if (found) {
    found.label = clip(e.label, LABEL_CAP) || found.label;
    found.status = status;
    if (e.detail !== undefined) found.detail = clip(e.detail, DETAIL_CAP);
    if (e.ms !== undefined) found.ms = e.ms;
  } else {
    turn.steps.push({ key, label: clip(e.label, LABEL_CAP), detail: e.detail !== undefined ? clip(e.detail, DETAIL_CAP) : undefined, status, t: e.t ?? Date.now(), ms: e.ms });
    // Round 23: only the RENDER WINDOW is bounded now (the newest rows survive for the
    // checklist view); the counters above come from turnStepStats and cover everything.
    if (turn.steps.length > STEP_CAP) turn.steps.splice(0, turn.steps.length - STEP_CAP);
  }
  recountTurn();
}

/**
 * modes.ts onEvent hook — the mirror of EVERY activity event, both modes.
 * Updates the "now" line always, and the turn checklist while a turn is open.
 */
export function noteActivity(e: ActivityMirror): void {
  try {
    if (!e || typeof e !== 'object') return;
    const kind = String(e.kind ?? '');
    if (kind === 'mode' || kind === 'speech') return; // toggle notices and held-speech lines are not progress
    const status: ProgressStep['status'] = e.status === 'busy' ? 'running' : (e.status ?? 'running');
    nowLine = { label: clip(e.label, LABEL_CAP), detail: e.detail !== undefined ? clip(e.detail, DETAIL_CAP) : undefined, status, since: e.t ?? Date.now() };
    if (kind === 'tool' || kind === 'task' || kind === 'verify' || kind === 'agent') upsertStep(e);
    push();
  } catch {
    /* progress must never break the tool run it mirrors */
  }
}

// -------------------------------------------------------------- task provider

/** Wired from index.ts: pulls the durable-task views straight from the task store. */
export const setTaskProvider = (fn: Provider<TaskProgressView> | null): void => {
  tasksProvider = fn;
};

const runProvider = async <T>(fn: Provider<T> | null): Promise<T[]> => {
  if (!fn) return [];
  try {
    return (await fn()) ?? [];
  } catch {
    return [];
  }
};

/**
 * Re-pull the durable task list into the snapshot and push. Called by the
 * taskStore mutation notifier (every transition / step change fires it), so the
 * task checklist updates in real time without polling.
 */
export async function refreshTasks(): Promise<void> {
  try {
    const list = await runProvider(tasksProvider);
    const had = tasks.size;
    tasks.clear();
    for (const t of list.slice(0, TASK_CAP)) {
      if (t && typeof t.id === 'string') tasks.set(t.id, t);
    }
    if (tasks.size || had) push(); // fresh work, or the board just emptied — either way, tell the HUD
  } catch {
    /* never break the caller (save() runs inside task mutations) */
  }
}
