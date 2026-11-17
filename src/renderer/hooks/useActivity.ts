import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActivityEvent, InvocationRecord, InvocationSummary } from '../lib/protocol';

/**
 * THE INVOCATION HISTORY HOOK (Round 23; async race-hardening in Round 24) — the
 * renderer's single source of tool activity.
 *
 * Data comes from two REAL channels, never fabricated:
 *  1. the main-process invocation ledger, through the paged `activity.query` API —
 *     the COMPLETE history of a scope (no window, no 30-item ceiling; a 500-call task
 *     is served in full across pages);
 *  2. the live `jarvis-activity` push, filtered by the event's ledger `scope` stamp —
 *     so another task's events can never leak into this view.
 *
 * Round 24 — async discipline. The page query and the push stream now interleave safely:
 *  - every effect run (scope / live / pageSize change) claims a monotonic REQUEST
 *    GENERATION and every async result applies only while its generation is still
 *    current, so a late answer from an older request — or from another scope — can
 *    never overwrite the view the user is looking at (unmount invalidates too);
 *  - a query page is MERGED into the records already collected from live pushes
 *    (deduplicated by correlation id, newest event id wins, storage order preserved)
 *    instead of replacing state — pushes that land while the first page is in flight
 *    survive its resolution;
 *  - pagination advances by the SERVER-ECHOED offset + page length, so live records
 *    arriving between pages can no longer skew the next page window;
 *  - the total only moves forward (a monotonic max over the query total, the merged
 *    records and the live count) — never a silent regression.
 *
 * Subscription hygiene: exactly ONE push listener per mounted hook instance, removed on
 * unmount and on every scope change; records are deduplicated by correlation id, so a
 * re-mounted view (or a duplicate delivery) can never create phantom entries. Renders
 * are windowed by the list component — the hook never truncates its data.
 */

const PAGE = 150;

export interface InvocationFeed {
  /** Storage order (oldest → newest); display layers reverse for newest-first. */
  records: InvocationRecord[];
  /** Total invocations recorded in the scope (may exceed what is loaded so far). */
  total: number;
  /** True while older pages are still available. */
  hasMore: boolean;
  loading: boolean;
  summary: InvocationSummary | null;
  loadMore: () => void;
}

interface FeedOpts {
  /** Subscribe to live pushes for this scope (default true). */
  live?: boolean;
  /** Page size for the query API (default 150, server cap 500). */
  pageSize?: number;
}

/** Pure projection: one wire event → one invocation record. Exported for tests. */
export const recordOfEvent = (ev: ActivityEvent): InvocationRecord => ({
  id: ev.id,
  cid: ev.cid!,
  ...(ev.taskId ? { taskId: ev.taskId } : {}),
  tool: ev.label,
  state: ev.blocked ? 'blocked' : ev.cancelled ? 'cancelled' : ev.status === 'ok' ? 'completed' : ev.status === 'fail' ? 'failed' : 'running',
  startedAt: ev.t,
  ...(ev.detail !== undefined ? { detail: ev.detail } : {}),
  ...(typeof ev.ms === 'number' ? { ms: ev.ms } : {}),
  ...(ev.status && ev.status !== 'busy' ? { endedAt: ev.t } : {}),
});

/**
 * Pure, idempotent merge of a query page into the records already collected from live
 * pushes (Round 24). Deduplicates by correlation id — on equal first-event ids the
 * LEDGER's page record wins (it carries the record's latest state even when only its
 * start event was ever pushed live), on differing ids the NEWEST event id wins, so a
 * stale snapshot can never regress a live record — and re-establishes storage order
 * (ledger sequence, oldest → newest). Exported for tests.
 */
export const mergeRecords = (current: InvocationRecord[], incoming: InvocationRecord[]): InvocationRecord[] => {
  const byCid = new Map<string, InvocationRecord>();
  const fold = (r: InvocationRecord): void => {
    const prev = byCid.get(r.cid);
    if (!prev || r.id >= prev.id) byCid.set(r.cid, r);
  };
  for (const r of current) fold(r);
  for (const r of incoming) fold(r);
  return [...byCid.values()].sort((a, b) => a.id - b.id || a.startedAt - b.startedAt);
};

/**
 * Pure upsert for one live record: replace in place, never regress to an older event.
 * A brand-new cid appends at the end — its event id is strictly the newest seen so far,
 * so append order stays storage order. Exported for tests.
 */
export const upsertRecord = (records: InvocationRecord[], rec: InvocationRecord): InvocationRecord[] => {
  const at = records.findIndex((r) => r.cid === rec.cid);
  if (at < 0) return [...records, rec];
  if (rec.id <= records[at].id) return records; // stale replay — nothing to change
  const next = [...records];
  next[at] = rec;
  return next;
};

