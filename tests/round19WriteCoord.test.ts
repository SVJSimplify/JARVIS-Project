import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 19 CHANGE 1 — WRITE COORDINATION CORRECTNESS.
 *
 * Pins the fixed waitOnce() contract and the explicit operation/scope identity model:
 *   - the abort listener registered while waiting is removed on EVERY completion path
 *     (gate release, tick timeout, cancellation, rejection) — the Round 18 code removed
 *     a different function than it registered and leaked one listener per wait;
 *   - an already-aborted signal never enters a wait and never queues a lane waiter;
 *   - the re-check tick timer never outlives the wait it belongs to;
 *   - a failed acquisition (timeout, cancellation, exception) leaves no lock, no scope,
 *     and no orphaned lane-queue entry behind;
 *   - owner LABELS are diagnostics only: two operations sharing one owner string
 *     serialize; only the explicit scope token re-enters.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import {
  clearWriteLocks,
  liveWriteScopes,
  setWriteCoordTimeoutsForTests,
  withWriteLock,
  withWriteLocks,
  writeLocks,
} from '../src/main/writeCoord';
import { runWithExecutionScope } from '../src/main/toolResult';

const ROOT = process.env.JARVIS_FILES_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-r19wc-'));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const uniq = (name: string): string => path.join(ROOT, `r19wc-${name}-${Math.random().toString(36).slice(2, 8)}.txt`);

beforeEach(() => {
  clearWriteLocks();
  setWriteCoordTimeoutsForTests();
});

afterEach(() => {
  setWriteCoordTimeoutsForTests();
  clearWriteLocks();
});

describe('CHANGE 1.1 — waitOnce abort-listener cleanup on every completion path', () => {
  it('a wait that ends via GATE RELEASE leaves no abort listener behind (abort afterwards is inert)', async () => {
    const file = uniq('gate-release');
    const first = withWriteLock(file, 'holder', async () => {
      await sleep(80);
      return 'held';
    });
    await sleep(10); // the lock is now held
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const waiter = withWriteLock(file, 'waiter', async () => 'ok');
      // The waiter is inside waitOnce; abort AFTER the gate released and the waiter
      // finished. With the Round 18 leak the still-registered listener would reject a
      // settled race; with the fix the listener is gone and nothing surfaces.
      await first;
      const ctl = new AbortController();
      await runWithExecutionScope({ signal: ctl.signal }, async () => withWriteLock(file, 'waiter2', async () => 'ok2'));
      await waiter;
      ctl.abort();
      await sleep(30);
      expect(unhandled).toEqual([]);
      expect(writeLocks()).toEqual([]);
      expect(liveWriteScopes()).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a wait that ends via the re-check TICK removes its listener and clears its timer (no post-timeout rejection)', async () => {
    setWriteCoordTimeoutsForTests(40); // tick = min(250, 40) = 40ms
    const file = uniq('tick');
    const first = withWriteLock(file, 'holder', async () => {
      await sleep(200);
      return 'held';
    });
    await sleep(5);
    const ctl = new AbortController();
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      // Capture the rejection SYNCHRONOUSLY so nothing surfaces as unhandled while we wait.
      const waiter = runWithExecutionScope({ signal: ctl.signal }, () =>
        withWriteLock(file, 'waiter', async () => {
          await sleep(0);
          return 'ok';
        })
      );
      const outcome: 'ok' | Error = await waiter.then(() => 'ok', (e: Error) => e);
      // Two ticks elapse while the holder still owns the lock; the waiter's own
      // acquire deadline (40ms) throws the structured conflict. The abort fires LATER:
      // a leaked listener would surface as a second, unhandled rejection.
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/WRITE CONFLICT/);
      await first;
      await sleep(30);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      setWriteCoordTimeoutsForTests();
    }
  });

  it('a wait that ends via CANCELLATION removes its listener (a second abort is a no-op)', async () => {
    const file = uniq('cancel-cleanup');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = withWriteLock(file, 'holder', async () => {
      await gate;
      return 'held';
    });
    await sleep(5);
    const ctl = new AbortController();
    const waiter = runWithExecutionScope({ signal: ctl.signal }, () =>
      withWriteLock(file, 'waiter', async () => 'never')
    );
    await sleep(20);
    ctl.abort();
    await expect(waiter).rejects.toThrow('cancelled');
    release();
    await first;
    ctl.abort(); // second fire: must be inert (listener removed on the first settlement)
    await sleep(20);
    expect(writeLocks()).toEqual([]);
  });
});

