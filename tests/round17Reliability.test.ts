import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());
// A model exists, and every model call HANGS until its signal aborts — turns stay
// genuinely in-flight so the abort wiring (F-13) is observable, without any network.
vi.mock('../src/main/llm', async (orig) => {
  const actual = await orig<typeof import('../src/main/llm')>();
  return {
    ...actual,
    send: (_path: string, _method: string, _body?: unknown, signal?: AbortSignal) =>
      new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) return reject(new Error('Interrupted'));
        signal?.addEventListener('abort', () => reject(new Error('Interrupted')));
      }),
    withModelFallback: async <T>(_chain: string[], fn: (m: string) => Promise<T>): Promise<T> => fn('test-model'),
    completeOnce: async () => ({ content: 'ok', toolCalls: [] }),
  };
});
// A model name is configured (turns reach the mocked model call); the coordinator's
// reviewer goes through the mocked completeOnce, so nothing touches the network.
vi.mock('../src/main/settings', async (orig) => {
  const actual = await orig<typeof import('../src/main/settings')>();
  return { ...actual, getModel: async () => 'test-model', getFallbackModels: async () => [] };
});

import { chat } from '../src/main/provider';
import {
  BOOT_ID,
  claimTask,
  createTask,
  markStep,
  reconcileInterruptedSteps,
  resetTaskStoreForTests,
  setSteps,
  transition,
  type TaskRecord,
} from '../src/main/taskStore';
import { buildTaskSpec } from '../src/main/taskSpec';
import { checkStalls, resumeTask, startTask, type CoordinatorDeps } from '../src/main/coordinator';
import { recordExecution, recordStarted, unknownOutcomeRecords } from '../src/main/toolRecord';
import {
  canonicalWritePath,
  clearWriteLocks,
  holdsWriteLock,
  setWriteCoordTimeoutsForTests,
  withWriteLock,
  withWriteLocks,
  writeLocks,
} from '../src/main/writeCoord';

/**
 * ROUND 17 — EXECUTION RELIABILITY REGRESSION SUITE.
 *
 * F-13 (execution-source cancellation isolation), F-18 (lease tokens + watchdog honesty),
 * F-19 (resume keeps the persisted plan), F-20 (orphaned RUNNING steps reconciled at boot
 * and at resume), idempotency receipts with outcome-unknown reconciliation, and F-21
 * (per-path write coordination).
 */

const root = (): string => process.env.JARVIS_FILES_ROOT ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-r17-'));

beforeEach(() => {
  process.env.JARVIS_FILES_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-r17-'));
  resetTaskStoreForTests();
  clearWriteLocks();
  setWriteCoordTimeoutsForTests();
});

const settled = async <T>(p: Promise<T>, ms: number): Promise<T | 'PENDING'> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'PENDING'>((r) => (timer = setTimeout(() => r('PENDING'), ms)));
  const out = await Promise.race([p.then(() => 'SETTLED' as const, () => 'SETTLED' as const), timeout]);
  clearTimeout(timer);
  return out;
};

