import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, safeStorage: { isEncryptionAvailable: () => false } }));

import { fileFormatOk, verifyAcceptance, urlsInEvidence } from '../src/main/verifier';
import { recordExecution, resetCallContext, setCallContext } from '../src/main/toolRecord';
import { buildTaskSpec } from '../src/main/taskSpec';
import { createTask, getTask, listTasks, resetTaskStoreForTests, transition } from '../src/main/taskStore';
import {
  cancelTask,
  checkStalls,
  coordinatorTools,
  fallbackPlan,
  startTask,
  taskStatusText,
  type CoordinatorDeps,
} from '../src/main/coordinator';
import { claimTask } from '../src/main/taskStore';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-test-${process.pid}`);
const wf = (name: string, content: string | Buffer): string => {
  const full = path.join(ROOT, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
};

beforeEach(() => {
  resetTaskStoreForTests();
  resetCallContext();
  fs.rmSync(path.join(ROOT, 'brain', 'tasks'), { recursive: true, force: true });
});

afterEach(() => {
  resetCallContext();
});

describe('file format validation — honest, no invented passes', () => {
  it('validates known formats structurally and refuses unknown ones', async () => {
    expect((await fileFormatOk(wf('ok.json', '{"a":1}'))).ok).toBe(true);
    expect((await fileFormatOk(wf('bad.json', '{nope'))).ok).toBe(false);
    // OOXML containers are ZIP archives: the PK signature is required.
    expect((await fileFormatOk(wf('real.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 1, 2, 3])))).ok).toBe(true);
    expect((await fileFormatOk(wf('fake.docx', 'plain text, not a zip'))).ok).toBe(false);
    expect((await fileFormatOk(wf('real.pdf', Buffer.from('%PDF-1.7 rest')))).ok).toBe(true);
    expect((await fileFormatOk(wf('fake.pdf', 'hello'))).ok).toBe(false);
    const clean = await fileFormatOk(wf('notes.txt', 'fine text'));
    expect(clean.ok).toBe(true);
    const binary = await fileFormatOk(wf('binary.txt', Buffer.from([0x41, 0x00, 0x42, 0x00, 0xff, 0xfe, 0x00, 0x00])));
    expect(binary.ok).toBe(false);
    // An unknown extension can NEVER pass: "no validator" is a fail, not a waiver.
    const unknown = await fileFormatOk(wf('mystery.xyz', 'anything'));
    expect(unknown.ok).toBe(false);
    expect(unknown.evidence).toMatch(/unproven|no structural validator/);
  });
});

describe('verifyAcceptance — criteria against reality', () => {
  const writeEvidence = async (taskId: string, file: string): Promise<void> => {
    setCallContext({ agent: 'task:general#1', taskId });
    await recordExecution({
      id: `e-${Math.random().toString(36).slice(2, 7)}`,
      t: Date.now(),
      ms: 5,
      tool: 'write_file',
      agent: 'task:general#1',
      taskId,
      args: `path=${file}`,
      auth: 'allowed',
      status: 'ok',
      result: `Wrote to ${file}`,
      retries: 0,
      idempotencyKey: `write_file:${file}`,
    });
    resetCallContext();
  };

  it('a written file passes exists/nonempty/format from durable evidence', async () => {
    const file = wf('out/report.md', '# Report\n\ncontent here');
    const spec = buildTaskSpec('Create a summary report in out/report.md');
    const t = await createTask(spec);
    await writeEvidence(t.id, file);
    const v = await verifyAcceptance(spec.acceptance, t.id, t.createdAt);
    expect(v.passed).toBe(true);
    expect(v.results.map((r) => r.pass)).toEqual([true, true, true]);
    expect(v.results[0].evidence).toContain('report.md');
  });

  it('missing evidence stays missing: a task with no writes fails every file criterion', async () => {
    const spec = buildTaskSpec('Create a summary report in out/never-written.md');
    const t = await createTask(spec);
    const v = await verifyAcceptance(spec.acceptance, t.id, t.createdAt);
    expect(v.passed).toBe(false);
    expect(v.results.every((r) => !r.pass)).toBe(true);
    expect(v.results[0].evidence).toMatch(/no successful write step recorded/);
  });

  it('sources-present counts URLs that actually flowed through web tools', async () => {
    const spec = buildTaskSpec('Research the market and write a report');
    const t = await createTask(spec);
    setCallContext({ agent: 'task:researcher#1', taskId: t.id });
    for (const [i, url] of ['https://a.example/x', 'https://b.example/y', 'https://a.example/x'].entries()) {
      await recordExecution({
        id: `w${i}`,
        t: Date.now(),
        ms: 9,
        tool: 'web_search',
        agent: 'task:researcher#1',
        taskId: t.id,
        args: `query=q${i} url=${url}`,
        auth: 'allowed',
        status: 'ok',
        result: `findings from ${url}`,
        retries: 0,
        idempotencyKey: `web_search:https://x${i}`,
      });
    }
    resetCallContext();
    const ev = { sources: buildTaskSpec('Research the market and write a report').acceptance.filter((a) => a.kind === 'sources-present') };
    void ev;
    const src = spec.acceptance.find((a) => a.kind === 'sources-present')!;
    const v = await verifyAcceptance([src], t.id, t.createdAt);
    expect(v.passed).toBe(true);
    expect(v.results[0].evidence).toMatch(/2 distinct URLs/);
  });

  it('command-passes requires a real exit 0', async () => {
    const pass = await verifyAcceptance([{ id: 'c1', kind: 'command-passes', detail: 'tests pass', target: 'npm test' }], 'T-none', 0, {
      runCommand: async () => 'exit 0\nall green',
    });
    expect(pass.passed).toBe(true);
    const fail = await verifyAcceptance([{ id: 'c2', kind: 'command-passes', detail: 'tests pass', target: 'npm test' }], 'T-none', 0, {
      runCommand: async () => 'exit 1\n2 failing',
    });
    expect(fail.passed).toBe(false);
    expect(fail.results[0].evidence).toContain('exit 1');
    // No runner available = unverified, never a pass.
    const noRunner = await verifyAcceptance([{ id: 'c3', kind: 'command-passes', detail: 'tests pass', target: 'npm test' }], 'T-none', 0, {});
    expect(noRunner.passed).toBe(false);
  });

  it('a FAILING reviewer verdict lowers the result; it can never raise it', async () => {
    const file = wf('out/good.md', 'content');
    const spec = buildTaskSpec('Create a summary report in out/good.md');
    const t = await createTask(spec);
    await writeEvidence(t.id, file);
    const lowered = await verifyAcceptance(spec.acceptance, t.id, t.createdAt, { reviewerVerdict: 'VERDICT: FAIL — the report misses the requested comparison table.' });
    expect(lowered.passed).toBe(false);
    // And a failing mechanical check is not rescued by a happy reviewer.
    const spec2 = buildTaskSpec('Create a summary report in out/absent.md');
    const t2 = await createTask(spec2);
    const still = await verifyAcceptance(spec2.acceptance, t2.id, t2.createdAt, { reviewerVerdict: 'VERDICT: PASS' });
    expect(still.passed).toBe(false);
  });
});

