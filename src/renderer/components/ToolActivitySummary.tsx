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
    <div className="absolute left-0 top-9 z-30 w-[440px] max-w-[80vw] rounded-2xl border border-hairline bg-surface p-4 shadow-[0_1px_2px_rgba(60,42,20,0.06),0_20px_50px_rgba(60,42,20,0.14)]">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="font-display text-[12px] font-bold text-steel">
          {scopeKind === 'task' ? `Task ${scope}` : scopeKind === 'turn' ? 'This prompt' : 'Session'}
        </span>
        <span className="font-mono text-[12px] tabular-nums text-steel">
          {calls} call{calls === 1 ? '' : 's'}
        </span>
      </div>
      <div className="max-h-[46vh] overflow-y-auto pr-1">
        <ActivityList records={feed.records} maxRows={POPOVER_ROWS} hasMore={feed.hasMore} loading={feed.loading} onLoadMore={feed.loadMore} dense />
      </div>
      <button type="button" onClick={onOpenActivity} className="mt-2 font-mono text-[12px] text-accent hover:text-hot">
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
    <div ref={wrapRef} className="relative hidden min-w-0 md:block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Tool activity — calls, states and durations of the current scope"
        title="Tool activity — click to inspect the individual invocations"
        className={`no-drag flex h-7 min-w-0 items-center gap-2 rounded-full border px-3 text-[12.5px] tabular-nums transition-colors ${
          open ? 'border-sand bg-surface text-ink' : 'border-hairline bg-surface text-muted hover:border-sand hover:text-ink'
        }`}
      >
        {inv.running > 0 ? (
          <svg width="12" height="12" viewBox="0 0 20 20" fill="none" className="anim-spin shrink-0" aria-hidden="true">
            <circle cx="10" cy="10" r="7.5" stroke="#E6DECF" strokeWidth="2.5" />
            <path d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5" stroke="#B05A33" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" aria-hidden="true">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
        )}
        <span>
          {inv.calls} call{inv.calls === 1 ? '' : 's'}
          {inv.running > 0 && <span className="text-accent"> · {inv.running} running</span>}
        </span>
        {errors > 0 && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" title={`${errors} failed or blocked invocation${errors === 1 ? '' : 's'}`} />}
      </button>

      {open && <ActivityInspector onOpenActivity={onOpenActivity} scopeKind={inv.scopeKind} scope={inv.scope} calls={inv.calls} />}
    </div>
  );
}
