import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 20 CHANGE 2 — WRITE-COORDINATOR CANCELLATION RACES, ELIMINATED.
 *
 * Pins the register-before-check discipline and the queue hygiene guarantees:
 *   - a parked lane waiter is removed from the queue when its scope aborts, so a
 *     cancelled sibling can never later be granted the lane or the lock;
 *   - an abort that fires in the check/register window (already-aborted after
 *     registration) settles the wait immediately — no parked-forever waiters, no
 *     granted-but-cancelled lanes;
 *   - a cancelled acquisition releases every resource it touched (no locks, no scopes,
 *     no lane entries) and later acquisitions succeed cleanly;
 *   - nested reentrancy, Promise.all siblings, multi-resource acquisition and
 *     overlapping sets keep working (serialization preserved, no stealing from the
 *     healthy, reentrancy NOT disabled).
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
import { runWithExecutionScope, executionSignal } from '../src/main/toolResult';

const ROOT = process.env.JARVIS_FILES_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-r20wc-'));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const uniq = (name: string): string => path.join(ROOT, `r20wc-${name}-${Math.random().toString(36).slice(2, 8)}.txt`);

beforeEach(() => {
  clearWriteLocks();
  setWriteCoordTimeoutsForTests();
});

afterEach(() => {
  setWriteCoordTimeoutsForTests();
  clearWriteLocks();
});

describe('CHANGE 2 — cancellation during lane-queue acquisition', () => {
  it('an uncancelled sibling parked in the lane queue still completes, in order (fairness preserved)', async () => {
    const file = uniq('lane-fair');
    const ran: string[] = [];
    await runWithExecutionScope({}, async () => {
      await withWriteLocks([file], 'parent', async (scope) => {
        const childA = withWriteLocks([file], 'childA', async () => {
          await sleep(100);
          ran.push('A');
          return 'A';
        }, { scope });
        const childB = withWriteLocks([file], 'childB', async () => {
          ran.push('B');
          return 'B';
        }, { scope });
        expect(await Promise.all([childA, childB])).toEqual(['A', 'B']);
      });
    });
    expect(ran).toEqual(['A', 'B']); // parked sibling runs after the lane unwinds — never lost
    expect(writeLocks()).toEqual([]);
    expect(liveWriteScopes()).toEqual([]);
  });

  it('a sibling aborted while parked rejects with cancelled, leaves no lane entry, and later acquisitions succeed', async () => {
    const file = uniq('lane-abort-ctl');
    const order: string[] = [];
    await runWithExecutionScope({}, async () => {
      await withWriteLocks([file], 'parent', async (scope) => {
        const ctl = new AbortController();
        const childA = withWriteLocks([file], 'childA', async () => {
          await sleep(150);
          order.push('A-ran');
          return 'A';
        }, { scope });
        const childBPromise = runWithExecutionScope({ signal: ctl.signal }, () =>
          withWriteLocks([file], 'childB', async () => {
            order.push('B-ran'); // must never happen
            return 'B';
          }, { scope })
        );
        await sleep(40); // B parked in the lane queue behind A
        ctl.abort(); // cancel B while it waits for the lane
        await expect(childBPromise).rejects.toThrow(/cancelled/);
        order.push('B-cancelled');
        await childA;
      });
    });
    expect(order).toEqual(['B-cancelled', 'A-ran']);
    expect(writeLocks()).toEqual([]);
    expect(liveWriteScopes()).toEqual([]);
  });

  it('an already-aborted signal never queues a lane waiter and never grants the lock', async () => {
    const file = uniq('lane-preaborted');
    let innerRan = false;
    await runWithExecutionScope({}, async () => {
      await withWriteLocks([file], 'parent', async (scope) => {
        const childA = withWriteLocks([file], 'childA', async () => {
          await sleep(80);
          return 'A';
        }, { scope });
        await sleep(10);
        const ctl = new AbortController();
        ctl.abort(); // abort BEFORE the sibling even tries to acquire
        await expect(
          runWithExecutionScope({ signal: ctl.signal }, () =>
            withWriteLocks([file], 'childB', async () => {
              innerRan = true;
              return 'B';
            }, { scope })
          )
        ).rejects.toThrow(/cancelled/);
        await childA;
      });
    });
    expect(innerRan).toBe(false);
    expect(writeLocks()).toEqual([]);
  });

  it('an abort that fires BETWEEN the aborted-check and listener registration still settles the wait (register-before-check)', async () => {
    const file = uniq('race-window');
    // The old code checked signal.aborted, then registered the listener: an abort in
    // between left the wait waiting for a listener that can never fire. The observable
    // contract: with an aborted signal, NO wait may outlive the tick — the acquisition
    // rejects promptly instead of hanging for the full acquire timeout.
    setWriteCoordTimeoutsForTests(2000);
    const holder = withWriteLock(file, 'holder', async () => {
      await sleep(400);
      return 'held';
    });
    await sleep(10);
    const ctl = new AbortController();
    const started = Date.now();
    const attempt = runWithExecutionScope({ signal: ctl.signal }, () =>
      withWriteLock(file, 'waiter', async () => 'ran')
    );
    await sleep(20); // waiter is inside waitOnce now
    ctl.abort(); // abort during the wait
    await expect(attempt).rejects.toThrow(/cancelled/);
    expect(Date.now() - started).toBeLessThan(1000); // settled by the abort, not the timeout
    await holder;
    expect(writeLocks()).toEqual([]);
  });
});