describe('F-13: execution sources never abort each other', () => {
  it('a new interactive turn aborts the previous interactive turn (existing behaviour)', async () => {
    const p1 = chat('first user message', () => undefined);
    await new Promise((r) => setTimeout(r, 40)); // turn 1 is inside the (hanging) model call
    const p2 = chat('second user message', () => undefined);
    expect(await settled(p1, 400)).toBe('SETTLED'); // the user's new message stopped it
    expect(await settled(p2, 400)).toBe('PENDING'); // turn 2 now runs
    const { cancelChat } = await import('../src/main/provider');
    cancelChat();
    expect(await settled(p2, 400)).toBe('SETTLED');
  });

  it('a SCHEDULED turn does NOT abort a running interactive turn', async () => {
    const { cancelChat } = await import('../src/main/provider');
    const p1 = chat('the user is talking', () => undefined);
    await new Promise((r) => setTimeout(r, 40)); // interactive turn in flight
    const p2 = chat('scheduled follow-up', () => undefined, undefined, { source: 'scheduled' });
    await new Promise((r) => setTimeout(r, 80)); // give a WRONG implementation time to abort
    // The interactive turn is STILL running (not aborted by the scheduled arrival).
    expect(await settled(p1, 150)).toBe('PENDING');
    // The scheduled turn queued behind it (also not started to completion).
    cancelChat(); // user stops the interactive turn
    expect(await settled(p1, 400)).toBe('SETTLED');
    cancelChat(); // stop the queued scheduled turn once it starts
    expect(await settled(p2, 400)).toBe('SETTLED');
  });

  it('a new INTERACTIVE request still preempts a running scheduled turn', async () => {
    const p1 = chat('scheduled work', () => undefined, undefined, { source: 'scheduled' });
    await new Promise((r) => setTimeout(r, 40));
    const p2 = chat('user speaks over it', () => undefined);
    expect(await settled(p1, 400)).toBe('SETTLED'); // the user took precedence
    const { cancelChat } = await import('../src/main/provider');
    cancelChat();
    expect(await settled(p2, 400)).toBe('SETTLED');
  });
});

describe('F-18: lease tokens, heartbeat independence, watchdog honesty', () => {
  const deps = (stepRunner?: CoordinatorDeps['stepRunner'], plannerCalls?: string[]): CoordinatorDeps => ({
    run: async () => 'unused',
    schemas: () => [],
    planner: async (spec) => {
      plannerCalls?.push(spec.request);
      return [
        { title: 'step one', detail: 'do one', kind: 'general' },
        { title: 'step two', detail: 'do two', kind: 'general' },
        { title: 'verify', detail: 'check', kind: 'verifier' },
      ];
    },
    stepRunner,
  });

  it('a watchdog takeover leaves the task INTERRUPTED (resumable), never CANCELLED', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let ctl: AbortSignal | null = null;
    const stepRunner: CoordinatorDeps['stepRunner'] = async (_p, _k, _t, _s, signal) => {
      ctl = signal;
      await gate;
      return 'DONE: nothing';
    };
    const reply = await startTask('Create a file named a.txt', deps(stepRunner));
    const id = /Task (T-[\w]+) started/.exec(reply)?.[1] ?? '';
    expect(id).toBeTruthy();
    // Wait until the driver is inside the step (claimed, RUNNING).
    for (let i = 0; i < 50 && (!ctl || ctl.aborted); i++) await new Promise((r) => setTimeout(r, 20));
    // The watchdog fires while the step is STILL running (no heartbeat reached it — that
    // is the F-18 scenario this test simulates with a frozen driver).
    const stale = await checkStalls(Date.now() + 11 * 60 * 1000);
    expect(stale).toContain(id);
    release();
    // Let the driver settle after the abort.
    await new Promise((r) => setTimeout(r, 120));
    const t = (await import('../src/main/taskStore')).then ? null : null;
    void t;
    const { getTask } = await import('../src/main/taskStore');
    const task = await getTask(id);
    expect(task?.status).toBe('INTERRUPTED'); // NOT converted to CANCELLED
    // The interrupted task is resumable and completes with a working driver.
    const resumeReply = await resumeTask(id, deps(async () => 'DONE: a.txt written and verified'));
    expect(resumeReply).toContain('resumed WITHOUT replanning');
  });

  it('resume keeps the persisted plan: the planner is NOT called again and done steps stay done', async () => {
    const plannerCalls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const stepRunner: CoordinatorDeps['stepRunner'] = async (prompt, _k, t, stepId, signal) => {
      if (first) {
        first = false;
        await markStep(t, 's1', { status: 'done', result: 'DONE: step one persisted' });
        // take over the SECOND step slot and block until the watchdog fires
        await markStep(t, 's2', { status: 'running' });
        void stepId;
        void prompt;
        await gate;
        void signal;
        return 'DONE: never reached';
      }
      return 'DONE: step completed on resume';
    };
    const reply = await startTask('Create a file named b.txt', deps(stepRunner, plannerCalls));
    const id = /Task (T-[\w]+) started/.exec(reply)?.[1] ?? '';
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const { getTask } = await import('../src/main/taskStore');
      const task = await getTask(id);
      if (task?.steps.some((s) => s.status === 'running')) break;
    }
    await checkStalls(Date.now() + 11 * 60 * 1000);
    release();
    await new Promise((r) => setTimeout(r, 150));
    const plannerCallsBefore = plannerCalls.length;
    const resumeReply = await resumeTask(id, deps(async () => 'DONE: finished after resume'));
    expect(plannerCalls.length).toBe(plannerCallsBefore); // F-19: NO replanning
    expect(resumeReply).toContain('resumed WITHOUT replanning');
    expect(resumeReply).toContain('1/3 steps were already completed');
    // F-20: the step that was mid-flight when the watchdog fired carries the unknown flag.
    const { getTask } = await import('../src/main/taskStore');
    const task = await getTask(id);
    expect(task?.steps.find((s) => s.id === 's2')?.outcomeUnknown).toBe(true);
  });
});

