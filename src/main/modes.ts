import { loadJson, atomicWrite } from './store';
import { executionSessionId } from './toolResult';
import type { ActivityEvent, ActivityKind, InteractionMode, ModeInfo, NotifyPayload } from './protocol';

export type { ActivityEvent, ActivityKind, InteractionMode, ModeInfo, NotifyPayload };
/**
 * Interaction modes — the single source of truth for HOW JARVIS presents his work.
 *
 * - `interactive`: every action (tool start/result, progress note, visual)
 *   is streamed live to the HUD activity feed. Nothing is hidden.
 * - `background`: JARVIS works silently. Speech is held, no attention-grabbing pop-ups,
 *   live feed pushes stop; events are buffered into a per-turn digest and ONE honest
 *   summary notification is delivered when the turn ends (from the turn's real verdict,
 *   never a canned "done").
 *
 * There are no approval prompts anywhere in the system (the single policy), so there is
 * nothing that needs to pierce background silence: the two hard restrictions are enforced
 * at the tool gate in code, in both modes alike.
 *
 * This module is pure logic and electron-free (it never imports electron) so the whole
 * state machine is unit-testable; index.ts injects the real sink (HUD push) and the
 * notifier (native OS notification) at startup.
 *
 * Wire types live in ../shared/protocol.ts and are re-exported here — one shape, both ends.
 */

interface ModesConfig {
  /** JSON file the mode is persisted to (userData/mode.json in the app). */
  file?: string;
  /** Push channel to the HUD (sendToHud in the app). Must never throw. */
  sink?: (channel: string, payload: unknown) => void;
  /** Native OS notifier (Electron Notification in the app). Must never throw. */
  notify?: (p: NotifyPayload) => void;
  /**
   * Mode-INDEPENDENT mirror of every activity event (wired to the live task
   * progress tracker). Fires in background mode too — unlike the feed push
   * below, this is how "what is JARVIS doing right now" stays answerable in
   * real time while everything else stays silent.
   */
  onEvent?: (e: ActivityEvent) => void;
  /** Turn lifecycle mirror for the progress tracker ('start' with the task, 'end' with the outcome). */
  onTurn?: (phase: 'start' | 'end', task: string, res?: { failed?: boolean; interrupted?: boolean }) => void;
}

/** Everything the feed can show is kept here; a 60-round turn cannot balloon memory. */
const RING_CAP = 200;
/** Entries handed to the renderer on first paint. */
const INITIAL_EVENTS = 100;
const LABEL_CAP = 140;
const DETAIL_CAP = 240;
const TASK_CAP = 160;
const REPLY_CAP = 300;

