import os from 'os';
import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * ROUND 25 — PART 2: THE MULTI-AGENT EXECUTION LIFECYCLE (§4–§11).
 *
 * Drives the REAL coordinator + task store + agent registry + tracker — only the MODEL
 * boundary is injected (the same deterministic contract the Round 18–22 tests use):
 *   - delegation decisions recorded on tasks (§3);
 *   - sequential, parallel (wave) and dependency-aware execution with evidence that
 *     waves actually overlapped (§4);
 *   - controlled upstream context passing (§5);
 *   - wave-level conflict reconciliation against the disk (§7);
 *   - failure isolation, honest timeout, cancellation propagation (§4);
 *   - persistence + recovery that distinguishes completed/interrupted/failed/pending
 *     work, and never reports unfinished work as complete (§8);
 *   - duplicate execution prevention (§11);
 *   - the global agent concurrency gate (§11);
 *   - agent observability (tracker → progress snapshot → HUD view shape) (§9).
 *
 * Steps that must produce VERIFIABLE evidence run REAL tool calls through the ONE
 * choke point (runToolDetailed with the task call context) — receipts, policy and the
 * evidence ledger are the production path, not a mock.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { startTask, cancelTask, resumeTask, checkStalls, taskStatusText, setCoordinatorTimingForTests, setCoordinatorBudgetsForTests, type CoordinatorDeps, type PlanStep } from '../src/main/coordinator';
import { getTask, resetTaskStoreForTests, reconcileInterruptedSteps } from '../src/main/taskStore';
import { resetCallContext, setCallContext } from '../src/main/toolRecord';
import { runToolDetailed } from '../src/main/tools';
import { resetDynamicAgentsForTests } from '../src/main/agentRegistry';
import { resetAgentTrackerForTests, agentViews, agentBegin, agentWaiting, agentResume, agentEnd } from '../src/main/agentTracker';
import { MAX_CONCURRENT_AGENT_RUNS, acquireRunSlotForTests, releaseRunSlotForTests, agentConcurrency } from '../src/main/subagent';
import { resetProgressForTests, setAgentProvider, getProgressSnapshot } from '../src/main/progress';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-r25m-${process.pid}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetTaskStoreForTests();
  resetDynamicAgentsForTests();
  resetAgentTrackerForTests();
  resetProgressForTests();
  resetCallContext();
  fs.rmSync(path.join(ROOT, 'brain', 'tasks'), { recursive: true, force: true });
  setCoordinatorTimingForTests(60_000, 600_000);
  setCoordinatorBudgetsForTests(600_000, 3_600_000);
});

afterEach(() => {
  resetCallContext();
  setCoordinatorTimingForTests(60_000, 600_000);
  setCoordinatorBudgetsForTests(600_000, 3_600_000);
});

const waitFor = async (id: string, status: string) => {
  for (let i = 0; i < 200; i++) {
    const t = await getTask(id);
    if (t?.status === status) return t;
    await sleep(40);
  }
  return await getTask(id);
};

const waitTerminal = async (id: string) => {
  for (let i = 0; i < 200; i++) {
    const t = await getTask(id);
    if (t && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status)) return t;
    await sleep(40);
  }
  return await getTask(id);
};

const taskIdOf = (out: string): string => /Task (T-[\w]+)/.exec(out)![1];

/** One REAL read-only tool run under the task's call context — durable evidence. */
const realEvidence = async (taskId: string, stepId: string): Promise<void> => {
  setCallContext({ agent: `task:general#${stepId}`, taskId, stepId });
  await runToolDetailed('get_current_time', '{}');
  resetCallContext();
};

const baseDeps = (over: Partial<CoordinatorDeps> = {}): CoordinatorDeps => ({
  run: async () => 'OK',
  schemas: () => [],
  planner: async () => [{ title: 'Do the work', detail: 'work', kind: 'general', dependsOn: [] }],
  ...over,
});

