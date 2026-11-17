import * as http from 'http';
import * as fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 16B EXECUTION-RELIABILITY PROOFS — real coordinator, real provider turn engine,
 * real persistence. UI is deliberately out of scope. Mocks are limited to the process
 * boundary (Electron, the provider HTTP endpoint on localhost:20128 — a real socket).
 */

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'r16b-user-'));
vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub({ app: { getPath: () => userData } }));

import { chat } from '../src/main/provider';
import { initModes } from '../src/main/modes';
import { setSettings } from '../src/main/settings';
import { registerScheduledRunner, resetSchedulerForTests, scheduleTask, tick } from '../src/main/scheduler';
import {
  checkStalls,
  resumeTask,
  setCoordinatorTimingForTests,
  startTask,
  type CoordinatorDeps,
} from '../src/main/coordinator';
import { claimTask, createTask, getTask, renewClaim, resetTaskStoreForTests, transition, releaseClaim } from '../src/main/taskStore';
import { recordExecution, recordsForTask, resetCallContext, runWithCallContext, unresolvedExecutionsFor } from '../src/main/toolRecord';
import { fsTools } from '../src/main/fsTools';
import { cancelTask, checkStalls, resumeTask, setCoordinatorTimingForTests, startTask, type CoordinatorDeps } from '../src/main/coordinator';
import { canonicalPathKey, setWriteWaitTimeoutForTests, withPathLock } from '../src/main/writeGate';
import { buildTaskSpec } from '../src/main/taskSpec';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-test-${process.pid}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const wf = (name: string, content: string): string => {
  const full = path.join(ROOT, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
};
const waitUntil = async (cond: () => Promise<boolean>, ms = 5000): Promise<void> => {
  for (let i = 0; i < ms / 25 && !(await cond()); i++) await sleep(25);
};

/** A step's write only counts as evidence when it lands in the durable tool-record ledger — same as production. */
const writeEvidence = async (taskId: string, stepId: string, file: string, content: string): Promise<void> => {
  wf(file.replace(/^\//, ''), content);
  const rel = path.isAbsolute(file) ? file : path.join(ROOT, file);
  await runWithCallContext({ agent: 'task:general#1', taskId, stepId }, () =>
    recordExecution({
      id: `ev-${Math.random().toString(36).slice(2, 8)}`,
      t: Date.now(),
      ms: 3,
      tool: 'write_file',
      agent: 'task:general#1',
      taskId,
      stepId,
      args: `path=${rel}`,
      auth: 'allowed',
      status: 'ok',
      result: 'wrote',
      retries: 0,
      idempotencyKey: `write_file:${rel}`,
    })
  );
};

// ----------------------------------------------------------------- provider harness
// A REAL local server on the provider endpoint: each completion is scripted by the test.

let script: Array<{ reply: string; hold?: (release: () => void) => void }> = [];
const seenUserTexts: string[] = [];
let server: http.Server | null = null;

const startServer = (): Promise<void> =>
  new Promise((resolve) => {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', date: new Date().toUTCString() });
        res.end('{"data":[]}');
        return;
      }
      let body = '';
      req.on('data', (c: Buffer) => (body += c));
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
          const lastUser = [...parsed.messages].reverse().find((m) => m.role === 'user');
          seenUserTexts.push(String(lastUser?.content ?? '').slice(0, 60));
        } catch {
          /* body shape is asserted elsewhere */
        }
        const next = script.shift();
        const respond = (): void => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: next?.reply ?? 'reply (unscripted)' } }] }));
        };
        if (next?.hold) next.hold(respond);
        else respond();
      });
    };
    // The parallel llmSend suite binds the same endpoint intermittently: retry until free.
    server = http.createServer(handler);
    let attempts = 0;
    const tryListen = (): void => {
      attempts++;
      server!.once('error', () => {
        if (attempts < 40) setTimeout(tryListen, 200);
      });
      server!.listen(20128, () => resolve());
    };
    tryListen();
  });

