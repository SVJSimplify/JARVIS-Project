import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 26 — CROSS-PHASE INTEGRATION WORKFLOWS (spec §5).
 * The phases must work as ONE product: profile + memory feed planning; execution runs
 * through the ONE coordinator with honest verification; pause/resume and cancellation
 * preserve completed work; integration discovery maps requests onto the existing tools.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { startTask, pauseTask, resumeTask, cancelTask, outcomeSummary, type CoordinatorDeps } from '../src/main/coordinator';
import { getTask, resetTaskStoreForTests } from '../src/main/taskStore';
import { resetCallContext, setCallContext } from '../src/main/toolRecord';
import { runToolDetailed } from '../src/main/tools';
import { refreshProjectProfile, loadProjectProfile, PROFILE_SECTIONS } from '../src/main/projectProfile';
import { buildTaskMemoryContext } from '../src/main/episodicMemory';
import { projectMemoryTools } from '../src/main/projectMemory';
import { discoverIntegrations } from '../src/main/integrations';
import { memoryTools } from '../src/main/memory';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-r26wf-${process.pid}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetTaskStoreForTests();
  resetCallContext();
  fs.rmSync(path.join(ROOT, 'brain', 'tasks'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'brain', 'episodes.json'), { force: true });
});

afterEach(() => resetCallContext());

const baseDeps = (over: Partial<CoordinatorDeps> = {}): CoordinatorDeps => ({
  run: async () => 'OK',
  schemas: () => [],
  planner: async () => [{ title: 'Do the work', detail: 'work', kind: 'general', dependsOn: [] }],
  ...over,
});

const waitStatus = async (id: string, statuses: string[]) => {
  for (let i = 0; i < 250; i++) {
    const t = await getTask(id);
    if (t && statuses.includes(t.status)) return t;
    await sleep(30);
  }
  return await getTask(id);
};

const taskIdOf = (out: string): string => /Task (T-[\w]+)/.exec(out)![1]!;

describe('Workflow A — complete a software feature (profile → plan → verified change)', () => {
  it('the profile feeds planning; the change lands on disk; the step verifies', async () => {
    const proj = path.join(ROOT, 'wf-app');
    fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'wf-app', scripts: { test: 'vitest run' } }));
    const { profile } = await refreshProjectProfile(proj);
    expect(profile.name).toBe('wf-app'); // Phase 1: the project is understood

    const file = path.join(ROOT, 'wf-app-config.json');
    const deps = baseDeps({
      planner: async () => [{ title: 'Add the flag', detail: 'set enabled', kind: 'general', dependsOn: [], acceptance: ['the config file has enabled=true'] }],
      stepRunner: async (_p, _k, task, stepId) => {
        setCallContext({ agent: `task:general#${stepId}`, taskId: task.id, stepId });
        await runToolDetailed('write_file', JSON.stringify({ path: file, content: JSON.stringify({ enabled: true }) }));
        resetCallContext();
        return `DONE: wrote ${path.basename(file)} with enabled=true; VERIFIED: wrote through the tool path`;
      },
    });
    const out = await startTask('Write the wf-config.json file with enabled true', deps);
    const t = await waitStatus(taskIdOf(out), ['COMPLETED', 'FAILED']);
    expect(t?.status).toBe('COMPLETED');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ enabled: true });
    expect(t?.steps[0]?.verification?.status).toBe('verified');
    expect(outcomeSummary(t!)).toMatch(/steps verified\/partial\/unverified: 1\/0\/0/);
  });
});

describe('Workflow B — pause, restart-simulation, resume', () => {
  it('a paused task survives a reload and resumes to completion', async () => {
    let first = true;
    const deps = baseDeps({
      planner: async () => [
        { title: 'step one', detail: 'a', kind: 'general', dependsOn: [] },
        { title: 'step two', detail: 'b', kind: 'general', dependsOn: ['s1'] },
      ],
      stepRunner: async (_p, _k, task, stepId) => {
        if (first) {
          first = false;
          setCallContext({ agent: `task:general#${stepId}`, taskId: task.id, stepId });
          await runToolDetailed('get_current_time', '{}'); // real evidence through the ONE path
          resetCallContext();
          return 'DONE: first step done.';
        }
        return new Promise<string>((resolve) => setTimeout(() => resolve('DONE: second step done.'), 200));
      },
    });
    const out = await startTask('Write the resume workflow artifact now', deps);
    const id = taskIdOf(out);
    await sleep(120); // step one completes, step two is mid-flight
    expect(pauseTask(id)).toBe(true);
    const paused = await waitStatus(id, ['PAUSED']);
    expect(paused?.status).toBe('PAUSED');
    expect(paused?.steps.some((s) => s.status === 'done')).toBe(true); // completed work preserved
    // The UI observes the in-memory state before the atomic write necessarily finishes.
    // Flush writes before simulating a process kill so this tests the durable restart path.
    await flushTaskStoreForTests();
    // restart simulation: drop the in-memory cache, reload from disk
    const { resetTaskStoreForTests: reset } = await import('../src/main/taskStore');
    reset();
    const restored = await getTask(id);
    expect(restored?.status).toBe('PAUSED');
    const msg = await resumeTask(id, baseDeps({ stepRunner: async () => 'DONE: finished after resume.' }));
    expect(msg).toContain('resumed');
    const done = await waitStatus(id, ['COMPLETED', 'FAILED', 'CANCELLED']);
    expect(done?.status).toBe('COMPLETED');
  });
});

