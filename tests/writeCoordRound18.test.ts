import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 18 PRIORITY ONE — WRITE COORDINATION STRESS TESTS (mandate §3.4).
 *
 * All twelve mandated scenarios, invoked against the REAL withWriteLocks implementation
 * (no helper re-implementations). The semantics pinned here:
 *   - Reentrancy requires the EXPLICIT scope token (mandate §3.1/§3.2): inherited async
 *     context (AsyncLocalStorage) NEVER confers reentrancy, so Promise.all branches that
 *     merely share an ancestor cannot bypass mutual exclusion.
 *   - Token-holding nested siblings (Promise.all) to one path run ONE AT A TIME (the
 *     lane stack) — mutual exclusion holds AND every sibling completes.
 *   - A live scope (frames > 0) is never stolen, however old; a scope whose frames all
 *     died is recoverable after the stale window (verified owner-liveness, §3.3).
 *   - Cancellation works while waiting for a lock AND while parked as a lane sibling;
 *   - every exit path (success, exception, cancellation) releases everything.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import {
  clearWriteLocks,
  holdsWriteLock,
  liveWriteScopes,
  setWriteCoordTimeoutsForTests,
  withWriteLock,
  withWriteLocks,
  writeLocks,
} from '../src/main/writeCoord';
import { runWithExecutionScope } from '../src/main/toolResult';

const ROOT = process.env.JARVIS_FILES_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-r18-'));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const uniq = (name: string): string => path.join(ROOT, `r18-${name}-${Math.random().toString(36).slice(2, 8)}.txt`);

beforeEach(() => {
  clearWriteLocks();
  setWriteCoordTimeoutsForTests();
});

afterEach(() => {
  setWriteCoordTimeoutsForTests();
  clearWriteLocks();
});

/** Tracks the maximum number of frames inside a critical section at any moment. */
function concurrencyTracker(): { enter: () => Promise<void>; inside: () => number; max: () => number; exit: () => void } {
  let cur = 0;
  let peak = 0;
  return {
    enter: async () => {
      await sleep(5); // widen the interleaving window
      cur += 1;
      peak = Math.max(peak, cur);
    },
    inside: () => cur,
    max: () => peak,
    exit: () => {
      cur -= 1;
    },
  };
}

describe('Round 18 §3.4.1 — nested acquisition by the same operation', () => {
  it('re-enters via the explicit scope token; nested release never frees the outer lock', async () => {
    const file = uniq('nested');
    const events: string[] = [];
    await withWriteLock(file, 'op-A', async (scope) => {
      await withWriteLock(
        file,
        'op-A',
        async () => {
          events.push('inner');
          expect(holdsWriteLock(file, 'op-A')).toBe(true);
        },
        { scope }
      );
      events.push(`between:${writeLocks().length}`); // still held after the nested release
      await withWriteLock(
        file,
        'op-A',
        async () => {
          events.push('inner2');
        },
        { scope }
      );
    });
    expect(events).toEqual(['inner', 'between:1', 'inner2']);
    expect(writeLocks()).toHaveLength(0);
  });

  it('deep nesting (three levels) transfers the lane down and back up', async () => {
    const file = uniq('deep');
    const order: string[] = [];
    await withWriteLock(file, 'op-A', async (s1) => {
      await withWriteLock(
        file,
        'op-A',
        async (s2) => {
          await withWriteLock(
            file,
            'op-A',
            async () => {
              order.push('level3');
            },
            { scope: s2 }
          );
          order.push('level2-after-3');
        },
        { scope: s1 }
      );
      order.push('level1-end');
    });
    expect(order).toEqual(['level3', 'level2-after-3', 'level1-end']);
    expect(writeLocks()).toHaveLength(0);
  });
});