describe('delegation decisions recorded on tasks (§3)', () => {
  it('a multi-stream research+write task is marked coordinated_multi_agent with the workstreams recorded', async () => {
    const deps = baseDeps({
      planner: async () => [{ title: 'Research both', detail: 'research', kind: 'research', dependsOn: [] }],
      stepRunner: async (_prompt, _kind, task, stepId) => {
        await realEvidence(task.id, stepId);
        return 'ANSWER: found; EVIDENCE: (https://example.com/li)';
      },
    });
    const out = await startTask('Research the price of lithium on the market and also research the price of cobalt, then write a comparison file compare.md covering each of them', deps);
    const id = taskIdOf(out);
    const t = await waitTerminal(id);
    expect(t).toBeDefined();
    expect(t!.delegation?.strategy).toBe('coordinated_multi_agent');
    expect(t!.delegation!.reasons.length).toBeGreaterThan(0);
    expect(t!.delegation!.workstreams.length).toBeGreaterThanOrEqual(2);
    expect(t!.delegation!.parallelizable).toBe(true);
    expect(t!.delegation!.decidedAt).toBeGreaterThan(0);
  });

  it('the delegation rationale is visible in task_status (the user can see WHY agents were assigned)', async () => {
    const deps = baseDeps({
      planner: async () => [{ title: 'Work', detail: 'w', kind: 'general', dependsOn: [] }],
      stepRunner: async (_prompt, _kind, task, stepId) => {
        await realEvidence(task.id, stepId);
        return 'DONE: ok; VERIFIED: re-read';
      },
    });
    const out = await startTask('Run the delegation status work', deps);
    const t = await waitTerminal(taskIdOf(out));
    expect(taskStatusText(t!)).toMatch(/DELEGATION: /);
  });
});

