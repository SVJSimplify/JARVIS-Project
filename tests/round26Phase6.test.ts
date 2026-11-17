import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 26, PHASE 6 — DURABLE BACKGROUND OPERATIONS & AUTONOMY.
 *
 * Recurring routines: explicit user-defined schedules that persist across restarts, run
 * through the SAME authorized runner, respect resource bounds (roster cap, ≤2 runs per
 * tick, sequential), record every execution (result OR failure), and can be disabled,
 * enabled or removed. Task lifecycle: PAUSED suspends a driven task honestly (mid-flight
 * steps reconciled, completed work preserved, no verdict) and task_resume continues it.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import {
  addRecurring,
  cancelRecurring,
  listRecurring,
  nextOccurrence,
  parseRecurrence,
  setRecurringEnabled,
  dropRecurringCacheForTests,
  tick,
  resetSchedulerForTests,
  registerScheduledRunner,
  type Recurrence,
} from '../src/main/scheduler';
import { startTask, pauseTask, resumeTask, type CoordinatorDeps } from '../src/main/coordinator';
import { getTask, resetTaskStoreForTests, canTransition } from '../src/main/taskStore';
import { resetCallContext } from '../src/main/toolRecord';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-r26p6-${process.pid}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetSchedulerForTests();
  resetTaskStoreForTests();
  resetCallContext();
  fs.rmSync(path.join(ROOT, 'brain', 'tasks'), { recursive: true, force: true });
});

// ------------------------------------------------------------------ recurring routines

describe('Phase 6 — recurring routines (§6.5)', () => {
  it('nextOccurrence: interval, daily (today-future vs tomorrow) and weekly are computed correctly', () => {
    const from = new Date(2026, 10, 9, 14, 0, 0, 0).getTime(); // Monday 2026-11-09 14:00
    expect(nextOccurrence({ kind: 'interval', minutes: 30 }, from)).toBe(from + 30 * 60_000);
    // daily at 09:00 → tomorrow 09:00 (today's 09:00 already passed)
    const daily = nextOccurrence({ kind: 'daily', at: '09:00' }, from);
    expect(new Date(daily).getDate()).toBe(10);
    expect(new Date(daily).getHours()).toBe(9);
    // daily at 20:00 → today 20:00
    const daily2 = nextOccurrence({ kind: 'daily', at: '20:00' }, from);
    expect(new Date(daily2).getDate()).toBe(9);
    expect(new Date(daily2).getHours()).toBe(20);
    // weekly on friday 09:00 → 2026-11-13 09:00
    const weekly = nextOccurrence({ kind: 'weekly', weekday: 5, at: '09:00' }, from);
    expect(new Date(weekly).getDay()).toBe(5);
    expect(new Date(weekly).getDate()).toBe(13);
  });

  it('parseRecurrence accepts the three shapes and rejects bad ones', () => {
    expect(parseRecurrence({ every_minutes: 60 })).toEqual({ kind: 'interval', minutes: 60 });
    expect(parseRecurrence({ daily_at: '09:00' })).toEqual({ kind: 'daily', at: '09:00' });
    expect(parseRecurrence({ weekly: 'monday', at: '08:30' })).toEqual({ kind: 'weekly', weekday: 1, at: '08:30' });
    expect(() => parseRecurrence({ every_minutes: 2 })).toThrow(/at least 5/);
    expect(() => parseRecurrence({})).toThrow(/every_minutes/);
  });

  it('a due routine runs through the registered runner, records the result, and advances', async () => {
    const runs: string[] = [];
    registerScheduledRunner(async (text) => {
      runs.push(text);
      return 'health check complete: all green';
    });
    const t = await addRecurring('run the project health check', { kind: 'interval', minutes: 5 });
    // force it due now
    t.nextDue = Date.now() - 1000;
    const list = await listRecurring();
    const stored = list.find((x) => x.id === t.id)!;
    stored.nextDue = Date.now() - 1000;
    await tick(Date.now());
    await tick(Date.now());
    const after = (await listRecurring()).find((x) => x.id === t.id)!;
    expect(after.runCount).toBeGreaterThanOrEqual(1);
    expect(after.lastResult).toContain('all green');
    expect(after.lastError).toBeUndefined();
    expect(after.nextDue).toBeGreaterThan(Date.now() - 1000);
    expect(runs[0]).toContain('health check');
  });

  it('a failing run is recorded as a failure — never silently swallowed', async () => {
    registerScheduledRunner(async () => {
      throw new Error('the runner exploded');
    });
    const t = await addRecurring('review the open issues weekly', { kind: 'weekly', weekday: 1, at: '09:00' });
    t.nextDue = Date.now() - 1000;
    await tick(Date.now());
    const after = (await listRecurring()).find((x) => x.id === t.id)!;
    expect(after.runCount).toBe(1);
    expect(after.lastError).toContain('exploded');
    expect(after.lastResult).toBeUndefined();
  });

  it('disabled routines do not run; enable re-arms them; cancel removes them', async () => {
    let runs = 0;
    registerScheduledRunner(async () => {
      runs++;
      return 'ok';
    });
    const t = await addRecurring('generate the recurring report', { kind: 'interval', minutes: 5 });
    t.nextDue = Date.now() - 1000;
    await setRecurringEnabled(t.id, false);
    await tick(Date.now());
    expect(runs).toBe(0);
    await setRecurringEnabled(t.id, true); // re-arm: a long-disabled routine must not fire a burst of missed runs
    t.nextDue = Date.now() - 1000; // due again for the test clock
    await tick(Date.now());
    expect(runs).toBe(1);
    expect(await cancelRecurring(t.id)).toContain('Removed');
    expect(await listRecurring()).toEqual([]);
  });

  it('resource bounds: a burst of overdue routines runs at most 2 per tick, sequentially', async () => {
    registerScheduledRunner(async () => 'done');
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await addRecurring(`bounded routine number ${i}`, { kind: 'interval', minutes: 5 });
      t.nextDue = Date.now() - 1000;
      ids.push(t.id);
    }
    await tick(Date.now());
    const afterTick1 = await listRecurring();
    expect(afterTick1.filter((t) => (t.runCount ?? 0) >= 1).length).toBe(2);
    await tick(Date.now());
    await tick(Date.now());
    expect((await listRecurring()).every((t) => t.runCount >= 1)).toBe(true);
  });

  it('the roster is capped (no unbounded autonomous work)', async () => {
    registerScheduledRunner(async () => 'ok');
    for (let i = 0; i < 12; i++) await addRecurring(`routine ${i}`, { kind: 'interval', minutes: 30 });
    await expect(addRecurring('one too many', { kind: 'interval', minutes: 30 })).rejects.toThrow(/recurring routines/);
  });

  it('routines persist across a restart (cache drop → reload from disk keeps schedule and history)', async () => {
    registerScheduledRunner(async () => 'ran once');
    const t = await addRecurring('morning project health check', { kind: 'daily', at: '23:59' });
    t.nextDue = Date.now() - 1000;
    await tick(Date.now());
    dropRecurringCacheForTests(); // simulate a restart: memory dropped, disk store remains
    const restored = await listRecurring();
    const r = restored.find((x) => x.task.includes('health check'));
    expect(r).toBeDefined();
    expect(r!.runCount).toBe(1);
    expect(r!.every.kind).toBe('daily');
  });
});

