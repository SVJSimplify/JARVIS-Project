import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';

/**
 * ROUND 20 CHANGE 4 — PLANNING/EXECUTION CONSISTENCY UNDER REAL FAILURES
 * and CHANGE 5 — EVIDENCE-BASED, PER-STEP VERIFICATION.
 *
 * Pins:
 *   - a replan NEVER launders away a step's recovery state (outcomeUnknown, interruption
 *     history, attempt counts survive for pending/failed steps);
 *   - an identical replan (same remaining titles) is refused without burning the budget;
 *   - a whole-task wall-clock budget fails a looping task explicitly;
 *   - a per-step deadline fails a stuck step honestly (never a silent infinite run);
 *   - skip propagation: branches blocked by failed dependencies are marked skipped with
 *     the reason, preserving successful branches into verification;
 *   - every settled step carries a StepVerification record with
 *     intended/action/toolResult/observed/method/evidence/status derived from evidence;
 *   - applyReviewerVerdict lowers but never inflates, and never re-runs checks.
 */

vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() }, safeStorage: { isEncryptionAvailable: () => false } }));

import { applyReviewerVerdict, verifyAcceptance } from '../src/main/verifier';
import { recordExecution, resetCallContext, setCallContext } from '../src/main/toolRecord';
import { buildTaskSpec } from '../src/main/taskSpec';
import { createTask, getTask, resetTaskStoreForTests, replanSteps, setSteps, transition } from '../src/main/taskStore';
import { setCoordinatorBudgetsForTests, startTask, type CoordinatorDeps } from '../src/main/coordinator';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-test-${process.pid}`);
const waitFor = async (id: string, status: string): Promise<void> => {
  for (let i = 0; i < 100 && (await getTask(id))?.status !== status; i++) await new Promise((r) => setTimeout(r, 50));
};

beforeEach(() => {
  resetTaskStoreForTests();
  resetCallContext();
  fs.rmSync(path.join(ROOT, 'brain', 'tasks'), { recursive: true, force: true });
});

describe('CHANGE 4 — replanning correctness', () => {
  it('a replan preserves outcomeUnknown, interruption history and attempts for pending/failed steps', async () => {
    const spec = buildTaskSpec('write a report');
    const t = await createTask(spec);
    await setSteps(t, [
      { title: 'Risky step', detail: 'may be interrupted', kind: 'general' },
      { title: 'Safe step', detail: 'fine', kind: 'general', dependsOn: [] },
    ]);
    const risky = t.steps.find((s) => s.title === 'Risky step')!;
    risky.status = 'pending';
    risky.outcomeUnknown = true;
    risky.interruptions = [{ at: 123, reason: 'orphaned by restart' }];
    risky.attempts = 2;
    await replanSteps(t, [
      { title: 'Risky step', detail: 'replanned shape', kind: 'general' },
      { title: 'Safe step', detail: 'fine', kind: 'general', dependsOn: [] },
    ]);
    const after = t.steps.find((s) => s.title === 'Risky step')!;
    expect(after.outcomeUnknown).toBe(true); // never laundered away by the replan
    expect(after.interruptions?.length).toBe(1);
    expect(after.attempts).toBe(2);
    expect(after.id).toBe(risky.id); // identity preserved
  });

  it('an identical replan is REFUSED without consuming the replan budget', async () => {
    const plan = [
      { title: 'Flaky step', detail: 'always fails', kind: 'general' },
      { title: 'Blocked step', detail: 'depends on the flaky one', kind: 'general' },
    ];
    const deps: CoordinatorDeps = {
      run: async () => ({ text: 'unused', status: 'success' }),
      schemas: () => [],
      planner: async () => plan,
      replanner: async () => plan.map((s) => ({ ...s })), // the same remaining work — no new strategy
      stepRunner: async (_p, _k, _t, stepId) => (stepId === 's1' ? 'FAILED: no way to do this step' : 'DONE: unreachable'),
    };
    const out = await startTask('Create the impossible artifact in out/r20-imp.md', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1];
    await waitFor(id, 'FAILED');
    const t = (await getTask(id))!;
    expect(t.status).toBe('FAILED');
    expect(t.replans).toBe(0); // budget NOT burned on an identical plan
    expect(t.planHistory.length).toBe(0); // no plan version was created
  });

  it('a genuinely different replan is accepted and preserves completed work', async () => {
    const calls: string[] = [];
    const deps: CoordinatorDeps = {
      run: async () => ({ text: 'unused', status: 'success' }),
      schemas: () => [],
      planner: async () => [
        { title: 'Write the file', detail: 'write it', kind: 'general' },
        { title: 'Verify the file', detail: 'check', kind: 'general' },
      ],
      replanner: async () => [{ title: 'Different strategy step', detail: 'new approach', kind: 'general' }],
      stepRunner: async (_p, _k, _t, stepId) => {
        calls.push(stepId);
        return stepId === 's1' ? 'DONE: wrote the file' : 'FAILED: the verify tool is broken today';
      },
    };
    const out = await startTask('Create the quarterly deck in out/deck20.md', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1];
    await waitFor(id, 'COMPLETED');
    const t = (await getTask(id))!;
    expect(t.replans).toBe(1);
    expect(t.steps.find((s) => s.title === 'Write the file')?.status).toBe('done'); // completed work preserved
    expect(calls.filter((c) => c === 's1').length).toBe(1); // never re-run
  });
});

describe('CHANGE 4 — explicit execution-time bounds', () => {
  it('a step stuck past its deadline fails honestly with the deadline note', async () => {
    setCoordinatorBudgetsForTests(120); // 120ms per step attempt
    const deps: CoordinatorDeps = {
      run: async () => ({ text: 'unused', status: 'success' }),
      schemas: () => [],
      planner: async () => [{ title: 'Stuck step', detail: 'hangs', kind: 'general' }],
      stepRunner: async (_p, _k, _t, _stepId, signal) => {
        // A well-behaved runner observes its signal (as runSubagent does).
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          const t = setTimeout(resolve, 5000);
          signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
        return signal.aborted ? 'FAILED: interrupted by the step deadline' : 'DONE: never';
      },
    };
    const out = await startTask('Create the hangy artifact in out/r20-hang.md', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1];
    await waitFor(id, 'FAILED');
    const t = (await getTask(id))!;
    expect(t.status).toBe('FAILED');
    expect(t.steps[0].result).toMatch(/deadline/i);
    expect(t.steps[0].status).toBe('failed');
    setCoordinatorBudgetsForTests(10 * 60_000);
  }, 20_000);

  it('a task past its whole-task budget fails explicitly instead of looping', async () => {
    setCoordinatorBudgetsForTests(10 * 60_000, 50); // 50ms total task budget
    const deps: CoordinatorDeps = {
      run: async () => ({ text: 'unused', status: 'success' }),
      schemas: () => [],
      planner: async () => [
        { title: 'Slow one', detail: 'x', kind: 'general' },
        { title: 'Slow two', detail: 'y', kind: 'general' },
      ],
      stepRunner: async () => {
        await new Promise((r) => setTimeout(r, 400));
        return 'DONE: slow progress';
      },
    };
    const out = await startTask('Create the slow artifact in out/r20-slow.md', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1];
    await waitFor(id, 'FAILED');
    const t = (await getTask(id))!;
    expect(t.status).toBe('FAILED');
    expect(t.note + t.history.map((h) => h.note).join(' ')).toMatch(/budget/);
    setCoordinatorBudgetsForTests(10 * 60_000);
  }, 20_000);
});

describe('CHANGE 5 — per-step evidence-based verification', () => {
  it('every settled step carries a StepVerification record derived from evidence', async () => {
    const deps: CoordinatorDeps = {
      run: async () => ({ text: 'unused', status: 'success' }),
      schemas: () => [],
      planner: async () => [{ title: 'Produce the artifact', detail: 'write out/r20-evidence.md', kind: 'general', expectedOutput: 'the file out/r20-evidence.md exists with content' }],
      // Round 26 Phase 3: the claim must be BACKED by reality — the step actually creates
      // the file so the verification has actual disk evidence (the old fixture only claimed).
      stepRunner: async () => {
        fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
        fs.writeFileSync(path.join(ROOT, 'out', 'r20-evidence.md'), 'hello world');
        return 'DONE: wrote out/r20-evidence.md; VERIFIED: re-read the file';
      },
    };
    const out = await startTask('Write out/r20-evidence.md with a hello world', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1];
    await waitFor(id, 'COMPLETED');
    const t = (await getTask(id))!;
    const v = t.steps[0].verification;
    expect(v).toBeTruthy();
    expect(v!.intended).toMatch(/r20-evidence\.md/);
    expect(v!.method).toMatch(/ledger|disk/i);
    expect(v!.observed).toMatch(/exists on disk/i);
    expect(v!.status).toBe('verified');
  });

  it('a failed step records status failed with the report as the tool claim', async () => {
    const deps: CoordinatorDeps = {
      run: async () => ({ text: 'unused', status: 'success' }),
      schemas: () => [],
      planner: async () => [{ title: 'Impossible step', detail: 'cannot', kind: 'general' }],
      stepRunner: async () => 'FAILED: the required API does not exist',
    };
    const out = await startTask('Create the impossible report in out/r20-fail.md', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1];
    await waitFor(id, 'FAILED');
    const t = (await getTask(id))!;
    const v = t.steps[0].verification!;
    expect(v.status).toBe('failed');
    expect(v.toolResult).toMatch(/FAILED: the required API/);
    expect(v.intended).toBeTruthy();
  });

  it('mechanical checks carry method and observed; the reviewer can only lower, never re-run', async () => {
    setCallContext({ agent: 'task:general#1', taskId: 'T-e' });
    await recordExecution({
      id: `e-${Math.random().toString(36).slice(2, 7)}`,
      t: Date.now(),
      ms: 5,
      tool: 'write_file',
      agent: 'task:general#1',
      taskId: 'T-e',
      args: `path=${path.join(ROOT, 'out', 'r20-method.md')}`,
      auth: 'allowed',
      status: 'ok',
      result: 'Wrote the file',
      retries: 0,
      idempotencyKey: 'write_file:x',
    });
    resetCallContext();
    fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'out', 'r20-method.md'), 'content');
    const v = await verifyAcceptance(
      [{ id: 'a1', kind: 'file-exists', detail: 'out/r20-method.md exists on disk', target: path.join(ROOT, 'out', 'r20-method.md') }],
      'T-e',
      0
    );
    expect(v.results[0].method).toMatch(/disk stat/);
    expect(v.results[0].observed).toBeTruthy();
    // Reviewer FAIL lowers; reviewer PASS never inflates a mechanical FAIL.
    const lowered = applyReviewerVerdict({ ...v, passed: true }, 'VERDICT: FAIL — the file is missing a section.');
    expect(lowered.passed).toBe(false);
    expect(lowered.results.some((r) => r.criterion === 'independent reviewer')).toBe(true);
    const notInflated = applyReviewerVerdict({ ...v, passed: false }, 'VERDICT: PASS');
    expect(notInflated.passed).toBe(false);
  });
});
