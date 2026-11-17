/**
 * THE ACTIVITY STREAM — what makes Interactive Mode interactive.
 *
 * Every tool call, turn, task transition and notice is emitted here and pushed to the
 * renderer feed live. Emission happens in the MAIN process at the single place tools are
 * executed and turns begin/end, so the feed cannot lie: it shows what actually ran, with
 * the real duration and the classified outcome, not what the model says it did.
 *
 * A ring buffer keeps the last 200 events so a user who opens the panel later still sees
 * what happened (late subscribers get history via recentActivity). Electron-free: the
 * push channel is injected (setActivityEmitter), so unit tests need no mocks.
 */

export type ActivityKind = 'tool' | 'turn' | 'notice';
export type ActivityStatus = 'running' | 'ok' | 'failed' | 'blocked' | 'info';

export interface ActivityEvent {
  id: number;
  t: number;
  kind: ActivityKind;
  status: ActivityStatus;
  /** Tool name, or short label for turn/notice events. */
  name: string;
  /** Arguments summary for tools; detail text for others. */
  detail?: string;
  /** Result summary (first line, clipped) once finished. */
  summary?: string;
  ms?: number;
  step?: number;
  steps?: number;
  /** Tool-call correlation: the finish event replaces the running one in the feed. */
  callId?: string;
}

type Emitter = (e: ActivityEvent) => void;
let emitPush: Emitter = () => undefined;

/** Wired from the main process (hud.sendToHud('activity', e)); keeps tests Electron-free. */
export const setActivityEmitter = (fn: Emitter): void => {
  emitPush = fn;
};

const MAX = 200;
const buffer: ActivityEvent[] = [];
let seq = 0;

export const clipActivity = (s: string, n: number): string => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export function emitActivity(e: Omit<ActivityEvent, 'id' | 't'>): ActivityEvent {
  const event: ActivityEvent = { ...e, id: ++seq, t: Date.now() };
  buffer.push(event);
  if (buffer.length > MAX) buffer.shift();
  emitPush(event);
  return event;
}

export const recentActivity = (count = 60): ActivityEvent[] => buffer.slice(-count);

/** Argument summary for the feed: clipped, whitespace-normalised — never a full dump. */
export const argSummary = (rawArgs: string): string => clipActivity(String(rawArgs ?? ''), 160);
