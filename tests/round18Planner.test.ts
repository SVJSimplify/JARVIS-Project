import os from 'os';
import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * ROUND 18 PRIORITY THREE — DEPENDENCY-AWARE PLANNER (mandate §5).
 *
 * Pins the corrected plan/execution semantics:
 *   - plans are DAGs: normalizePlan defaults to sequential, honors EXPLICIT dependsOn
 *     (the parallel-eligibility signal), maps title references, and cannot form cycles;
 *   - independent eligible steps run CONCURRENTLY (bounded by MAX_PARALLEL_STEPS=2);
 *   - a failed step blocks only its dependent branch — unrelated branches complete;
 *   - adaptive replanning rebuilds the remaining plan PRESERVING completed work, once;
 *   - expectedOutput reaches the step brief; retryMax is a per-step policy.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import {
  createTask,
  getTask,
  resetTaskStoreForTests,
  setSteps,
  transition,
  normalizePlan,
  replanSteps,
  type TaskRecord,
} from '../src/main/taskStore';
import { startTask, type CoordinatorDeps, type PlanStep } from '../src/main/coordinator';
import { recordExecution, resetCallContext, setCallContext } from '../src/main/toolRecord';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-r18p-${process.pid}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetTaskStoreForTests();
  resetCallContext();
  fs.rmSync(path.join(ROOT, 'brain', 'tasks'), { recursive: true, force: true });
});

afterEach(() => {
  resetCallContext();
});

const waitFor = async (id: string, status: string): Promise<TaskRecord | undefined> => {
  for (let i = 0; i < 100; i++) {
    const t = await getTask(id);
    if (t?.status === status) return t;
    await sleep(50);
  }
  return await getTask(id);
};

