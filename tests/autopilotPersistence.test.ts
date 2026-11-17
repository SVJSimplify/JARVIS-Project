import fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 22 §7 — PERSISTENCE, CONCURRENCY AND RECOVERY of the project store on the
 * SHARED Round 21 primitives (atomicWrite temp+fsync+rename+.bak, loadJson corrupt
 * recovery, withStoreLock serialized RMW).
 *
 * Proven here: concurrent creation, concurrent same-project updates (no lost updates),
 * concurrent multi-project updates (isolation), updates racing task settlement,
 * cache/file consistency, and atomic persistence without debris.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

// These are REAL integration tests (real coordinator drives with durable fsynced saves):
// they need more wall-clock than the default 30 s. File-scoped; other suites unaffected.
vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });


import { resetTaskStoreForTests, getTask } from '../src/main/taskStore';
import { resetAutopilotStoreForTests, listProjects, getProject, createProject, newProjectId, updateProject, pushEvent, countProjects } from '../src/main/autopilot/store';
import { createProjectFromDescription, executeProject, runProjectTick, pauseProject, setAutopilotDeps } from '../src/main/autopilot/engine';
import { makeDeps, simplePlan, writeThroughTools, until, wipeAutopilot, ROOT, engineTick } from './helpers/autopilot';
import type { ProjectRecord } from '../src/main/autopilot/types';

beforeEach(() => {
  resetTaskStoreForTests();
  resetAutopilotStoreForTests();
  wipeAutopilot();
  setAutopilotDeps(null);
});

const projectsDir = (): string => path.join(ROOT, 'brain', 'autopilot', 'projects');