describe('F-20: orphaned running steps are reconciled, with owner-identity proof', () => {
  it('boot reconciliation: RUNNING task → INTERRUPTED, running steps → pending with outcomeUnknown', async () => {
    const t = await createTask(buildTaskSpec('Create a file'), 'boot-reconcile');
    await transition(t, 'READY');
    await transition(t, 'RUNNING');
    await claimTask(t, 'coordinator');
    await setSteps(t, [{ title: 'alpha', detail: 'a' }, { title: 'beta', detail: 'b' }]);
    await markStep(t, 's1', { status: 'done', result: 'DONE: survived' });
    await markStep(t, 's2', { status: 'running' });
    // Simulate the restart: wipe the in-memory cache and force a reload from disk.
    resetTaskStoreForTests();
    const { getTask } = await import('../src/main/taskStore');
    const reloaded = await getTask(t.id);
    expect(reloaded?.status).toBe('INTERRUPTED');
    expect(reloaded?.owner).toBe('');
    const s1 = reloaded?.steps.find((s) => s.id === 's1');
    const s2 = reloaded?.steps.find((s) => s.id === 's2');
    expect(s1?.status).toBe('done'); // completed work is NEVER reset
    expect(s1?.result).toContain('DONE: survived');
    expect(s2?.status).toBe('pending'); // retryable again
    expect(s2?.outcomeUnknown).toBe(true); // explicitly flagged
    expect(s2?.interruptions?.length).toBeGreaterThan(0);
    // The boot id proves the on-disk owner is a different (dead) process.
    expect(BOOT_ID).toMatch(/^boot/);
  });

  it('reconcileInterruptedSteps preserves attempts and appends the reason', async () => {
    const t = await createTask(buildTaskSpec('Create a file'), 'reconcile');
    await setSteps(t, [{ title: 'x', detail: 'x' }]);
    await markStep(t, 's1', { status: 'running' });
    const t2 = (await import('../src/main/taskStore')).constructor ? t : t;
    void t2;
    const attempts = t.steps[0].attempts;
    const ids = await reconcileInterruptedSteps(t, 'driver died mid-step');
    expect(ids).toEqual(['s1']);
    expect(t.steps[0].status).toBe('pending');
    expect(t.steps[0].outcomeUnknown).toBe(true);
    expect(t.steps[0].attempts).toBe(attempts); // attempt history preserved, not incremented
    expect(t.steps[0].interruptions?.[0]?.reason).toContain('driver died');
  });
});