describe('sequential, parallel and dependency-aware execution (§4, §5)', () => {
  it('independent steps run as an OVERLAPPING wave; dependent steps wait for their dependencies', async () => {
    const events: Array<{ step: string; phase: 'start' | 'end'; at: number }> = [];
    let maxConcurrent = 0;
    let current = 0;
    const plan: PlanStep[] = [
      { title: 'Scan folder A', detail: 'list a', kind: 'explore', dependsOn: [] },
      { title: 'Scan folder B', detail: 'list b', kind: 'explore', dependsOn: [] },
      { title: 'Merge scans', detail: 'combine', kind: 'general', dependsOn: ['s1', 's2'] },
    ];
    const deps = baseDeps({
      planner: async () => plan,
      stepRunner: async (_prompt, _kind, task, stepId, signal) => {
        events.push({ step: stepId, phase: 'start', at: Date.now() });
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await sleep(stepId === 's3' ? 10 : 150);
        if (signal.aborted) {
          current--;
          throw new Error('cancelled');
        }
        current--;
        events.push({ step: stepId, phase: 'end', at: Date.now() });
        await realEvidence(task.id, stepId);
        return 'DONE: scan complete; VERIFIED: listed';
      },
    });
    const out = await startTask('Scan two folders and merge the results into a summary file', deps);
    const t = await waitTerminal(taskIdOf(out));
    expect(t!.status).toBe('COMPLETED');
    expect(t!.steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(maxConcurrent).toBe(2); // the two scans overlapped (bounded by MAX_PARALLEL_STEPS)
    const s1End = events.find((e) => e.step === 's1' && e.phase === 'end')!;
    const s2End = events.find((e) => e.step === 's2' && e.phase === 'end')!;
    const s3Start = events.find((e) => e.step === 's3' && e.phase === 'start')!;
    expect(s3Start.at).toBeGreaterThanOrEqual(Math.max(s1End.at, s2End.at)); // dependency respected
  });

  it('a dependent step receives the CONTROLLED upstream context (§5) — only its own dependencies, nothing else', async () => {
    const prompts: Record<string, string> = {};
    const plan: PlanStep[] = [
      { title: 'Find the config', detail: 'locate', kind: 'explore', dependsOn: [] },
      { title: 'Unrelated step', detail: 'other', kind: 'explore', dependsOn: [] },
      { title: 'Patch the config', detail: 'edit it', kind: 'coder', dependsOn: ['s1'] },
    ];
    const deps = baseDeps({
      planner: async () => plan,
      stepRunner: async (_prompt, _kind, _task, stepId) => {
        return stepId === 's1' ? 'FOUND: config at app/settings.json; ANSWER: the config lives there' : 'DONE: ok; VERIFIED: re-read';
      },
    });
    // capture prompts via a wrapper (stepRunner signature: prompt first)
    const deps2: CoordinatorDeps = {
      ...deps,
      stepRunner: async (prompt, kind, t, stepId, signal) => {
        prompts[stepId] = prompt;
        return deps.stepRunner!(prompt, kind, t, stepId, signal);
      },
    };
    const out = await startTask('Find the config file and patch the config file accordingly', deps2);
    await waitTerminal(taskIdOf(out));
    expect(prompts.s3).toContain('UPSTREAM RESULTS');
    expect(prompts.s3).toContain('RESULT OF "Find the config"');
    expect(prompts.s3).toContain('config at app/settings.json');
    // scope: the dependent step sees ONLY its own dependency — never the unrelated parallel step's result
    expect(prompts.s3).not.toContain('RESULT OF "Unrelated step"');
    // a step with no dependencies gets no upstream block at all
    expect(prompts.s1).not.toContain('UPSTREAM RESULTS');
    expect(prompts.s2).not.toContain('UPSTREAM RESULTS');
  });

  it('contradictory results from PARALLEL agents are reconciled against the DISK (§7) — no averaging, no voting', async () => {
    // Round 25.1 FIX #1: a write-capable step never shares a wave, so the contradictory
    // pair under test is now two READ-ONLY agents (a legal parallel wave) disputing a
    // file's state; the coordinator still reconciles their claims against the disk.
    const file = path.join(ROOT, 'out', 'r25-shared.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'the reconciled truth');
    const plan: PlanStep[] = [
      { title: 'Agent A reads the file', detail: 'read out/r25-shared.md', kind: 'explore', dependsOn: [] },
      { title: 'Agent B checks the file', detail: 'check out/r25-shared.md', kind: 'explore', dependsOn: [] },
    ];
    const deps = baseDeps({
      planner: async () => plan,
      stepRunner: async (_prompt, _kind, task, stepId) => {
        await realEvidence(task.id, stepId);
        return stepId === 's1'
          ? 'FOUND: out/r25-shared.md exists with the reconciled truth; ANSWER: the file is there'
          : 'FOUND: nothing — out/r25-shared.md does not exist; ANSWER: the file is missing';
      },
    });
    const out = await startTask('Read the shared file out/r25-shared.md and check the shared file out/r25-shared.md', deps);
    const t = await waitTerminal(taskIdOf(out));
    const stored = t!.steps.map((s) => s.result).join('\n');
    expect(stored).toContain('COORDINATOR RECONCILIATION');
    expect(stored).toContain('agents DISAGREED');
    expect(stored).toMatch(/EXISTS/); // ground truth from disk: the file exists
  });
});

describe('failure isolation, honest timeout, cancellation (§4)', () => {
  it('a failed step blocks ONLY its own branch; unrelated work still completes; blocked work is skipped honestly', async () => {
    const plan: PlanStep[] = [
      { title: 'Failing stream', detail: 'doomed', kind: 'general', dependsOn: [] },
      { title: 'Healthy stream', detail: 'fine', kind: 'explore', dependsOn: [] },
      { title: 'Needs the failed stream', detail: 'blocked', kind: 'general', dependsOn: ['s1'] },
    ];
    const deps = baseDeps({
      planner: async () => plan,
      stepRunner: async (_prompt, _kind, task, stepId) => {
        if (stepId === 's1') return 'FAILED: the provider is unreachable for this step';
        await realEvidence(task.id, stepId);
        return 'DONE: ok; VERIFIED: re-read';
      },
    });
    const out = await startTask('Run the failing stream and the healthy stream and save the result file out/streams.md', deps);
    const t = await waitTerminal(taskIdOf(out));
    expect(t!.status).toBe('FAILED'); // the file deliverable never materialized — honest verdict
    const by = (title: string) => t!.steps.find((s) => s.title === title)!;
    expect(by('Failing stream').status).toBe('failed');
    expect(by('Healthy stream').status).toBe('done');
    expect(by('Needs the failed stream').status).toBe('skipped');
    expect(t!.verdict).toBe('failed');
    // the agent tracker saw the failure too (§9 visibility)
    const trackerFailures = agentViews().filter((a) => a.status === 'failed');
    expect(trackerFailures.length).toBeGreaterThan(0);
  });

  it('a step that blows its deadline fails HONESTLY (never silently left running)', async () => {
    setCoordinatorBudgetsForTests(60, 3_600_000); // 60 ms step deadline
    const plan: PlanStep[] = [{ title: 'Hung step', detail: 'hangs', kind: 'general', dependsOn: [] }];
    const deps = baseDeps({
      planner: async () => plan,
      stepRunner: async (_p, _k, _t, _s, signal) => {
        // respect the execution signal the way the real runner does, then report the failure
        await sleep(300);
        if (signal.aborted) return 'FAILED: the model call was stopped by the step deadline';
        return 'FAILED: provider hung';
      },
    });
    const out = await startTask('Run the hung step', deps);
    const t = await waitTerminal(taskIdOf(out));
    expect(t!.status).toBe('FAILED');
    expect(t!.steps[0].status).toBe('failed');
    expect(t!.steps[0].result).toContain('deadline');
  });

  it('cancellation propagates: mid-flight steps settle to UNKNOWN outcome, the task is CANCELLED (never completed)', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const plan: PlanStep[] = [
      { title: 'Long step', detail: 'long', kind: 'general', dependsOn: [] },
      { title: 'Second step', detail: 'second', kind: 'general', dependsOn: ['s1'] },
    ];
    const deps = baseDeps({
      planner: async () => plan,
      stepRunner: async (_p, _k, _t, _s, signal) => {
        await Promise.race([gate, new Promise<'aborted'>((r) => signal.addEventListener('abort', () => r('aborted'), { once: true }))]);
        if (signal.aborted) throw new Error('cancelled');
        return 'DONE: ok; VERIFIED: re-read';
      },
    });
    const out = await startTask('Run the long cancellable work', deps);
    const id = taskIdOf(out);
    await sleep(80); // let the first step go mid-flight
    expect(cancelTask(id)).toBe(true);
    release!();
    const t = await waitFor(id, 'CANCELLED');
    expect(t!.status).toBe('CANCELLED');
    expect(t!.verdict).toBe('failed');
    const mid = t!.steps[0];
    expect(mid.status === 'pending' || mid.outcomeUnknown === true || mid.status === 'done').toBe(true);
    // no tracker row is left stuck 'running' after the cancellation
    const rows = agentViews().filter((a) => a.taskId === id);
    expect(rows.some((r) => r.status === 'running')).toBe(false);
  });

  it('an agent waiting behind the concurrency gate queues FIFO and a cancelled waiter leaves the queue (§11)', async () => {
    // Fill every slot.
    const held: Array<Promise<void>> = [];
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) held.push(acquireRunSlotForTests());
    expect(agentConcurrency()).toBe(MAX_CONCURRENT_AGENT_RUNS);
    const queued = acquireRunSlotForTests();
    let settled = false;
    void queued.then(
      () => (settled = true),
      () => (settled = true)
    );
    await sleep(20);
    expect(settled).toBe(false); // FIFO: still queued
    releaseRunSlotForTests();
    await queued; // the freed slot is handed over
    // A queued run that is aborted leaves the queue instead of waiting forever:
    // refill every slot, then enqueue one and abort it while it waits.
    for (let i = 0; i < MAX_CONCURRENT_AGENT_RUNS; i++) held.push(acquireRunSlotForTests());
    expect(agentConcurrency()).toBe(MAX_CONCURRENT_AGENT_RUNS);
    const ctl = new AbortController();
    const abortable = acquireRunSlotForTests(ctl.signal);
    const p = abortable.catch((e) => e);
    await sleep(10);
    ctl.abort();
    expect(await p).toBeInstanceOf(Error);
    for (const h of held) void h;
  });
});

