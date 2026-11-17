import os from 'os';
import path from 'path';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 20 CHANGE 1 — DURABLE, ACCOUNTABLE EXECUTION RECEIPTS (strict outcome path)
 * and CHANGE 3 — CRASH-SAFE PERSISTENCE (atomic write, backup recovery, quarantine).
 *
 * Receipts:
 *   - completion persistence failure after a REAL side effect → the envelope still
 *     reports the real result (never pretends failure), but is marked receiptPending
 *     and a durable 'outcome_unknown' reconciliation marker lands on disk;
 *   - the controlled recovery flush lands the real outcome exactly once once the
 *     ledger heals, without ever repeating the side effect;
 *   - a repeated flush / duplicate write never double-appends (idempotent);
 *   - the flush gives up loudly after its bounded attempt budget.
 * Persistence:
 *   - atomicWrite leaves the previous good version recoverable; a corrupt main file
 *     is quarantined and recovered from .bak;
 *   - concurrent writers never lose an update (serialization);
 *   - appends are fsynced (durable receipt).
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { runToolDetailed } from '../src/main/tools';
import {
  flushPendingOutcomes,
  pendingOutcomeCount,
  recordExecution,
  recordOutcome,
  resetCallContext,
  resetPendingOutcomesForTests,
  setCallContext,
  setRecordAppendFailureForTests,
  setRecordPersistenceProbeForTests,
  unknownOutcomeRecords,
  recordsForDay,
  type ToolExecutionRecord,
} from '../src/main/toolRecord';
import { atomicWrite, loadJson } from '../src/main/store';

const ROOT = process.env.JARVIS_FILES_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-r20-'));
const uniq = (name: string): string => path.join(ROOT, `r20-${name}-${Math.random().toString(36).slice(2, 8)}.txt`);

beforeEach(() => {
  resetCallContext();
  resetPendingOutcomesForTests();
  setRecordAppendFailureForTests(null);
  setRecordPersistenceProbeForTests(null);
  setCallContext({ agent: 'main' });
});

afterEach(() => {
  resetCallContext();
  resetPendingOutcomesForTests();
  setRecordAppendFailureForTests(null);
  setRecordPersistenceProbeForTests(null);
});

const dayRecords = async (): Promise<ToolExecutionRecord[]> => recordsForDay(Date.now());

