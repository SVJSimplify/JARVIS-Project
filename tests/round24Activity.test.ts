// @vitest-environment jsdom
/**
 * ROUND 24 — ACTIVITY TRACKING RELIABILITY REGRESSION TESTS.
 *
 * These drive the REAL `useInvocations` hook (React Testing Library + jsdom) against a
 * fake electron bridge whose query/summary promises are resolved manually, so the exact
 * interleavings reported against Round 23 can be reproduced deterministically:
 *
 *   1. activity from Scope A never appears in Scope B;
 *   2. switching from Scope A to Scope B immediately displays the correct scope;
 *   3. live events received during initial loading are not lost;
 *   4. a delayed response from an older request cannot overwrite newer state;
 *   5. rapidly switching between scopes does not cause cross-scope contamination;
 *   6. duplicate live events and query results do not create duplicate records;
 *   7. existing pagination, counters and activity history continue working.
 *
 * The fake bridge mirrors the real wire contract (src/preload/index.ts): `activity.query`
 * answers `{ scope, offset, limit, total, records }` (oldest → newest), `activity.summary`
 * answers an InvocationSummary, and `on('jarvis-activity', cb)` registers a push listener.
 * Auto mode additionally slices a fake ledger exactly like the real ledger handler
 * (offset clamped to total, echoed back, fixed page size), so pagination math is honest.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useInvocations } from '../src/renderer/hooks/useActivity';
import type { ActivityEvent } from '../src/main/protocol';
import type { InvocationQuery, InvocationRecord, InvocationSummary } from '../src/main/invocations';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --------------------------------------------------------------------- fake bridge

interface Pending<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

const pending = <T,>(): Pending<T> => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

type QueryOpts = { scope?: string; offset?: number; limit?: number };

const summaryFor = (scope: string, calls: number): InvocationSummary => ({
  scope,
  scopeKind: scope === 'session' ? 'session' : scope.startsWith('turn-') ? 'turn' : 'task',
  tools: Math.max(1, calls),
  calls,
  running: 0,
  completed: calls,
  failed: 0,
  blocked: 0,
  cancelled: 0,
  lastAt: 0,
});

class FakeBridge {
  /** Query calls in dispatch order, each still unresolved (manual mode). */
  readonly queries: Array<{ opts: QueryOpts; p: Pending<InvocationQuery> }> = [];
  readonly summaries: Array<{ scope?: string; p: Pending<InvocationSummary> }> = [];
  /** Auto mode: queries answer immediately from this ledger, PAGE rows per page. */
  ledger: InvocationRecord[] = [];
  auto = false;
  private channels = new Map<string, Set<(raw: unknown) => void>>();

  readonly activity = {
    query: (opts?: QueryOpts): Promise<InvocationQuery> => {
      const norm: QueryOpts = { scope: opts?.scope, offset: Math.max(0, opts?.offset ?? 0), limit: opts?.limit ?? 100 };
      if (this.auto) {
        const total = this.ledger.length;
        const offset = Math.min(norm.offset ?? 0, total);
        const records = this.ledger.slice(offset, offset + PAGE);
        return Promise.resolve({ scope: norm.scope, offset, limit: PAGE, total, records });
      }
      const p = pending<InvocationQuery>();
      this.queries.push({ opts: norm, p });
      return p.promise;
    },
    summary: (scope?: string): Promise<InvocationSummary> => {
      if (this.auto) return Promise.resolve(summaryFor(scope ?? 'session', 0));
      const p = pending<InvocationSummary>();
      this.summaries.push({ scope, p });
      return p.promise;
    },
    scopes: (): Promise<never[]> => Promise.resolve([]),
  };

  on = (channel: string, cb: (raw: unknown) => void): (() => void) => {
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(cb);
    return () => {
      this.channels.get(channel)?.delete(cb);
    };
  };

  emit(channel: string, raw: unknown): void {
    for (const cb of [...(this.channels.get(channel) ?? [])]) cb(raw);
  }

  listenerCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }

  /** Resolve the i-th dispatched query with a page; `total` mirrors the real handler. */
  resolveQuery(i: number, records: InvocationRecord[], total = records.length): void {
    const call = this.queries[i];
    if (!call) throw new Error(`no query call #${i}`);
    call.p.resolve({ scope: call.opts.scope, offset: call.opts.offset ?? 0, limit: call.opts.limit ?? 100, total, records });
  }
}

