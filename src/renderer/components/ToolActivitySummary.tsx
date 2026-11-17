import { useEffect, useRef, useState } from 'react';
import { useTaskProgress } from '../hooks/useTaskProgress';
import { useInvocations } from '../hooks/useActivity';
import { ActivityList } from './ActivityFeed';

/**
 * THE EXECUTION HEADER'S TOOL ACTIVITY SUMMARY (Round 23).
 *
 * A compact, always-live line — "8 tools · 24 calls · 2 running" — fed by the shared
 * jarvis-progress snapshot (the main process aggregates it from the invocation ledger
 * on every event, in both interaction modes). One shared subscription for the whole
 * window; no extra push listeners while collapsed.
 *
 * Expanding opens the invocation inspector: the newest calls of the current scope with
 * their states and durations (rendered windowed — the compact header never tries to show
 * hundreds of rows), plus the pointer to the full paged history in Settings → Activity.
 * The observer can look, never act: nothing here can start, retry or authorize a tool.
 */

const POPOVER_ROWS = 40;

/** Mounted only while expanded — the query/subscription lifecycle belongs to the popover. */
function ActivityInspector({ onOpenActivity, scopeKind, scope, calls }: { onOpenActivity: () => void; scopeKind: 'task' | 'turn' | 'session'; scope: string; calls: number }) {
  // Round 24: subscribe to THIS scope explicitly. The initial page and the live pushes
  // now describe the same task/turn the header counts describe — the hook's scope
  // filter drops pushes stamped with any other scope, so one task's activity can no
  // longer leak into another task's inspector while both are live.
  const feed = useInvocations(scope);
  return (
    <div className="absolute left-0 top-7 z-30 w-[420px] max-w-[80vw] rounded-md border border-accent/25 bg-[rgb(var(--void)/0.97)] p-3 shadow-lg shadow-black/40">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-display text-[9px] font-bold uppercase tracking-[0.32em] text-steel">
          {scopeKind === 'task' ? `Task ${scope}` : scopeKind === 'turn' ? 'This prompt' : 'Session'}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-steel">
          {calls} call{calls === 1 ? '' : 's'}
        </span>
      </div>
      <div className="max-h-[46vh] overflow-y-auto pr-1">
        <ActivityList records={feed.records} maxRows={POPOVER_ROWS} hasMore={feed.hasMore} loading={feed.loading} onLoadMore={feed.loadMore} dense />
      </div>
      <button type="button" onClick={onOpenActivity} className="mt-2 font-mono text-[10px] uppercase tracking-wider text-accent hover:text-hot">
        Full history → Settings › Activity
      </button>
    </div>
  );
}

export default function ToolActivitySummary({ onOpenActivity }: { onOpenActivity: () => void }) {
  const snap = useTaskProgress();
  const inv = snap?.invocations;
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  if (!inv) return null; // no ledger data yet (fresh boot): render nothing, no clutter
  const errors = inv.failed + inv.blocked;

  return (
    <div ref={wrapRef} className="relative ml-4 hidden min-w-0 md:block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Tool activity — calls, states and durations of the current scope"
        title="Tool activity — click to inspect the individual invocations behind these counts"
        className="no-drag flex min-w-0 items-baseline gap-2 font-mono text-[11px] text-steel transition-colors hover:text-accent"
      >
        <span className="hidden shrink-0 font-display text-[9px] font-bold uppercase tracking-[0.3em] lg:inline">Tool Activity</span>
        <span className="tabular-nums">
          <span className="text-accent">{inv.tools}</span> tools · <span className="text-accent">{inv.calls}</span> calls
          {inv.running > 0 ? (
            <>
              {' · '}
              <span className="animate-pulse text-accent">{inv.running} running</span>
            </>
          ) : (
            ''
          )}
        </span>
        {errors > 0 && <span className="shrink-0 text-hot" title={`${errors} failed or blocked invocation${errors === 1 ? '' : 's'}`}>●</span>}
      </button>

      {open && <ActivityInspector onOpenActivity={onOpenActivity} scopeKind={inv.scopeKind} scope={inv.scope} calls={inv.calls} />}
    </div>
  );
}
