import os from 'os';
import path from 'path';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 19 CHANGE 2 — DURABLE, RECOVERABLE EXECUTION RECEIPTS.
 *
 * Crash-injection at every persistence boundary of the receipt lifecycle:
 *   - BEFORE the started receipt lands  → the side effect must NOT run;
 *   - AFTER the started receipt lands (caller sees the failure) → the side effect must
 *     NOT run, the started receipt IS on disk, and restart reconciliation classifies
 *     the outcome as UNKNOWN with the tool's idempotency class;
 *   - AFTER the completion receipt lands → completed work is NOT silently lost.
 * Plus: duplicate receipt writes are idempotent, and the central idempotency
 * classification fails closed for unclassified tools.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { runToolDetailed } from '../src/main/tools';
import {
  classifyUnfinished,
  recordExecution,
  reconcileUnfinishedAtResume,
  recordsForDay,
  resetCallContext,
  setCallContext,
  toolIdempotencyClass,
  unknownOutcomeRecords,
  setRecordAppendFailureForTests,
  setRecordPersistenceProbeForTests,
  type ToolExecutionRecord,
} from '../src/main/toolRecord';

const ROOT = process.env.JARVIS_FILES_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-r19r-'));
const uniq = (name: string): string => path.join(ROOT, `r19r-${name}-${Math.random().toString(36).slice(2, 8)}.txt`);

beforeEach(() => {
  resetCallContext();
  setRecordAppendFailureForTests(null);
  setRecordPersistenceProbeForTests(null);
  setCallContext({ agent: 'main' });
});

afterEach(() => {
  resetCallContext();
  setRecordAppendFailureForTests(null);
  setRecordPersistenceProbeForTests(null);
});

const dayRecords = async (): Promise<ToolExecutionRecord[]> => recordsForDay(Date.now());

describe('CHANGE 2.1 — crash BEFORE the started receipt lands', () => {
  it('the side effect never runs and no started record exists (the safe never-started direction)', async () => {
    const target = uniq('crash-before');
    setRecordAppendFailureForTests((phase, rec) => {
      if (phase === 'before' && rec.status === 'started') throw new Error('simulated crash before persistence');
    });
    const res = await runToolDetailed('write_file', JSON.stringify({ path: target, content: 'must never land' }));
    expect(res.status).toBe('error');
    expect(res.text).toMatch(/^RECEIPT UNAVAILABLE/);
    // THE CONTRACT: no receipt → no side effect.
    expect(fs.existsSync(target)).toBe(false);
    const started = (await dayRecords()).filter((r) => r.tool === 'write_file' && r.status === 'started');
    expect(started).toEqual([]);
  });
});

describe('CHANGE 2.2 — crash AFTER the started receipt lands, BEFORE the operation runs', () => {
  it('the side effect does not run; the started receipt IS durable; reconciliation classifies the UNKNOWN outcome', async () => {
    const target = uniq('crash-after-started');
    setRecordAppendFailureForTests((phase, rec) => {
      if (phase === 'after' && rec.status === 'started') throw new Error('simulated crash after persistence');
    });
    const res = await runToolDetailed('write_file', JSON.stringify({ path: target, content: 'must never land' }));
    expect(res.status).toBe('error');
    expect(res.text).toMatch(/^RECEIPT UNAVAILABLE/);
    expect(fs.existsSync(target)).toBe(false); // still no side effect
    // The receipt IS on disk: recovery must see an operation with UNKNOWN outcome.
    const started = (await dayRecords()).filter((r) => r.tool === 'write_file' && r.status === 'started');
    expect(started.length).toBe(1);
    const taskId = `T-recover-${Math.random().toString(36).slice(2, 6)}`;
    // Classify it the way restart recovery does:
    const c = classifyUnfinished({ ...started[0], taskId });
    expect(c.state).toBe('started_unknown');
    expect(c.idempotency).toBe('idempotent'); // write_file is a full-content overwrite
    expect(c.verdict).toMatch(/UNKNOWN/i);
  });

  it('a NON-idempotent interrupted operation is classified never-auto-repeat', async () => {
    const target = uniq('crash-nonidem');
    setRecordAppendFailureForTests((phase, rec) => {
      if (phase === 'after' && rec.status === 'started') throw new Error('simulated crash');
    });
    await runToolDetailed('edit_file', JSON.stringify({ path: target, old_text: 'a', new_text: 'b' }));
    const started = (await dayRecords()).filter((r) => r.tool === 'edit_file' && r.status === 'started');
    expect(started.length).toBe(1);
    const c = classifyUnfinished(started[0]);
    expect(c.idempotency).toBe('non-idempotent');
    expect(c.verdict).toMatch(/NEVER be auto-repeat/i);
  });
});

