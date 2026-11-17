import os from 'os';
import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * ROUND 18 PRIORITY TWO — DURABLE IDEMPOTENCY RECEIPTS (mandate §4).
 *
 * Pins the corrected receipt lifecycle at the ONE dispatch choke point:
 *   - the started receipt is DURABLE (awaited) before the side effect begins (§4.1);
 *   - the outcome receipt is durable before the result is reported (§4.1);
 *   - the side-effect classification is derived from the central classifier, not a
 *     hand-maintained list (§4.3);
 *   - crash windows leave explicit, queryable UNKNOWN states that reconciliation
 *     settles with observed verdicts — never assumptions (§4.4/§4.5);
 *   - idempotency identity is stable across retries for duplicate detection (§4.2).
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { runToolDetailed } from '../src/main/tools';
import {
  recordReconciled,
  recordStarted,
  recordsForDay,
  recordsForTask,
  resetCallContext,
  setCallContext,
  unresolvedExecutionsFor,
} from '../src/main/toolRecord';
import { setRecordPersistenceProbeForTests } from '../src/main/toolRecord';

const ROOT = process.env.JARVIS_FILES_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-r18r-'));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetCallContext();
  setRecordPersistenceProbeForTests(null);
});

afterEach(() => {
  resetCallContext();
  setRecordPersistenceProbeForTests(null);
});

const dayRecords = async () => {
  const all = await recordsForDay(Date.now());
  return all;
};

describe('§4.1 the started receipt is durable BEFORE the side effect begins', () => {
  it('a write_file side effect cannot start until its started receipt has resolved', async () => {
    const target = path.join(ROOT, `receipt-gated-${Date.now()}.txt`);
    // Gate the FIRST record persistence (the started receipt) behind our control.
    let releaseReceipt!: () => void;
    const receiptDurable = new Promise<void>((r) => (releaseReceipt = r));
    let seenStarted = false;
    setRecordPersistenceProbeForTests(async (_file, rec) => {
      if (rec.status === 'started' && !seenStarted) {
        seenStarted = true;
        await receiptDurable; // hold the receipt hostage: it is NOT yet committed
      }
    });
    const call = runToolDetailed('write_file', JSON.stringify({ path: target, content: 'side effect' }));
    await sleep(150); // the tool has had every opportunity to misbehave
    // THE CONTRACT: no side effect before a committed receipt.
    expect(fs.existsSync(target)).toBe(false);
    // Release the receipt: only then may the world change.
    releaseReceipt();
    const res = await call;
    expect(res.status).toBe('success');
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('side effect');
  });

  it('the outcome record is on disk before the envelope is returned to the caller', async () => {
    const res = await runToolDetailed('calculate', JSON.stringify({ expression: '6*7' }));
    expect(res.status).toBe('success');
    const all = await dayRecords();
    const mine = all.filter((r) => r.tool === 'calculate' && r.status === 'ok');
    expect(mine.length).toBeGreaterThanOrEqual(1); // durable BEFORE runToolDetailed resolved
  });
});

describe('§4.3 side-effect classification comes from the central classifier', () => {
  it('write-class tools get a started receipt with a completion twin under the SAME id', async () => {
    const target = path.join(ROOT, `twin-${Date.now()}.txt`);
    const res = await runToolDetailed('write_file', JSON.stringify({ path: target, content: 'x' }));
    expect(res.status).toBe('success');
    const all = await dayRecords();
    const started = all.find((r) => r.tool === 'write_file' && r.status === 'started' && r.args.includes(path.basename(target)));
    expect(started).toBeDefined();
    const twin = all.find((r) => r.tool === 'write_file' && r.id === started!.id && r.status === 'ok');
    expect(twin).toBeDefined(); // started → succeeded under ONE correlation id
    expect(twin!.idempotencyKey).toBe(started!.idempotencyKey);
  });

  it('read-only tools get NO started receipt (repeatable by definition)', async () => {
    await runToolDetailed('calculate', JSON.stringify({ expression: '1+1' }));
    const all = await dayRecords();
    expect(all.find((r) => r.tool === 'calculate' && r.status === 'started')).toBeUndefined();
  });

  it('a policy-blocked side effect never reaches the receipt phase (it never began)', async () => {
    setCallContext({ agent: 'main' });
    const res = await runToolDetailed('run_command', JSON.stringify({ command: 'rm -rf important-stuff' }));
    expect(res.text).toMatch(/^BLOCKED/);
    const all = await dayRecords();
    const blockedRun = all.find((r) => r.tool === 'run_command' && r.status === 'not-run' && r.auth === 'blocked');
    expect(blockedRun).toBeDefined();
    expect(all.find((r) => r.tool === 'run_command' && r.status === 'started')).toBeUndefined();
  });
});

describe('§4.5 crash windows are explicit UNKNOWN states that reconciliation settles', () => {
  it('crash after the started receipt: unresolved until RECONCILED by a real inspection', async () => {
    setCallContext({ agent: 'main', taskId: 'T-receipt-crash', stepId: 's1' });
    // Simulate the crash window: started receipt persisted, outcome never arrived.
    await recordStarted({
      id: 'crash-window-1',
      t: Date.now(),
      tool: 'write_file',
      agent: 'main',
      taskId: 'T-receipt-crash',
      stepId: 's1',
      args: 'path=half-written.txt',
      auth: 'autonomous',
      idempotencyKey: 'write_file:half-written.txt',
    });
    let unresolved = await unresolvedExecutionsFor('T-receipt-crash');
    expect(unresolved.map((r) => r.id)).toEqual(['crash-window-1']); // the honest gap state
    // Recovery inspects the real world and settles the receipt with an OBSERVED verdict.
    await recordReconciled('crash-window-1', { tool: 'write_file', agent: 'coordinator', taskId: 'T-receipt-crash', stepId: 's1' }, 'inspected disk: the file exists complete with the intended content; nothing to repeat');
    unresolved = await unresolvedExecutionsFor('T-receipt-crash');
    expect(unresolved).toEqual([]); // settled
    const settled = (await recordsForTask('T-receipt-crash')).find((r) => r.id === 'crash-window-1' && r.status === 'reconciled');
    expect(settled?.result).toContain('inspected disk');
  });

  it('idempotency identity is STABLE across attempts, so a duplicate retry is detectable', async () => {
    setCallContext({ agent: 'main', taskId: 'T-retry-id' });
    const args = { path: path.join(ROOT, `retry-${Date.now()}.txt`), content: 'same op, second attempt' };
    await runToolDetailed('write_file', JSON.stringify(args));
    await runToolDetailed('write_file', JSON.stringify(args)); // a retry of the same logical op
    const recs = (await recordsForTask('T-retry-id')).filter((r) => r.tool === 'write_file');
    const keys = new Set(recs.map((r) => r.idempotencyKey));
    expect(keys.size).toBe(1); // both attempts share ONE stable idempotency identity (§4.2)
    expect(recs.length).toBeGreaterThanOrEqual(4); // started+ok, started+ok — history preserved
  });

  it('concurrent receipt writes all land durably (no lost records under parallelism)', async () => {
    const calls = Array.from({ length: 24 }, (_, i) =>
      runToolDetailed('calculate', JSON.stringify({ expression: `${i}+1` })).then(() => i)
    );
    await Promise.all(calls);
    const all = await dayRecords();
    const okCalculates = all.filter((r) => r.tool === 'calculate' && r.status === 'ok');
    expect(okCalculates.length).toBeGreaterThanOrEqual(24); // every outcome record survived
  });
});