export function useInvocations(scope?: string, opts: FeedOpts = {}): InvocationFeed {
  const { live = true, pageSize = PAGE } = opts;
  const [records, setRecords] = useState<InvocationRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<InvocationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // Round 24: request generation. Each effect run claims the next number; the cleanup
  // moves the counter past it. An async result may touch state ONLY while its
  // generation is still the current one. (The single `alive` ref this replaces was
  // flipped back to true by the next effect run before an older request had settled —
  // exactly how a stale scope's page used to overwrite the freshly selected one.)
  const genRef = useRef(0);
  // The authoritative record list kept OUTSIDE React state: push events and query pages
  // are folded synchronously through the pure helpers above, so no interleaved promise
  // resolution can ever base its merge on a stale render of the state.
  const recordsRef = useRef<InvocationRecord[]>([]);
  // Monotonic total floor for the scope (reset per effect run, raised from below).
  const totalRef = useRef(0);
  // Ledger positions already served by query pages — the server echoes the clamped
  // offset back, so consumed = echoed offset + page length. Counting the renderer's own
  // array instead used to skip ledger rows whenever a live record landed between pages.
  const loadedRef = useRef(0);
  // Newest event id folded in, per correlation id: duplicate delivery is idempotent.
  const seen = useRef(new Map<string, number>());

  useEffect(() => {
    const gen = ++genRef.current;
    const current = (): boolean => genRef.current === gen;
    setLoading(true);
    recordsRef.current = [];
    setRecords([]);
    totalRef.current = 0;
    setTotal(0);
    loadedRef.current = 0;
    seen.current = new Map();
    setSummary(null);
    void window.electronAPI.activity
      .query({ scope, offset: 0, limit: pageSize })
      .then((q) => {
        if (!current()) return; // a late page from an older request/scope never overwrites this view
        const fresh = q.records ?? [];
        // MERGE, never replace: pushes that arrived while this page was in flight are
        // already in the view, and wholesale replacement here is exactly how they used
        // to vanish the moment the snapshot landed.
        const merged = mergeRecords(recordsRef.current, fresh);
        recordsRef.current = merged;
        setRecords(merged);
        for (const r of fresh) seen.current.set(r.cid, Math.max(seen.current.get(r.cid) ?? 0, r.id));
        loadedRef.current = Math.max(loadedRef.current, (q.offset ?? 0) + fresh.length);
        // The total only moves forward: the query's own snapshot, whatever the live
        // pushes already raised it to, and the records actually merged are all lower
        // bounds on what the scope really holds.
        totalRef.current = Math.max(totalRef.current, q.total ?? fresh.length, merged.length);
        setTotal(totalRef.current);
        setLoading(false);
      })
      .catch(() => current() && setLoading(false));
    void window.electronAPI.activity
      .summary(scope)
      .then((s) => current() && setSummary(s))
      .catch(() => undefined);

    let lastSummaryPull = 0;
    const off = live
      ? window.electronAPI.on('jarvis-activity', (raw) => {
          const ev = raw as ActivityEvent;
          if (!ev || typeof ev !== 'object' || ev.kind !== 'tool' || !ev.cid) return;
          // Scope discipline: a push without a ledger stamp belongs to no visible scope
          // (it can only come from a main process older than the stamp contract) — it is
          // dropped, never guessed into the current view.
          if (!ev.scope) return;
          if (scope && ev.scope !== scope) return; // another task's activity never leaks in
          const last = seen.current.get(ev.cid);
          if (last !== undefined && ev.id <= last) return; // duplicate — idempotent
          const isNew = last === undefined;
          seen.current.set(ev.cid, Math.max(last ?? 0, ev.id));
          const rec = recordOfEvent(ev);
          if (isNew) {
            totalRef.current += 1;
            setTotal(totalRef.current);
          }
          const next = upsertRecord(recordsRef.current, rec);
          recordsRef.current = next;
          setRecords(next);
          // Summary counts are cheap but not free: at most one pull per 300 ms burst.
          const now = Date.now();
          if (now - lastSummaryPull > 300) {
            lastSummaryPull = now;
            void window.electronAPI.activity
              .summary(scope)
              .then((s) => current() && setSummary(s))
              .catch(() => undefined);
          }
        })
      : undefined;

    return () => {
      // Invalidate every request this run issued — a scope change or an unmount must
      // leave no path by which their answers could still reach the view.
      genRef.current += 1;
      off?.();
    };
  }, [scope, live, pageSize]);

  const loadMore = useCallback(() => {
    const gen = genRef.current; // pinned at dispatch; any scope change invalidates it
    setLoading(true);
    void window.electronAPI.activity
      .query({ scope, offset: loadedRef.current, limit: pageSize })
      .then((q) => {
        if (genRef.current !== gen) return; // the view moved on — this page belongs to nobody
        const fresh = q.records ?? [];
        const merged = mergeRecords(recordsRef.current, fresh);
        recordsRef.current = merged;
        setRecords(merged);
        for (const r of fresh) seen.current.set(r.cid, Math.max(seen.current.get(r.cid) ?? 0, r.id));
        loadedRef.current = Math.max(loadedRef.current, (q.offset ?? 0) + fresh.length);
        totalRef.current = Math.max(totalRef.current, q.total ?? 0, merged.length);
        setTotal(totalRef.current);
        setLoading(false);
      })
      .catch(() => genRef.current === gen && setLoading(false));
  }, [scope, pageSize]);

  return { records, total, hasMore: records.length < total, loading, summary, loadMore };
}