describe('CHANGE 2.3 — crash AFTER the completion receipt lands', () => {
  it('completed work is NOT silently lost: the file and the ok record both survive', async () => {
    const target = uniq('crash-after-ok');
    setRecordAppendFailureForTests((phase, rec) => {
      if (phase === 'after' && rec.status === 'ok') throw new Error('simulated crash after completion');
    });
    // recordExecution is lenient (the caller must still get its envelope), so the
    // envelope returns success — but the point of this test is what is ON DISK.
    const res = await runToolDetailed('write_file', JSON.stringify({ path: target, content: 'durable work' }));
    expect(res.status).toBe('success');
    expect(fs.readFileSync(target, 'utf8')).toBe('durable work'); // the work survived
    const ok = (await dayRecords()).filter((r) => r.tool === 'write_file' && r.status === 'ok');
    expect(ok.length).toBe(1); // the completion receipt survived: nothing lost, nothing doubled
    expect(ok[0].id).toBe(ok[0].id);
  });
});

describe('CHANGE 2.4 — duplicate receipt writes are idempotent', () => {
  it('the same (id, status) record appends exactly once per boot', async () => {
    const id = `dup-${Date.now().toString(36)}`;
    await recordExecution({ id, t: Date.now(), ms: 1, tool: 'calculate', agent: 'test', args: '', auth: 'allowed', status: 'ok', result: '42', retries: 0 });
    await recordExecution({ id, t: Date.now(), ms: 1, tool: 'calculate', agent: 'test', args: '', auth: 'allowed', status: 'ok', result: '42', retries: 0 });
    await recordExecution({ id, t: Date.now(), ms: 1, tool: 'calculate', agent: 'test', args: '', auth: 'allowed', status: 'ok', result: '42', retries: 0 });
    const mine = (await dayRecords()).filter((r) => r.id === id && r.status === 'ok');
    expect(mine.length).toBe(1);
  });

  it('different statuses under one id (started → ok) both land — that is the lifecycle, not a duplicate', async () => {
    const id = `life-${Date.now().toString(36)}`;
    await recordExecution({ id, t: Date.now(), ms: 0, tool: 'write_file', agent: 'test', args: '', auth: 'autonomous', status: 'started', retries: 0 });
    await recordExecution({ id, t: Date.now(), ms: 5, tool: 'write_file', agent: 'test', args: '', auth: 'autonomous', status: 'ok', retries: 0 });
    const mine = (await dayRecords()).filter((r) => r.id === id);
    expect(mine.map((m) => m.status)).toEqual(['started', 'ok']);
  });
});

describe('CHANGE 2.5 — central idempotency classification', () => {
  it('full-content overwrites are idempotent; compounding operations are not', () => {
    expect(toolIdempotencyClass('write_file')).toBe('idempotent');
    expect(toolIdempotencyClass('make_dir')).toBe('idempotent');
    for (const t of ['edit_file', 'multi_edit', 'apply_patch', 'run_command', 'run_python', 'browser_click', 'click_text', 'make_document', 'remember']) {
      expect(toolIdempotencyClass(t)).toBe('non-idempotent');
    }
  });

  it('an UNKNOWN side-effecting tool fails closed as non-idempotent', () => {
    expect(toolIdempotencyClass('some_future_tool')).toBe('non-idempotent');
  });
});

describe('CHANGE 2.6 — restart reconciliation writes classified verdicts', () => {
  it('a started-without-twin execution gets a durable reconciled record; the query then reports nothing unresolved', async () => {
    const taskId = `T-recon-${Date.now().toString(36)}`;
    const startedId = `rec-${Date.now().toString(36)}`;
    await recordExecution({
      id: startedId,
      t: Date.now(),
      ms: 0,
      tool: 'run_command',
      agent: 'task:general#1',
      taskId,
      args: 'npm test',
      auth: 'autonomous',
      status: 'started',
      retries: 0,
    });
    // Pre-reconciliation: the outcome is unresolved.
    expect((await unknownOutcomeRecords(taskId)).length).toBe(1);
    const reconciled = await reconcileUnfinishedAtResume(taskId);
    expect(reconciled.length).toBe(1);
    expect(reconciled[0].state).toBe('started_unknown');
    expect(reconciled[0].idempotency).toBe('non-idempotent');
    expect(reconciled[0].verdict).toMatch(/NEVER be auto-repeat/);
    // The reconciled record is durable under the SAME id:
    const all = await recordsForDay(Date.now());
    const twin = all.find((r) => r.id === startedId && r.status === 'reconciled');
    expect(twin?.result).toMatch(/RECONCILED: outcome UNKNOWN/);
    // The query is settled: nothing unresolved remains for this task.
    expect((await unknownOutcomeRecords(taskId)).length).toBe(0);
  });
});
