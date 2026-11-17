import fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 22 §4 — PROJECT-DATA PRESERVATION (Scenario F + the mandatory correction).
 *
 * The Autopilot project store contains NO deletion path: no pruneOld(), no startup
 * window (slice(-MAX_PROJECTS)), no terminal-status eviction, no background cleanup.
 * These tests pin the contract: 40+ projects (beyond the old eviction threshold) all
 * survive creation, reload and restart; terminal status never makes a record deletable;
 * history, decisions and durable events stay intact; pagination never destroys records.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

// These are REAL integration tests (real coordinator drives with durable fsynced saves):
// they need more wall-clock than the default 30 s. File-scoped; other suites unaffected.
vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });


import { resetTaskStoreForTests } from '../src/main/taskStore';
import { resetAutopilotStoreForTests, listProjects, getProject, createProject, readDurableEvents, countProjects } from '../src/main/autopilot/store';
import { createProjectFromDescription, setAutopilotDeps, startAutopilotTicker, stopAutopilotTicker } from '../src/main/autopilot/engine';
import { listProjectViews } from '../src/main/autopilot/views';
import { makeDeps, wipeAutopilot, ROOT } from './helpers/autopilot';

beforeEach(() => {
  resetTaskStoreForTests();
  resetAutopilotStoreForTests();
  wipeAutopilot();
  setAutopilotDeps(null);
});

const projectsDir = (): string => path.join(ROOT, 'brain', 'autopilot', 'projects');
const projectFileCount = (): number => fs.existsSync(projectsDir()) ? fs.readdirSync(projectsDir()).filter((f) => f.endsWith('.json')).length : 0;

describe('Scenario F — more than 40 projects: nothing is ever deleted', () => {
  it('creating 45 projects writes 45 files, deletes none, and evicts nothing from memory', async () => {
    const deps = makeDeps({}); // deterministic floor (no model at all)
    setAutopilotDeps(deps);
    // Concurrent creation (the store serializes every write; this also proves the write
    // path under load) — 45 projects, beyond the old 40-record eviction threshold.
    await Promise.all(Array.from({ length: 45 }, (_, k) => createProjectFromDescription(`Data preservation project number ${k + 1}: archive batch ${k + 1}.`)));
    // ALL 45 files exist on disk — not 40, not a window, everything.
    expect(projectFileCount()).toBe(45);
    expect(await countProjects()).toBe(45);
    const all = await listProjects();
    expect(all).toHaveLength(45);
  });

  it('ALL projects remain accessible after a full store reload (restart), oldest first', async () => {
    const deps = makeDeps({});
    setAutopilotDeps(deps);
    await Promise.all(Array.from({ length: 45 }, (_, k) => createProjectFromDescription(`Reload survival project ${k + 1}.`)));
    const all0 = await listProjects();
    const firstId = all0.reduce((min, p) => (p.createdAt < min.createdAt ? p : min)).id; // the OLDEST by creation time
    const oldestTitle = (await getProject(firstId))!.title;

    // ---- full restart: the cache is dropped, everything reloads from disk ----
    resetAutopilotStoreForTests();
    const reloaded = await listProjects();
    expect(reloaded).toHaveLength(45);
    const oldest = await getProject(firstId);
    expect(oldest).toBeDefined();
    expect(oldest!.title).toBe(oldestTitle);
    expect(oldest!.status).toBe('draft'); // untouched, honest
  });

  it('terminal status does NOT make a project eligible for deletion; completed history stays on disk and discoverable', async () => {
    const deps = makeDeps({});
    setAutopilotDeps(deps);
    for (let i = 1; i <= 12; i++) await createProjectFromDescription(`Old completed project ${i}.`);
    // Complete the OLDEST project (the classic "evict the oldest terminal record" bait)
    const all1 = await listProjects();
    const oldest = all1.reduce((min, p) => (p.createdAt < min.createdAt ? p : min));
    const { updateProject, transitionProject } = await import('../src/main/autopilot/store');
    await updateProject(oldest.id, async (p) => {
      await transitionProject(p, 'active', 'test execution');
      await transitionProject(p, 'completed', 'test completion');
    });
    expect(projectFileCount()).toBe(12);

    resetAutopilotStoreForTests(); // restart
    expect(projectFileCount()).toBe(12); // the completed record was NOT cleaned up
    const completed = await listProjects();
    expect(completed.filter((p) => p.status === 'completed')).toHaveLength(1);
    expect(completed.find((p) => p.id === oldest.id)).toBeDefined();
    // And it is discoverable through search/pagination too
    const view = await listProjectViews({ query: 'Old completed project 1', status: 'completed' });
    expect(view.projects.some((p) => p.id === oldest.id)).toBe(true);
  });

  it('no background cleanup ever removes project files (the ticker runs against draft projects too)', async () => {
    const deps = makeDeps({});
    setAutopilotDeps(deps);
    await Promise.all(Array.from({ length: 45 }, (_, k) => createProjectFromDescription(`Background cleanup probe ${k + 1}.`)));
    const before = projectFileCount();
    expect(before).toBe(45);
    startAutopilotTicker();
    await new Promise((r) => setTimeout(r, 400));
    stopAutopilotTicker();
    expect(projectFileCount()).toBe(45); // untouched
    expect(await countProjects()).toBe(45);
  });

  it('project history, decisions, events and plan versions remain intact across restarts', async () => {
    const deps = makeDeps({});
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('History integrity project: must keep everything.');
    const { updateProject, pushDecision, pushEvent, pushPlanHistory, transitionProject } = await import('../src/main/autopilot/store');
    await updateProject(p.id, (x) => {
      pushDecision(x, { id: 'D-hist-1', at: Date.now(), text: 'keep this decision forever', source: 'user' });
      pushEvent(x, { id: 'E-hist-1', at: Date.now(), kind: 'note', message: 'keep this event forever' });
      pushPlanHistory(x, { version: 9, at: Date.now(), note: 'a later plan version', repairs: [] });
      x.planVersion = 9;
      return undefined;
    });
    // More projects push it far beyond any old eviction window
    for (let i = 1; i <= 45; i++) await createProjectFromDescription(`Filler project ${i} for history test.`);
    resetAutopilotStoreForTests(); // restart
    const restored = await getProject(p.id);
    expect(restored).toBeDefined();
    expect(restored!.decisions.some((d) => d.id === 'D-hist-1')).toBe(true);
    expect(restored!.events.some((e) => e.id === 'E-hist-1')).toBe(true);
    expect(restored!.planVersion).toBe(9);
    // The DURABLE event history file is also intact and readable
    const durable = await readDurableEvents(p.id);
    expect(durable.some((e) => e.id === 'E-hist-1')).toBe(true);
    // Completing it does not clean anything either (legal path: active → completed)
    await updateProject(p.id, async (x) => {
      await transitionProject(x, 'active', 'final execution');
      await transitionProject(x, 'completed', 'final completion');
    });
    resetAutopilotStoreForTests();
    expect(projectFileCount()).toBe(46);
    expect((await getProject(p.id))!.status).toBe('completed');
  });
});

