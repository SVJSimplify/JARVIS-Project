import * as fs from 'fs';
import * as os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 17.1 HARDENING REGRESSIONS — tests for the defects the Round 17 review confirmed
 * and this round fixed. Each test pins the CORRECTED semantics:
 *   1. writeCoord reentrancy: a nested release can never free an outer lock. (Round 18
 *      v2: reentrancy requires the EXPLICIT scope token — ambient same-owner nesting is
 *      a competing write, because inherited async context cannot distinguish a genuine
 *      nested operation from Promise.all siblings sharing an ancestor.)
 *   2. writeCoord lock retention: a LIVE chain is never stolen for being old; waiters get
 *      a structured conflict instead (age alone no longer decides).
 *   3. writeCoord cancellation: a waiter whose scope is aborted stops waiting at once.
 *   4. store.atomicWrite: concurrent writers of one store cannot collide on a fixed temp
 *      name and cannot interleave — every write lands whole.
 *   5. projectMemory: two overlapping project_save calls never lose each other's decision.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import {
  clearWriteLocks,
  setWriteCoordTimeoutsForTests,
  withWriteLock,
  withWriteLocks,
  writeLocks,
} from '../src/main/writeCoord';
import { runWithExecutionScope } from '../src/main/toolResult';
import { atomicWrite, loadJson, withStoreLock } from '../src/main/store';

const ROOT = process.env.JARVIS_FILES_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-r171-'));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  clearWriteLocks();
  setWriteCoordTimeoutsForTests();
});

afterEach(() => {
  setWriteCoordTimeoutsForTests();
  clearWriteLocks();
});

describe('writeCoord reentrancy ownership (review defect A1)', () => {
  it('a nested release does NOT free the lock the outer frame still holds', async () => {
    const file = path.join(ROOT, 'nested.txt');
    const seen: string[] = [];
    // Outer operation: takes the lock, then does a nested locked write, then CONTINUES
    // to write again. With the old design the nested release freed the path and the
    // parallel writer below could slip in between the outer frames.
    const outer = withWriteLock(file, 'engine-A', async (scope) => {
      // Round 18: re-entrancy is EXPLICIT — the nested call passes the outer scope token.
      await withWriteLock(
        file,
        'engine-A',
        async () => {
          seen.push('nested-start');
          await sleep(60);
          seen.push('nested-end');
        },
        { scope }
      );
      // The lock MUST still be ours here: a parallel acquirer must not be able to take it.
      seen.push(`outer-between:${writeLocks().length}`);
      await sleep(40);
      seen.push('outer-end');
    });
    const parallel = withWriteLock(file, 'engine-B', async () => {
      seen.push('PARALLEL-ENTERED-INSIDE-OUTER');
      return 'B';
    });
    await Promise.all([outer, parallel]);
    // engine-B may only enter AFTER engine-A fully finished (no lock was freed early).
    expect(seen.indexOf('outer-end')).toBeLessThan(seen.indexOf('PARALLEL-ENTERED-INSIDE-OUTER'));
    expect(seen.filter((s) => s.startsWith('outer-between'))).toEqual(['outer-between:1']); // still held
  });

  it('nested multi-path acquisition re-enters without deadlocking on the shared path', async () => {
    const a = path.join(ROOT, 'multi-a.txt');
    const b = path.join(ROOT, 'multi-b.txt');
    const out = await withWriteLocks([a, b], 'engine-A', async (scope) =>
      withWriteLocks([b], 'engine-A', async () => 'nested ok', { scope })
    );
    expect(out).toBe('nested ok');
    expect(writeLocks()).toHaveLength(0);
  });
});

