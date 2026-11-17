import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildTaskSpec, specPrompt, type TaskSpec } from '../src/main/taskSpec';
import {
  canTransition,
  claimTask,
  createTask,
  getTask,
  getTaskPrompt,
  LEGAL_TRANSITIONS,
  listTasks,
  markStep,
  nextEligibleSteps,
  reconcileInterruptedSteps,
  releaseClaim,
  renewClaim,
  resetTaskStoreForTests,
  setSteps,
  stepEligible,
  stepsComplete,
  transition,
  type TaskRecord,
} from '../src/main/taskStore';

beforeEach(() => {
  resetTaskStoreForTests();
  // Isolation: tasks of an earlier test live on disk in the shared tmp workspace and would
  // reappear in later tests via boot loading (the store is durable by design).
  fs.rmSync(path.join(process.env.JARVIS_FILES_ROOT ?? '/tmp', 'brain', 'tasks'), { recursive: true, force: true });
});

describe('TaskSpec (Module A) — structure from natural language', () => {
  it('a plain question stays informational with no ceremony', () => {
    const s = buildTaskSpec('What is the capital of Australia?');
    expect(s.kind).toBe('informational');
    expect(s.risk).toBe('low');
    expect(s.needsClarification).toBe(false);
    expect(s.acceptance).toHaveLength(0);
    expect(s.deliverables).toContain('a direct answer');
  });

  it('a file-creation request derives file acceptance criteria and a medium/low risk', () => {
    const s = buildTaskSpec('Create a summary report of my notes in report.md');
    expect(s.kind).toBe('action');
    expect(s.acceptance.map((a) => a.kind)).toEqual(expect.arrayContaining(['file-exists', 'file-nonempty', 'file-format']));
    expect(s.deliverables.some((d) => d.includes('saved file'))).toBe(true);
    expect(s.risk).toBe('low');
  });

  it('research requests require at least two actually-fetched sources', () => {
    const s = buildTaskSpec('Research the current market for robot vacuum cleaners and write a report');
    const src = s.acceptance.find((a) => a.kind === 'sources-present');
    expect(src?.min).toBe(2);
    expect(s.capabilities).toContain('research');
  });

  it('code work derives a command-passes criterion', () => {
    const s = buildTaskSpec('Fix the bug in my python script');
    expect(s.capabilities).toContain('code');
    expect(s.acceptance.some((a) => a.kind === 'command-passes')).toBe(true);
  });

  it('high-risk vocabulary raises the risk class only for action tasks', () => {
    expect(buildTaskSpec('What does the registry key do?').risk).toBe('low');
    expect(buildTaskSpec('Uninstall that program and clean the registry').risk).toBe('high');
  });

  it('clarification fires only for action tasks with a blocking gap, never for questions', () => {
    const send = buildTaskSpec('Send an email saying I will be late');
    expect(send.needsClarification).toBe(true);
    expect(send.clarification).toMatch(/Where should it go/);
    expect(buildTaskSpec('What should I send to the team?').needsClarification).toBe(false);
    expect(buildTaskSpec('Write a poem about the sea').needsClarification).toBe(false);
  });

  it('constraints are extracted from explicit negatives, and the request stays verbatim', () => {
    const s = buildTaskSpec('Create the budget spreadsheet without using formulas, do not touch last year numbers');
    expect(s.constraints.length).toBeGreaterThanOrEqual(2);
    expect(s.request).toBe('Create the budget spreadsheet without using formulas, do not touch last year numbers');
  });

  it('specPrompt is a compact block for the model', () => {
    const p = specPrompt(buildTaskSpec('Create a report in notes/report.md about the Q3 sales without guessing numbers'));
    expect(p).toContain('TASK OBJECTIVE');
    expect(p).toContain('ACCEPTANCE');
    expect(p).toContain('CONSTRAINTS');
  });
});

