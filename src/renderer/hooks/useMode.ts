import { useCallback, useEffect, useState } from 'react';
import type { InteractionMode } from '../lib/protocol';

export interface ModeControls {
  mode: InteractionMode;
  ready: boolean;
  set: (m: InteractionMode) => void;
}

/**
 * Current interaction mode (interactive = live feed, background = silent work with an
 * end-of-task notification). Subscribes to main-process changes so the keyboard shortcut
 * (Ctrl+Alt+B) and every component stay in sync.
 */
export function useMode(): ModeControls {
  const [mode, setMode] = useState<InteractionMode>('interactive');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.electronAPI.modes
      .get()
      .then((info) => {
        if (!alive) return;
        setMode(info.mode);
        setReady(true);
      })
      .catch(() => alive && setReady(true));
    const off = window.electronAPI.on('mode-changed', (m) => {
      const next = (m as { mode?: InteractionMode } | null)?.mode;
      if (next === 'interactive' || next === 'background') setMode(next);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  // Optimistic: the authoritative state comes back on mode-changed (the main process is
  // the single source of truth; a rejected IPC just leaves the optimistic value, which
  // the next mode-changed corrects).
  const set = useCallback((m: InteractionMode) => {
    setMode(m);
    void window.electronAPI.modes.set(m).catch(() => {});
  }, []);

  return { mode, ready, set };
}