const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n)}…` : t);
const oneLine = (t: string): string => t.replace(/\s+/g, ' ').trim();

interface Digest {
  open: boolean;
  task: string;
  startedAt: number;
  steps: number;
  failures: number;
  /** Speech lines held back by background mode. */
  held: number;
  /** True when any part of the turn ran (or began) under background rules. */
  background: boolean;
}

const freshDigest = (): Digest => ({ open: false, task: '', startedAt: 0, steps: 0, failures: 0, held: 0, background: false });

let mode: InteractionMode = 'interactive';
let file: string | undefined;
let sink: ModesConfig['sink'];
let notify: ModesConfig['notify'];
let onEventHook: ModesConfig['onEvent'];
let onTurnHook: ModesConfig['onTurn'];
let seq = 0;
const digests = new Map<string, Digest>();
const sessionKey = (): string => executionSessionId() ?? '__default__';
const currentDigest = (): Digest => {
  const id = sessionKey();
  let value = digests.get(id);
  if (!value) { value = freshDigest(); digests.set(id, value); }
  return value;
};
const ring: ActivityEvent[] = [];
let switchChain: Promise<unknown> = Promise.resolve();

const isBackground = (): boolean => mode === 'background';

/** Live push to the HUD. The render frame can vanish at any moment; dropping is always correct. */
const push = (channel: string, payload: unknown): void => {
  try {
    sink?.(channel, payload);
  } catch {
    /* the feed must never break the work it is reporting */
  }
};

/**
 * Boot the mode system. State loads asynchronously from `file`; until it resolves the
 * default (interactive) applies, which is also the correct state for every test run.
 */
export function initModes(cfg: ModesConfig = {}): Promise<void> {
  file = cfg.file;
  sink = cfg.sink;
  notify = cfg.notify;
  onEventHook = cfg.onEvent;
  onTurnHook = cfg.onTurn;
  mode = 'interactive';
  digests.clear();
  ring.length = 0;
  if (!file) return Promise.resolve();
  return loadJson<{ mode?: string }>(file, {})
    .then((stored) => {
      // A hand-edited or corrupted file falls back to the default, loudly enough to debug.
      if (stored.mode === 'background' || stored.mode === 'interactive') {
        mode = stored.mode;
        push('mode-changed', { mode });
      }
    })
    .catch(() => undefined);
}

export const getMode = (): InteractionMode => mode;
export const isBackgroundMode = isBackground;
export const modeInfo = (): ModeInfo => ({ mode, events: ring.slice(-INITIAL_EVENTS) });

/** Switch mode. Invalid values are rejected (the renderer whitelist can be bypassed via IPC). */
export function setMode(next: InteractionMode): Promise<InteractionMode> {
  if (next !== 'interactive' && next !== 'background') return Promise.reject(new Error('Unknown mode.'));
  if (next === mode) return Promise.resolve(mode);
  // The state flips synchronously: gating decisions made right after the call must see the
  // new mode, never a stale one. Only the disk write is asynchronous.
  mode = next;
  push('mode-changed', { mode });
  emitActivity({ kind: 'mode', label: next === 'background' ? 'Background mode on — working silently' : 'Interactive mode on — live feed', status: 'ok' });
  const job = switchChain.then(async () => {
    if (!file) return mode;
    try {
      await atomicWrite(file, JSON.stringify({ mode, t: Date.now() }));
    } catch (e) {
      // The switch still applies in memory; a read-only disk must not brick the toggle.
      console.warn('[modes] could not persist mode:', e instanceof Error ? e.message : e);
    }
    return mode;
  });
  switchChain = job.catch(() => undefined);
  return job;
}

export function toggleMode(): Promise<InteractionMode> {
  return setMode(isBackground() ? 'interactive' : 'background');
}

/**
 * Record one action and route it. In interactive mode it is pushed to the feed at once;
 * in background mode it is only buffered (ring + digest) so the end-of-turn notification
 * can summarise it. Never throws: a broken sink must not break the tool being reported.
 */
export function emitActivity(e: Omit<ActivityEvent, 'id' | 't'>): ActivityEvent {
  const ev: ActivityEvent = {
    ...e,
    id: ++seq,
    t: Date.now(),
    label: clip(oneLine(e.label ?? ''), LABEL_CAP),
    ...(e.detail !== undefined ? { detail: clip(oneLine(e.detail), DETAIL_CAP) } : {}),
  };
  ring.push(ev);
  if (ring.length > RING_CAP) ring.splice(0, ring.length - RING_CAP);
  // The progress mirror fires in BOTH modes (silence in background mode applies to the
  // feed push, speech and notifications — never to "where is JARVIS right now").
  try {
    onEventHook?.(ev);
  } catch {
    /* a broken mirror must not break the tool being reported */
  }
  const digest = currentDigest();
  if (digest.open && e.kind !== 'mode') {
    digest.steps++;
    if (e.status === 'fail') digest.failures++;
    if (e.status === 'held') digest.held++;
    if (isBackground()) digest.background = true;
  }
  if (!isBackground()) push('jarvis-activity', ev);
  return ev;
}

/**
 * Speech gate for proactive announcements (say_aloud, timers): background mode holds them
 * and records the hold in the feed instead of staying silent about the silence.
 */
export function holdSpeech(text: string): boolean {
  if (!isBackground()) return false;
  emitActivity({ kind: 'speech', label: 'Speech held in background mode', detail: text, status: 'held' });
  return true;
}

/** Open the per-turn digest. Called once per conversational turn, before any tool runs. */
export function beginTurn(task: string): void {
  const digest = { ...freshDigest(), open: true, task: clip(oneLine(task), TASK_CAP), startedAt: Date.now(), background: isBackground() };
  digests.set(sessionKey(), digest);
  try {
    onTurnHook?.('start', digest.task);
  } catch {
    /* the progress mirror must never break the turn starting */
  }
}

/**
 * Close the turn and, when the turn ran under background rules, deliver the ONE
 * end-of-task notification from the turn's real outcome. A fully interactive turn
 * notifies nothing: the user watched it happen.
 */
export function endTurn(res: { reply?: string; failed?: boolean; interrupted?: boolean; error?: string }): NotifyPayload | null {
  try {
    const digest = currentDigest();
    if (!digest.open) return null;
    const d = digest;
    digests.set(sessionKey(), freshDigest());
    // The progress tracker learns the outcome in BOTH modes (before the background
    // early-return below): a finished silent turn must still freeze its checklist.
    try {
      onTurnHook?.('end', d.task, { failed: res.failed, interrupted: res.interrupted });
    } catch {
      /* a broken mirror must not break the turn ending */
    }
    if (!(isBackground() || d.background)) return null;

    const reply = clip(oneLine(res.reply ?? ''), REPLY_CAP);
    const s = d.steps === 1 ? 'step' : 'steps';
    let title: string;
    let body: string;
    let speakLine: string;
    if (res.interrupted) {
      title = 'JINI — interrupted';
      body = d.steps ? `Interrupted after ${d.steps} ${s}. ${d.task}` : `Interrupted before I did anything. ${d.task}`;
      speakLine = d.steps ? `Interrupted after ${d.steps} ${s}, sir.` : 'Stopped before I did anything, sir.';
    } else if (res.failed) {
      title = 'JINI — could not finish';
      body = clip(oneLine(res.error || res.reply || 'The task failed.'), REPLY_CAP);
      speakLine = clip(`I could not finish that, sir. ${reply}`.trim(), 240);
    } else {
      title = 'JINI — task complete';
      body = d.failures ? `${d.failures} of ${d.steps} ${s} failed. ${reply}` : reply || `Done, sir. ${d.steps} ${s}.`;
      speakLine = clip(reply || (d.failures ? `${d.failures} ${s} failed, sir.` : 'Done, sir.'), 240);
    }
    const payload: NotifyPayload = {
      title,
      body,
      speakLine,
      ok: !res.interrupted && !res.failed,
      interrupted: res.interrupted === true,
      task: d.task,
      reply,
      steps: d.steps,
      failures: d.failures,
      held: d.held,
    };
    push('jarvis-notify', payload);
    try {
      notify?.(payload);
    } catch {
      /* a missing OS notifier must not fail the turn */
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Fire the OS notifier directly, bypassing the turn digest — used ONLY by the scheduler for
 * its follow-up notifications (a scheduled task is not part of the turn that scheduled it).
 * Never throws: a missing notifier must not fail the scheduled work.
 */
export function notifyDirect(p: NotifyPayload): void {
  try {
    push('jarvis-notify', p);
    notify?.(p);
  } catch {
    /* the follow-up already ran; a dead notifier must not resurrect it as a failure */
  }
}