describe('urlsInEvidence', () => {
  it('collects distinct URLs only from successful web-family records', () => {
    const rec = (tool: string, status: 'ok' | 'failed', args: string) => ({
      id: Math.random().toString(36).slice(2),
      t: Date.now(),
      ms: 1,
      tool,
      agent: 'main',
      args,
      auth: 'allowed' as const,
      status,
      retries: 0,
    });
    const records = [
      rec('web_search', 'ok', 'query=x url=https://one.example/a'),
      rec('fetch_url', 'ok', 'url=https://two.example/b'),
      rec('web_search', 'failed', 'url=https://three.example/c'),
      rec('read', 'ok', 'path=x https://not-web.example/d'),
    ];
    expect(urlsInEvidence(records)).toEqual(['https://one.example/a', 'https://two.example/b']);
  });
});

// ------------------------------------------------------------------ coordinator

const silentDeps = (overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps => ({
  run: async () => 'OK',
  schemas: () => [],
  planner: async (spec) => fallbackPlan(spec),
  stepRunner: async () => 'DONE: the deliverable exists at out/x.md; VERIFIED: re-read; ISSUES: none',
  ...overrides,
});

describe('TaskCoordinator (Module C)', () => {
  it('informational requests are refused; the turn loop answers those directly', async () => {
    const out = await startTask('What is the capital of Australia?', silentDeps());
    expect(out).toMatch(/NOT DONE/);
  });

  it('high-risk wording starts autonomously under the single policy (no confirmation gate)', async () => {
    // "Uninstall / registry" wording used to require an APPROVAL NEEDED round trip. The
    // request itself is the mandate; the two hard restrictions are enforced at the tool
    // gate in code, so the coordinator must never pause for permission.
    const out = await startTask(
      'Audit which of these installed programs are outdated and write the findings to out/audit.md',
      silentDeps({ stepRunner: async () => 'DONE: audit written to out/audit.md; VERIFIED: re-read; ISSUES: none' })
    );
    expect(out).not.toMatch(/APPROVAL NEEDED/);
    expect(out).toMatch(/Task T-/);
  });

  it('drives a full task: plan → steps → verification → COMPLETED, with a real file', async () => {
    const file = path.join(ROOT, 'out', 'tasked.md');
    const deps = silentDeps({
      stepRunner: async (_p, _kind, t, stepId) => {
        wf('out/tasked.md', `content for ${t.id} step ${stepId}`);
        setCallContext({ agent: 'task:general#1', taskId: t.id, stepId });
        await recordExecution({
          id: `s-${stepId}`,
          t: Date.now(),
          ms: 3,
          tool: 'write_file',
          agent: 'task:general#1',
          taskId: t.id,
          stepId,
          args: `path=${file}`,
          auth: 'allowed',
          status: 'ok',
          result: 'wrote',
          retries: 0,
          idempotencyKey: `write_file:${file}`,
        });
        resetCallContext();
        return `DONE: wrote ${file}; VERIFIED: re-read it; ISSUES: none`;
      },
    });
    const out = await startTask('Create the project notes file in out/tasked.md', deps);
    expect(out).toMatch(/Task T-/);
    const id = /Task (T-[\w]+)/.exec(out)![1];
    // Drive is async: wait for the terminal state.
    for (let i = 0; i < 50 && (await getTask(id))?.status !== 'COMPLETED'; i++) await new Promise((r) => setTimeout(r, 50));
    const t = await getTask(id);
    expect(t?.status).toBe('COMPLETED');
    expect(t?.verification?.passed).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(taskStatusText(t!)).toMatch(/COMPLETED/);
  });

  it('a failing step stops the task honestly with FAILED — later steps never run', async () => {
    const calls: string[] = [];
    const deps = silentDeps({
      planner: async () => [
        { title: 'first', detail: 'x', kind: 'general' },
        { title: 'second', detail: 'y', kind: 'general' },
      ],
      stepRunner: async (_p, _k, _t, stepId) => {
        calls.push(stepId);
        return stepId === 's1' ? 'FAILED: the source file was not found and nothing was written.' : 'DONE: never reached';
      },
    });
    const out = await startTask('Create the quarterly summary deck in out/deck.md', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1];
    for (let i = 0; i < 50 && (await getTask(id))?.status !== 'FAILED'; i++) await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual(['s1', 's1']); // run once, retried once, then stopped
    const t = await getTask(id);
    expect(t?.status).toBe('FAILED');
    // Round 20 (CHANGE 4): the dependent step is marked SKIPPED with the reason — it can
    // never run in this plan version, so 'pending' (which reads as merely not-yet-run)
    // was the old dishonest shape. The step itself still never ran.
    expect(t?.steps[1].status).toBe('skipped');
    expect(t?.steps[1].result).toMatch(/^SKIPPED: a dependency failed/);
    expect(calls).not.toContain('s2');
  });

  it('duplicate requests are refused while a task with the same request is active', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deps = silentDeps({ stepRunner: async () => { await gate; return 'DONE: ok; VERIFIED: ok; ISSUES: none'; } });
    const first = await startTask('Create the budget sheet in out/budget.xlsx', deps);
    expect(first).toMatch(/Task T-/);
    const second = await startTask('create   the budget sheet in out/budget.xlsx', deps);
    expect(second).toMatch(/NOT DONE/);
    release();
  });

  it('cancellation is respected: an aborted task lands CANCELLED', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deps = silentDeps({ stepRunner: async () => { await gate; return 'DONE: ok; VERIFIED: ok; ISSUES: none'; } });
    const out = await startTask('Create the long report in out/long.md', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1];
    await new Promise((r) => setTimeout(r, 80)); // let it reach RUNNING inside the step
    expect(cancelTask(id)).toBe(true);
    release();
    for (let i = 0; i < 50 && (await getTask(id))?.status !== 'CANCELLED'; i++) await new Promise((r) => setTimeout(r, 50));
    expect((await getTask(id))?.status).toBe('CANCELLED');
  });

  it('stall detection marks a stale RUNNING task INTERRUPTED and resumable', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const deps = silentDeps({ stepRunner: async () => { await gate; return 'DONE: ok; VERIFIED: ok; ISSUES: none'; } });
    const out = await startTask('Create the stalled notes in out/stalled.md', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1];
    await new Promise((r) => setTimeout(r, 80)); // let it reach RUNNING inside the gated step
    const t = (await getTask(id))!;
    expect(t.status).toBe('RUNNING');
    // Simulate a driver that died mid-step: an ancient claim timestamp.
    t.ownerSince = Date.now() - 20 * 60_000;
    const stale = await checkStalls();
    expect(stale).toContain(id);
    expect((await getTask(id))?.status).toBe('INTERRUPTED');
    // Tear down cleanly: cancel + release the gate so the driver exits via CANCELLED.
    cancelTask(id);
    release();
  });

  it('the tools are registered and answer honestly without tasks', async () => {
    const tools = coordinatorTools(silentDeps());
    expect(await tools.list_tasks.run({})).toMatch(/No durable tasks recorded/);
    expect(await tools.task_status.run({})).toMatch(/No tasks have been started/);
    expect(await tools.task_cancel.run({ id: 'T-none' })).toMatch(/NOT DONE/);
  });
});
