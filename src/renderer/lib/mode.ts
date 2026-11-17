/**
 * Interaction-mode store (renderer side of mode.ts in the main process).
 *
 * Single source of truth for the UI: loaded from the main process at startup, kept in
 * sync via the 'mode-changed' push (the mode can also be switched by the model through
 * the set_interaction_mode tool). Components subscribe instead of prop-drilling.
 */

export type InteractionMode = 'interactive' | 'background';

let current: InteractionMode = 'interactive';
let loaded = false;
const subs = new Set<(m: InteractionMode) => void>();

type OnFn = (channel: 'mode-changed', func: (...args: unknown[]) => void) => () => void;

/** Called once from App on mount; safe to call again (idempotent). */
export function initMode(on: OnFn | undefined): void {
  if (loaded) return;
  loaded = true;
  const api = window.electronAPI;
  if (api?.modes?.get) {
    api.modes
      .get()
      .then((info) => {
        const m = (info as { mode?: InteractionMode } | null)?.mode;
        if (m === 'interactive' || m === 'background') {
          current = m;
          subs.forEach((s) => s(current));
        }
      })
      .catch(() => undefined);
  }
  // The push payload is { mode } (the same shape mode-changed sends everywhere else).
  on?.('mode-changed', (...args: unknown[]) => {
    const m = (args[0] as { mode?: InteractionMode } | null)?.mode;
    if (m === 'interactive' || m === 'background') {
      current = m;
      subs.forEach((s) => s(current));
    }
  });
}

export const getMode = (): InteractionMode => current;
export const isBackground = (): boolean => current === 'background';

export function subscribeMode(cb: (m: InteractionMode) => void): () => void {
  subs.add(cb);
  cb(current);
  return () => subs.delete(cb);
}

export async function switchMode(next: InteractionMode): Promise<string> {
  const api = window.electronAPI;
  if (!api?.modes?.set) return 'Mode switching is unavailable outside the app.';
  const result = await api.modes.set(next).catch(() => undefined);
  return result === 'interactive' || result === 'background' ? `Mode: ${result}` : 'Mode switch was rejected.';
}
