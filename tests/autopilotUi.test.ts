import { readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 22 §3.8 — UI AND IPC INTEGRATION TESTS.
 *
 * The renderer must invoke REAL backend operations. Because the renderer components run
 * inside Electron (not jsdom), the contract is pinned on two axes:
 *  1. THE IPC WIRE CONTRACT — every 'projects-*' channel the preload exposes has a real
 *     ipcMain.handle in index.ts wired to a real engine/store operation (a drift in
 *     either file breaks this test);
 *  2. THE COMPONENT CONTRACT — ProjectsPanel/ProjectGraph/JarvisWindow contain the real
 *     controls wired to electronAPI.projects (no decorative buttons), the views layer is
 *     behavior-tested for real persisted-state projection, and the existing panels
 *     (conversations, settings) are untouched.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

// These are REAL integration tests (real coordinator drives with durable fsynced saves):
// they need more wall-clock than the default 30 s. File-scoped; other suites unaffected.
vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });


const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

import { resetTaskStoreForTests } from '../src/main/taskStore';
import { resetAutopilotStoreForTests, listProjects, createProject, updateProject, pushEvent, transitionProject } from '../src/main/autopilot/store';
import { createProjectFromDescription, setAutopilotDeps, executeProject } from '../src/main/autopilot/engine';
import { listProjectViews, projectDetailView, toSummaryView, toDetailView } from '../src/main/autopilot/views';
import { makeDeps, simplePlan, writeThroughTools, until, wipeAutopilot, engineTick } from './helpers/autopilot';

beforeEach(() => {
  resetTaskStoreForTests();
  resetAutopilotStoreForTests();
  wipeAutopilot();
  setAutopilotDeps(null);
});

describe('the IPC wire contract — every exposed channel is backed by a real handler', () => {
  const preload = src('src/preload/index.ts');
  const main = src('src/main/index.ts');

  const channels = [
    'projects-list',
    'projects-get',
    'projects-create',
    'projects-create-template',
    'projects-templates',
    'projects-execute',
    'projects-pause',
    'projects-resume',
    'projects-cancel',
    'projects-replan',
    'projects-update-requirements',
  ];

  for (const ch of channels) {
    it(`${ch}: exposed by the preload AND handled in the main process`, () => {
      expect(preload).toContain(`'${ch}'`);
      expect(main).toContain(`ipcMain.handle('${ch}'`);
    });
  }

  it('each main handler calls a REAL backend operation (no decorative channel exists)', () => {
    expect(main).toContain("ipcMain.handle('projects-execute', (_, id: unknown) => executeProject(strArg(id, 80)))");
    expect(main).toContain("ipcMain.handle('projects-pause', (_, id: unknown) => pauseProject(strArg(id, 80)))");
    expect(main).toContain("ipcMain.handle('projects-resume', (_, id: unknown) => resumeProject(strArg(id, 80)))");
    expect(main).toContain("ipcMain.handle('projects-cancel', (_, id: unknown) => cancelProject(strArg(id, 80)))");
    expect(main).toContain('createProjectFromDescription(d,');
    expect(main).toContain('replanProject(strArg(id, 80)');
    expect(main).toContain('updateRequirements(strArg(id, 80)');
    expect(main).toContain('listProjectViews({');
    expect(main).toContain('projectDetailView(strArg(id, 80))');
  });

  it('the preload refuses unknown push channels and exposes projects-updated only', () => {
    expect(preload).toMatch(/'projects-updated'/);
    expect(preload).toMatch(/A wide-open `on` would let a compromised/);
  });

  it('the renderer type declarations expose the projects namespace', () => {
    const dts = src('types/electron.d.ts');
    expect(dts).toContain('projects: {');
    expect(dts).toContain('execute: (id: string) => Promise<string>');
    expect(dts).toContain('updateRequirements: (id: string, patch');
    expect(dts).toContain("'projects-updated'");
  });
});

