import { useEffect, useState } from 'react';
import type { ProgressSnapshot } from '../lib/protocol';

/**
 * The live task progress snapshot: what JARVIS is doing right now, the current
 * turn's step checklist, and the durable-task boards — updated in
 * real time in BOTH interaction modes (the main process pushes the dedicated
 * `jarvis-progress` channel regardless of the background-mode silence rules).
 *
 * Late subscribers first pull the current snapshot (`progress.get`), so a
 * freshly (re)loaded window shows the truth on first paint instead of waiting
 * for the next event. Out-of-order or malformed pushes are dropped: the
 * snapshot is only ever replaced by an equal or newer one.
 */
export function useTaskProgress(): ProgressSnapshot | null {
  const [snap, setSnap] = useState<ProgressSnapshot | null>(null);

  useEffect(() => {
    let alive = true;
    // Optional chaining: a renderer rebuilt ahead of its preload (or a fresh window
    // before the bridge is ready) degrades to push-only instead of crashing the HUD.
    void (window.electronAPI.progress?.get?.() as Promise<ProgressSnapshot> | undefined)
      ?.then((s) => {
        if (alive && s && typeof s === 'object' && typeof s.updatedAt === 'number') setSnap(s);
      })
      .catch(() => {});
    const off = window.electronAPI.on('jarvis-progress', (raw) => {
      const p = raw as ProgressSnapshot | null;
      // Boundary discipline: a malformed push is dropped, never rendered.
      if (!p || typeof p !== 'object' || typeof p.updatedAt !== 'number' || !Number.isFinite(p.updatedAt)) return;
      setSnap((prev) => (prev && prev.updatedAt > p.updatedAt ? prev : p));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  return snap;
}