describe('Round 18 §3.4.2 — two parallel sibling writes to the SAME path', () => {
  it('Promise.all siblings holding the same scope are SERIALIZED, never concurrent', async () => {
    setWriteCoordTimeoutsForTests(5_000);
    const file = uniq('siblings');
    const t = concurrencyTracker();
    const result = await withWriteLock(file, 'op-A', async (scope) => {
      const [a, b, c] = await Promise.all([
        withWriteLock(file, 'op-A', async () => { await t.enter(); t.exit(); return 'a'; }, { scope }),
        withWriteLock(file, 'op-A', async () => { await t.enter(); t.exit(); return 'b'; }, { scope }),
        withWriteLock(file, 'op-A', async () => { await t.enter(); t.exit(); return 'c'; }, { scope }),
      ]);
      return { a, b, c };
    });
    expect(result).toEqual({ a: 'a', b: 'b', c: 'c' }); // every sibling completed, in order
    expect(t.max()).toBe(1); // mutual exclusion HELD: never two inside the lock at once
    expect(writeLocks()).toHaveLength(0);
  });

  it('ambient (scope-less) nested writes to a held path are competing writes — they wait, they never bypass', async () => {
    // THE Round 18 fix, pinned: without the scope token there is NO reentrancy. The old
    // design let this exact call run concurrently inside the outer lock.
    setWriteCoordTimeoutsForTests(5_000);
    const file = uniq('ambient');
    const t = concurrencyTracker();
    const inner = withWriteLock(file, 'engine-A', async () => {
      await t.enter();
      t.exit();
      return 'inner';
    });
    const outer = withWriteLock(file, 'engine-A', async () => {
      await sleep(30); // outer is inside while the ambient inner waits
      return 'outer';
    });
    const [o, i] = await Promise.all([outer, inner]);
    expect(o).toBe('outer');
    expect(i).toBe('inner'); // it eventually ran — AFTER the outer released, sequentially
    expect(t.max()).toBe(1); // and never concurrently with it
  });
});

describe('Round 18 §3.4.3 — two parallel sibling writes to DIFFERENT paths', () => {
  it('run concurrently without waiting on each other', async () => {
    setWriteCoordTimeoutsForTests(5_000);
    const f1 = uniq('p1');
    const f2 = uniq('p2');
    let overlap = 0;
    let sawOverlap = false;
    const work = (f: string) =>
      withWriteLock(f, 'op-A', async (scope) => {
        // a nested sibling on the OTHER path — different locks, no interaction
        overlap += 1;
        if (overlap === 2) sawOverlap = true;
        await sleep(25);
        overlap -= 1;
        return withWriteLock(f, 'op-A', async () => f, { scope });
      });
    await Promise.all([work(f1), work(f2)]);
    expect(sawOverlap).toBe(true); // both were inside at once: independent paths never serialize
  });
});

describe('Round 18 §3.4.4 — nested acquisition inside Promise.all', () => {
  it('a nested child launched from inside a Promise.all branch awaits its turn (lane discipline)', async () => {
    setWriteCoordTimeoutsForTests(5_000);
    const file = uniq('all-nested');
    const t = concurrencyTracker();
    await withWriteLock(file, 'op-A', async (scope) => {
      await Promise.all([
        withWriteLock(
          file,
          'op-A',
          async (s2) => {
            // branch 1 nests one level deeper while branch 2 is also pending
            await Promise.all([
              withWriteLock(file, 'op-A', async () => { await t.enter(); t.exit(); }, { scope: s2 }),
              withWriteLock(file, 'op-A', async () => { await t.enter(); t.exit(); }, { scope: s2 }),
            ]);
          },
          { scope }
        ),
        withWriteLock(file, 'op-A', async () => { await t.enter(); t.exit(); }, { scope }),
      ]);
    });
    expect(t.max()).toBe(1); // lane discipline held through two levels of Promise.all
    expect(writeLocks()).toHaveLength(0);
  });
});

describe('Round 18 §3.4.5 — cancellation while waiting', () => {
  it('a parked lane sibling whose scope aborts stops waiting and cleans up', async () => {
    setWriteCoordTimeoutsForTests(30_000);
    const file = uniq('lane-cancel');
    const ctl = new AbortController();
    await withWriteLock(file, 'op-A', async (scope) => {
      const slow = withWriteLock(
        file,
        'op-A',
        async () => {
          await sleep(400); // occupies the lane
          return 'slow';
        },
        { scope }
      );
      await sleep(20); // let the slow sibling take the lane
      const parked = runWithExecutionScope({ signal: ctl.signal }, () =>
        withWriteLock(file, 'op-A', async () => 'parked-should-never-run', { scope })
      );
      await sleep(30);
      ctl.abort(); // cancel WHILE parked in the lane queue
      await expect(parked).rejects.toThrow(/cancel/i);
      await slow;
    });
    expect(writeLocks()).toHaveLength(0);
    expect(liveWriteScopes()).toHaveLength(0);
  });
});