describe('TaskStore (Module B) — the durable state machine', () => {
  it('only legal transitions pass; illegal ones throw', async () => {
    const t = await createTask(buildTaskSpec('Create a file'), 'test');
    expect(canTransition('CREATED', 'RUNNING')).toBe(false);
    await expect(transition(t, 'RUNNING')).rejects.toThrow(/Illegal task transition/);
    await transition(t, 'PLANNING');
    await transition(t, 'READY');
    await transition(t, 'RUNNING');
    await transition(t, 'VERIFYING');
    await transition(t, 'COMPLETED');
    expect(t.status).toBe('COMPLETED');
    expect(t.endedAt).toBeGreaterThan(0);
  });

  it('every ACTIVE status can reach CANCELLED or FAILED except terminals', () => {
    for (const [from, tos] of Object.entries(LEGAL_TRANSITIONS) as Array<[keyof typeof LEGAL_TRANSITIONS, string[]]>) {
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(from)) {
        expect(tos).toHaveLength(0);
      } else {
        expect(tos).toContain('CANCELLED');
      }
    }
  });

  it('tasks persist to disk and reload with boot reconciliation marking RUNNING as INTERRUPTED', async () => {
    const t = await createTask(buildTaskSpec('Create a file'), 'persist');
    await transition(t, 'READY');
    await transition(t, 'RUNNING', 'working');
    // Simulate a restart: clear the in-memory cache, reload from disk.
    resetTaskStoreForTests();
    const again = await getTask(t.id);
    expect(again?.status).toBe('INTERRUPTED');
    expect(again?.owner).toBe('');
    expect(again?.history.some((h) => h.note === 'boot reconciliation')).toBe(true);
    // INTERRUPTED is resumable, never terminal.
    expect(canTransition('INTERRUPTED', 'READY')).toBe(true);
  });

  it('steps support dependencies and eligibility ordering', async () => {
    const t = await createTask(buildTaskSpec('Create a file'), 'deps');
    await setSteps(t, [
      { title: 'fetch data', detail: 'read the sources' },
      { title: 'write the report', dependsOn: ['s1'] },
      { title: 'verify the report', dependsOn: ['s2'] },
    ]);
    expect(t.steps.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(nextEligibleSteps(t).map((s) => s.id)).toEqual(['s1']);
    await markStep(t, 's1', { status: 'done', result: 'got it' });
    expect(nextEligibleSteps(t).map((s) => s.id)).toEqual(['s2']);
    expect(stepEligible(t, t.steps[2])).toBe(false);
    await markStep(t, 's2', { status: 'done' });
    await markStep(t, 's3', { status: 'done' });
    expect(stepsComplete(t)).toBe(true);
    expect(t.steps[1].attempts).toBe(1);
  });

  it('ownership claims are exclusive and stale claims break (F-18 lease tokens)', async () => {
    const t = await createTask(buildTaskSpec('Create a file'), 'claim');
    const token1 = await claimTask(t, 'turn:1');
    expect(typeof token1).toBe('string'); // claims return a LEASE TOKEN, not a boolean
    expect(await claimTask(t, 'turn:2')).toBe(null); // fresh claim held by turn:1
    await releaseClaim(t, 'turn:1', token1 ?? undefined);
    expect(await claimTask(t, 'turn:2')).toBeTruthy();
    // A stale owner (older than the freshness window) does not block a new claim.
    const t2 = await createTask(buildTaskSpec('Create a file'), 'stale');
    await claimTask(t2, 'turn:dead');
    t2.ownerSince = Date.now() - 11 * 60 * 1000;
    expect(await claimTask(t2, 'turn:fresh')).toBeTruthy();
    // A non-holder cannot renew or release the lease (token required).
    const t3 = await createTask(buildTaskSpec('Create a file'), 'token');
    const tok3 = await claimTask(t3, 'coordinator');
    await expect(renewClaim(t3, 'coordinator', 'wrong-token')).resolves.toBe(false);
    await expect(renewClaim(t3, 'coordinator', tok3 ?? '')).resolves.toBe(true);
    await releaseClaim(t3, 'coordinator', 'wrong-token');
    expect(t3.owner).toBe('coordinator'); // wrong token releases nothing
    await releaseClaim(t3, 'coordinator', tok3 ?? undefined);
    expect(t3.owner).toBe('');
  });

  it('getTaskPrompt lists active tasks and recent completions for the system prompt', async () => {
    expect(await getTaskPrompt()).toBe('');
    const t = await createTask(buildTaskSpec('Create a file'), 'prompt');
    await transition(t, 'READY');
    const p = await getTaskPrompt();
    expect(p).toContain('DURABLE TASKS');
    expect(p).toContain(t.id);
    expect(p).toContain('READY');
  });

  it('malformed store files are dropped, not fatal', async () => {
    const { promises: fs } = await import('fs');
    const { FILES_ROOT } = await import('../src/main/workspace');
    const dir = `${FILES_ROOT}/brain/tasks`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/task-T-bad.json`, '{not json');
    await fs.writeFile(`${dir}/task-T-shape.json`, JSON.stringify({ nope: true }));
    resetTaskStoreForTests();
    const all: TaskRecord[] = await listTasks();
    expect(Array.isArray(all)).toBe(true);
  });
});