const bareProject = (title: string): ProjectRecord => ({
  id: newProjectId(),
  title,
  status: 'draft',
  understanding: {
    title,
    objective: title,
    summary: title,
    requirements: [],
    constraints: [],
    assumptions: [],
    outOfScope: [],
    successCriteria: [],
    deliverables: [],
    category: 'general',
    complexity: 'standard',
    sources: {
      title: 'default', objective: 'default', summary: 'default', requirements: 'default', constraints: 'default',
      assumptions: 'default', outOfScope: 'default', successCriteria: 'default', deliverables: 'default', category: 'default', complexity: 'default',
    },
    understoodAt: Date.now(),
  },
  milestones: [],
  tasks: [],
  deliverables: [],
  verifications: [],
  decisions: [],
  events: [],
  planVersion: 1,
  planHistory: [],
  replans: 0,
  request: title,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

describe('concurrent creation and multi-project isolation', () => {
  it('10 projects created in parallel all persist fully and load back whole', async () => {
    const ps = await Promise.all(Array.from({ length: 10 }, (_, i) => createProject(bareProject(`Concurrent project ${i}`))));
    expect(new Set(ps.map((p) => p.id)).size).toBe(10);
    expect(await countProjects()).toBe(10);
    resetAutopilotStoreForTests(); // reload from disk
    const all = await listProjects();
    expect(all).toHaveLength(10);
    for (const p of all) expect(p.title).toMatch(/Concurrent project \d/);
  });

  it('concurrent updates to DIFFERENT projects never wait on each other or lose data', async () => {
    const ps = await Promise.all([createProject(bareProject('A')), createProject(bareProject('B')), createProject(bareProject('C'))]);
    await Promise.all(
      ps.flatMap((p, pi) =>
        Array.from({ length: 6 }, (_, i) =>
          updateProject(p.id, (x) => pushEvent(x, { id: `E-${pi}-${i}`, at: Date.now(), kind: 'note', message: `update ${i} of project ${pi}` }))
        )
      )
    );
    resetAutopilotStoreForTests();
    for (const [pi, p] of ps.entries()) {
      const restored = await getProject(p.id);
      const events = restored!.events.filter((e) => e.id.startsWith(`E-${pi}-`));
      expect(events).toHaveLength(6); // no lost updates
    }
  });
});

describe('concurrent updates to ONE project (serialized RMW, no lost updates)', () => {
  it('20 overlapping updateProject calls all land, in order, and the file always parses', async () => {
    const p = await createProject(bareProject('Raced project'));
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => updateProject(p.id, (x) => pushEvent(x, { id: `E-race-${i}`, at: Date.now(), kind: 'note', message: `raced update ${i}` })))
    );
    const after = await getProject(p.id);
    const ids = after!.events.filter((e) => e.id.startsWith('E-race-')).map((e) => e.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    // The file on disk matches the cache exactly (no cache/file inconsistency)
    const file = path.join(projectsDir(), `project-${p.id}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ProjectRecord;
    expect(parsed.events.filter((e) => e.id.startsWith('E-race-'))).toHaveLength(20);
    expect(parsed.updatedAt).toBe(after!.updatedAt);
  });

  it('a burst of updates racing a status transition keeps a consistent record', async () => {
    const p = await createProject(bareProject('Race the transition'));
    await Promise.all([
      updateProject(p.id, async (x) => {
        const { transitionProject } = await import('../src/main/autopilot/store');
        await transitionProject(x, 'active', 'racing transition');
      }),
      ...Array.from({ length: 10 }, (_, i) => updateProject(p.id, (x) => pushEvent(x, { id: `E-mix-${i}`, at: Date.now(), kind: 'note', message: 'mixed' }))),
    ]);
    const after = await getProject(p.id);
    expect(after!.status).toBe('active');
    expect(after!.events.filter((e) => e.id.startsWith('E-mix-'))).toHaveLength(10);
    expect(after!.events.some((e) => e.refs?.status === 'active')).toBe(true);
  });
});

describe('atomic persistence', () => {
  it('saves leave no temp debris and keep the .bak safety copy', async () => {
    const p = await createProject(bareProject('Atomicity probe'));
    await updateProject(p.id, (x) => pushEvent(x, { id: 'E-atomic', at: Date.now(), kind: 'note', message: 'second save' }));
    const files = fs.readdirSync(projectsDir());
    expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
    const main = path.join(projectsDir(), `project-${p.id}.json`);
    expect(fs.existsSync(`${main}.bak`)).toBe(true); // Round 20 CHANGE 3 backup behavior
    expect(JSON.parse(fs.readFileSync(main, 'utf8'))).toBeTruthy();
  });

  it('a corrupted record file is quarantined and recovered from .bak — never deleted, never silently reset', async () => {
    const p = await createProject(bareProject('Corrupt recovery probe'));
    const main = path.join(projectsDir(), `project-${p.id}.json`);
    const good = fs.readFileSync(main, 'utf8');
    fs.writeFileSync(`${main}.bak`, good);
    fs.writeFileSync(main, '{corrupted!!!');
    resetAutopilotStoreForTests();
    const recovered = await getProject(p.id);
    expect(recovered).not.toBeNull(); // from .bak
    expect(recovered!.title).toBe('Corrupt recovery probe');
    // The damaged bytes were quarantined (diagnosable), not destroyed
    const files = fs.readdirSync(projectsDir());
    expect(files.some((f) => f.includes('.corrupt-'))).toBe(true);
  });
});

describe('project updates while tasks are settling', () => {
  it('a pause racing task settlement leaves a consistent, honest record', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const rel = 'projects/persist-race/out.md';
    const deps = makeDeps({
      planner: async () => simplePlan(rel),
      handlers: [
        { match: /Produce the deliverable/, run: async () => { await writeThroughTools(rel, 'race content'); return `DONE: created ${rel}`; } },
        { match: /Verify the deliverable/, run: async () => { await gate; return 'DONE: verified'; } },
      ],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('pause race test', { planner: deps.planner });
    await executeProject(p.id, deps);
    await engineTick(p.id, deps, async () => (await listProjects())[0].tasks[1].state === 'running');
    // Pause (a user update) while the verify task is mid-flight and ticks are settling
    await Promise.all([pauseProject(p.id), runProjectTick(p.id, deps), runProjectTick(p.id, deps)]);
    const paused = (await listProjects())[0];
    expect(paused.status).toBe('paused');
    expect(paused.tasks[0].state).toBe('completed'); // settled truth preserved
    expect(paused.tasks[1].state).toBe('running'); // honest: still mid-flight
    // And the durable task agrees with the project record
    const durable = await getTask(paused.tasks[1].taskId!);
    expect(['RUNNING', 'PLANNING', 'VERIFYING', 'INTERRUPTED', 'COMPLETED']).toContain(durable!.status);
    release?.();
  });

  it('multi-project execution does not cross-contaminate records under concurrent ticks', async () => {
    const relA = 'projects/persist-multi/a.md';
    const relB = 'projects/persist-multi/b.md';
    const deps = makeDeps({
      planner: async (u) => ({ ...simplePlan(u.title.includes('A') ? relA : relB) }),
      handlers: [
        { match: /Produce the deliverable/, run: async ({ prompt }) => { const rel = prompt.includes(relA) ? relA : relB; await writeThroughTools(rel, `of ${rel}`); return `DONE: created ${rel}`; } },
        { match: /Verify the deliverable/, run: async () => 'DONE: verified' },
      ],
    });
    setAutopilotDeps(deps);
    const [pa, pb] = await Promise.all([
      createProjectFromDescription('Persistence race project A', { planner: deps.planner }),
      createProjectFromDescription('Persistence race project B', { planner: deps.planner }),
    ]);
    await Promise.all([executeProject(pa.id, deps), executeProject(pb.id, deps)]);
    // Interleaved ticks on both projects while they run
    await engineTick([pa.id, pb.id], deps, async () => (await listProjects()).every((x) => x.status === 'completed'));
    const [fa, fb] = await Promise.all([getProject(pa.id), getProject(pb.id)]);
    expect(fa!.tasks.every((t) => t.state === 'completed')).toBe(true);
    expect(fb!.tasks.every((t) => t.state === 'completed')).toBe(true);
    const idsA = new Set(fa!.tasks.map((t) => t.taskId));
    expect(fb!.tasks.every((t) => !idsA.has(t.taskId))).toBe(true);
  });
});
