import { useEffect, useState } from 'react';
import { useInvocations } from '../hooks/useActivity';
import type { InvocationRecord, InvocationState } from '../lib/protocol';

const pad = (n: number) => String(n).padStart(2, '0');
const hms = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

/**
 * Event time as HH:MM:SS. A push with a missing/garbage `t` used to print "Invalid Date"
 * into the feed; now it degrades to a placeholder and the row still reads normally.
 */
export const feedTime = (t: unknown): string => {
  const d = new Date(typeof t === 'number' && Number.isFinite(t) ? t : NaN);
  return Number.isNaN(d.getTime()) ? '--:--:--' : hms(d);
};

/**
 * Execution states on the activity wire (Round 23). The glyphs reuse the existing
 * feed vocabulary (✓ ✗ ◇) so the visual language stays native; cancelled/blocked get
 * their own marks so a policy block is never mistaken for a tool failure.
 */
export const STATE_MARK: Record<InvocationState, { glyph: string; cls: string }> = {
  running: { glyph: '◇', cls: 'animate-pulse text-accent' },
  completed: { glyph: '✓', cls: 'text-accent' },
  failed: { glyph: '✗', cls: 'text-hot' },
  cancelled: { glyph: '⊘', cls: 'text-steel' },
  blocked: { glyph: '⊗', cls: 'text-hot' },
};

const STATE_LABEL: Record<InvocationState, string> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  blocked: 'blocked',
};

/**
 * One invocation row: time, state glyph, tool name, clipped detail, duration.
 * The detail is the engine's own one-line summary (arg-preview conventions) — this
 * component never renders raw arguments or results.
 */
export function InvocationRow({ r }: { r: InvocationRecord }) {
  const tone = STATE_MARK[r.state] ?? STATE_MARK.running;
  return (
    <li className="flex items-baseline gap-2">
      <time className="shrink-0 font-mono text-[10px] text-accent/70">{feedTime(r.startedAt)}</time>
      <span className={`shrink-0 font-mono text-[11px] leading-none ${tone.cls}`} title={STATE_LABEL[r.state]}>
        {tone.glyph}
      </span>
      <span className={`truncate text-[12.5px] leading-snug ${r.state === 'running' ? 'text-accent' : r.state === 'failed' || r.state === 'blocked' ? 'text-hot/85' : 'text-hot/80'}`} title={`${r.tool} — ${STATE_LABEL[r.state]}${r.detail ? `: ${r.detail}` : ''}`}>
        {r.tool}
      </span>
      {r.detail && <span className="hidden min-w-0 truncate font-mono text-[10.5px] text-steel md:block">{r.detail}</span>}
      {r.ms !== undefined && <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-steel">{r.ms}ms</span>}
    </li>
  );
}

/**
 * THE SHARED INVOCATION LIST — one implementation, two mounts:
 * the header's expandable tool-activity panel and the Settings → Activity section.
 *
 * Records arrive in storage order (oldest → newest) and render newest-first. The list
 * itself is windowed for rendering (`maxRows`), while the underlying data stays complete:
 * "… N earlier" keeps the count honest and Settings → Activity serves the full history
 * through pagination (loadMore), so nothing is ever truncated away.
 */
export function ActivityList({
  records,
  maxRows = 40,
  emptyLabel = 'No tool activity yet.',
  onLoadMore,
  hasMore = false,
  loading = false,
  dense = false,
}: {
  records: InvocationRecord[];
  maxRows?: number;
  emptyLabel?: string;
  onLoadMore?: () => void;
  hasMore?: boolean;
  loading?: boolean;
  dense?: boolean;
}) {
  if (records.length === 0) {
    return <p className="text-sm text-steel">{loading ? 'Loading…' : emptyLabel}</p>;
  }
  const newest = [...records].reverse();
  const rows = newest.slice(0, maxRows);
  const older = newest.length - rows.length;
  return (
    <div className={dense ? 'space-y-1' : 'space-y-2'}>
      <ol className="space-y-1.5">
        {rows.map((r) => (
          <InvocationRow key={r.cid} r={r} />
        ))}
      </ol>
      {(older > 0 || hasMore) && (
        <div className="flex items-center justify-between pt-1">
          {older > 0 ? <span className="font-mono text-[10px] text-steel">… {older} earlier invocation{older === 1 ? '' : 's'} in this scope</span> : <span />}
          {hasMore && onLoadMore ? (
            <button type="button" onClick={onLoadMore} className="font-mono text-[10px] uppercase tracking-wider text-accent hover:text-hot">
              {loading ? 'loading…' : 'load older'}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The Settings → Activity section: scope picker + live summary + the full, paged
 * invocation history. This is the relocated old right-rail ActivityFeed (single
 * implementation, now with real history instead of a capped ring window).
 */
export function SettingsActivitySection() {
  const [scopes, setScopes] = useState<Array<{ scope: string; label: string; calls: number }>>([]);
  // 'all' is the server-side sentinel for every scope in this session.
  const [scope, setScope] = useState<string>('all');
  const feed = useInvocations(scope);
  const s = feed.summary;

  // The scope list refreshes with the section and whenever the loaded history grows —
  // a scope that just received its first invocation appears without reopening Settings.
  useEffect(() => {
    let alive = true;
    void window.electronAPI.activity
      .scopes()
      .then((list) => alive && setScopes((list ?? []).map((x) => ({ scope: x.scope, label: x.label, calls: x.calls }))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [feed.total]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="rail-title">Activity</h2>
        <span className="font-mono text-[11px] tabular-nums text-steel" data-testid="activity-summary">
          {s ? (
            <>
              <span className="text-accent">{s.tools}</span> tools · <span className="text-accent">{s.calls}</span> calls
              {s.running > 0 && <> · <span className="animate-pulse text-accent">{s.running} running</span></>}
              {s.failed > 0 && <> · <span className="text-hot">{s.failed} failed</span></>}
              {s.cancelled > 0 && <> · <span className="text-steel">{s.cancelled} cancelled</span></>}
              {s.blocked > 0 && <> · <span className="text-hot">{s.blocked} blocked</span></>}
            </>
          ) : (
            'no activity yet'
          )}
        </span>
      </div>

      <label className="flex items-center justify-between gap-4 text-sm text-steel">
        Scope
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value || 'all')}
          className="ml-auto max-w-[70%] border-b border-line bg-transparent py-1 font-mono text-sm text-hot outline-none focus:border-accent"
        >
          <option value="all" className="bg-[#04101a]">
            All scopes (this session)
          </option>
          {scopes.map((sc) => (
            <option key={sc.scope} value={sc.scope} className="bg-[#04101a]">
              {sc.label} ({sc.calls})
            </option>
          ))}
        </select>
      </label>

      <div className="max-h-[46vh] overflow-y-auto pr-1">
        <ActivityList
          records={feed.records}
          maxRows={500}
          hasMore={feed.hasMore}
          loading={feed.loading}
          onLoadMore={feed.loadMore}
          emptyLabel="No tool activity has been recorded in this scope."
        />
      </div>
    </div>
  );
}