const PAGE = 2; // auto-mode page size — small so several pages are exercised

// --------------------------------------------------------------------- factories

let bridge: FakeBridge;
let seq = 0;

beforeEach(() => {
  seq = 100;
  bridge = new FakeBridge();
  (window as unknown as { electronAPI: unknown }).electronAPI = bridge;
});

afterEach(() => {
  cleanup();
});

/** A live wire event, stamped with the ledger scope like the main process does. */
const ev = (over: Partial<ActivityEvent>): ActivityEvent => {
  seq += 1;
  return { id: seq, t: 1_700_000_000_000 + seq, kind: 'tool', label: 'read_file', cid: `cid-${seq}`, status: 'busy', scope: 'task-A', ...over };
};

/** A ledger-shaped record for query pages (id = first event id, state = latest). */
const rec = (over: Partial<InvocationRecord>): InvocationRecord => {
  seq += 1;
  return { id: seq, cid: `cid-${seq}`, tool: 'read_file', state: 'completed', startedAt: 1_700_000_000_000 + seq, ...over };
};

/** Let already-resolved promise chains run to completion inside act(). */
const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

// ----------------------------------------------------------------------- the tests

describe('Round 24 — activity tracking reliability', () => {
  it('1 · activity from Scope B never appears in a Scope-A view', async () => {
    const { result } = renderHook(({ scope }) => useInvocations(scope), { initialProps: { scope: 'task-A' } });

    // the initial page request names THIS scope explicitly
    expect(bridge.queries[0].opts.scope).toBe('task-A');
    expect(bridge.queries[0].opts.offset).toBe(0);
    await act(async () => {
      bridge.resolveQuery(0, [rec({ cid: 'a1', id: 1 })]);
    });
    expect(result.current.records.map((r) => r.cid)).toEqual(['a1']);

    // a push stamped with ANOTHER scope is ignored — it can never leak in
    await act(async () => {
      bridge.emit('jarvis-activity', ev({ cid: 'b1', id: 2, scope: 'task-B', label: 'write_file' }));
    });
    expect(result.current.records.map((r) => r.cid)).toEqual(['a1']);
    expect(result.current.total).toBe(1);

    // a push from THIS scope still lands
    await act(async () => {
      bridge.emit('jarvis-activity', ev({ cid: 'a2', id: 3, scope: 'task-A' }));
    });
    expect(result.current.records.map((r) => r.cid)).toEqual(['a1', 'a2']);
    expect(result.current.total).toBe(2);
  });

  it('2 · switching from Scope A to Scope B shows B at once, with nothing left of A', async () => {
    const { result, rerender } = renderHook(({ scope }) => useInvocations(scope), { initialProps: { scope: 'task-A' } });
    await act(async () => {
      bridge.resolveQuery(0, [rec({ cid: 'a1', id: 1 })], 1);
    });
    expect(result.current.records.map((r) => r.cid)).toEqual(['a1']);

    rerender({ scope: 'task-B' });
    // reset happens immediately — no A residue — and the new page request names B
    expect(result.current.records).toEqual([]);
    expect(bridge.queries[1].opts.scope).toBe('task-B');

    await act(async () => {
      bridge.resolveQuery(1, [rec({ cid: 'b1', id: 2 })], 3);
    });
    expect(result.current.records.map((r) => r.cid)).toEqual(['b1']);
    expect(result.current.total).toBe(3);
    expect(result.current.hasMore).toBe(true); // 1 loaded of 3
  });

  it('3 · live pushes that land while the initial page is in flight survive it', async () => {
    const { result } = renderHook(() => useInvocations('task-A'));

    // a real push arrives BEFORE the snapshot resolves
    await act(async () => {
      bridge.emit('jarvis-activity', ev({ cid: 'live-1', id: 5, scope: 'task-A' }));
    });
    expect(result.current.records.map((r) => r.cid)).toEqual(['live-1']);

    // the snapshot lands WITHOUT the live invocation — it must merge, not replace
    await act(async () => {
      bridge.resolveQuery(0, [rec({ cid: 'q1', id: 2 })], 1);
    });
    expect(result.current.records.map((r) => r.cid)).toEqual(['q1', 'live-1']);
    expect(result.current.total).toBe(2); // the snapshot said 1; the live push made it 2
    expect(result.current.loading).toBe(false);
  });

  it('4 · a delayed response from an older request can never overwrite the current scope', async () => {
    const { result, rerender } = renderHook(({ scope }) => useInvocations(scope), { initialProps: { scope: 'task-A' } });

    // switch before A's page settles
    rerender({ scope: 'task-B' });
    await act(async () => {
      bridge.resolveQuery(1, [rec({ cid: 'b1', id: 2 })], 1);
    });
    await act(async () => {
      bridge.summaries[1].p.resolve(summaryFor('task-B', 1));
    });
    expect(result.current.records.map((r) => r.cid)).toEqual(['b1']);
    expect(result.current.summary?.scope).toBe('task-B');

    // NOW the stale A answers arrive — they must be dropped wholesale
    await act(async () => {
      bridge.resolveQuery(0, [rec({ cid: 'a1', id: 1 }), rec({ cid: 'a2', id: 2 })], 9);
    });
    await act(async () => {
      bridge.summaries[0].p.resolve(summaryFor('task-A', 9));
    });
    expect(result.current.records.map((r) => r.cid)).toEqual(['b1']); // records untouched
    expect(result.current.total).toBe(1); // totals untouched
    expect(result.current.summary?.scope).toBe('task-B'); // summary untouched
    expect(result.current.loading).toBe(false);
  });

  it('5 · rapid scope switching (A→B→A) cannot cross-contaminate the view', async () => {
    const { result, rerender } = renderHook(({ scope }) => useInvocations(scope), { initialProps: { scope: 'task-A' } });
    rerender({ scope: 'task-B' });
    rerender({ scope: 'task-A' }); // A again — a third request generation

    // adversarial resolution order: B first, then the stale A, then the fresh A
    await act(async () => {
      bridge.resolveQuery(1, [rec({ cid: 'b1', id: 20 })], 4);
    });
    expect(result.current.records).toEqual([]); // B's page belongs to an abandoned scope
    await act(async () => {
      bridge.resolveQuery(0, [rec({ cid: 'a0', id: 1 })], 2);
    });
    expect(result.current.records).toEqual([]); // the first A's page is equally stale
    await act(async () => {
      bridge.resolveQuery(2, [rec({ cid: 'a1', id: 30 }), rec({ cid: 'a2', id: 31 })], 2);
    });
    expect(result.current.records.map((r) => r.cid)).toEqual(['a1', 'a2']);

    // a live push from B still cannot enter
    await act(async () => {
      bridge.emit('jarvis-activity', ev({ cid: 'b2', id: 40, scope: 'task-B' }));
    });
    expect(result.current.records.map((r) => r.cid)).toEqual(['a1', 'a2']);
    expect(result.current.total).toBe(2);

    // stale summaries do not survive either
    await act(async () => {
      bridge.summaries[0].p.resolve(summaryFor('task-A', 2)); // first A — stale
    });
    await act(async () => {
      bridge.summaries[1].p.resolve(summaryFor('task-B', 4)); // B — stale
    });
    await act(async () => {
      bridge.summaries[2].p.resolve(summaryFor('task-A', 2)); // current A
    });
    expect(result.current.summary?.scope).toBe('task-A');
  });

  it('6 · duplicate deliveries — pushes and pages — collapse to one record each', async () => {
    const { result } = renderHook(() => useInvocations('task-A'));

    // the same start event delivered twice, then a newer terminal event for that cid
    await act(async () => {
      bridge.emit('jarvis-activity', ev({ cid: 'x1', id: 5, scope: 'task-A', status: 'busy' }));
    });
    await act(async () => {
      bridge.emit('jarvis-activity', ev({ cid: 'x1', id: 5, scope: 'task-A', status: 'busy' })); // duplicate delivery
    });
    await act(async () => {
      bridge.emit('jarvis-activity', ev({ cid: 'x1', id: 6, scope: 'task-A', status: 'ok', ms: 25 }));
    });
    expect(result.current.records).toHaveLength(1);
    expect(result.current.records[0]).toMatchObject({ cid: 'x1', state: 'completed', ms: 25 });
    expect(result.current.total).toBe(1);

    // the page redelivers x1 (at its older ledger state) plus a new record:
    // no duplicates, and the newer live state is never regressed by the snapshot
    await act(async () => {
      bridge.resolveQuery(0, [rec({ cid: 'x1', id: 5, state: 'running' }), rec({ cid: 'x0', id: 3 })], 2);
    });
    expect(result.current.records.map((r) => r.cid)).toEqual(['x0', 'x1']); // storage order, no duplicates
    expect(result.current.records[1]).toMatchObject({ cid: 'x1', state: 'completed' }); // newest state wins
    expect(result.current.total).toBe(2);
  });

  it('7 · pagination, counters and history keep working under live traffic', async () => {
    bridge.auto = true;
    bridge.ledger = [rec({ cid: 'r1', id: 1 }), rec({ cid: 'r2', id: 2 }), rec({ cid: 'r3', id: 3 }), rec({ cid: 'r4', id: 4 }), rec({ cid: 'r5', id: 5 })];
    const { result } = renderHook(() => useInvocations('task-A'));
    await settle();

    // first page
    expect(result.current.records.map((r) => r.cid)).toEqual(['r1', 'r2']);
    expect(result.current.total).toBe(5);
    expect(result.current.hasMore).toBe(true);

    // a live invocation lands between pages (ledger fold first, then the push — real order)
    bridge.ledger.push(rec({ cid: 'live-x', id: 10 }));
    await act(async () => {
      bridge.emit('jarvis-activity', ev({ cid: 'live-x', id: 10, scope: 'task-A' }));
    });
    expect(result.current.total).toBe(6);

    // page 2 through the REAL loadMore — the live record must not skew the window
    await act(async () => {
      result.current.loadMore();
      await Promise.resolve();
    });
    await settle();
    expect(result.current.records.map((r) => r.cid)).toEqual(['r1', 'r2', 'r3', 'r4', 'live-x']);
    expect(result.current.records.some((r) => r.cid === 'r5')).toBe(false);
    expect(result.current.hasMore).toBe(true); // 5 loaded of 6 — r5 is still reachable

    // page 3 completes the history; the live record is redelivered and deduplicated
    await act(async () => {
      result.current.loadMore();
      await Promise.resolve();
    });
    await settle();
    expect(result.current.records.map((r) => r.cid)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'live-x']);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.total).toBe(6);
  });

  it('unmount removes the push subscription, and late answers are harmless', async () => {
    const { unmount } = renderHook(() => useInvocations('task-A'));
    expect(bridge.listenerCount('jarvis-activity')).toBe(1);
    unmount();
    expect(bridge.listenerCount('jarvis-activity')).toBe(0);
    // the still-in-flight page settles after unmount — nothing throws, nobody listens
    await act(async () => {
      bridge.resolveQuery(0, [rec({ cid: 'a1', id: 1 })]);
    });
  });
});
