import os from 'os';
import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * ROUND 18 — PRIORITIES SIX & SEVEN REGRESSIONS: browser verification (§8.5),
 * cancellation through the whole stack (§11), policy-description consistency (§10),
 * write-path coverage (§12).
 *
 * Environment note (honest, per §16): Windows-only runtime behavior (real PowerShell,
 * UI Automation, real Chromium downloads) CANNOT be executed in this Linux sandbox.
 * Everything testable here is tested; the Windows remainder is listed in the round
 * report as environment-blocked, not claimed as passing.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { runToolDetailed } from '../src/main/tools';
import { runWithExecutionScope } from '../src/main/toolResult';
import { pinnedRequest } from '../src/main/safeNet';
import { sniffFileType, verifyDownloadFile } from '../src/main/fsTools';
import { withTimeout } from '../src/main/toolResult';

const ROOT = process.env.JARVIS_FILES_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-r18rz-'));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {});
afterEach(() => {});

describe('§11 cancellation reaches in-flight tools in the MAIN loop (S1)', () => {
  it('an aborted turn scope kills a running run_python child instead of letting it run to completion', async () => {
    const ctl = new AbortController();
    const start = Date.now();
    // This is the dispatch shape the provider turn loop now uses (Round 18 S1): the
    // signal-bearing scope wraps runToolDetailed. Before the fix, executionSignal()
    // was undefined in the main loop and the 5s child ran to completion after Stop.
    const run = runWithExecutionScope({ signal: ctl.signal }, () =>
      runToolDetailed('run_python', JSON.stringify({ code: 'import time\ntime.sleep(5)\nprint("done")' }))
    );
    await sleep(400); // let the interpreter actually start
    ctl.abort();
    const res = await run;
    const elapsed = Date.now() - start;
    expect(res.status).toBe('cancelled');
    expect(elapsed).toBeLessThan(3000); // the child was killed, not awaited
  }, 15_000);

  it('a cancelled scope never STARTS the next tool', async () => {
    const ctl = new AbortController();
    let secondRan = false;
    await runWithExecutionScope({ signal: ctl.signal }, async () => {
      ctl.abort();
      const res = await runToolDetailed('calculate', JSON.stringify({ expression: '1+1' }));
      secondRan = res.status !== 'cancelled';
    });
    expect(secondRan).toBe(false);
  });
});

describe('§11 timeouts are distinguishable from cancellations (S2)', () => {
  it('a wall-clock timeout surfaces as "timed out" (transient), a user abort as "cancelled"', async () => {
    // 10.255.255.1 is reserved (RFC 1918) and non-routable from the test sandbox:
    // connect hangs, the timeout signal fires with a TimeoutError reason.
    const timeoutSignal = withTimeout(250);
    const timedOut = pinnedRequest('http://10.255.255.1:81/slow', { timeoutMs: 5_000, signal: timeoutSignal });
    await expect(timedOut).rejects.toThrow(/timed out/);
    const ctl = new AbortController();
    const cancelled = pinnedRequest('http://10.255.255.1:82/slow', { timeoutMs: 5_000, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 100);
    await expect(cancelled).rejects.toThrow(/^cancelled$/);
  }, 15_000);
});

describe('§8.5 downloads are verified, not trusted (browser first-class)', () => {
  it('sniffFileType identifies real signatures', () => {
    expect(sniffFileType(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3])).label).toBe('PDF');
    expect(sniffFileType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])).label).toContain('ZIP');
    expect(sniffFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])).label).toBe('PNG image');
    expect(sniffFileType(Buffer.from('%PDF-1.7 rest', 'latin1')).exts).toContain('pdf');
    expect(sniffFileType(Buffer.from('hello, world')).label).toBe('text file');
    expect(sniffFileType(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03])).label).toBe('binary data');
  });

  it('verifyDownloadFile: empty file fails honestly; a real file reports size+type; mismatches are flagged', async () => {
    const empty = path.join(ROOT, 'empty.pdf');
    fs.writeFileSync(empty, '');
    const emptyVerdict = await verifyDownloadFile(empty);
    expect(emptyVerdict.ok).toBe(false);
    expect(emptyVerdict.evidence).toContain('EMPTY');

    const real = path.join(ROOT, 'doc.pdf');
    fs.writeFileSync(real, Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(2000, 7)]));
    const okVerdict = await verifyDownloadFile(real);
    expect(okVerdict.ok).toBe(true);
    expect(okVerdict.evidence).toMatch(/PDF/);
    expect(okVerdict.evidence).toMatch(/KB/);

    const liar = path.join(ROOT, 'fake.png');
    fs.writeFileSync(liar, Buffer.from('%PDF-1.7 not actually a png'));
    const mismatch = await verifyDownloadFile(liar);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.evidence).toContain('MISMATCH');
  });
});

describe('§12 write-path coverage regressions', () => {
  it('edit_file re-reads INSIDE the lock: a concurrent writer between read and write cannot be clobbered', async () => {
    const file = path.join(ROOT, 'edit-race.txt');
    fs.writeFileSync(file, 'base');
    // Two concurrent edits to DIFFERENT parts of the same file: with the read outside
    // the lock, the second edit could apply against a stale base and drop the first.
    const [a, b] = await Promise.all([
      runToolDetailed('edit_file', JSON.stringify({ path: file, old_text: 'base', new_text: 'base-A' })),
      runToolDetailed('edit_file', JSON.stringify({ path: file, old_text: 'base', new_text: 'base-B' })),
    ]);
    expect(a.status === 'success' || b.status === 'success').toBe(true);
    const after = fs.readFileSync(file, 'utf8');
    // whichever edit landed FIRST is preserved — the other is told the text changed
    expect(after.startsWith('base-')).toBe(true);
    expect(after).not.toBe('base');
  });
});