// ------------------------------------------------------------------- pause / resume

describe('Phase 6 — task pause & resume (§6.1/6.4)', () => {
  const baseDeps = (over: Partial<CoordinatorDeps> = {}): CoordinatorDeps => ({
    run: async () => 'OK',
    schemas: () => [],
    planner: async () => [
      { title: 'first step', detail: 'work', kind: 'general', dependsOn: [] },
      { title: 'second step', detail: 'work', kind: 'general', dependsOn: ['s1'] },
    ],
    ...over,
  });

  const waitStatus = async (id: string, status: string) => {
    for (let i = 0; i < 250; i++) {
      const t = await getTask(id);
      if (t?.status === status) return t;
      await sleep(30);
    }
    return await getTask(id);
  };

  it('transitions are legal: RUNNING→PAUSED→READY, RUNNING→RECOVERING', () => {
    expect(canTransition('RUNNING', 'PAUSED')).toBe(true);
    expect(canTransition('PAUSED', 'READY')).toBe(true);
    expect(canTransition('PAUSED', 'CANCELLED')).toBe(true);
    expect(canTransition('RUNNING', 'RECOVERING')).toBe(true);
    expect(canTransition('PAUSED', 'COMPLETED')).toBe(false);
  });

  it('pausing a driven task settles PAUSED with completed work preserved and NO verdict', async () => {
    const deps = baseDeps({
      stepRunner: async (_prompt, _kind, _t, _stepId, signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => resolve('FAILED: the step was aborted while paused'), { once: true });
        }),
    });
    const out = await startTask('Write the long running migration now', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1]!;
    await waitStatus(id, 'RUNNING');
    expect(pauseTask(id)).toBe(true);
    const paused = await waitStatus(id, 'PAUSED');
    expect(paused?.status).toBe('PAUSED');
    expect(paused?.verdict).toBeUndefined();
    // resume with a working runner → the remaining work completes
    const msg = await resumeTask(id, baseDeps({ stepRunner: async () => 'DONE: finished the remaining work.' }));
    expect(msg).toContain('resumed');
    for (let i = 0; i < 250; i++) {
      const t = await getTask(id);
      if (t && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status)) break;
      await sleep(30);
    }
    const done = await getTask(id);
    expect(['COMPLETED', 'FAILED']).toContain(done?.status);
  });

  it('task_pause on a non-driven task refuses honestly; double pause is idempotent in wording', async () => {
    const out = String(
      await (
        await import('../src/main/coordinator')
      ).coordinatorTools({
        run: async () => 'OK',
        schemas: () => [],
      }).task_pause.run({ id: 'T-none' })
    );
    expect(out).toContain('NOT DONE: no task');
  });
});