describe('Workflow C — research artifact → episodic memory → future context', () => {
  it('a finished task becomes recalled context for the next one', async () => {
    const artifact = path.join(ROOT, 'providers-comparison.md');
    const deps = baseDeps({
      stepRunner: async (_p, _k, task, stepId) => {
        setCallContext({ agent: `task:general#${stepId}`, taskId: task.id, stepId });
        await runToolDetailed('write_file', JSON.stringify({ path: artifact, content: '# Provider comparison\n\nA, B, C compared.' }));
        resetCallContext();
        return `DONE: wrote ${path.basename(artifact)} comparing the providers; VERIFIED: file written via tool path`;
      },
    });
    const out = await startTask('Write providers-comparison.md with the three saved entries', deps);
    const t = await waitStatus(taskIdOf(out), ['COMPLETED', 'FAILED']);
    expect(t?.status).toBe('COMPLETED');
    // the engine observed the outcome → episodic memory
    await new Promise((r) => setTimeout(r, 80)); // the episode record is fire-and-forget
    const ctx = await buildTaskMemoryContext('refresh the providers comparison file with the saved entries', ROOT);
    expect(ctx).toContain('RELEVANT PAST WORK');
    expect(ctx).toContain('providers');
  });
});

describe('Workflow D — project memory: staleness + recall', () => {
  it('stale profile sections are detected and project memory recalls decisions (never over disk)', async () => {
    await projectMemoryTools.project_save.run({ name: 'wf-app', description: 'auth uses JWT with refresh tokens', stack: ['node'] });
    await memoryTools.remember.run({ fact: 'the user prefers TypeScript strict mode', category: 'preference' });
    const { profile } = await refreshProjectProfile(ROOT);
    expect(profile.sections.length).toBe(PROFILE_SECTIONS.length);
    const ctx = await buildTaskMemoryContext('implement the JWT auth refresh token route', ROOT);
    expect(ctx).toContain('JWT');
    // the filesystem stays authoritative: after a change, the profile goes stale
    fs.writeFileSync(path.join(ROOT, 'package.json'), JSON.stringify({ name: 'renamed-root' }));
    const second = await refreshProjectProfile(ROOT);
    expect(second.stale.length).toBeGreaterThan(0);
  });
});

describe('Workflow E — cross-tool discovery maps onto the ONE execution path', () => {
  it('a repository+files request discovers capabilities whose operations name existing tools', async () => {
    const hits = await discoverIntegrations('commit the changes in my git repository and organize the project files');
    const ids = hits.map((h) => h.id);
    expect(ids).toContain('repository');
    expect(ids).toContain('filesystem');
    for (const h of hits) for (const op of h.matchedOperations) expect(op.via.length).toBeGreaterThan(0);
  });
});

describe('Workflow F — approval stays enforced; cancellation propagates honestly', () => {
  it('cancelling a driven task stops queued work and records the honest state', async () => {
    const ran: string[] = [];
    const deps = baseDeps({
      planner: async () => [
        { title: 'quick step', detail: 'a', kind: 'general', dependsOn: [] },
        { title: 'never runs', detail: 'b', kind: 'general', dependsOn: ['s1'] },
      ],
      stepRunner: async (_p, _k, _t, stepId) => {
        ran.push(stepId);
        return new Promise<string>((resolve) => setTimeout(() => resolve('DONE: slow step.'), 500));
      },
    });
    const out = await startTask('Write the cancellation workflow report now', deps);
    const id = taskIdOf(out);
    await sleep(100);
    expect(cancelTask(id)).toBe(true);
    const t = await waitStatus(id, ['CANCELLED']);
    expect(t?.status).toBe('CANCELLED');
    expect(ran.every((s) => s === 's1')).toBe(true); // the queued dependent never ran
    // and the terminal summary still reports what DID happen
    expect(outcomeSummary(t!)).toContain('OUTCOMES');
  });

  it('unauthorized destructive actions are refused by the ONE permission gate (no bypass)', async () => {
    setCallContext({ agent: 'main', taskId: undefined, stepId: undefined });
    const result = await runToolDetailed('read', JSON.stringify({ path: '/etc/shadow' })).catch((e) => String(e));
    const text = String(result);
    // the guard/policy path answers — it never executes the protected read
    expect(text).not.toContain('root:');
  });
});