describe('writeCoord lock retention (review defect A2: no stealing of healthy locks)', () => {
  it('a live holder keeps its lock far beyond the stale window; the waiter gets a structured conflict', async () => {
    setWriteCoordTimeoutsForTests(80, 60); // stale window 60ms, waiter budget 80ms
    const file = path.join(ROOT, 'healthy.txt');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = withWriteLock(file, 'engine-A', async () => {
      await gate; // stays healthy (chain live) far beyond 60ms
      return 'A';
    });
    await sleep(30);
    // Age alone must NOT steal: the waiter times out into a conflict naming the holder.
    await expect(withWriteLock(file, 'engine-B', async () => 'B')).rejects.toThrow(/WRITE CONFLICT.*engine-A/);
    release();
    await expect(holder).resolves.toBe('A');
    // After the holder finishes, the path is free again.
    await expect(withWriteLock(file, 'engine-B', async () => 'B now')).resolves.toBe('B now');
  });
});

describe('writeCoord cancellation-aware waiting (review defect A3)', () => {
  it('a waiter whose execution scope is aborted stops waiting immediately', async () => {
    setWriteCoordTimeoutsForTests(30_000); // the waiter would otherwise wait 30s
    const file = path.join(ROOT, 'cancel.txt');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = withWriteLock(file, 'engine-A', async () => {
      await gate;
      return 'A';
    });
    await sleep(20);
    const ctl = new AbortController();
    const wait = runWithExecutionScope({ signal: ctl.signal }, () =>
      withWriteLock(file, 'engine-B', async () => 'B')
    );
    await sleep(40); // far inside the 30s budget, but the abort must end the wait NOW
    ctl.abort();
    await expect(wait).rejects.toThrow(/cancel/i);
    release();
    await holder; // let the holder's own release land before asserting the table
    expect(writeLocks()).toHaveLength(0); // nobody holds anything: waiter and holder both gone
  });
});

describe('store.atomicWrite concurrency (review defect D)', () => {
  it('concurrent writers of the SAME file never collide on a temp name and never interleave', async () => {
    const file = path.join(ROOT, 'atomic.json');
    const writes = Array.from({ length: 24 }, (_, i) =>
      atomicWrite(file, JSON.stringify({ i, pad: 'x'.repeat(2000) }))
    );
    await Promise.all(writes); // any fixed-tmp implementation throws ENOENT/EPERM here
    const parsed = await loadJson<{ i: number; pad: string } | null>(file, null);
    expect(parsed).not.toBeNull();
    expect(parsed!.pad).toBe('x'.repeat(2000)); // exactly one whole record, never a mix
    const debris = fs.readdirSync(path.dirname(file)).filter((f) => f.includes('.tmp'));
    expect(debris).toEqual([]); // no temp files left behind
  });

  it('withStoreLock serializes read-modify-write so no update is lost', async () => {
    const file = path.join(ROOT, 'rmw.json');
    await atomicWrite(file, JSON.stringify({ n: 0 }));
    await Promise.all(
      Array.from({ length: 20 }, (_, k) =>
        withStoreLock(file, async () => {
          const cur = await loadJson<{ n: number }>(file, { n: -1 });
          await sleep(5); // widen the race window: an unlocked RMW would lose updates
          await atomicWrite(file, JSON.stringify({ n: cur.n + 1 + (k === 0 ? 0 : 0) }));
        })
      )
    );
    const final = await loadJson<{ n: number }>(file, { n: -1 });
    expect(final.n).toBe(20); // every increment survived
  });
});

describe('projectMemory serialized updates (review defect C)', () => {
  it('two overlapping project_save calls keep BOTH decisions', async () => {
    const { projectMemoryTools } = await import('../src/main/projectMemory');
    const [a, b] = await Promise.all([
      projectMemoryTools.project_save.run({ name: 'race-proj', decision: 'decision one from engine A' }),
      projectMemoryTools.project_save.run({ name: 'race-proj', decision: 'decision two from engine B' }),
    ]);
    expect(String(a)).toMatch(/Project memory saved/);
    expect(String(b)).toMatch(/Project memory saved/);
    const read = String(await projectMemoryTools.project_read.run({ name: 'race-proj' }));
    expect(read).toContain('decision one from engine A');
    expect(read).toContain('decision two from engine B');
  });
});