beforeAll(async () => {
  await startServer();
  await initModes({ file: path.join(userData, 'mode.json'), sink: () => undefined, notify: () => undefined, onEvent: () => undefined, onTurn: () => undefined });
  await setSettings({ model: 'test-model', apiKey: 'test-key' });
});

afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  fs.rmSync(userData, { recursive: true, force: true });
});

beforeEach(() => {
  resetTaskStoreForTests();
  resetCallContext();
  resetSchedulerForTests();
  seenUserTexts.length = 0;
  script = [];
});

afterEach(() => {
  setCoordinatorTimingForTests(30_000, 5 * 60_000);
  setWriteWaitTimeoutForTests(60_000);
});

const silentDeps = (overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps => ({
  run: async () => 'OK',
  schemas: () => [],
  planner: async (spec) => [
    { title: 'Do the work', detail: spec.objective, kind: 'general' },
    { title: 'Verify the result', detail: 'check', kind: 'verifier' },
  ],
  stepRunner: async () => 'DONE: ok; VERIFIED: re-read; ISSUES: none',
  ...overrides,
});

// ------------------------------------------------------------------ B. execution isolation

describe('F-13: execution sources own their cancellation', () => {
  it('a scheduled follow-up NEVER aborts a running interactive turn — it queues behind it', async () => {
    let releaseTurn1!: () => void;
    script = [
      { reply: 'reply one', hold: (r) => (releaseTurn1 = r) },
      { reply: 'reply two (scheduled)' },
    ];
    const p1 = chat('first interactive request', () => undefined, undefined, 'interactive');
    await waitUntil(async () => seenUserTexts.length >= 1); // turn 1 is inside its completion
    const p2 = chat('scheduled follow-up task text', () => undefined, undefined, 'scheduled');
    // Give the scheduler entry every chance to (wrongly) abort turn 1.
    await sleep(120);
    releaseTurn1();
    expect(await p1).toBe('reply one'); // turn 1 survived: not aborted by the scheduled request
    expect(await p2).toBe('reply two (scheduled)');
    expect(seenUserTexts).toHaveLength(2);
  });

  it('two scheduled follow-ups never abort each other (scheduler runs them sequentially)', async () => {
    const concurrent = { n: 0, max: 0 };
    const order: string[] = [];
    registerScheduledRunner(async (text) => {
      concurrent.n++;
      concurrent.max = Math.max(concurrent.max, concurrent.n);
      order.push(text.includes('ALPHA') ? 'A' : 'B');
      await sleep(80);
      concurrent.n--;
      return `done ${text.includes('ALPHA') ? 'A' : 'B'}`;
    });
    await scheduleTask('check ALPHA now', { at: new Date(Date.now() + 100).toISOString() });
    await scheduleTask('check BETA now', { at: new Date(Date.now() + 100).toISOString() });
    await tick(new Date(Date.now() + 500).getTime());
    const all = await (await import('../src/main/scheduler')).listScheduled();
    expect(all.map((t) => t.status)).toEqual(['done', 'done']);
    expect(concurrent.max).toBe(1); // strictly sequential
    expect(order).toEqual(['A', 'B']);
  });

  it('the REAL scheduler→chat path: both scheduled turns complete, neither aborts the other', async () => {
    registerScheduledRunner((text) => chat(text, () => undefined, undefined, 'scheduled'));
    script = [{ reply: 'alpha verdict' }, { reply: 'beta verdict' }];
    await scheduleTask('follow-up ALPHA', { at: new Date(Date.now() + 100).toISOString() });
    await scheduleTask('follow-up BETA', { at: new Date(Date.now() + 100).toISOString() });
    await tick(new Date(Date.now() + 500).getTime());
    const all = await (await import('../src/main/scheduler')).listScheduled();
    expect(all.map((t) => t.status)).toEqual(['done', 'done']);
    expect(all[0].reply).toContain('alpha');
    expect(all[1].reply).toContain('beta');
  });

  it('an interactive request still interrupts a previous INTERACTIVE turn (existing product behaviour)', async () => {
    let releaseTurn1!: () => void;
    script = [
      { reply: 'never delivered', hold: (r) => (releaseTurn1 = r) },
      { reply: 'reply for the newer request' },
    ];
    const p1 = chat('older interactive request', () => undefined, undefined, 'interactive');
    await waitUntil(async () => seenUserTexts.length >= 1);
    const p2 = chat('newer interactive request', () => undefined, undefined, 'interactive');
    expect(await p1).toBe(''); // interrupted
    releaseTurn1(); // its in-flight completion still unwinds
    expect(await p2).toBe('reply for the newer request');
  });

  it('the turn signal is bound when a turn STARTS, not when it is queued', async () => {
    const { currentTurnSignal } = await import('../src/main/turnSignal');
    const boundDuring: Array<boolean> = [];
    let releaseTurn1!: () => void;
    script = [
      { reply: 'one', hold: (r) => (releaseTurn1 = r) },
      { reply: 'two' },
    ];
    const p1 = chat('signal check one', () => undefined, undefined, 'interactive');
    await waitUntil(async () => seenUserTexts.length >= 1);
    boundDuring.push(currentTurnSignal() !== null); // running turn owns the signal
    const p2 = chat('signal check two', () => undefined, undefined, 'scheduled');
    await sleep(60); // queued scheduled turn must NOT have stolen the signal
    boundDuring.push(currentTurnSignal() !== null);
    releaseTurn1();
    await p1;
    await p2;
    await sleep(60); // the chain's cleanup runs one tick after the returned promise settles
    expect(boundDuring).toEqual([true, true]);
    expect(currentTurnSignal()).toBeNull(); // cleared after the chain drains
  });
});

// ------------------------------------------------------------------ C. lease / heartbeat (F-18)

describe('F-18: the watchdog detects dead drivers, not slow steps', () => {
  it('a healthy step running far beyond the OLD watchdog threshold keeps its lease and completes', async () => {
    setCoordinatorTimingForTests(40, 300); // heartbeat 40 ms, stall threshold 300 ms
    const deps = silentDeps({
      planner: async (spec) => [{ title: 'long step', detail: spec.objective, kind: 'general' }],
      stepRunner: async (p, k, t, stepId) => {
        await sleep(700); // 700 ms >> the 300 ms stall threshold — the old watchdog killed this
        await writeEvidence(t.id, stepId, 'out/long.md', 'survived a long step\n');
        return 'DONE: wrote out/long.md; VERIFIED: re-read; ISSUES: none';
      },
    });
    const out = await startTask('Create the long-step proof in out/long.md', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1];
    await waitUntil(async () => (await getTask(id))?.status === 'COMPLETED', 12000);
    const t = (await getTask(id))!;
    expect(t.status).toBe('COMPLETED');
    expect(t.steps[0].status).toBe('done');
  }, 20000);

  it('a genuinely abandoned worker is interrupted, and its claim is broken for the next owner', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deps = silentDeps({
      planner: async (spec) => [{ title: 'gated step', detail: spec.objective, kind: 'general' }],
      stepRunner: async () => {
        await gate;
        return 'DONE: ok; VERIFIED: yes; ISSUES: none';
      },
    });
    const out = await startTask('Create the abandoned proof in out/abandoned.md', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1];
    await waitUntil(async () => (await getTask(id))?.status === 'RUNNING');
    const t = (await getTask(id))!;
    const ownerBefore = t.owner;
    expect(ownerBefore).toMatch(/^coordinator:/); // unique ownership token, not a shared string
    t.ownerSince = Date.now() - 10 * 60_000; // driver died right after claiming
    const stale = await checkStalls();
    expect(stale).toContain(id);
    expect((await getTask(id))?.status).toBe('INTERRUPTED');
    // The dead token cannot renew anything anymore...
    const before = (await getTask(id))!.ownerSince;
    await renewClaim((await getTask(id))!, ownerBefore);
    expect((await getTask(id))!.ownerSince).toBe(before);
    // ...and a fresh worker CAN claim. (claimTask returns the lease TOKEN — the taskStore
    // contract pinned by taskSpec.test — so the assertion is truthiness, not identity.)
    expect(await claimTask((await getTask(id))!, 'coordinator:new-driver')).toBeTruthy();
    cancelTask(id);
    release();
  }, 15000);
});

