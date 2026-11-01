import { useEffect, useState } from 'react';
import type { ActivityEvent } from '../lib/protocol';

/**
 * The live activity feed: tool calls with their args, results and timings, progress
 * notes, approvals, visuals — whatever JARVIS is doing, newest first. A tool's start
 * and its result share a correlation id (cid), so the busy line is replaced in place
 * by the outcome instead of doubling up. Mode-independent: events are buffered in
 * background mode too, so the feed shows what happened the moment the user looks.
 */
export function useActivity(limit = 80): ActivityEvent[] {
  const [items, setItems] = useState<ActivityEvent[]>([]);

  useEffect(() => {
    let alive = true;
    void window.electronAPI.modes
      .get()
      .then((info) => {
        // The initial pull is oldest→newest; the feed renders newest first.
        if (alive) setItems([...info.events].reverse());
      })
      .catch(() => {});
    const off = window.electronAPI.on('jarvis-activity', (e) => {
      const ev = e as ActivityEvent;
      setItems((prev) => {
        const i = prev.findIndex((p) => (ev.cid !== undefined && p.cid === ev.cid) || p.id === ev.id);
        if (i >= 0) {
          const next = [...prev];
          next[i] = ev;
          return next;
        }
        return [ev, ...prev].slice(0, limit);
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, [limit]);

  return items;
}