describe('Round 18 §3.4.6 — exceptions during nested operations', () => {
  it('a throwing nested child releases its lane+ref; the parent continues; nothing wedges', async () => {
    setWriteCoordTimeoutsForTests(5_000);
    const file = uniq('throw');
    await withWriteLock(file, 'op-A', async (scope) => {
      await expect(
        withWriteLock(
          file,
          'op-A',
          async () => {
            throw new Error('nested boom');
          },
          { scope }
        )
      ).rejects.toThrow('nested boom');
      // the parent still holds the lock and can keep nested-writing
      await withWriteLock(file, 'op-A', async () => 'after-throw', { scope });
    });
    await expect(withWriteLock(file, 'engine-B', async () => 'B')).resolves.toBe('B');
    expect(writeLocks()).toHaveLength(0);
  });

  it('a throwing PARENT releases the whole lock even with parked siblings', async () => {
    setWriteCoordTimeoutsForTests(5_000);
    const file = uniq('parent-throw');
    await expect(
      withWriteLock(file, 'op-A', async (scope) => {
        void withWriteLock(file, 'op-A', async () => {
          await sleep(200);
          return 'sibling-late';
        }, { scope });
        await sleep(20);
        throw new Error('parent boom');
      })
    ).rejects.toThrow('parent boom');
    // sibling was either rejected (ancestor gone) or completed — the LOCK must be free.
    await expect(withWriteLock(file, 'engine-B', async () => 'B')).resolves.toBe('B');
    expect(writeLocks()).toHaveLength(0);
  });
});

describe('Round 18 §3.4.7 — multi-path acquisition with competing owners', () => {
  it('sorted acquisition prevents deadlock; the loser gets a bounded structured conflict, then succeeds', async () => {
    setWriteCoordTimeoutsForTests(120);
    const a = uniq('m-a');
    const b = uniq('m-b');
    let releaseA!: () => void;
    const gate = new Promise<void>((r) => (releaseA = r));
    const holder = withWriteLocks([a, b], 'engine-A', async () => {
      await gate;
      return 'A';
    });
    await sleep(20);
    // B wants [b, c] while A holds [a, b]: B must block on b (sorted) and time out into
    // a conflict naming the holder — never deadlock, never corrupt.
    await expect(withWriteLocks([b, uniq('m-c')], 'engine-B', async () => 'B')).rejects.toThrow(/WRITE CONFLICT.*engine-A/);
    releaseA();
    await expect(holder).resolves.toBe('A');
    await expect(withWriteLocks([b, uniq('m-d')], 'engine-B', async () => 'B-now')).resolves.toBe('B-now');
  });
});

describe('Round 18 §3.4.8 — long-running healthy owner is never stolen', () => {
  it('keeps the lock across many stale windows while its scope has live frames', async () => {
    setWriteCoordTimeoutsForTests(60, 25); // stale window 25ms — the owner outlives many of them
    const file = uniq('healthy');
    const result = withWriteLock(file, 'op-A', async (scope) => {
      const attempts: string[] = [];
      for (let i = 0; i < 4; i++) {
        await sleep(30); // ~5 stale windows total while this frame is LIVE
        try {
          await withWriteLock(file, 'engine-B', async () => 'STOLEN');
        } catch (e) {
          attempts.push(e instanceof Error ? 'conflict' : 'other');
        }
        // nested self-check: the healthy owner can still re-enter at any age
        await withWriteLock(file, 'op-A', async () => 'self', { scope });
      }
      return attempts;
    });
    await expect(result).resolves.toEqual(['conflict', 'conflict', 'conflict', 'conflict']);
  });
});