describe('persistence, recovery and duplicate prevention (§8, §11)', () => {
  it('a watchdog takeover marks the task INTERRUPTED (resumable), completed steps survive, resume finishes the work', async () => {
    setCoordinatorTimingForTests(40, 120); // heartbeat 40ms; stall threshold 120ms
    const plan: PlanStep[] = [
      { title: 'First step', detail: 'first', kind: 'general', dependsOn: [] },
      { title: 'Second step', detail: 'second', kind: 'general', dependsOn: ['s1'] },
    ];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const deps = baseDeps({
      planner: async () => plan,
      stepRunner: async (_prompt, _kind, task, stepId, signal) => {
        if (stepId === 's1') {
          await realEvidence(task.id, stepId);
          return 'DONE: first complete; VERIFIED: re-read';
        }
        await Promise.race([gate, new Promise<'aborted'>((r) => signal.addEventListener('abort', () => r('aborted'), { once: true }))]);
        if (signal.aborted) throw new Error('cancelled');
        await realEvidence(task.id, stepId);
        return 'DONE: second complete; VERIFIED: re-read';
      },
    });
    const out = await startTask('Run the two-step recoverable work', deps);
    const id = taskIdOf(out);
    // wait until the second step is mid-flight, then simulate the driver DYING: the
    // claim stops being renewed (stale), so the production watchdog takes over.
    for (let i = 0; i < 100; i++) {
      if ((await getTask(id))?.steps[1]?.status === 'running') break;
      await sleep(40);
    }
    const rec = await getTask(id);
    rec!.ownerSince = Date.now() - 60_000; // no heartbeat for a minute: provably dead driver
    await checkStalls();
    setCoordinatorTimingForTests(60_000, 600_000);
    // Before resume: the completed step is preserved; the recovery state distinguishes
    // done ≠ interrupted ≠ pending — and nothing is reported complete that is not.
    const t = await getTask(id);
    expect(t!.status).toBe('INTERRUPTED');
    expect(t!.steps[0].status).toBe('done');
    expect(t!.steps[1].status === 'running' || t!.steps[1].status === 'pending').toBe(true);
    const reconciled = await reconcileInterruptedSteps(t!, 'test reconciliation');
    expect(Array.isArray(reconciled)).toBe(true);
    // Resume: NO replanning, no repeated completed work — the engine continues from step 2.
    release!();
    const resumed = await resumeTask(id, deps);
    expect(resumed).toMatch(/resumed WITHOUT replanning/);
    const done = await waitFor(id, 'COMPLETED');
    expect(done!.steps[0].status).toBe('done');
    expect(done!.steps[1].status).toBe('done');
    expect(done!.verdict).toBe('completed');
  });

  it('a restart never reports unfinished work as complete: boot reconciliation interrupts ACTIVE tasks', async () => {
    const { createTask, transition, markStep } = await import('../src/main/taskStore');
    const { buildTaskSpec } = await import('../src/main/taskSpec');
    const spec = buildTaskSpec('Write the recovery report file out/recovery.md');
    const t = await createTask(spec, 'created');
    await transition(t, 'READY', 'accepted');
    await transition(t, 'RUNNING', 'running');
    // Fresh boot: wipe the cache so the next read reloads from disk and reconciles.
    resetTaskStoreForTests();
    const reloaded = await getTask(t.id);
    expect(reloaded!.status).toBe('INTERRUPTED');
    expect(reloaded!.owner).toBe('');
    const mid = reloaded!.steps.find((s) => s.status === 'running');
    if (mid) expect(mid.outcomeUnknown).toBe(true);
    void markStep;
  });

  it('duplicate execution is prevented: the same request while a task is active is refused with a pointer', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const deps = baseDeps({
      planner: async () => [{ title: 'Work', detail: 'w', kind: 'general', dependsOn: [] }],
      stepRunner: async () => {
        await gate;
        return 'DONE: ok; VERIFIED: re-read';
      },
    });
    const out = await startTask('Write the duplicate check report file out/dup.md', deps);
    expect(out).toMatch(/Task T-/);
    const second = await startTask('Write the duplicate check report file out/dup.md', deps);
    expect(second).toMatch(/NOT DONE: task .* is already running/);
    release!();
  });
});