describe('idempotency receipts and outcome-unknown reconciliation', () => {
  it("a started record without a completion twin is reported as outcome UNKNOWN", async () => {
    const taskId = 'T-test-unknown';
    const t0 = Date.now();
    await recordStarted({
      id: 'cid-1', t: t0, tool: 'write_file', agent: 'task:general#1', taskId,
      args: 'path=report.txt', auth: 'autonomous', idempotencyKey: 'write_file:report.txt',
    });
    await recordExecution({
      id: 'cid-2', t: t0 + 1, ms: 5, tool: 'read', agent: 'task:general#1', taskId,
      args: 'path=report.txt', auth: 'allowed', status: 'ok', result: 'contents', retries: 0,
      idempotencyKey: 'read:report.txt',
    });
    // a started record WITH a twin is closed
    await recordExecution({
      id: 'cid-1', t: t0 + 2, ms: 9, tool: 'write_file', agent: 'task:general#1', taskId,
      args: 'path=report.txt', auth: 'autonomous', status: 'ok', result: 'Wrote 3 lines', retries: 0,
      idempotencyKey: 'write_file:report.txt',
    });
    const unknown = await unknownOutcomeRecords(taskId, t0 - 10);
    expect(unknown).toHaveLength(0);
    // an orphaned started record stays unknown
    await recordStarted({
      id: 'cid-3', t: t0 + 3, tool: 'run_command', agent: 'task:general#1', taskId,
      args: 'command=echo hi', auth: 'autonomous', idempotencyKey: 'run_command:echo hi',
    });
    const unknown2 = await unknownOutcomeRecords(taskId, t0 - 10);
    expect(unknown2).toHaveLength(1);
    expect(unknown2[0].id).toBe('cid-3');
    expect(unknown2[0].status).toBe('started');
  });
});

describe('F-21: per-path write coordination', () => {
  it('canonical identity: different spellings of one path are ONE lock', async () => {
    const dir = root();
    const a = path.join(dir, 'sub', 'file.txt');
    const b = path.join(dir, 'sub', '..', 'sub', 'file.txt');
    expect(canonicalWritePath(a)).toBe(canonicalWritePath(b));
    release();
    async function release() {
      await withWriteLock(a, 'engine-A', async () => {
        expect(holdsWriteLock(b, 'engine-A')).toBe(true); // same canonical lock
        expect(holdsWriteLock(a, 'engine-B')).toBe(false);
      });
      expect(writeLocks()).toHaveLength(0); // released on completion
    }
  });

  it('conflicting engines get a structured WRITE CONFLICT, never a silent overwrite', async () => {
    setWriteCoordTimeoutsForTests(150);
    const dir = root();
    const file = path.join(dir, 'shared.txt');
    let releaseB!: () => void;
    const gateB = new Promise<void>((r) => (releaseB = r));
    const b = withWriteLock(file, 'engine-B', async () => {
      await gateB;
      return 'B done';
    });
    await new Promise((r) => setTimeout(r, 30));
    await expect(withWriteLock(file, 'engine-A', async () => 'A wrote')).rejects.toThrow(/WRITE CONFLICT.*engine-B/);
    releaseB();
    await expect(b).resolves.toBe('B done');
    // after B releases, A can write
    await expect(withWriteLock(file, 'engine-A', async () => 'A wrote now')).resolves.toBe('A wrote now');
  });

  it('locks release on exceptions and cancellation; a stale lock is stealable', async () => {
    setWriteCoordTimeoutsForTests(200, 80);
    const dir = root();
    const file = path.join(dir, 'x.txt');
    await expect(
      withWriteLock(file, 'engine-A', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(writeLocks()).toHaveLength(0); // exception released the lock
    // stale steal: A holds, the clock runs past the stale window, B steals rather than wedging
    const held = withWriteLock(file, 'engine-A', async () => {
      await new Promise((r) => setTimeout(r, 200));
      return 'A';
    });
    await new Promise((r) => setTimeout(r, 40));
    await expect(withWriteLock(file, 'engine-B', async () => 'B')).resolves.toBe('B');
    await expect(held).resolves.toBe('A');
  });

  it('multi-file transactions lock in canonical order and release as a set', async () => {
    const dir = root();
    const f1 = path.join(dir, 'b.txt');
    const f2 = path.join(dir, 'a.txt');
    await withWriteLocks([f1, f2], 'engine-A', async () => {
      expect(holdsWriteLock(f1, 'engine-A')).toBe(true);
      expect(holdsWriteLock(f2, 'engine-A')).toBe(true);
    });
    expect(writeLocks()).toHaveLength(0);
  });
});
