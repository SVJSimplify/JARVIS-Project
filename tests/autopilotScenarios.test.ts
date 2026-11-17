import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 22 — END-TO-END SCENARIOS B and E (A/C/D live in engine/recovery suites).
 *
 * Scenario B — dependency scheduling: dependent tasks NEVER start before their
 *   dependencies complete; concurrency stays bounded.
 * Scenario E — project isolation: two projects run concurrently; their durable tasks,
 *   deliverables, events and decision records never cross.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

// These are REAL integration tests (real coordinator drives with durable fsynced saves):
// they need more wall-clock than the default 30 s. File-scoped; other suites unaffected.
vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });


import { resetTaskStoreForTests, getTask, listTasks } from '../src/main/taskStore';
import { resetAutopilotStoreForTests, listProjects, getProject } from '../src/main/autopilot/store';
import { createProjectFromDescription, executeProject, runProjectTick, pauseProject, resumeProject, cancelProject, setAutopilotDeps } from '../src/main/autopilot/engine';
import { until, makeDeps, writeThroughTools, wipeAutopilot, ROOT, engineTick } from './helpers/autopilot';
import * as fs from 'fs';
import * as path from 'path';

beforeEach(() => {
  resetTaskStoreForTests();
  resetAutopilotStoreForTests();
  wipeAutopilot();
  setAutopilotDeps(null);
});