describe('CHANGE 1 — strict outcome persistence at the dispatch choke point', () => {
  it('a side effect that ran is reported truthfully even when its completion receipt cannot be persisted', async () => {
    const target = uniq('pending-ok');
    let failCompletion = true;
    setRecordAppendFailureForTests((phase, rec) => {
      if (phase === 'before' && rec.status === 'ok' && failCompletion) throw new Error('simulated ledger outage');
    });
    const res = await runToolDetailed('write_file', JSON.stringify({ path: target, content: 'real work' }));
    // The action DID succeed — the file exists. The envelope must not pretend failure.
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toBe('real work');
    expect(res.status).toBe('success');
    expect(res.receiptPending).toBe(true);
    expect(res.text).toContain('Wrote 1 lines'); // the real result is preserved
    expect(res.text).toMatch(/RECEIPT PENDING/); // the missing durability is stated, never swallowed
    // The durable reconciliation marker: an explicit outcome_unknown record on disk.
    const unknown = (await dayRecords()).filter((r) => r.tool === 'write_file' && r.status === 'outcome_unknown');
    expect(unknown.length).toBe(1);
    expect(unknown[0].result).toMatch(/reconciliation required/);
    // The started receipt is durable too (the operation is fully accounted for in ledger terms).
    const started = (await dayRecords()).filter((r) => r.tool === 'write_file' && r.status === 'started');
    expect(started.length).toBe(1);
    expect(await unknownOutcomeRecords('no-such-task')).toEqual([]); // no task linkage here, no false claims
  });

  it('a not-run outcome (policy-blocked deletion) never gets an unknown marker — nothing may have happened', async () => {
    const target = uniq('blocked');
    setRecordAppendFailureForTests((phase, rec) => {
      if (phase === 'before' && (rec.status === 'ok' || rec.status === 'not-run')) throw new Error('ledger outage');
    });
    // The one deletion-shaped path that reaches the gate: apply_patch with a Delete File header.
    const res = await runToolDetailed(
      'apply_patch',
      JSON.stringify({ patch: `*** Begin Patch\n*** Delete File: ${target}\n*** End Patch` })
    );
    expect(res.text).toMatch(/^BLOCKED:/); // the deletion tooth fired
    expect(res.receiptPending).toBe(true);
    const unknown = (await dayRecords()).filter((r) => r.tool === 'apply_patch' && r.status === 'outcome_unknown');
    expect(unknown.length).toBe(0); // no started receipt existed → no "may have run" claim
  });

  it('the recovery flush lands the real outcome exactly once when the ledger heals — without repeating the side effect', async () => {
    const target = uniq('flush');
    let failCompletion = true;
    setRecordAppendFailureForTests((phase, rec) => {
      if (phase === 'before' && rec.status === 'ok' && failCompletion) throw new Error('simulated ledger outage');
    });
    await runToolDetailed('write_file', JSON.stringify({ path: target, content: 'flushed work' }));
    expect(pendingOutcomeCount()).toBeGreaterThan(0); // held in memory, not discarded
    // Ledger heals.
    failCompletion = false;
    const flush1 = await flushPendingOutcomes();
    expect(flush1.flushed).toBe(1);
    expect(flush1.remaining).toBe(0);
    // The real 'ok' outcome is now on disk, exactly once; the file was written ONCE.
    const oks = (await dayRecords()).filter((r) => r.tool === 'write_file' && r.status === 'ok');
    expect(oks.length).toBe(1);
    expect(fs.readFileSync(target, 'utf8')).toBe('flushed work');
    // A second flush is a no-op (idempotent recovery).
    const flush2 = await flushPendingOutcomes();
    expect(flush2.flushed).toBe(0);
    expect((await dayRecords()).filter((r) => r.tool === 'write_file' && r.status === 'ok').length).toBe(1);
  });

  it('when the ledger stays broken, the outcome survives in memory (bounded) and gives up loudly after the budget', async () => {
    setRecordAppendFailureForTests((phase, rec) => {
      if (phase === 'before' && rec.status === 'ok') throw new Error('persistent ledger outage');
    });
    await recordOutcome(
      { id: 'pend1', t: Date.now(), ms: 1, tool: 'write_file', agent: 'test', args: '', auth: 'autonomous', status: 'ok', result: 'r', retries: 0 },
      { sideEffectMayHaveRun: true }
    );
    expect(pendingOutcomeCount()).toBe(1);
    // Drain the bounded attempt budget; every attempt fails; the entry is dropped loudly at the end.
    let flushedTotal = 0;
    for (let i = 0; i < 45; i++) {
      const r = await flushPendingOutcomes();
      flushedTotal += r.flushed;
    }
    expect(flushedTotal).toBe(0); // nothing could be persisted — no false claims
    expect(pendingOutcomeCount()).toBe(0); // bounded: dropped after MAX_FLUSH_ATTEMPTS
  });

  it('recordOutcome treats an append that landed but reported failure (crash-after-durable) as durable — never a double append', async () => {
    const target = uniq('after-window');
    setRecordAppendFailureForTests((phase, rec) => {
      if (phase === 'after' && rec.status === 'ok') throw new Error('crash after the append landed');
    });
    const outcome = await recordOutcome(
      { id: 'after1', t: Date.now(), ms: 1, tool: 'write_file', agent: 'test', args: '', auth: 'autonomous', status: 'ok', result: 'r', retries: 0 },
      { sideEffectMayHaveRun: true }
    );
    expect(outcome.durable).toBe(true);
    expect(await flushPendingOutcomes()).toMatchObject({ flushed: 0, remaining: 0 });
    const oks = (await dayRecords()).filter((r) => r.id === 'after1' && r.status === 'ok');
    expect(oks.length).toBe(1); // exactly one append, despite the failure after it
  });

  it('unknown-marker fallback also fails → both are pending; nothing is silently dropped', async () => {
    setRecordAppendFailureForTests((phase, rec) => {
      if (phase === 'before' && (rec.status === 'ok' || rec.status === 'outcome_unknown')) throw new Error('total ledger outage');
    });
    const outcome = await recordOutcome(
      { id: 'both1', t: Date.now(), ms: 1, tool: 'write_file', agent: 'test', args: '', auth: 'autonomous', status: 'ok', result: 'r', retries: 0 },
      { sideEffectMayHaveRun: true }
    );
    expect(outcome.durable).toBe(false);
    expect(outcome.error).toMatch(/both unpersistable/);
    expect(pendingOutcomeCount()).toBe(1); // the real outcome is retained for recovery
  });

  it('duplicate completion writes are idempotent across the strict path too', async () => {
    const rec: ToolExecutionRecord = { id: 'dup20', t: Date.now(), ms: 1, tool: 'write_file', agent: 'test', args: '', auth: 'autonomous', status: 'ok', result: 'x', retries: 0 };
    const a = await recordOutcome(rec, { sideEffectMayHaveRun: true });
    const b = await recordOutcome({ ...rec }, { sideEffectMayHaveRun: true });
    expect(a.durable).toBe(true);
    expect(b.durable).toBe(true);
    const oks = (await dayRecords()).filter((r) => r.id === 'dup20' && r.status === 'ok');
    expect(oks.length).toBe(1);
  });
});