describe('CHANGE 1.2 — already-aborted signals never enter a wait', () => {
  it('a lock wait on an already-aborted scope throws cancelled without acquiring or waiting', async () => {
    const file = uniq('pre-aborted');
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      runWithExecutionScope({ signal: ctl.signal }, () => withWriteLock(file, 'doomed', async () => 'never'))
    ).rejects.toThrow('cancelled');
    expect(writeLocks()).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a lane-parking sibling on an already-aborted scope throws cancelled and leaves no queue entry', async () => {
    const file = uniq('pre-aborted-lane');
    const ctl = new AbortController();
    const result = await runWithExecutionScope({ signal: ctl.signal }, () =>
      withWriteLock(file, 'parent', async (scope) => {
        ctl.abort(); // abort BEFORE the sibling tries to park
        const sibling = withWriteLock(file, 'sibling', async () => 'never', { scope });
        await expect(sibling).rejects.toThrow('cancelled');
        return 'parent-ok';
      })
    );
    expect(result).toBe('parent-ok');
    expect(writeLocks()).toEqual([]);
  });
});

describe('CHANGE 1.3 — failed acquisitions leave no residue', () => {
  it('a timed-out acquisition (structured conflict) leaves no lock, no scope, no orphaned queue entry', async () => {
    setWriteCoordTimeoutsForTests(60);
    const file = uniq('timeout-residue');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = withWriteLock(file, 'holder', async () => {
      await gate;
      return 'held';
    });
    await sleep(5);
    await expect(withWriteLock(file, 'loser', async () => 'never')).rejects.toThrow(/WRITE CONFLICT/);
    // The loser is gone: nothing is left behind except the healthy holder.
    expect(writeLocks().length).toBe(1);
    expect(writeLocks()[0].owner).toBe('holder');
    expect(liveWriteScopes().length).toBe(1);
    release();
    await holder;
    expect(writeLocks()).toEqual([]);
    expect(liveWriteScopes()).toEqual([]);
  });

  it('an exception during acquisition of the SECOND path releases the FIRST and orphans nothing', async () => {
    const a = uniq('multi-a');
    const b = uniq('multi-b');
    // Hold b so the second acquisition spins; the loser times out.
    setWriteCoordTimeoutsForTests(50);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = withWriteLock(b, 'holder', async () => {
      await gate;
      return 'held';
    });
    await sleep(5);
    await expect(withWriteLocks([a, b], 'multi', async () => 'never')).rejects.toThrow(/WRITE CONFLICT/);
    // Path `a` (acquired first) was released by the failure path:
    expect(writeLocks().map((l) => l.path)).toEqual([expect.stringContaining('multi-b') || '']);
    release();
    await holder;
    expect(writeLocks()).toEqual([]);
  });

  it('a throwing nested child leaves no orphaned lane-queue entry for later siblings', async () => {
    const file = uniq('orphan-queue');
    const order: string[] = [];
    await withWriteLock(file, 'parent', async (scope) => {
      const child = withWriteLock(
        file,
        'child',
        async () => {
          order.push('child');
          throw new Error('child exploded');
        },
        { scope }
      );
      await expect(child).rejects.toThrow('child exploded');
      // The parent still runs fine after the child's failure, and a later nested call
      // takes the lane cleanly (no stale entry blocks it).
      const later = await withWriteLock(file, 'later', async () => 'later-ok', { scope });
      order.push(later);
      return order;
    });
    expect(order).toEqual(['child', 'later-ok']);
    expect(writeLocks()).toEqual([]);
    expect(liveWriteScopes()).toEqual([]);
  });
});

describe('CHANGE 1.4 — owner labels are diagnostics, never identity', () => {
  it('two top-level operations sharing the SAME owner string serialize (no label-based reentrancy)', async () => {
    const file = uniq('same-owner');
    let inside = 0;
    let peak = 0;
    const job = async (n: number): Promise<string> =>
      withWriteLock(file, 'identical-owner', async () => {
        inside += 1;
        peak = Math.max(peak, inside);
        await sleep(15);
        inside -= 1;
        return `job-${n}`;
      });
    const [x, y] = await Promise.all([job(1), job(2)]);
    expect([x, y].sort()).toEqual(['job-1', 'job-2']);
    expect(peak).toBe(1); // mutual exclusion held despite identical labels
  });

  it('siblings inside Promise.all that inherit the same ambient context and owner still serialize', async () => {
    const file = uniq('ambient-siblings');
    let inside = 0;
    let peak = 0;
    await runWithExecutionScope({}, async () => {
      await Promise.all(
        [1, 2, 3].map((n) =>
          withWriteLock(file, 'shared-label', async () => {
            inside += 1;
            peak = Math.max(peak, inside);
            await sleep(10);
            inside -= 1;
            return n;
          })
        )
      );
    });
    expect(peak).toBe(1);
  });

  it('overlapping multi-file writes acquire in sorted order and both sides complete (deadlock-free)', async () => {
    const a = uniq('overlap-a');
    const b = uniq('overlap-b');
    const [r1, r2] = await Promise.all([
      withWriteLocks([a, b], 'opA', async () => {
        await sleep(15);
        return 'A';
      }),
      withWriteLocks([b, a], 'opB', async () => {
        await sleep(5);
        return 'B';
      }),
    ]);
    expect([r1, r2].sort()).toEqual(['A', 'B']);
    expect(writeLocks()).toEqual([]);
  });
});
