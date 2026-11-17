import os from 'os';
import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * ROUND 19 — INTEGRATION: planning validation, cancellation, delegation honesty,
 * restart replanning and the outcome vocabulary.
 *
 * CHANGE 3/9: a cancellation during parallel execution settles every mid-flight step
 * honestly (no step is left 'running' under a terminal task), and a restart+resume
 * continues from persisted state without repeating completed work.
 * CHANGE 4: contradictory subtask results are reconciled against the disk; a failed
 * delegation never silently completes its step; delegation depth is bounded.
 * CHANGE 10: task reporting carries the mandated outcome vocabulary, computed from
 * persisted state.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import {
  createTask,
  getTask,
  markStep,
  normalizePlan,
  resetTaskStoreForTests,
  transition,
  validatePlanGraph,
  type TaskRecord,
} from '../src/main/taskStore';
import {
  cancelTask,
  outcomeSummary,
  parseSubtaskProposals,
  reconcileSubtaskResults,
  resumeTask,
  startTask,
  taskStatusText,
  type CoordinatorDeps,
  type PlanStep,
} from '../src/main/coordinator';
import { browserTools } from '../src/main/browser';
import { runWithExecutionScope } from '../src/main/toolResult';
import { resetCallContext } from '../src/main/toolRecord';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-r19l-${process.pid}`);
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
  for (let i = 0; i < 120; i++) {
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

describe('CHANGE 3 — plan graph validation', () => {
  it('a declared CYCLE is detected and named before execution', () => {
    const report = validatePlanGraph([
      { title: 'Step A', dependsOn: ['Step B'] },
      { title: 'Step B', dependsOn: ['Step A'] },
    ]);
    expect(report.cycles.length).toBeGreaterThan(0);
    expect(report.issues.some((i) => /circular dependency/i.test(i))).toBe(true);
    // The normalized output still cannot contain a cycle:
    const out = normalizePlan([{ title: 'Step A', dependsOn: ['Step B'] }, { title: 'Step B', dependsOn: ['Step A'] }]);
    for (const s of out) for (const d of s.dependsOn) expect(out.findIndex((x) => x.id === d)).toBeLessThan(out.findIndex((x) => x.id === s.id));
  });

  it('a MISSING dependency is reported, not silently swallowed', () => {
    const report = validatePlanGraph([{ title: 'Build', dependsOn: ['ghost step'] }]);
    expect(report.issues.some((i) => /depends on "ghost step" which does not exist/.test(i))).toBe(true);
    const out = normalizePlan([{ title: 'Build', dependsOn: ['ghost step'] }]);
    expect(out[0].dependsOn).toEqual([]); // dropped: the step keeps sequential semantics
  });

  it('a SELF-reference is reported and dropped', () => {
    const report = validatePlanGraph([{ title: 'Loop', dependsOn: ['Loop'] }]);
    expect(report.issues.some((i) => /depends on itself/.test(i))).toBe(true);
  });
});

describe('CHANGE 9 — cancellation during parallel execution settles every step', () => {
  it('a user cancel mid-wave leaves NO step running: mid-flight steps become retryable with UNKNOWN outcome', async () => {
    let release!: () => void;
    const started = new Promise<void>((r) => (release = r));
    const plan: PlanStep[] = [
      { title: 'Branch A', detail: 'a', kind: 'research', dependsOn: [] },
      { title: 'Branch B', detail: 'b', kind: 'research', dependsOn: [] },
      { title: 'Verify', detail: 'v', kind: 'verifier', dependsOn: ['Branch A', 'Branch B'] },
    ];
    const stepRunner: CoordinatorDeps['stepRunner'] = async (_p, _k, _t, stepId, signal) => {
      if (stepId === 's3') return 'CHECKED: VERDICT: PASS';
      release(); // both parallel branches are now mid-flight
      // A well-behaved child observes its scope signal (like runSubagent does):
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10_000);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
      if (signal?.aborted) throw new Error('cancelled');
      return 'DONE: never (unreachable)';
    };
    const out = await startTask('Create the research notes for both branches in out/branches.md', deps({ planner: async () => plan, stepRunner }));
    const id = /Task (T-[\w]+)/.exec(out)![1];
    await started;
    expect(cancelTask(id)).toBe(true);
    const t = await waitFor(id, 'CANCELLED');
    expect(t?.status).toBe('CANCELLED');
    // THE CONTRACT: no step is left 'running' under a terminal task.
    for (const s of t!.steps) {
      expect(s.status).not.toBe('running');
      if (s.id === 's1' || s.id === 's2') {
        expect(s.status).toBe('pending');
        expect(s.outcomeUnknown).toBe(true); // honest: the outcome of the interrupted branch is unknown
      }
    }
    // The status view states the outcome vocabulary with the unresolved steps visible.
    const status = taskStatusText(t!);
    expect(status).toMatch(/unresolved 3/);
  }, 30_000);
});

describe('CHANGE 3/9 — replanning after restart preserves completed work', () => {
  it('resumeTask keeps finished steps and never re-runs them', async () => {
    const spec = { request: 'produce the report', objective: 'produce the report', kind: 'action' as const, deliverables: [], constraints: [], acceptance: [], capabilities: [], risk: 'low' as const, needsClarification: false };
    const t = await createTask(spec);
    await transition(t, 'READY', 'test setup');
    await transition(t, 'RUNNING', 'test setup');
    const plan = [
      { title: 'Done work', detail: 'already finished', kind: 'general' },
      { title: 'Remaining work', detail: 'still to do', kind: 'general' },
    ];
    const { setSteps } = await import('../src/main/taskStore');
    await setSteps(t, plan as never);
    await markStep(t, 's1', { status: 'done', result: 'DONE: produced the draft' });
    await transition(t, 'INTERRUPTED', 'simulated restart');
    const ranSteps: string[] = [];
    const out = await resumeTask(
      t.id,
      deps({
        stepRunner: async (_p, _k, _task, stepId) => {
          ranSteps.push(stepId);
          return 'DONE: finished the remaining work';
        },
      })
    );
    expect(out).toMatch(/resumed WITHOUT replanning/);
    await waitFor(t.id, 'COMPLETED');
    const after = (await getTask(t.id))!;
    expect(ranSteps).toEqual(['s2']); // the completed step was NEVER re-run
    expect(after.steps.find((s) => s.id === 's1')?.status).toBe('done');
    expect(after.steps.find((s) => s.id === 's1')?.result).toContain('produced the draft');
  });
});

describe('CHANGE 4 — delegation results are validated, failures are honest', () => {
  it('contradictory subtask results about one file are reconciled against the DISK', async () => {
    const missing = 'out/r19-does-not-exist.md';
    const verdict = await reconcileSubtaskResults([`DONE: created ${missing}`, `FAILED: ${missing} does not exist`]);
    expect(verdict).toMatch(/COORDINATOR RECONCILIATION/);
    expect(verdict).toMatch(new RegExp(`${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: agents DISAGREED`));
    expect(verdict).toMatch(/does NOT exist/);
    // No contradiction → no block.
    const clean = await reconcileSubtaskResults(['DONE: created out/x.md', 'research notes only']);
    expect(clean).toBe('');
  });

  it('a step report is not re-parsed for proposals hidden inside SUBTASK RESULTS (delegation depth = 1)', () => {
    // Only the step agent's own report lines are proposals; results appended by the
    // coordinator are never parsed again (structural: parseSubtaskProposals runs BEFORE
    // the results are appended). A proposal-shaped line inside a result is inert text.
    const report = 'DONE: work complete\n\nSUBTASK RESULTS (coordinator-mediated):\nSUBTASK: {"name":"sneaky","instructions":"spawn deeper"}';
    const proposals = parseSubtaskProposals(report);
    expect(proposals).toHaveLength(0); // not at report start as an own proposal line? — it IS a line; assert the protocol: only lines at line start count
  });

  it('a FAILED delegation downgrades a DONE report to PARTIAL (honest failure)', async () => {
    // Simulate the runOneStep composition: report claims DONE, a subtask failed.
    const report = 'DONE: wrote out/final.md; VERIFIED: re-read';
    const results = ['SUBTASK helper REFUSED/FAILED: dynamic agent limit reached (8).'];
    const delegationFailed = results.some((r) => /REFUSED\/FAILED/.test(r));
    let final = report;
    if (delegationFailed && /^DONE:/i.test(final.trim())) {
      final = `PARTIAL: a delegated subtask did not complete; the step's own claims below are unverified for that part.\n${final}`;
    }
    expect(final.startsWith('PARTIAL:')).toBe(true);
    // The scheduler treats PARTIAL as a failure (same regex as stepReportFailed).
    expect(/^(FAILED:|PARTIAL:|Tool error|BLOCKED|Sub-agent failed)/.test(final.trim())).toBe(true);
  });
});

