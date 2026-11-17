import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 22 §3.3/§3.4 — EXECUTION THROUGH THE REAL COORDINATOR.
 *
 * These tests prove project tasks are REAL durable JARVIS tasks: dispatched via
 * startTaskWithSpec through the ONE coordinator, executed by scoped agents with durable
 * records, verified by the Round 21 verifier, and bounded by the SHARED concurrency cap.
 * Only the model boundary is injected (deterministic step runner).
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

// These are REAL integration tests (real coordinator drives with durable fsynced saves):
// they need more wall-clock than the default 30 s. File-scoped; other suites unaffected.
vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });


import { resetTaskStoreForTests, getTask, listTasks, activeTasks } from '../src/main/taskStore';
import { resetAutopilotStoreForTests, listProjects } from '../src/main/autopilot/store';
import { createProjectFromDescription, executeProject, runProjectTick, tickProject, buildProjectTaskSpec, setAutopilotDeps } from '../src/main/autopilot/engine';
import { projectDetailView } from '../src/main/autopilot/views';
import { until, makeDeps, simplePlan, ROOT, wipeAutopilot, writeThroughTools, understandingOf, engineTick } from './helpers/autopilot';

beforeEach(() => {
  resetTaskStoreForTests();
  resetAutopilotStoreForTests();
  wipeAutopilot();
  setAutopilotDeps(null);
});

describe('§3.3 — project tasks run as REAL durable tasks through the coordinator', () => {
  it('Scenario A: create → plan → execute → durable tasks → deliverable verified → project completed', async () => {
    const rel = 'projects/engine-test/report.md';
    const deps = makeDeps({
      understanding: understandingOf({ title: 'Engine test project', objective: 'produce and verify a report file', complexity: 'light' }),
      planner: async () => simplePlan(rel),
      handlers: [
        {
          match: /Produce the deliverable/,
          run: async ({ taskId, stepId }) => {
            const w = await writeThroughTools(rel, '# Engine test report\n\nReal content written through the guarded tool pipeline.', taskId);
            if (!w.ok) return `FAILED: write refused: ${w.text.slice(0, 200)}`;
            return `DONE: created ${rel} (real write_file through the permission gate)`;
          },
        },
        { match: /Verify the deliverable/, run: async () => 'DONE: verified — the file exists on disk and reopens cleanly' },
      ],
    });
    setAutopilotDeps(deps);

    const p = await createProjectFromDescription('Produce a report file for the engine test.', { planner: deps.planner, understanding: deps.understanding });
    expect(p.status).toBe('draft');
    expect(p.tasks).toHaveLength(2);
    expect(p.deliverables).toHaveLength(1);

    await executeProject(p.id, deps);
    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'completed');

    const after = (await listProjects())[0];
    // Project completed honestly: every task verified + deliverable verified
    expect(after.status).toBe('completed');
    expect(after.tasks.every((t) => t.state === 'completed')).toBe(true);
    // REAL durable tasks exist with REAL verdicts
    for (const t of after.tasks) {
      expect(t.taskId).toMatch(/^T-/);
      const durable = await getTask(t.taskId!);
      expect(durable).toBeDefined();
      expect(durable!.verdict).toBe('completed');
      expect(durable!.verification?.passed).toBe(true);
    }
    // Deliverable verified ON DISK with integrity metadata
    expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
    expect(after.verifications.some((v) => v.verdict === 'verified' && v.sha256 && v.bytes! > 0)).toBe(true);
    // Execution evidence in the event history
    const kinds = after.events.map((e) => e.kind);
    expect(kinds).toContain('task-dispatched');
    expect(kinds).toContain('task-completed');
    expect(kinds).toContain('deliverable-verified');
    expect(kinds).toContain('milestone-completed');
    expect(kinds).toContain('completed');
  });

  it('the task-spec bridge embeds acceptance criteria, deliverable paths and failure context in a real TaskSpec', async () => {
    const rel = 'projects/spec-test/out.md';
    const deps = makeDeps({ planner: async () => simplePlan(rel) });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('spec bridge test', { planner: deps.planner });
    const spec = buildProjectTaskSpec(p, p.tasks[0], 'PREVIOUS FAILURE: the model hiccuped');
    expect(spec.request).toContain(`PROJECT TASK PT-1`);
    expect(spec.request).toContain(rel);
    expect(spec.request).toContain('PREVIOUS FAILURE');
    expect(spec.acceptance.some((c) => c.kind === 'file-exists' && c.target === rel)).toBe(true);
    expect(spec.acceptance.some((c) => c.kind === 'file-nonempty')).toBe(true);
    expect(spec.deliverables.join(' ')).toContain(rel);
    // The bridge produces an ordinary TaskSpec — no project-specific spec fields exist.
    expect(spec.kind).toBe('action');
  });

  it('the project layer never executes by itself: nothing runs before executeProject, and no fake task ids exist', async () => {
    const deps = makeDeps({ planner: async () => simplePlan('projects/no-auto/out.md') });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('never auto-runs', { planner: deps.planner });
    await runProjectTick(p.id, deps); // draft: the scheduler must not dispatch
    expect(p.tasks.every((t) => t.state === 'pending')).toBe(true);
    expect((await listTasks()).length).toBe(0);
    expect(p.tasks.every((t) => !t.taskId)).toBe(true);
  });
});

