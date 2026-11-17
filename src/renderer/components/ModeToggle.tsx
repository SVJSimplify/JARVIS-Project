import { useEffect, useState } from 'react';
import { getMode, initMode, subscribeMode, switchMode, type InteractionMode } from '../lib/mode';

/**
 * The mode switch — one honest pill.
 *
 * INTERACTIVE: everything JARVIS does appears live in the activity feed; he speaks.
 * BACKGROUND: he works silently (no speech, no captions, the browser panel stays off
 * screen) and every finished task lands as one notification with the audited outcome.
 * Switching from the HUD or via the set_interaction_mode tool is the same code path:
 * the main process persists it, broadcasts it, and every subscriber updates.
 */
export default function ModeToggle() {
  const [mode, setLocal] = useState<InteractionMode>(getMode());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    initMode(window.electronAPI?.on);
    return subscribeMode(setLocal);
  }, []);

  const flip = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await switchMode(mode === 'interactive' ? 'background' : 'interactive');
      // The push updates the label; a failed switch keeps the old one (the result text
      // is returned to the model when it flips the mode — here the push is the truth).
    } finally {
      setBusy(false);
    }
  };

  const bg = mode === 'background';
  return (
    <button
      type="button"
      onClick={flip}
      disabled={busy}
      title={
        bg
          ? 'Background mode: silent work, one notification per finished task. Click for Interactive mode.'
          : 'Interactive mode: everything is shown live. Click for Background mode (silent, notify when done).'
      }
      className={`no-drag rounded-full border px-3 py-1 font-mono text-[12px] transition-colors ${
        bg ? 'border-accent/60 text-accent' : 'border-steel/30 text-steel hover:border-steel/60'
      } ${busy ? 'opacity-50' : ''}`}
    >
      {bg ? '● BACKGROUND' : '○ INTERACTIVE'}
    </button>
  );
}