const deps = (overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps => ({
  run: async () => 'OK',
  schemas: () => [],
  ...overrides,
});

describe('normalizePlan — the plan DAG (§5.1)', () => {
  it('absent dependsOn = sequential chain; explicit [] = independent (parallel-eligible)', () => {
    const out = normalizePlan([
      { title: 'a' }, // no dependsOn: sequential
      { title: 'b' }, // no dependsOn: depends on a
      { title: 'c', dependsOn: [] }, // EXPLICIT: independent
    ]);
    expect(out.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(out[1].dependsOn).toEqual(['s1']);
    expect(out[2].dependsOn).toEqual([]);
  });

  it('dependency references by TITLE map to ids; references to LATER steps are dropped (no cycles)', () => {
    const out = normalizePlan([
      { title: 'Time travel', dependsOn: ['Build the sheet'] }, // forward edge: dropped
      { title: 'Build the sheet' },
      { title: 'Research competitors', id: 'research' },
      { title: 'Polish', dependsOn: ['Build the sheet', 'research'] }, // backward edges: kept
    ]);
    expect(out[0].id).toBe('s1');
    expect(out[0].dependsOn).toEqual([]); // forward reference removed — DAG by construction
    expect(out[3].dependsOn).toEqual(['s2', 'research']);
  });

  it('planner ids are preserved; duplicate ids get fresh unique ones', () => {
    const out = normalizePlan([
      { title: 'one', id: 'scan' },
      { title: 'two', id: 'scan' }, // duplicate: re-id'd
      { title: 'three', dependsOn: ['scan'] },
    ]);
    expect(new Set(out.map((s) => s.id)).size).toBe(3);
    expect(out[2].dependsOn).toEqual(['scan']); // the FIRST scan
    expect(out[2].dependsOn).not.toContain(out[1].id);
  });
});

describe('parallel waves (§5.2) and dependency enforcement (§5.3)', () => {
  it('two independent steps run CONCURRENTLY; the dependent step waits for BOTH', async () => {
    const file = path.join(ROOT, 'out', 'rivals.md');
    const inside = new Set<string>();
    let maxInside = 0;
    const startOrder: string[] = [];
    const finishOf: Record<string, number> = {};
    const plan: PlanStep[] = [
      { title: 'Research A', detail: 'research branch A', kind: 'research', dependsOn: [] },
      { title: 'Research B', detail: 'research branch B', kind: 'research', dependsOn: [] },
      { title: 'Build the sheet', detail: 'write the comparison', kind: 'general', dependsOn: ['Research A', 'Research B'] },
      { title: 'Verify the result', detail: 'check it', kind: 'verifier', dependsOn: ['Build the sheet'] },
    ];
    const stepRunner: CoordinatorDeps['stepRunner'] = async (_p, _k, t, stepId) => {
      startOrder.push(stepId);
      if (stepId === 's3') {
        // the dependent build step: only now may the deliverable be produced
        const a = t.steps.find((s) => s.id === 's1');
        const b = t.steps.find((s) => s.id === 's2');
        expect(a?.status).toBe('done');
        expect(b?.status).toBe('done');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'A vs B: side-by-side complete');
        setCallContext({ agent: 'task:general#1', taskId: t.id, stepId });
        await recordExecution({
          id: `w-${stepId}`,
          t: Date.now(),
          ms: 2,
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
        return 'DONE: wrote out/compare.md; VERIFIED: re-read; ISSUES: none';
      }
      if (stepId === 's4') return 'CHECKED: file exists PASS; VERDICT: PASS';
      inside.add(stepId);
      maxInside = Math.max(maxInside, inside.size);
      await sleep(120); // long enough that the sibling MUST overlap if scheduling is parallel
      inside.delete(stepId);
      finishOf[stepId] = Date.now();
      return 'DONE: research notes; VERIFIED: sources listed; ISSUES: none';
    };
    const out = await startTask('Create the side-by-side product notes in out/rivals.md', deps({ planner: async () => plan, stepRunner }));
    const id = /Task (T-[\w]+)/.exec(out)![1];
    const t = await waitFor(id, 'COMPLETED');
    expect(t?.status).toBe('COMPLETED');
    expect(maxInside).toBe(2); // §5.2: independent research ran concurrently (and only 2 — the bound)
    // Dependency enforcement: the build step started strictly after BOTH research steps finished.
    const s3Start = startOrder.indexOf('s3');
    expect(s3Start).toBeGreaterThan(startOrder.lastIndexOf('s1'));
    expect(s3Start).toBeGreaterThan(startOrder.lastIndexOf('s2'));
    expect(fs.readFileSync(file, 'utf8')).toContain('side-by-side complete');
  });

  it('a failed step blocks ONLY its dependent branch; unrelated branches still complete', async () => {
    const calls: string[] = [];
    const plan: PlanStep[] = [
      { title: 'Broken branch', detail: 'this one fails', kind: 'general', dependsOn: [] },
      { title: 'Healthy branch', detail: 'this one succeeds', kind: 'general', dependsOn: [] },
      { title: 'Dependent step', detail: 'needs the broken branch', kind: 'general', dependsOn: ['Broken branch'] },
    ];
    const stepRunner: CoordinatorDeps['stepRunner'] = async (_p, _k, _t, stepId) => {
      calls.push(stepId);
      if (stepId === 's1') return 'FAILED: the required source file does not exist.';
      return 'DONE: branch complete; VERIFIED: re-read; ISSUES: none';
    };
    const out = await startTask('Create the branch isolation notes in out/branch.md', deps({ planner: async () => plan, stepRunner }));
    const id = /Task (T-[\w]+)/.exec(out)![1];
    const t = await waitFor(id, 'FAILED');
    expect(t?.status).toBe('FAILED');
    // §5.3: the healthy branch ran to completion despite the broken branch.
    const healthy = t!.steps.find((s) => s.title === 'Healthy branch');
    expect(healthy?.status).toBe('done');
    expect(calls.filter((c) => c === 's2')).toEqual(['s2']);
    // the broken branch retried once, and its dependent NEVER ran
    expect(calls.filter((c) => c === 's1')).toEqual(['s1', 's1']);
    // Round 20 (CHANGE 4): the dependent is marked SKIPPED with the reason — it can never
    // run in this plan version; 'pending' was the old shape that read as merely not-yet-run.
    expect(t!.steps.find((s) => s.title === 'Dependent step')?.status).toBe('skipped');
  });
});

describe('adaptive replanning (§5.5)', () => {
  it('a failed strategy is replanned ONCE with completed work preserved; the task then completes', async () => {
    const file = path.join(ROOT, 'out', 'rescue.md');
    const calls: string[] = [];
    let sawFailedContext: string | null = null;
    const initial: PlanStep[] = [
      { title: 'Try the doomed approach', detail: 'will fail', kind: 'general', dependsOn: [] },
      { title: 'Verify the result', detail: 'check it', kind: 'verifier', dependsOn: ['Try the doomed approach'] },
    ];
    const stepRunner: CoordinatorDeps['stepRunner'] = async (_p, _k, t, stepId) => {
      calls.push(`${t.planVersion}:${stepId}`);
      if (t.planVersion === 1 && stepId === 's1') return 'FAILED: the API endpoint no longer exists.';
      if (t.planVersion >= 2 && stepId === 's1') {
        // the rescue plan's build step (it inherited the failed step's id)
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'rescued deliverable');
        setCallContext({ agent: 'task:general#9', taskId: t.id, stepId });
        await recordExecution({
          id: `w-${stepId}`,
          t: Date.now(),
          ms: 2,
          tool: 'write_file',
          agent: 'task:general#9',
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
        return 'DONE: produced the deliverable the other way; VERIFIED: re-read; ISSUES: none';
      }
      return 'CHECKED: deliverable exists PASS; VERDICT: PASS';
    };
    const replanner: NonNullable<CoordinatorDeps['replanner']> = async (t, failedStepsIn) => {
      sawFailedContext = failedStepsIn.map((s) => s.title).join(',');
      expect(t.steps.find((s) => s.title === 'Try the doomed approach')?.status).toBe('failed');
      return [
        { title: 'Rescue the deliverable the other way', detail: 'use the local cache instead', kind: 'general', dependsOn: [] },
        { title: 'Verify the result', detail: 'check it', kind: 'verifier', dependsOn: ['Rescue the deliverable the other way'] },
      ];
    };
    const out = await startTask('Create the rescued notes in out/rescue.md', deps({ planner: async () => initial, stepRunner, replanner }));
    const id = /Task (T-[\w]+)/.exec(out)![1];
    const t = await waitFor(id, 'COMPLETED');
    expect(t?.status).toBe('COMPLETED');
    expect(sawFailedContext).toContain('Try the doomed approach');
    expect(t!.replans).toBe(1); // bounded: exactly one adaptive replan
    expect(t!.planVersion).toBe(2);
    expect(t!.planHistory.some((h) => h.version === 2)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('rescued deliverable');
  });

  it('replanSteps preserves completed steps verbatim and never re-runs them', async () => {
    const t = await createTask({ kind: 'action', objective: 'demo', request: 'demo', deliverables: [], constraints: [], acceptance: [], capabilities: [], risk: 'low', needsClarification: false } as never);
    await setSteps(t, [
      { title: 'Done work', detail: 'x' },
      { title: 'Pending work', detail: 'y' },
    ]);
    const done = t.steps[0];
    await transition(t, 'READY', 'test');
    await transition(t, 'RUNNING', 'test');
    done.status = 'done';
    done.result = 'the finished artifact';
    const after = await replanSteps(t, [
      { title: 'Done work', detail: 'x' }, // same title: must keep its done status + result
      { title: 'Different strategy', detail: 'new way', dependsOn: [] },
    ]);
    const preserved = after.steps.find((s) => s.title === 'Done work');
    expect(preserved?.status).toBe('done');
    expect(preserved?.result).toBe('the finished artifact');
    expect(after.steps.find((s) => s.title === 'Different strategy')?.status).toBe('pending');
    expect(after.planVersion).toBe(2);
    expect(after.replans).toBe(1);
  });
});

describe('step-level policies (§5.1)', () => {
  it('expectedOutput reaches the step brief; retryMax: 0 means a single honest attempt', async () => {
    const prompts: string[] = [];
    const calls: string[] = [];
    const plan: PlanStep[] = [{ title: 'Only step', detail: 'do it', kind: 'general', dependsOn: [], expectedOutput: 'a saved file at out/single.md', retryMax: 0 }];
    const stepRunner: CoordinatorDeps['stepRunner'] = async (prompt, _k, _t, stepId) => {
      prompts.push(prompt);
      calls.push(stepId);
      return 'FAILED: not possible.';
    };
    const out = await startTask('Create the single notes in out/single.md', deps({ planner: async () => plan, stepRunner }));
    const id = /Task (T-[\w]+)/.exec(out)![1];
    await waitFor(id, 'FAILED');
    expect(prompts[0]).toContain('EXPECTED OUTPUT: a saved file at out/single.md');
    expect(calls).toEqual(['s1']); // retryMax 0: no retry round
  });
});