describe('§3.4 — bounded concurrency through the SHARED coordinator cap', () => {
  it('runs at most the coordinator capacity (2) durable tasks at once, even with more eligible tasks', async () => {
    let running = 0;
    let peak = 0;
    let gateOpen = false;
    // A REUSABLE gate: first-wave handlers park until the assertions release them; the
    // third task's handler parks too (it dispatches only after capacity frees).
    const gate = async (): Promise<void> => {
      const start = Date.now();
      while (!gateOpen && Date.now() - start < 30000) await new Promise((r) => setTimeout(r, 15));
    };
    const deps = makeDeps({
      planner: async () => ({
        milestones: [{ id: 'M-1', title: 'M', detail: '' }],
        tasks: [1, 2, 3].map((i) => ({
          id: `PT-${i}`,
          title: `Independent task ${i}`,
          detail: `Work item ${i} — independent of the others.`,
          kind: 'general',
          milestone: 'M-1',
          dependsOn: [], // explicit independence: all three eligible at once
          acceptance: [{ kind: 'evidence-present', detail: `work item ${i} evidenced` }],
        })),
      }),
      handlers: [
        {
          match: /Independent task \d/,
          run: async () => {
            running += 1;
            peak = Math.max(peak, running);
            await gate();
            running -= 1;
            return 'DONE: gated work complete';
          },
        },
      ],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('concurrency cap test', { planner: deps.planner! });
    await executeProject(p.id, deps);
    // First dispatch wave: capacity is 2 (the ONE shared cap)
    await engineTick(p.id, deps, async () => (await activeTasks()).length >= 2);
    await until(() => peak >= 2, 5000);
    expect(peak).toBe(2); // never 3: the shared MAX_CONCURRENT_TASKS is respected
    expect((await listTasks()).filter((t) => ['RUNNING', 'PLANNING', 'READY'].includes(t.status)).length).toBe(2);
    const thirdStillPending = (await listProjects())[0].tasks.filter((t) => t.state === 'pending').length;
    expect(thirdStillPending).toBe(1);
    // Open the gate; the wave completes, capacity frees, the third task dispatches.
    gateOpen = true;
    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'completed');
    expect(peak).toBe(2);
  });
});

describe('§3.8 — views expose real persisted state (UI data source)', () => {
  it('projectDetailView mirrors the durable record: tasks, milestones, deliverables, decisions, events', async () => {
    const rel = 'projects/view-test/v.md';
    const deps = makeDeps({
      planner: async () => simplePlan(rel),
      handlers: [
        { match: /Produce the deliverable/, run: async () => { await writeThroughTools(rel, 'view test body'); return `DONE: created ${rel}`; } },
        { match: /Verify the deliverable/, run: async () => 'DONE: checked' },
      ],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('view test project', { planner: deps.planner });
    await executeProject(p.id, deps);
    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'completed');

    const v = await projectDetailView(p.id);
    expect(v).not.toBeNull();
    expect(v!.summary.status).toBe('completed');
    expect(v!.summary.tasksCompleted).toBe(2);
    expect(v!.tasks).toHaveLength(2);
    expect(v!.tasks.every((t) => t.durableTaskId?.startsWith('T-'))).toBe(true);
    expect(v!.deliverables[0].statusLine).toMatch(/verified/);
    expect(v!.events.length).toBeGreaterThan(5);
    expect(v!.understandingSources).toBeTruthy();
  });
});