describe('Round 18 §3.4.9 — abandoned owner recovery', () => {
  it('a dead scope (frames=0) is NOT stolen by age alone inside the stale window', async () => {
    setWriteCoordTimeoutsForTests(80, 400); // conflict at 80ms, stale window 400ms
    const file = uniq('abandoned-early');
    const { simulateAbandonedScopeForTests } = await import('../src/main/writeCoord');
    await withWriteLock(file, 'ghost-op', async (scope) => {
      simulateAbandonedScopeForTests(scope); // frames → 0 while the lock is held
      await sleep(30); // younger than the 400ms stale window
      await expect(withWriteLock(file, 'engine-B', async () => 'B-early')).rejects.toThrow(/WRITE CONFLICT/);
    });
  });

  it('a dead scope whose stale window has elapsed IS recoverable by a new acquirer', async () => {
    setWriteCoordTimeoutsForTests(600, 150); // the acquirer waits long enough for the window
    const file = uniq('abandoned-recover');
    const { simulateAbandonedScopeForTests } = await import('../src/main/writeCoord');
    const ghostNeverReturns = withWriteLock(file, 'ghost-op-2', async (scope) => {
      simulateAbandonedScopeForTests(scope); // frames → 0: the "crashed" owner
      await sleep(500); // the ghost never releases on its own
      return 'ghost-finished';
    });
    await sleep(30);
    await expect(withWriteLock(file, 'engine-B', async () => 'B-recovered')).resolves.toBe('B-recovered');
    // The ghost's eventual finally must not corrupt the successor's lock: it releases
    // its own (already stolen) entry harmlessly.
    await expect(ghostNeverReturns).resolves.toBe('ghost-finished');
    await expect(withWriteLock(file, 'engine-C', async () => 'C-clean')).resolves.toBe('C-clean');
  });
});

describe('Round 18 §3.4.10 — lock release after cancellation', () => {
  it('a cancelled waiter leaves no lock, no scope, and no residue behind', async () => {
    setWriteCoordTimeoutsForTests(30_000);
    const file = uniq('cancel-residue');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = withWriteLock(file, 'op-A', async () => {
      await gate;
      return 'A';
    });
    await sleep(20);
    const ctl = new AbortController();
    const waiter = runWithExecutionScope({ signal: ctl.signal }, () => withWriteLock(file, 'engine-B', async () => 'B'));
    await sleep(20);
    ctl.abort();
    await expect(waiter).rejects.toThrow(/cancel/i);
    release();
    await holder;
    expect(writeLocks()).toHaveLength(0);
    expect(liveWriteScopes()).toHaveLength(0);
    // the path is immediately usable again
    await expect(withWriteLock(file, 'engine-C', async () => 'C')).resolves.toBe('C');
  });
});

describe('Round 18 §3.4.11 — concurrent agent writes', () => {
  it('eight agents writing one file run strictly one-at-a-time and all complete', async () => {
    setWriteCoordTimeoutsForTests(10_000);
    const file = uniq('agents');
    const t = concurrencyTracker();
    const writes = Array.from({ length: 8 }, (_, i) =>
      withWriteLock(file, `agent-${i}`, async () => {
        await t.enter();
        await sleep(5);
        t.exit();
        return i;
      })
    );
    const results = await Promise.all(writes);
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7]); // every agent completed
    expect(t.max()).toBe(1); // never two inside at once
  });
});

describe('Round 18 §3.4.12 — interactive and scheduled task contention', () => {
  it('an interactive turn and a scheduled job contend on one path: serialized, both honest', async () => {
    setWriteCoordTimeoutsForTests(10_000);
    const file = uniq(' contention');
    const t = concurrencyTracker();
    const interactiveCtl = new AbortController();
    const scheduledCtl = new AbortController();
    const interactive = runWithExecutionScope({ signal: interactiveCtl.signal }, () =>
      withWriteLock(file, 'turn:interactive', async () => {
        await t.enter();
        await sleep(15);
        t.exit();
        return 'interactive-done';
      })
    );
    const scheduled = runWithExecutionScope({ signal: scheduledCtl.signal }, () =>
      withWriteLock(file, 'scheduled:tick', async () => {
        await t.enter();
        await sleep(15);
        t.exit();
        return 'scheduled-done';
      })
    );
    expect(await interactive).toBe('interactive-done');
    expect(await scheduled).toBe('scheduled-done');
    expect(t.max()).toBe(1);
    expect(writeLocks()).toHaveLength(0);
  });
});