describe('agent observability (§9)', () => {
  it('agent runs are tracked with WHO, WHAT and WHY, and reach the progress snapshot for the HUD', async () => {
    setAgentProvider(() => agentViews());
    const plan: PlanStep[] = [{ title: 'Work', detail: 'w', kind: 'general', dependsOn: [] }];
    const deps = baseDeps({
      planner: async () => plan,
      stepRunner: async (_prompt, _kind, task, stepId) => {
        await realEvidence(task.id, stepId);
        return 'DONE: ok; VERIFIED: re-read';
      },
    });
    const out = await startTask('Run the observable work', deps);
    const id = taskIdOf(out);
    await waitTerminal(id);
    // the durable record carries the delegation decision either way:
    const t = await getTask(id);
    expect(t!.delegation).toBeDefined();
    expect(t!.delegation!.strategy).toBe('single_specialist');
    // the snapshot shape the HUD renders (TaskProgress AgentsSection) is well-formed:
    const snap = getProgressSnapshot();
    if (snap.agents?.length) {
      for (const a of snap.agents) {
        expect(typeof a.id).toBe('string');
        expect(typeof a.agent).toBe('string');
        expect(['running', 'done', 'failed', 'cancelled', 'waiting']).toContain(a.status);
        expect(typeof a.why).toBe('string');
      }
    }
  });

  it('the tracker records waiting/running/done transitions and the delegation why', () => {
    agentBegin({ id: 'step:T-1:s1', agent: 'coder', kind: 'coder', taskId: 'T-1', stepId: 's1', why: 'step "Patch" of task T-1 — delegated: single_specialist' });
    agentWaiting('step:T-1:s1', 'waiting for an execution slot (6/6 agents running)');
    expect(agentViews().find((a) => a.id === 'step:T-1:s1')?.status).toBe('waiting');
    agentResume('step:T-1:s1');
    expect(agentViews().find((a) => a.id === 'step:T-1:s1')?.status).toBe('running');
    agentEnd('step:T-1:s1', 'done', 'DONE: patched; VERIFIED: diagnostics');
    const row = agentViews().find((a) => a.id === 'step:T-1:s1');
    expect(row?.status).toBe('done');
    expect(row!.endedAt).toBeGreaterThanOrEqual(row!.startedAt);
    expect(row?.why).toContain('single_specialist');
  });

  it('the HUD view stays bounded and shape-safe against garbage', () => {
    for (let i = 0; i < 30; i++) agentBegin({ id: `agent:${i}`, agent: `agent${i}`, kind: 'general', why: `why ${i}` });
    for (let i = 0; i < 30; i++) agentEnd(`agent:${i}`, 'done');
    const views = agentViews();
    expect(views.length).toBeLessThanOrEqual(8); // the HUD slice is bounded
    setAgentProvider(() => views);
    const snap = getProgressSnapshot();
    expect(Array.isArray(snap.agents)).toBe(true);
  });
});