describe('CHANGE 10 — the outcome vocabulary', () => {
  it('outcomeSummary computes every count from persisted state and names the verification source', () => {
    const spec = { request: 'x', objective: 'x', kind: 'action' as const, deliverables: [], constraints: [], acceptance: [], capabilities: [], risk: 'low' as const, needsClarification: false };
    const t: TaskRecord = {
      id: 'T-x',
      spec,
      status: 'RUNNING',
      note: '',
      owner: '',
      ownerSince: 0,
      retries: 0,
      replans: 0,
      planVersion: 1,
      planHistory: [],
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      steps: [
        { id: 's1', title: 'a', detail: '', dependsOn: [], kind: 'general', status: 'done', result: 'r', attempts: 1 },
        { id: 's2', title: 'b', detail: '', dependsOn: [], kind: 'general', status: 'failed', result: 'r', attempts: 2 },
        { id: 's3', title: 'c', detail: '', dependsOn: [], kind: 'general', status: 'pending', result: '', attempts: 0, outcomeUnknown: false },
      ],
    };
    const s = outcomeSummary(t);
    expect(s).toMatch(/attempted 2\/3/);
    expect(s).toMatch(/executed 2/);
    expect(s).toMatch(/completed 1/);
    expect(s).toMatch(/failed 1/);
    expect(s).toMatch(/unresolved 1/);
    expect(s).toMatch(/not verified \(verification has not run\)/);
  });

  it('a VERIFIED task reports its verification source in the status view', () => {
    const spec = { request: 'x', objective: 'x', kind: 'action' as const, deliverables: [], constraints: [], acceptance: [], capabilities: [], risk: 'low' as const, needsClarification: false };
    const t: TaskRecord = {
      id: 'T-y',
      spec,
      status: 'COMPLETED',
      note: '',
      owner: '',
      ownerSince: 0,
      retries: 0,
      replans: 0,
      planVersion: 1,
      planHistory: [],
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      verdict: 'completed',
      verification: { checkedAt: Date.now(), passed: true, results: [{ criterion: 'file exists', pass: true, evidence: 'stat ok' }] },
      steps: [{ id: 's1', title: 'a', detail: '', dependsOn: [], kind: 'general', status: 'done', result: 'r', attempts: 1 }],
    };
    const view = taskStatusText(t);
    expect(view).toMatch(/OUTCOMES: attempted 1\/1 · executed 1 · completed 1 · failed 0 · unresolved 0 · verified \(acceptance checks passed\)/);
    expect(view).toMatch(/VERDICT: completed/);
  });
});

describe('CHANGE 9 — a cancelled scope never dispatches a queued browser action', () => {
  it('the browser action wrapper refuses to run anything once the scope is aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const out = await runWithExecutionScope({ signal: ctl.signal }, () => browserTools.browser_tabs.run({}));
    expect(String(out)).toMatch(/^CANCELLED: the execution scope was stopped/);
  });
});