describe('Scenario B — dependency scheduling', () => {
  it('a dependent task never dispatches before its dependency completes; the chain runs in order', async () => {
    const dispatchOrder: string[] = [];
    const seenDispatches = new Set<string>(); // one entry per DURABLE task (each dispatch runs 2 steps)
    const deps = makeDeps({
      planner: async () => ({
        milestones: [{ id: 'M-1', title: 'Chain', detail: '' }],
        tasks: [
          { id: 'PT-1', title: 'First stage', detail: 'do stage one', kind: 'general', milestone: 'M-1', dependsOn: [], acceptance: [{ kind: 'evidence-present', detail: 'stage one evidence' }] },
          { id: 'PT-2', title: 'Second stage', detail: 'do stage two after the first', kind: 'general', milestone: 'M-1', dependsOn: ['PT-1'], acceptance: [{ kind: 'evidence-present', detail: 'stage two evidence' }] },
          { id: 'PT-3', title: 'Third stage', detail: 'do stage three after the second', kind: 'verifier', milestone: 'M-1', dependsOn: ['PT-2'], acceptance: [{ kind: 'evidence-present', detail: 'stage three evidence' }] },
        ],
      }),
      handlers: [
        {
          match: /First stage/,
          run: async ({ taskId }) => {
            if (!seenDispatches.has(taskId)) { seenDispatches.add(taskId); dispatchOrder.push('PT-1'); }
            return 'DONE: stage one complete';
          },
        },
        {
          match: /Second stage/,
          run: async ({ taskId }) => {
            if (!seenDispatches.has(taskId)) { seenDispatches.add(taskId); dispatchOrder.push('PT-2'); }
            return 'DONE: stage two complete';
          },
        },
        {
          match: /Third stage/,
          run: async ({ taskId }) => {
            if (!seenDispatches.has(taskId)) { seenDispatches.add(taskId); dispatchOrder.push('PT-3'); }
            return 'DONE: stage three complete';
          },
        },
      ],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('dependency chain test', { planner: deps.planner });
    await executeProject(p.id, deps);
    // After the first tick ONLY PT-1 may have dispatched (PT-2 depends on PT-1)
    const p1 = (await listProjects())[0];
    expect(p1.tasks[0].state === 'running' || p1.tasks[0].state === 'completed').toBe(true);
    expect(p1.tasks[1].state).toBe('pending');
    expect(p1.tasks[2].state).toBe('pending');

    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'completed');
    expect(dispatchOrder).toEqual(['PT-1', 'PT-2', 'PT-3']); // strict causal order
    const after = (await listProjects())[0];
    expect(after.tasks.every((t) => t.state === 'completed')).toBe(true);
    // The durable creation times prove the order as well
    const d1 = await getTask(after.tasks[0].taskId!);
    const d2 = await getTask(after.tasks[1].taskId!);
    const d3 = await getTask(after.tasks[2].taskId!);
    expect(d1!.createdAt).toBeLessThanOrEqual(d2!.createdAt);
    expect(d2!.createdAt).toBeLessThanOrEqual(d3!.createdAt);
  });

  it('a failed dependency blocks its dependent branch honestly (the dependent never starts)', async () => {
    const secondRan: string[] = [];
    const deps = makeDeps({
      planner: async () => ({
        milestones: [{ id: 'M-1', title: 'Branch', detail: '' }],
        tasks: [
          { id: 'PT-1', title: 'Broken stage', detail: 'this one fails for real', kind: 'general', milestone: 'M-1', dependsOn: [], acceptance: [{ kind: 'evidence-present', detail: 'broken stage evidence' }] },
          { id: 'PT-2', title: 'Dependent stage', detail: 'needs the broken stage', kind: 'general', milestone: 'M-1', dependsOn: ['PT-1'], acceptance: [{ kind: 'evidence-present', detail: 'dependent stage evidence' }] },
        ],
      }),
      handlers: [
        { match: /Broken stage/, run: async () => 'FAILED: the work is impossible in this environment (permanent)' },
        { match: /Dependent stage/, run: async () => { secondRan.push('ran'); return 'DONE: should never happen'; } },
      ],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('branch failure test', { planner: deps.planner });
    await executeProject(p.id, deps);
    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'blocked');
    const after = (await listProjects())[0];
    // The dependent NEVER ran, regardless of the project-level outcome
    expect(secondRan).toEqual([]);
    expect(after.tasks[1].state).not.toBe('completed');
    expect(after.status).toBe('blocked'); // honest: a required branch failed
    expect(after.blockReason).toMatch(/permanently/i);
  });
});

describe('Scenario E — multi-project isolation', () => {
  it('two projects run concurrently; their durable tasks, deliverables, events and decisions never cross', async () => {
    const deps = makeDeps({
      planner: async (u) => ({
        milestones: [{ id: 'M-1', title: 'Deliver', detail: '' }],
        tasks: [
          {
            id: 'PT-1',
            title: 'Produce the deliverable',
            detail: `Write the artifact for ${u.title}.`,
            kind: 'general',
            milestone: 'M-1',
            dependsOn: [],
            acceptance: [{ kind: 'evidence-present', detail: `artifact for ${u.title} evidenced` }],
            deliverables: [{ name: `Artifact of ${u.title}`, path: `projects/isolation/${u.title.includes('Alpha') ? 'alpha' : 'beta'}.md`, format: 'md' }],
          },
          { id: 'PT-2', title: 'Verify the deliverable', detail: `Verify ${u.title}.`, kind: 'verifier', milestone: 'M-1', dependsOn: ['PT-1'], acceptance: [{ kind: 'evidence-present', detail: 'verified' }] },
        ],
      }),
      handlers: [
        {
          match: /Produce the deliverable/,
          run: async ({ prompt }) => {
            const alpha = prompt.includes('Alpha');
            const rel = alpha ? 'projects/isolation/alpha.md' : 'projects/isolation/beta.md';
            const w = await writeThroughTools(rel, `content of ${alpha ? 'alpha' : 'beta'}`);
            return w.ok ? `DONE: created ${rel}` : `FAILED: ${w.text.slice(0, 80)}`;
          },
        },
        { match: /Verify the deliverable/, run: async () => 'DONE: verified' },
      ],
    });
    setAutopilotDeps(deps);
    const [alpha, beta] = await Promise.all([
      createProjectFromDescription('Isolation Alpha project: produce its artifact.', { planner: deps.planner }),
      createProjectFromDescription('Isolation Beta project: produce its artifact.', { planner: deps.planner }),
    ]);
    expect(alpha.id).not.toBe(beta.id);
    await Promise.all([executeProject(alpha.id, deps), executeProject(beta.id, deps)]);
    await engineTick([alpha.id, beta.id], deps, async () => {
      const ps = await listProjects();
      return ps.every((p) => p.status === 'completed');
    });

    const [a, b] = await Promise.all([getProject(alpha.id), getProject(beta.id)]);
    // Distinct durable tasks (real ids), no sharing
    const taskIdsA = a!.tasks.map((t) => t.taskId);
    const taskIdsB = b!.tasks.map((t) => t.taskId);
    expect(new Set([...taskIdsA, ...taskIdsB]).size).toBe(4);
    for (const id of [...taskIdsA, ...taskIdsB]) expect((await getTask(id!))!.verdict).toBe('completed');
    // Distinct deliverables on disk, no cross-writes
    expect(fs.existsSync(path.join(ROOT, 'projects/isolation/alpha.md'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'projects/isolation/beta.md'))).toBe(true);
    expect(a!.deliverables.every((d) => d.path.includes('alpha'))).toBe(true);
    expect(b!.deliverables.every((d) => d.path.includes('beta'))).toBe(true);
    // Events never cross projects
    for (const e of a!.events) expect(e.message).not.toMatch(/Beta/);
    for (const e of b!.events) expect(e.message).not.toMatch(/Alpha/);
  });

  it('pause/resume/cancel are real controls over real durable work (never decorative)', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const deps = makeDeps({
      planner: async () => ({
        milestones: [{ id: 'M-1', title: 'M', detail: '' }],
        tasks: [
          { id: 'PT-1', title: 'Gated task', detail: 'waits on a gate', kind: 'general', milestone: 'M-1', dependsOn: [], acceptance: [{ kind: 'evidence-present', detail: 'gated evidence' }] },
          { id: 'PT-2', title: 'Follow-up task', detail: 'runs after the gated one', kind: 'general', milestone: 'M-1', dependsOn: ['PT-1'], acceptance: [{ kind: 'evidence-present', detail: 'follow-up evidence' }] },
        ],
      }),
      handlers: [
        { match: /Gated task/, run: async () => { started += 1; await gate; return 'DONE: gated'; } },
        { match: /Follow-up task/, run: async () => 'DONE: follow-up' },
      ],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('pause resume cancel test', { planner: deps.planner });
    await executeProject(p.id, deps);
    await engineTick(p.id, deps, async () => started >= 1);

    // PAUSE: no new dispatch; the running task may settle
    await pauseProject(p.id);
    let paused = (await listProjects())[0];
    expect(paused.status).toBe('paused');
    expect(paused.events.some((e) => e.kind === 'paused')).toBe(true);
    await runProjectTick(p.id, deps);
    paused = (await listProjects())[0];
    expect(paused.tasks[1].state).toBe('pending'); // nothing new dispatched while paused

    // RESUME: explicit; scheduling continues
    await resumeProject(p.id, deps);
    expect((await listProjects())[0].status).toBe('active');
    release?.();
    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'completed');

    // CANCEL on a fresh project: durable work stops at the step boundary, records preserved
    const deps2 = makeDeps({
      planner: async () => ({
        milestones: [{ id: 'M-1', title: 'M', detail: '' }],
        tasks: [{ id: 'PT-1', title: 'Slow task', detail: 'slow work', kind: 'general', milestone: 'M-1', dependsOn: [], acceptance: [{ kind: 'evidence-present', detail: 'slow evidence' }] }],
      }),
      handlers: [{ match: /Slow task/, run: async () => { await new Promise((r) => setTimeout(r, 300)); return 'DONE: slow'; } }],
    });
    const p2 = await createProjectFromDescription('cancel test', { planner: deps2.planner });
    await executeProject(p2.id, deps2);
    await engineTick(p2.id, deps2, async () => (await listProjects()).find((x) => x.id === p2.id)?.tasks[0].state === 'running');
    const msg = await cancelProject(p2.id);
    expect(msg).toMatch(/cancelled/i);
    const cancelled = (await listProjects()).find((x) => x.id === p2.id)!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.tasks[0].state).toBe('skipped');
    // The durable record of the cancelled task still exists (never deleted)
    expect((await listTasks()).some((t) => t.id === cancelled.tasks[0].taskId)).toBe(true);
    void started;
  });
});