// ------------------------------------------------------------------ D. durable resume (F-19/F-20 + idempotency)

describe('F-19/F-20: resume continues persisted work; receipts are reconciled', () => {
  it('a multi-step task resumes from the persisted plan: done steps are NOT re-run, no re-plan happens', async () => {
    const planner = vi.fn(async (spec: ReturnType<typeof buildTaskSpec>) => [
      { title: 'step one', detail: 'first chunk', kind: 'general' },
      { title: 'step two', detail: 'second chunk', kind: 'general' },
      { title: 'step three', detail: 'write the deliverable', kind: 'general' },
    ]);
    let crashed = false;
    const deps1 = silentDeps({
      planner: planner as unknown as CoordinatorDeps['planner'],
      stepRunner: async (_p, _k, _t, stepId) => {
        if (stepId === 's1' || stepId === 's2') return `DONE: finished ${stepId}; VERIFIED: re-read; ISSUES: none`;
        if (!crashed) {
          crashed = true;
          await new Promise<void>(() => undefined); // the "process death": this driver never reports back
        }
        return 'unreachable';
      },
    });
    const out = await startTask('Create the resume proof report in out/resume.md', deps1);
    const id = /Task (T-[\w]+)/.exec(out)![1];
    await waitUntil(async () => (await getTask(id))?.steps[2]?.status === 'running');

    // Emulate the crash exactly as boot reconciliation records it: task INTERRUPTED,
    // the mid-flight step left 'running', ownership dropped with the dead process.
    const crashedRecord = (await getTask(id))!;
    await transition(crashedRecord, 'INTERRUPTED', 'simulated process death');
    await releaseClaim(crashedRecord, crashedRecord.owner);

    // The dead driver had dispatched a side-effecting write whose outcome never landed:
    await recordExecution({
      id: 'exec-unresolved-1',
      t: Date.now(),
      ms: 0,
      tool: 'write_file',
      agent: 'task:general#9',
      taskId: id,
      stepId: 's3',
      args: 'path=out/resume.md',
      auth: 'autonomous',
      status: 'outcome_unknown',
      retries: 0,
      idempotencyKey: 'write_file:out/resume.md',
    });

    const seenAfterResume: string[] = [];
    const deps2 = silentDeps({
      stepRunner: async (p, k, t, stepId) => {
        seenAfterResume.push(stepId);
        if (stepId === 's3') await writeEvidence(t.id, stepId, 'out/resume.md', `deliverable of ${stepId}\n`);
        return `DONE: finished ${stepId}; VERIFIED: re-read; ISSUES: none`;
      },
    });
    const msg = await resumeTask(id, deps2);
    expect(msg).toMatch(/resumed from step 3/);
    await waitUntil(async () => (await getTask(id))?.status === 'COMPLETED', 8000);
    const t = (await getTask(id))!;
    expect(t.status).toBe('COMPLETED');
    expect(t.verification?.passed).toBe(true); // verification still runs after resumed work
    expect(planner).toHaveBeenCalledTimes(1); // the plan was NEVER re-made
    expect(seenAfterResume).toEqual(['s3']); // completed steps were not blindly repeated
    expect(t.steps[0].status).toBe('done');
    expect(t.steps[1].status).toBe('done');
    expect(t.steps[0].result).toContain('finished s1'); // persisted results survive
    expect(t.steps[2].detail).toMatch(/RECONCILE FIRST/); // unknown outcome is reconciled, not retried blind
    expect(t.steps[2].detail).toMatch(/write_file/);
    expect(fs.existsSync(path.join(ROOT, 'out', 'resume.md'))).toBe(true);
  }, 20000);

  it('unresolvedExecutionsFor returns exactly the receipts that never completed', async () => {
    const taskId = 'T-receipts';
    const write = (id: string, status: 'ok' | 'outcome_unknown'): Promise<void> =>
      recordExecution({ id, t: Date.now(), ms: 1, tool: 'write_file', agent: 'main', taskId, args: 'path=x', auth: 'allowed', status, result: 'r', retries: 0 });
    await write('a1', 'outcome_unknown'); // started, never completed → unresolved
    await write('a2', 'outcome_unknown'); // started...
    await write('a2', 'ok'); // ...then completed under the SAME id → resolved
    const unresolved = await unresolvedExecutionsFor(taskId);
    expect(unresolved.map((r) => r.id)).toEqual(['a1']);
    const perStep = await unresolvedExecutionsFor(taskId, 's9');
    expect(perStep).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ E. workspace write coordination (F-21)

describe('F-21: per-path write coordination across engines', () => {
  it('independent files write TRULY concurrently; the same path is strictly serialized', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const job = (p: string): Promise<void> =>
      withPathLock([p], async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(60);
        inFlight--;
      });
    const f1 = path.join(ROOT, 'conc-a.txt');
    const f2 = path.join(ROOT, 'conc-b.txt');
    await Promise.all([job(f1), job(f2)]);
    expect(maxInFlight).toBe(2); // different paths: concurrency preserved
    maxInFlight = 0;
    await Promise.all([job(f1), job(f1)]);
    expect(maxInFlight).toBe(1); // same path: strictly serialized
  });

  it('two engines editing the same file via the REAL tool never lose an update', async () => {
    const rel = 'conflict/shared.txt';
    wf(rel, 'content-X\n');
    const results = await Promise.allSettled([
      runWithCallContext({ agent: 'engine-A' }, () =>
        fsTools.multi_edit.run({ path: rel, edits: [{ old_text: 'content-X', new_text: 'content-A' }] })
      ),
      runWithCallContext({ agent: 'engine-B' }, () =>
        fsTools.multi_edit.run({ path: rel, edits: [{ old_text: 'content-X', new_text: 'content-B' }] })
      ),
    ]);
    const final = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // Serialized read-modify-write: the second engine READS what the first wrote, so its
    // old_text no longer matches and it fails LOUDLY — the file is exactly one winner's
    // content, never a mangled mix, and never silently last-writer-wins on stale data.
    expect(final === 'content-A\n' || final === 'content-B\n').toBe(true);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const err = (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as Error;
    expect(err.message).toMatch(/old_text was not found/);
  });

  it('locks are released on errors and cancellation-style throws (no leak)', async () => {
    const p = path.join(ROOT, 'leak.txt');
    await expect(withPathLock([p], async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(withPathLock([p], async () => 'second run')).resolves.toBe('second run');
    expect(canonicalPathKey(p)).toBe(canonicalPathKey(p)); // canonical identity is stable
  });

  it('a hung holder surfaces a STRUCTURED conflict instead of waiting forever', async () => {
    setWriteWaitTimeoutForTests(60);
    const p = path.join(ROOT, 'held.txt');
    void withPathLock([p], () => new Promise<string>(() => undefined)); // held forever by a "hung" writer
    await expect(withPathLock([p], async () => 'never')).rejects.toThrow(/CONFLICT.*another execution/);
  });

  it('the full engine mix can write different files at once (interactive + coordinator + background identities)', async () => {
    const agents = ['main', 'task:general#1', 'background-job'];
    const files = agents.map((_, i) => wf(`mix/out-${i}.txt`, 'start\n'));
    const outs = await Promise.all(
      agents.map((agent, i) =>
        runWithCallContext({ agent }, () =>
          fsTools.multi_edit.run({ path: path.relative(ROOT, files[i]), edits: [{ old_text: 'start', new_text: agent }] })
        )
      )
    );
    expect(outs.every((o) => /Applied 1 edit/.test(String(o)))).toBe(true);
    agents.forEach((agent, i) => expect(fs.readFileSync(files[i], 'utf8')).toBe(`${agent}\n`));
  });
});