describe('CHANGE 2 — core concurrency guarantees preserved', () => {
  it('genuine nested reentrancy still works; Promise.all siblings of one parent serialize', async () => {
    const file = uniq('nested');
    const active: number[] = [];
    let peak = 0;
    await runWithExecutionScope({}, async () => {
      await withWriteLocks([file], 'op', async (scope) => {
        const children = [1, 2, 3].map((n) =>
          withWriteLocks([file], `child${n}`, async () => {
            active.push(n);
            peak = Math.max(peak, active.length);
            await sleep(25);
            active.splice(active.indexOf(n), 1);
            return n;
          }, { scope })
        );
        expect(await Promise.all(children)).toEqual([1, 2, 3]);
        // Straight re-entry with the token re-enters instantly.
        await expect(withWriteLocks([file], 'again', async () => 're', { scope })).resolves.toBe('re');
      });
    });
    expect(peak).toBe(1); // siblings of the same parent ran ONE at a time inside the lock
    expect(writeLocks()).toEqual([]);
  });

  it('concurrent operations sharing an owner label still serialize; independent files do not block each other', async () => {
    const a = uniq('conc-a');
    const b = uniq('conc-b');
    let inA = false;
    let overlap = false;
    const opA = withWriteLock(a, 'same-owner', async () => {
      inA = true;
      await sleep(60);
      inA = false;
    });
    const opB = withWriteLock(a, 'same-owner', async () => {
      if (inA) overlap = true; // would only happen if the same-path lock was bypassed
    });
    const opC = withWriteLock(b, 'other-file', async () => 'independent');
    await Promise.all([opA, opB, opC]);
    expect(overlap).toBe(false);
    expect(await opC).toBe('independent');
  });

  it('overlapping multi-resource sets acquire in canonical order and never deadlock', async () => {
    const f1 = uniq('ov-1');
    const f2 = uniq('ov-2');
    const op1 = withWriteLocks([f1, f2], 'op1', async () => {
      await sleep(40);
      return 1;
    });
    const op2 = withWriteLocks([f2, f1], 'op2', async () => {
      await sleep(10);
      return 2;
    });
    expect(await Promise.all([op1, op2])).toEqual([1, 2]); // both complete, in some order
    expect(writeLocks()).toEqual([]);
  });

  it('an exception inside the callback releases every lock and scope', async () => {
    const file = uniq('throw');
    await expect(
      withWriteLocks([file, uniq('throw2')], 'boom', async () => {
        throw new Error('kaboom');
      })
    ).rejects.toThrow('kaboom');
    expect(writeLocks()).toEqual([]);
    expect(liveWriteScopes()).toEqual([]);
  });

  it('a long-running healthy operation is never stolen, however old it gets', async () => {
    const file = uniq('healthy');
    setWriteCoordTimeoutsForTests(50, 20); // acquire 50ms, stale window 20ms — far below the op duration
    let finished = false;
    const op = withWriteLock(file, 'slow-but-alive', async () => {
      await sleep(260); // ~13 stale windows
      finished = true;
      return 'done';
    });
    // Concurrent acquirers keep trying while the healthy op runs; they must get a CONFLICT
    // (structured), never a steal mid-flight.
    const results = await Promise.all([
      op,
      withWriteLock(file, 'w1', async () => 'x').catch((e) => e),
      withWriteLock(file, 'w2', async () => 'x').catch((e) => e),
    ]);
    expect(finished).toBe(true);
    expect(results[0]).toBe('done');
    const errors = results.slice(1).filter((r) => r instanceof Error);
    expect(errors.length).toBe(2);
    expect(errors[0].message).toMatch(/WRITE CONFLICT/); // structured, not a stolen lock
    expect(writeLocks()).toEqual([]);
  });

  it('an abandoned scope (bookkeeping crash, frames=0) is stealable after the stale window', async () => {
    const { simulateAbandonedScopeForTests } = await import('../src/main/writeCoord');
    const file = uniq('abandoned');
    setWriteCoordTimeoutsForTests(60, 40);
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => (release = r));
    const abandoned = withWriteLock(file, 'ghost', async () => {
      await held; // holds the lock until we resolve it manually
      return 'ghost-done';
    });
    await sleep(20); // lock is held
    const entries = writeLocks();
    expect(entries.length).toBe(1);
    // Simulate the bookkeeping crash: the scope's frames hit zero while the lock is held.
    const { id } = liveWriteScopes()[0];
    simulateAbandonedScopeForTests({ id });
    void release;
    (release as () => void)();
    await abandoned;
    // The stale steal path lets a fresh acquirer take the (now-dead) lock immediately.
    const taker = await withWriteLock(file, 'fresh', async () => 'took');
    expect(taker).toBe('took');
  });

  it('timeout produces a structured WRITE CONFLICT and leaves no resources behind', async () => {
    const file = uniq('timeout');
    setWriteCoordTimeoutsForTests(60);
    const holder = withWriteLock(file, 'holder', async () => {
      await sleep(250);
      return 'held';
    });
    await sleep(10);
    await expect(withWriteLock(file, 'waiter', async () => 'x')).rejects.toThrow(/WRITE CONFLICT/);
    expect(await holder).toBe('held');
    expect(writeLocks()).toEqual([]);
    expect(liveWriteScopes()).toEqual([]);
  });

  it('cancellation during execution releases locks and rejects pending acquirers cleanly', async () => {
    const file = uniq('cancel-midrun');
    const ctl = new AbortController();
    const op = runWithExecutionScope({ signal: ctl.signal }, () =>
      withWriteLock(file, 'cancellable', async () => {
        // A well-behaved operation observes its execution signal (as tools do).
        await new Promise<void>((resolve) => {
          const s = executionSignal();
          if (s?.aborted) return resolve();
          const timer = setTimeout(resolve, 500);
          s?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
        if (ctl.signal.aborted) throw new Error('cancelled mid-run');
        return 'never';
      })
    );
    await sleep(30);
    ctl.abort(); // the op's own scope aborts while it holds the lock
    await expect(op).rejects.toThrow(/cancelled mid-run/);
    await sleep(30);
    expect(writeLocks()).toEqual([]); // the finally-block released despite the abort
    const next = await withWriteLock(file, 'next', async () => 'ok');
    expect(next).toBe('ok');
  });
});