describe('the renderer component contract — real controls, real data', () => {
  const panel = src('src/renderer/components/ProjectsPanel.tsx');
  const graph = src('src/renderer/components/ProjectGraph.tsx');
  const window = src('src/renderer/components/JarvisWindow.tsx');
  const app = src('src/renderer/App.tsx');

  it('ProjectsPanel wires every control to a real electronAPI.projects operation', () => {
    expect(panel).toMatch(/a\.(execute|resume)\(detail\.summary\.id\)/); // execute/resume button
    expect(panel).toMatch(/a\.pause\(detail\.summary\.id\)/);
    expect(panel).toMatch(/a\.cancel\(detail\.summary\.id\)/);
    expect(panel).toMatch(/a\.replan\(detail\.summary\.id/);
    expect(panel).toMatch(/a\.updateRequirements\(detail\.summary\.id/);
    expect(panel).toMatch(/a\.create\(description\.trim\(\), templateId/);
    expect(panel).toMatch(/a\.list\(\{ offset: atOffset, limit: PAGE_SIZE, query \}\)/);
    expect(panel).toMatch(/a\.get\(id\)/);
    expect(panel).toMatch(/a\.templates\(\)/);
  });

  it('ProjectsPanel renders persisted state only — progress bars bind to backend counts', () => {
    expect(panel).toMatch(/detail\.summary\.tasksCompleted/);
    expect(panel).toMatch(/detail\.summary\.tasksTotal/);
    expect(panel).toMatch(/p\.tasksCompleted\/\{p\.tasksTotal\}|tasksCompleted/);
    expect(panel).toMatch(/detail\.summary\.milestones/);
    expect(panel).toMatch(/detail\.deliverables/);
    expect(panel).toMatch(/detail\.decisions/);
    expect(panel).toMatch(/detail\.events/);
    expect(panel).toMatch(/detail\.summary\.blockReason/); // blocked-project recovery info
  });

  it('the panel shows blocked-recovery guidance and never deletes project data', () => {
    expect(panel).toMatch(/never retried automatically/);
    expect(panel).not.toMatch(/deleteProject|projects\.delete|removeProject/);
  });

  it('ProjectGraph renders the dependency DAG from the durable plan (nodes + edges, no fake layout)', () => {
    expect(graph).toMatch(/t\.dependsOn/);
    expect(graph).toMatch(/markerEnd/); // real SVG edges
    expect(graph).toMatch(/stateColor/);
    expect(graph).toMatch(/milestoneOf/);
  });

  it('JarvisWindow hosts the Projects workspace without touching the existing UI', () => {
    expect(window).toContain("import ProjectsPanel from './ProjectsPanel'");
    expect(window).toMatch(/setProjectsOpen\(true\)/);
    expect(window).toMatch(/<ProjectsPanel open=\{projectsOpen\}/);
    // Existing panels and header behaviour preserved:
    expect(window).toContain("import ConversationsPanel from './ConversationsPanel'");
    expect(window).toMatch(/<ConversationsPanel open=\{conversationsOpen\}/);
    expect(window).toMatch(/<SettingsPanel open=\{settingsOpen\}/);
    expect(window).toMatch(/onSetMode\(bg \? 'interactive' : 'background'\)/);
    expect(window).toMatch(/hud\.setMini\(!mini\)/);
  });

  it('App.tsx remains untouched by the integration (no autopilot imports needed there)', () => {
    expect(app).not.toMatch(/autopilot|ProjectsPanel/);
    expect(app).toMatch(/window\.electronAPI\.ai\.chat/); // the core turn loop unchanged
  });
});

describe('the views layer projects REAL persisted state (the data source of the UI)', () => {
  it('summaries and details mirror the durable record, shape-safe and bounded', async () => {
    const rel = 'projects/ui-test/u.md';
    const deps = makeDeps({
      planner: async () => simplePlan(rel),
      handlers: [
        { match: /Produce the deliverable/, run: async () => { await writeThroughTools(rel, 'ui test body'); return `DONE: created ${rel}`; } },
        { match: /Verify the deliverable/, run: async () => 'DONE: verified' },
      ],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('UI projection test', { planner: deps.planner });
    await updateProject(p.id, (x) => pushEvent(x, { id: 'E-ui', at: Date.now(), kind: 'note', message: 'a UI-visible event' }));
    await executeProject(p.id, deps);
    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'completed');

    const fresh = (await listProjects())[0];
    const summary = await toSummaryView(fresh);
    expect(summary.status).toBe('completed');
    expect(summary.tasksCompleted).toBe(2);
    expect(summary.tasksTotal).toBe(2);
    expect(summary.milestones[0].done).toBe(2);
    expect(summary.deliverablesVerified).toBe(1);
    const detail = await toDetailView(fresh);
    expect(detail.events.some((e) => e.id === 'E-ui')).toBe(true);
    expect(detail.tasks.every((t) => typeof t.state === 'string' && typeof t.id === 'string')).toBe(true);
    // Renderer-safe shapes only: no raw TaskSpec, no durable tool payloads leak through
    expect(JSON.stringify(detail)).not.toMatch(/"spec":/);
    const apiDetail = await projectDetailView(p.id);
    expect(apiDetail!.summary.id).toBe(p.id);
  });

  it('list views paginate and count across ALL projects (the UI page source)', async () => {
    const deps = makeDeps({});
    setAutopilotDeps(deps);
    for (let i = 1; i <= 20; i++) await createProjectFromDescription(`UI list probe ${i}`);
    const v0 = await listProjectViews({ offset: 0, limit: 6 });
    const v3 = await listProjectViews({ offset: 18, limit: 6 });
    expect(v0.projects).toHaveLength(6);
    expect(v3.projects).toHaveLength(2);
    expect(v0.counts.all).toBe(20);
    expect(v0.total).toBe(20);
  });
});