describe('§4 — pagination and search are non-destructive', () => {
  it('pages select views, never delete records: every page flips reveals different projects, disk keeps all', async () => {
    const deps = makeDeps({});
    setAutopilotDeps(deps);
    await Promise.all(Array.from({ length: 45 }, (_, k) => createProjectFromDescription(`Paginated archive project ${k + 1}.`)));
    const page0 = await listProjectViews({ offset: 0, limit: 10 });
    const page4 = await listProjectViews({ offset: 40, limit: 10 });
    expect(page0.projects).toHaveLength(10);
    expect(page4.projects).toHaveLength(5);
    expect(page0.total).toBe(45);
    expect(page4.total).toBe(45);
    expect(page0.counts.all).toBe(45);
    // No overlap between pages
    const ids0 = new Set(page0.projects.map((p) => p.id));
    expect(page4.projects.every((p) => !ids0.has(p.id))).toBe(true);
    // And the disk still holds every record
    expect(projectFileCount()).toBe(45);
  });

  it('search surfaces old projects without moving or removing them', async () => {
    const deps = makeDeps({});
    setAutopilotDeps(deps);
    await Promise.all(Array.from({ length: 45 }, (_, k) => createProjectFromDescription(`Search probe ${k + 1}: needle-${42 === k + 1 ? 'HIT' : 'miss'}.`)));
    const hits = await listProjectViews({ query: 'needle-HIT' });
    expect(hits.total).toBe(1);
    expect(hits.projects[0].title).toMatch(/42/);
    expect(projectFileCount()).toBe(45);
  });
});

describe('§4 — the store module itself contains no deletion path', () => {
  it('no prune/evict/rm code exists in the autopilot store (source-level pin over the mandatory fix)', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(path.join(__dirname, '..', 'src', 'main', 'autopilot', 'store.ts'), 'utf8');
    expect(src).not.toMatch(/pruneOld/);
    expect(src).not.toMatch(/fs\.rm/);
    expect(src).not.toMatch(/unlink/);
    expect(src).not.toMatch(/slice\(-MAX_PROJECTS\)/);
    expect(src).not.toMatch(/rmdir/);
  });
});