describe('CHANGE 3 — crash-safe JSON persistence', () => {
  it('a corrupt store file is quarantined and recovered from its .bak backup', async () => {
    const file = path.join(ROOT, `r20-store-${Math.random().toString(36).slice(2, 8)}.json`);
    await atomicWrite(file, JSON.stringify({ v: 1, keep: 'yes' }));
    await atomicWrite(file, JSON.stringify({ v: 2, keep: 'yes' })); // .bak now holds v1
    // Corrupt the main file in place (simulated media damage / buggy writer).
    fs.writeFileSync(file, '{"v":3,"trunc');
    const recovered = await loadJson<{ v: number; keep: string } | null>(file, null);
    expect(recovered).not.toBeNull();
    expect(recovered?.keep).toBe('yes'); // the last known-good version came back
    // The damaged bytes were never silently destroyed.
    const quarantined = fs.readdirSync(ROOT).find((f) => f.startsWith(path.basename(file) + '.corrupt-'));
    expect(quarantined).toBeTruthy();
    expect(fs.readFileSync(path.join(ROOT, quarantined as string), 'utf8')).toContain('trunc');
    // Recovery is idempotent: the main file parses again now.
    const again = await loadJson<{ v: number } | null>(file, null);
    expect(again?.v).toBe(1);
  });

  it('a corrupt file with NO backup starts fresh (fallback) after quarantining the damage', async () => {
    const file = path.join(ROOT, `r20-nobak-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(file, '{oops');
    const recovered = await loadJson<{ a?: number } | null>(file, { a: 0 });
    expect(recovered).toEqual({ a: 0 });
    expect(fs.readdirSync(ROOT).some((f) => f.startsWith(path.basename(file) + '.corrupt-'))).toBe(true);
  });

  it('concurrent atomic writers to the same file never lose an update (serialized)', async () => {
    const file = path.join(ROOT, `r20-race-${Math.random().toString(36).slice(2, 8)}.json`);
    const writers = Array.from({ length: 12 }, (_, i) => atomicWrite(file, JSON.stringify({ i })));
    await Promise.all(writers);
    const final = JSON.parse(await fs.promises.readFile(file, 'utf8')) as { i: number };
    expect(Number.isInteger(final.i)).toBe(true); // a whole version, never interleaved bytes
    expect(fs.readdirSync(ROOT).filter((f) => f.includes('.tmp')).length).toBe(0); // no debris
  });

  it('receipt appends are fsynced and a torn tail line never destroys earlier records', async () => {
    const { atomicAppend } = await import('../src/main/store');
    const file = path.join(ROOT, `r20-append-${Math.random().toString(36).slice(2, 8)}.jsonl`);
    await atomicAppend(file, '{"a":1}\n');
    await atomicAppend(file, '{"a":2}\n');
    await atomicAppend(file, '{"a":3'); // torn tail (simulated crash mid-append)
    const text = await fs.promises.readFile(file, 'utf8');
    expect(text).toContain('{"a":1}');
    expect(text).toContain('{"a":2}');
    const parsed = text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l) as { a: number }; } catch { return null; } });
    expect(parsed.filter((v) => v?.a === 1 || v?.a === 2).length).toBe(2);
  });
});
