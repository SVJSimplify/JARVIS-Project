import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 22 §3.6 — RECOVERY AND REPLANNING (bounded, honest, policy-authoritative).
 *
 * Scenarios: bounded transient retry WITH failure-context injection; a POLICY block that
 * is NEVER retried; permanent failure → honest blocking; explicit replan preserving
 * completed work; restart reconciliation from DURABLE records (Scenario D) with no
 * duplicated completed work and explicit resume for interrupted tasks.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

// These are REAL integration tests (real coordinator drives with durable fsynced saves):
// they need more wall-clock than the default 30 s. File-scoped; other suites unaffected.
vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });


import { resetTaskStoreForTests, getTask, listTasks, persistTask } from '../src/main/taskStore';
import { resetAutopilotStoreForTests, listProjects } from '../src/main/autopilot/store';
import { createProjectFromDescription, executeProject, resumeProject, reconcileOnStartup, replanProject, setAutopilotDeps } from '../src/main/autopilot/engine';
import { checkStalls } from '../src/main/coordinator';
import { until, makeDeps, simplePlan, writeThroughTools, wipeAutopilot, engineTick } from './helpers/autopilot';

beforeEach(() => {
  resetTaskStoreForTests();
  resetAutopilotStoreForTests();
  wipeAutopilot();
  setAutopilotDeps(null);
});

