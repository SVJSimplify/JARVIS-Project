import * as path from 'path';
import { promises as fs } from 'fs';
import { atomicWrite, loadJson } from './store';
import { FILES_ROOT } from './workspace';

/**
 * INTERACTION MODES — a code-enforced presentation contract, not a prompt hope.
 *
 *  INTERACTIVE  — everything JARVIS does is shown live (activity feed, browser panel,
 *                 captions, speech). The default.
 *  BACKGROUND   — JARVIS works silently: no speech, no captions, browser tools may run
 *                 without dragging the panel on screen, and every finished task (turn or
 *                 durable task) is delivered as an OS notification with the audited verdict.
 *                 If the OS cannot notify, the report is persisted as an unread digest so
 *                 it is never lost (the digest lives in modes.ts).
 *
 * The mode changes PRESENTATION and DELIVERY only — the tool pipeline, the verify-then-
 * report envelopes and the completion guarantee run identically in both modes, so a task
 * that succeeds interactively succeeds in the background too. Delivery uses the mode at
 * the moment the reply is ready, so flipping the mode mid-turn is always handled honestly.
 *
 * Electron-free by design: the push channel is injected (setModeBroadcaster), so
 * unit tests need no mocks.
 */

export type InteractionMode = 'interactive' | 'background';

let current: InteractionMode = 'interactive';
let loaded = false;
let broadcast: (mode: InteractionMode) => void = () => undefined;

/** Wired from the main process (hud.sendToHud('mode-changed', mode)); keeps tests Electron-free. */
export const setModeBroadcaster = (fn: (mode: InteractionMode) => void): void => {
  broadcast = fn;
};

const file = (): string => path.join(FILES_ROOT, 'brain', 'interaction-mode.json');

export const getMode = (): InteractionMode => current;
export const isBackground = (): boolean => current === 'background';

export const isInteractionMode = (v: unknown): v is InteractionMode =>
  v === 'interactive' || v === 'background';

/** Boot-time restore. Never throws: a corrupt file means the default (interactive). */
export async function loadMode(): Promise<InteractionMode> {
  const saved = await loadJson<{ mode?: string }>(file(), {});
  current = isInteractionMode(saved.mode) ? saved.mode : 'interactive';
  loaded = true;
  broadcast(current);
  return current;
}

/**
 * Switch mode. Persists first (so a crash right after the switch cannot silently revert),
 * then broadcasts. Returns the honest result text the caller can show.
 */
export async function setMode(next: InteractionMode): Promise<string> {
  if (!isInteractionMode(next)) {
    return `Unknown mode "${String(next)}". Use "interactive" or "background". Nothing was changed.`;
  }
  const changed = next !== current;
  current = next;
  try {
    await fs.mkdir(path.join(FILES_ROOT, 'brain'), { recursive: true });
    await atomicWrite(file(), JSON.stringify({ mode: current }, null, 2));
  } catch (e) {
    // The switch still applies for this session, but the user must know it will not
    // survive a restart — never claim a silent success.
    return `Switched to ${current} mode for this session, but persisting failed: ${e instanceof Error ? e.message : String(e)}. After a restart it will be interactive again.`;
  }
  // Broadcast only on an actual change — same-mode sets stay silent.
  if (changed) broadcast(current);
  return changed
    ? current === 'background'
      ? 'Background mode on. I will work silently and notify you when each task finishes.'
      : 'Interactive mode on. Everything I do is shown live again.'
    : `Already in ${current} mode; nothing changed.`;
}

export const modeLoaded = (): boolean => loaded;

/** One-line status injected into the turn context every prompt. */
export function modeContextLine(): string {
  return current === 'background'
    ? 'INTERACTION MODE: background — the user may be away. Work silently: your final reply is delivered as a notification, so make it a compact spoken-style summary of the outcome (and the next step if anything failed). Do not narrate mid-task.'
    : 'INTERACTION MODE: interactive — every tool call is shown to the user live in the activity feed.';
}