describe('bounded transient retry with failure-context injection', () => {
  it('a transient failure is retried within the budget; the retry brief carries the failure context; success completes the project', async () => {
    const rel = 'projects/recovery/retry.md';
    let attempts = 0;
    const deps = makeDeps({
      planner: async () => simplePlan(rel),
      handlers: [
        {
          match: /Produce the deliverable/,
          run: async () => {
            attempts += 1;
            // Fail the ENTIRE first dispatch (the coordinator retries the step once
            // within a dispatch; the ENGINE-level retry is a NEW durable task).
            if (attempts <= 2) return 'FAILED: the provider returned a 503; the model call could not complete';
            const w = await writeThroughTools(rel, 'recovered on the second dispatch');
            return w.ok ? `DONE: created ${rel}` : `FAILED: ${w.text.slice(0, 100)}`;
          },
        },
        { match: /Verify the deliverable/, run: async () => 'DONE: verified on disk' },
      ],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('retry test', { planner: deps.planner });
    await executeProject(p.id, deps);
    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'completed');

    expect(attempts).toBeGreaterThanOrEqual(3); // 2 failed step-runs in dispatch 1 + 1 successful run in dispatch 2
    const after = (await listProjects())[0];
    expect(after.status).toBe('completed');
    // The retry dispatch carried the failure context into the new durable task's request
    const produce = after.tasks[0];
    expect(produce.attempts.map((a) => a.outcome)).toEqual(['failed', 'completed']); // bounded retry history
    const retryDurable = produce.taskId ? await getTask(produce.taskId) : undefined;
    // The SECOND durable task (the retry) contains the failure context of the first
    const durableTasks = (await listTasks()).filter((t) => t.spec.request.includes('PROJECT TASK PT-1'));
    expect(durableTasks.length).toBe(2); // exactly one engine-level retry: a NEW durable task
    const withContext = durableTasks.find((t) => t.spec.request.includes('PREVIOUS ATTEMPT FAILED'));
    expect(withContext).toBeDefined();
    expect(withContext!.spec.request).toMatch(/503|could not complete/);
    // Recovery was recorded in the event history
    expect(after.events.some((e) => e.kind === 'recovery')).toBe(true);
    void retryDurable;
  });
});

describe('§3.6 — a POLICY block is NEVER retried (hard restriction authority)', () => {
  it('a project task whose execution hits a policy hard restriction blocks the project — one dispatch, no retries, no bypass', async () => {
    const deps = makeDeps({
      planner: async () => simplePlan('projects/policy-block/never.md'),
      handlers: [
        {
          match: /Produce the deliverable/,
          run: async () => 'FAILED: BLOCKED: Deletion is disabled on this laptop (policy hard restriction A). Do not try another way.',
        },
        { match: /Verify the deliverable/, run: async () => 'DONE: n/a' },
      ],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('policy block test', { planner: deps.planner });
    await executeProject(p.id, deps);
    // Drive the engine: the blocked task must settle WITHOUT any retry
    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'blocked');

    const after = (await listProjects())[0];
    expect(after.status).toBe('blocked');
    const blockedTask = after.tasks[0];
    expect(blockedTask.state).toBe('blocked');
    expect(blockedTask.lastFailure?.class).toBe('policy-blocked');
    // EXACTLY one durable task was created for it — the restriction was never re-attempted
    const durableForTask = (await listTasks()).filter((t) => t.spec.request.includes('PROJECT TASK PT-1'));
    expect(durableForTask.length).toBe(1);
    expect(blockedTask.attempts.length).toBe(1);
    expect(blockedTask.attempts[0].outcome).toBe('blocked');
    expect(after.events.some((e) => e.kind === 'task-blocked')).toBe(true);
    expect(after.blockReason).toMatch(/POLICY hard restriction/i);
    // The project cannot be "completed" around the block
    expect(after.tasks.every((t) => t.state === 'completed')).toBe(false);
  });
});

describe('permanent failure → honest blocking → explicit replan preserving completed work', () => {
  it('Scenario C: transient retries exhaust → blocked; user replan keeps completed tasks verbatim and re-plans the rest', async () => {
    const rel = 'projects/perm-fail/out.md';
    let produceAttempts = 0;
    const failedDispatches = new Set<string>();
    const deps = makeDeps({
      planner: async () => simplePlan(rel),
      handlers: [
        {
          match: /Produce the deliverable/,
          run: async (ctx) => {
            produceAttempts += 1;
            // Fail the first TWO dispatches entirely (each = 2 step-runs); succeed on the
            // replanned third dispatch. This exercises bounded retry exhaustion AND the
            // replan recovery preserving nothing-but-honest state.
            if (failedDispatches.has(ctx.taskId) || failedDispatches.size < 2) {
              failedDispatches.add(ctx.taskId);
              return 'FAILED: permanent-looking model error; the tool subprocess is gone';
            }
            const w = await writeThroughTools(rel, 'finally produced');
            return w.ok ? `DONE: created ${rel}` : `FAILED: write refused`;
          },
        },
        { match: /Verify the deliverable/, run: async () => 'DONE: verified' },
      ],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('permanent failure test', { planner: deps.planner });
    await executeProject(p.id, deps);
    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'blocked');
    let after = (await listProjects())[0];
    // PT-1 retried (budget 1 retryMax → 2 dispatches, 4 step-runs), then honestly blocked
    expect(produceAttempts).toBe(4);
    expect(['blocked']).toContain(after.status);
    expect(after.tasks[0].state).toBe('failed');
    expect(after.blockReason).toMatch(/permanently/i);

    // Explicit user replan: remaining work re-planned, retries allowed again under the new version
    const r = await replanProject(p.id, 'user asked to try again after fixing the tool', { deps, userTriggered: true });
    expect(r.ok).toBe(true);
    after = (await listProjects())[0];
    expect(after.planVersion).toBe(2);
    expect(after.planHistory.length).toBe(2);
    const replannedTask = after.tasks.find((t) => t.title === 'Produce the deliverable')!;
    expect(replannedTask.state).toBe('pending'); // re-attemptable under the new version
    // Finish the run
    await executeProject(p.id, deps);
    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'completed');
    after = (await listProjects())[0];
    expect(after.status).toBe('completed');
    expect(fs.existsSync(path.join(process.env.JARVIS_FILES_ROOT ?? '.', rel))).toBe(true);

  });

  it('the automatic recovery replan is bounded (one attempt) and never runs without a replanner', async () => {
    const deps = makeDeps({
      planner: async () => simplePlan('projects/auto-replan/out.md'),
      handlers: [{ match: /Produce the deliverable/, run: async () => 'FAILED: hard model outage' }, { match: /Verify/, run: async () => 'DONE: ok' }],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('auto replan budget', { planner: deps.planner });
    await executeProject(p.id, deps);
    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'blocked');
    const after = (await listProjects())[0];
    // No injected replanner → the one automatic attempt is refused → honest blocked state
    expect(after.status).toBe('blocked');
    expect(after.replans).toBe(0);
    expect(after.planVersion).toBe(1);
    expect(after.blockReason).toMatch(/no replan was available|blocked|permanently/i);
  });
});

describe('§7 — restart reconciliation from DURABLE records (Scenario D)', () => {
  it('completed work is never duplicated; interrupted work needs explicit resume and resumes from its persisted plan', async () => {
    const rel = 'projects/restart/out.md';
    let produceRan = 0;
    let verifyRan = 0;
    let releaseVerify: (() => void) | null = null;
    const verifyGate = new Promise<void>((r) => (releaseVerify = r));
    const deps = makeDeps({
      planner: async () => simplePlan(rel),
      handlers: [
        {
          match: /Produce the deliverable/,
          run: async () => {
            produceRan += 1;
            await writeThroughTools(rel, `restart test content (run ${produceRan})`);
            return `DONE: created ${rel}`;
          },
        },
        {
          match: /Verify the deliverable/,
          run: async () => {
            verifyRan += 1;
            await verifyGate;
            return 'DONE: verified after restart';
          },
        },
      ],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('restart reconciliation test', { planner: deps.planner });
    await executeProject(p.id, deps);
    // PT-1 completes; PT-2 (verify) starts and is mid-flight
    await engineTick(p.id, deps, async () => (await listProjects())[0].tasks[0].state === 'completed');
    await engineTick(p.id, deps, async () => (await listProjects())[0].tasks[1].state === 'running');
    await until(async () => (await getTask((await listProjects())[0].tasks[1].taskId!))?.status === 'RUNNING', 30000);
    const beforeRestart = (await listProjects())[0];
    const completedDurableId = beforeRestart.tasks[0].taskId!;
    const interruptedDurableId = beforeRestart.tasks[1].taskId!;
    const completedDurableBefore = await getTask(completedDurableId);
    const completedStepsBefore = completedDurableBefore!.steps.filter((s) => s.status === 'done').length;

    // ---- THE RESTART, simulated in-process: the mid-flight driver stops renewing its
    // claim (what a dead process does), the watchdog takes over and the task becomes
    // INTERRUPTED (honest, resumable) — the exact production path for "shut down while
    // tasks are active". ----
    const midFlight = await getTask(interruptedDurableId);
    midFlight!.ownerSince = Date.now() - 15 * 60_000; // the dead process stopped heartbeating
    await persistTask(midFlight!);
    const stalled = await checkStalls();
    expect(stalled).toContain(interruptedDurableId);

    // ---- engine-side restart reconciliation: recompute from DURABLE records ----
    const report = await reconcileOnStartup();
    expect(report.projects).toBe(1);
    expect(report.interrupted).toBe(1);

    // ---- a HARD store restart too: every record reloads from disk with the same truth ----
    resetTaskStoreForTests();
    resetAutopilotStoreForTests();
    setAutopilotDeps(deps);
    await reconcileOnStartup();

    const afterRestart = (await listProjects())[0];
    void afterRestart;
    // Completed work survives VERBATIM from the durable record — same durable id, same state
    expect(afterRestart.tasks[0].state).toBe('completed');
    expect(afterRestart.tasks[0].taskId).toBe(completedDurableId);
    // The mid-flight task is interrupted (honest), never marked done or lost
    expect(afterRestart.tasks[1].state).toBe('interrupted');
    expect(afterRestart.tasks[1].taskId).toBe(interruptedDurableId);
    expect(afterRestart.events.some((e) => e.kind === 'task-interrupted')).toBe(true);
    // The project is NOT completed while work remains
    expect(afterRestart.status).not.toBe('completed');

    // ---- release the gate FIRST: the dead driver's aborted run unwinds safely (its
    // outcome is discarded by the signal check, never settled) ----
    releaseVerify?.();
    await until(async () => (await getTask(interruptedDurableId))?.owner === '', 20000);
    // ---- EXPLICIT RESUME: the persisted plan is kept; completed steps are NOT re-run ----
    produceRan = 0; // if the completed step re-ran, this would increment again
    const resumed = await resumeProject(afterRestart.id, deps);
    expect(resumed).toMatch(/resumed/i);
    await engineTick(afterRestart.id, deps, async () => (await listProjects())[0]?.status === 'completed');

    const final = (await listProjects())[0];
    expect(final.status).toBe('completed');
    expect(final.tasks[0].taskId).toBe(completedDurableId); // still the SAME durable task
    const completedDurableAfter = await getTask(completedDurableId);
    expect(completedDurableAfter!.steps.filter((s) => s.status === 'done').length).toBe(completedStepsBefore);
    expect(produceRan).toBe(0); // zero duplicated completed work
    expect(verifyRan).toBeGreaterThanOrEqual(1); // only the interrupted step re-ran
    expect(final.events.some((e) => e.kind === 'task-resumed')).toBe(true);
  });

  it('a project whose durable tasks all completed is reconciled to completed WITH fresh deliverable verification', async () => {
    const rel = 'projects/reconcile-complete/out.md';
    const deps = makeDeps({
      planner: async () => simplePlan(rel),
      handlers: [
        { match: /Produce the deliverable/, run: async () => { await writeThroughTools(rel, 'reconcile me'); return `DONE: created ${rel}`; } },
        { match: /Verify the deliverable/, run: async () => 'DONE: verified' },
      ],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('reconcile completion', { planner: deps.planner });
    await executeProject(p.id, deps);
    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'completed');

    // Force the cache stale (pretend the engine crashed before saving 'completed')…
    const stale = (await listProjects())[0];
    stale.status = 'active';
    stale.tasks.forEach((t) => (t.state = 'running'));
    // …then reconcile FROM DURABLE TRUTH: the durable records win over the stale cache.
    const report = await reconcileOnStartup();
    expect(report.recompleted).toBe(2); // both tasks were stale in the cache, completed in the durable store
    const after = (await listProjects())[0];
    expect(after.status).toBe('completed');
    expect(after.tasks.every((t) => t.state === 'completed')).toBe(true);
    void report;
  });
});
