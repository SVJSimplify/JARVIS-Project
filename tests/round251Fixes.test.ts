import os from 'os';
import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * ROUND 25.1 — FOCUSED REGRESSION TESTS FOR THE FOUR SURGICAL FIXES.
 *
 * FIX #1 — write-safe parallel waves: the coordinator's wave scheduler enforces the
 *          read-only / write-capable distinction at SCHEDULING time (registry action
 *          ceilings, not prompts): readers may share a wave, a writer never shares one.
 * FIX #2 — dependency result verification provenance: injected upstream results carry
 *          their persisted verification status (VERIFIED / UNVERIFIED / FAILED /
 *          PARTIALLY VERIFIED) with evidence references — never a silent pass.
 * FIX #3 — dynamic-agent retirement and run counts persist; persistence is serialized
 *          and observable (no stale-write race, no false "durable success").
 *
 * (FIX #4 — behavior preservation — is pinned by the UNCHANGED Round 25 suite and the
 * full pre-existing regression suite, which must pass without modification.)
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import {
  startTask,
  writeSafeWave,
  upstreamResultsBlock,
  type CoordinatorDeps,
  type PlanStep,
} from '../src/main/coordinator';
import { getTask, resetTaskStoreForTests, stampStepResult, type TaskRecord, type TaskStep, type StepVerification, type StepVerificationStatus } from '../src/main/taskStore';
import { resetCallContext, setCallContext } from '../src/main/toolRecord';
import { runToolDetailed } from '../src/main/tools';
import {
  registerDynamicAgent,
  getDynamicAgent,
  retireDynamicAgent,
  noteDynamicRun,
  persistDynamicAgents,
  restoreDynamicAgents,
  resetDynamicAgentsForTests,
  dynamicRosterPersistState,
} from '../src/main/agentRegistry';
import { resetAgentTrackerForTests } from '../src/main/agentTracker';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-r251-${process.pid}`);
const rosterFile = (): string => path.join(ROOT, 'brain', 'agents', 'dynamic.json');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetTaskStoreForTests();
  resetDynamicAgentsForTests();
  resetAgentTrackerForTests();
  resetCallContext();
  fs.rmSync(path.join(ROOT, 'brain', 'tasks'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'brain', 'agents'), { recursive: true, force: true });
});

afterEach(() => {
  resetCallContext();
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

// ---------------------------------------------------------------- fixtures (unit tests)

const step = (id: string, kind: string, over: Partial<TaskStep> = {}): TaskStep => {
  const s: TaskStep = {
    id,
    title: `step ${id}`,
    detail: 'd',
    dependsOn: [],
    kind,
    status: 'done',
    result: `result of ${id}`,
    attempts: 1,
    ...over,
  };
  // Round 26 Phase 3: the engine stamps every persisted verification record with the
  // digest of the verified result. The fixture mirrors the setter so unit fixtures keep
  // exercising the provenance rendering (assertions unchanged).
  if (s.verification && !s.verification.resultStamp) {
    s.verification = { ...s.verification, resultStamp: stampStepResult(s.result) };
  }
  return s;
};

const ver = (status: StepVerificationStatus, evidence = 'evidence line'): StepVerification => ({
  checkedAt: Date.now(),
  intended: 'i',
  action: 'a',
  toolResult: 'r',
  observed: 'the state was observed after the run',
  method: 'durable tool ledger + deliverable re-inspection on disk',
  evidence,
  status,
});

const taskWith = (steps: TaskStep[]): TaskRecord =>
  ({
    id: 'T-FIX',
    spec: { objective: 'o', request: 'o' },
    status: 'RUNNING',
    steps,
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
  }) as unknown as TaskRecord;

// ============================================================== FIX #1 — write-safe waves

describe('FIX #1 — the wave scheduler enforces write safety (scheduling time, not prompts)', () => {
  it('unit: two independent READ-ONLY steps share a wave — parallelism remains possible where safe', () => {
    const wave = writeSafeWave([step('s1', 'explore'), step('s2', 'research')]);
    expect(wave.map((s) => s.id)).toEqual(['s1', 's2']);
    // the permanent read-only specialists parallel too
    const wave2 = writeSafeWave([step('s1', 'reviewer'), step('s2', 'planner')]);
    expect(wave2.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('unit: read-only waves stay bounded by the existing parallelism limit (MAX_PARALLEL_STEPS = 2)', () => {
    const wave = writeSafeWave([step('s1', 'explore'), step('s2', 'explore'), step('s3', 'explore')]);
    expect(wave.map((s) => s.id)).toEqual(['s1', 's2']); // third waits for the next wave
  });

  it('unit: two WRITE-CAPABLE steps never share a wave', () => {
    const wave = writeSafeWave([step('s1', 'general'), step('s2', 'coder')]);
    expect(wave.map((s) => s.id)).toEqual(['s1']);
  });

  it('unit: a write-capable step never joins a wave that already collected readers (and vice versa)', () => {
    // reader first: the wave stops AT the writer; the writer leads the next wave
    const a = writeSafeWave([step('s1', 'explore'), step('s2', 'general'), step('s3', 'explore')]);
    expect(a.map((s) => s.id)).toEqual(['s1']);
    // writer first: solo wave even though readers follow
    const b = writeSafeWave([step('s1', 'general'), step('s2', 'explore')]);
    expect(b.map((s) => s.id)).toEqual(['s1']);
    // execute-capable agents (verifier runs commands) are write-capable for scheduling
    const c = writeSafeWave([step('s1', 'verifier'), step('s2', 'explore')]);
    expect(c.map((s) => s.id)).toEqual(['s1']);
  });

  it('unit: an UNKNOWN kind is treated as write-capable (fails safe, never parallel)', () => {
    const wave = writeSafeWave([step('s1', 'mystery-kind'), step('s2', 'explore')]);
    expect(wave.map((s) => s.id)).toEqual(['s1']);
  });

  it('two independent write-capable steps CANNOT execute in parallel — both still complete, in plan order', async () => {
    const events: Array<{ step: string; phase: 'start' | 'end'; at: number }> = [];
    let maxConcurrent = 0;
    let current = 0;
    const plan: PlanStep[] = [
      { title: 'Write the report', detail: 'write', kind: 'general', dependsOn: [] },
      { title: 'Build the dataset', detail: 'build', kind: 'coder', dependsOn: [] },
    ];
    const deps = baseDeps({
      planner: async () => plan,
      stepRunner: async (_prompt, _kind, task, stepId, signal) => {
        events.push({ step: stepId, phase: 'start', at: Date.now() });
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await sleep(120);
        if (signal.aborted) {
          current--;
          throw new Error('cancelled');
        }
        current--;
        events.push({ step: stepId, phase: 'end', at: Date.now() });
        await realEvidence(task.id, stepId);
        return 'DONE: work; VERIFIED: re-read';
      },
    });
    const out = await startTask('Scan two folders and merge the results into a summary file', deps);
    const t = await waitTerminal(taskIdOf(out));
    expect(t!.status).toBe('COMPLETED');
    expect(t!.steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(maxConcurrent).toBe(1); // the two writers were serialized by the scheduler
    const s1End = events.find((e) => e.step === 's1' && e.phase === 'end')!;
    const s2Start = events.find((e) => e.step === 's2' && e.phase === 'start')!;
    expect(s2Start.at).toBeGreaterThanOrEqual(s1End.at); // FIFO order preserved, no overlap
  });

  it('a read-only step and a write-capable step cannot overlap (the reader could observe a half-written workspace)', async () => {
    let maxConcurrent = 0;
    let current = 0;
    const plan: PlanStep[] = [
      { title: 'Read the workspace', detail: 'read', kind: 'explore', dependsOn: [] },
      { title: 'Rewrite the config', detail: 'write', kind: 'general', dependsOn: [] },
    ];
    const deps = baseDeps({
      planner: async () => plan,
      stepRunner: async (_prompt, _kind, task, stepId, signal) => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await sleep(120);
        if (signal.aborted) {
          current--;
          throw new Error('cancelled');
        }
        current--;
        await realEvidence(task.id, stepId);
        return stepId === 's1' ? 'FOUND: state; ANSWER: reported' : 'DONE: wrote; VERIFIED: re-read';
      },
    });
    const out = await startTask('Read the workspace state and rewrite the config file', deps);
    const t = await waitTerminal(taskIdOf(out));
    expect(t!.status).toBe('COMPLETED');
    expect(t!.steps.map((s) => s.status)).toEqual(['done', 'done']);
    expect(maxConcurrent).toBe(1); // the writer ran alone; the reader never overlapped it
  });

  it('two independent read-only steps STILL execute in parallel after the fix', async () => {
    let maxConcurrent = 0;
    let current = 0;
    const plan: PlanStep[] = [
      { title: 'Scan folder A', detail: 'list a', kind: 'explore', dependsOn: [] },
      { title: 'Scan folder B', detail: 'list b', kind: 'research', dependsOn: [] },
    ];
    const deps = baseDeps({
      planner: async () => plan,
      stepRunner: async (_prompt, _kind, task, stepId, signal) => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await sleep(150);
        if (signal.aborted) {
          current--;
          throw new Error('cancelled');
        }
        current--;
        await realEvidence(task.id, stepId);
        return 'FOUND: things; ANSWER: reported';
      },
    });
    const out = await startTask('Scan folder A and scan folder B, then merge the results into a summary file', deps);
    const t = await waitTerminal(taskIdOf(out));
    expect(t!.status).toBe('COMPLETED');
    expect(maxConcurrent).toBe(2); // safe parallelism preserved
  });

  it('existing dependency ordering still works for write-capable chains (dependent step starts only after its dependency ends)', async () => {
    const events: Array<{ step: string; phase: 'start' | 'end'; at: number }> = [];
    const plan: PlanStep[] = [
      { title: 'Write the module', detail: 'write', kind: 'general', dependsOn: [] },
      { title: 'Test the module', detail: 'test', kind: 'coder', dependsOn: ['s1'] },
    ];
    const deps = baseDeps({
      planner: async () => plan,
      stepRunner: async (_prompt, _kind, task, stepId, signal) => {
        events.push({ step: stepId, phase: 'start', at: Date.now() });
        await sleep(stepId === 's1' ? 120 : 20);
        if (signal.aborted) throw new Error('cancelled');
        events.push({ step: stepId, phase: 'end', at: Date.now() });
        await realEvidence(task.id, stepId);
        return 'DONE: work; VERIFIED: re-read';
      },
    });
    const out = await startTask('Scan two folders and merge the results into a summary file', deps);
    const t = await waitTerminal(taskIdOf(out));
    expect(t!.status).toBe('COMPLETED');
    expect(t!.steps.map((s) => s.status)).toEqual(['done', 'done']);
    const s1End = events.find((e) => e.step === 's1' && e.phase === 'end')!;
    const s2Start = events.find((e) => e.step === 's2' && e.phase === 'start')!;
    expect(s2Start.at).toBeGreaterThanOrEqual(s1End.at);
  });
});

// ==================================================== FIX #2 — verification provenance

describe('FIX #2 — dependency results carry honest verification provenance', () => {
  it('unit: a VERIFIED upstream result is passed with its verified status and evidence reference', () => {
    const t = taskWith([
      step('s1', 'general', { verification: ver('verified', 'every claimed path exists on disk') }),
      step('s2', 'coder', { dependsOn: ['s1'] }),
    ]);
    const block = upstreamResultsBlock(t, t.steps[1]);
    expect(block).toContain('UPSTREAM RESULTS');
    expect(block).toContain('RESULT OF "step s1"');
    expect(block).toContain('UPSTREAM STATUS: VERIFIED');
    expect(block).toContain('evidence: every claimed path exists on disk');
    expect(block).toContain('re-verify'); // downstream is told what VERIFIED does and does not cover
  });

  it('unit: an UNVERIFIED upstream result (no record / unknown outcome) is explicitly marked unverified — never silently verified', () => {
    const noRecord = taskWith([step('s1', 'general'), step('s2', 'coder', { dependsOn: ['s1'] })]);
    const b1 = upstreamResultsBlock(noRecord, noRecord.steps[1]);
    expect(b1).toContain('UPSTREAM STATUS: UNVERIFIED');
    expect(b1).not.toContain('VERIFIED (');
    expect(b1).not.toMatch(/UPSTREAM STATUS: VERIFIED/);

    const unknownOutcome = taskWith([
      step('s1', 'general', { verification: ver('unknown', 'unresolved receipt(s): R-1') }),
      step('s2', 'coder', { dependsOn: ['s1'] }),
    ]);
    const b2 = upstreamResultsBlock(unknownOutcome, unknownOutcome.steps[1]);
    expect(b2).toContain('UPSTREAM STATUS: UNVERIFIED');
    expect(b2).toContain('could not be confirmed');
    expect(b2).not.toMatch(/UPSTREAM STATUS: VERIFIED/);
  });

  it('unit: a FAILED or PARTIALLY VERIFIED result is never presented as successful-and-verified; a failed STEP is excluded entirely', () => {
    const failedVerification = taskWith([
      step('s1', 'general', { verification: ver('failed', 'acceptance check did not pass') }),
      step('s2', 'coder', { dependsOn: ['s1'] }),
    ]);
    const b1 = upstreamResultsBlock(failedVerification, failedVerification.steps[1]);
    expect(b1).toContain('UPSTREAM STATUS: FAILED');
    expect(b1).toContain('do not treat this result as a success');
    expect(b1).not.toMatch(/UPSTREAM STATUS: VERIFIED/);

    const partial = taskWith([
      step('s1', 'general', { verification: ver('executed', 'partial evidence') }),
      step('s2', 'coder', { dependsOn: ['s1'] }),
    ]);
    const b2 = upstreamResultsBlock(partial, partial.steps[1]);
    expect(b2).toContain('PARTIALLY VERIFIED');
    expect(b2).toContain('unverified information');
    expect(b2).not.toMatch(/UPSTREAM STATUS: VERIFIED/);

    // a step that FAILED outright never enters the block at all (existing behavior preserved)
    const failedStep = taskWith([
      step('s1', 'general', { status: 'failed', result: 'FAILED: boom' }),
      step('s2', 'coder', { dependsOn: ['s1'] }),
    ]);
    const b3 = upstreamResultsBlock(failedStep, failedStep.steps[1]);
    expect(b3).toBe('');
    // a skipped dependency is explicitly a non-evidence
    const skipped = taskWith([
      step('s1', 'general', { status: 'skipped', result: 'SKIPPED: dependency failed' }),
      step('s2', 'coder', { dependsOn: ['s1'] }),
    ]);
    const b4 = upstreamResultsBlock(skipped, skipped.steps[1]);
    expect(b4).toContain('SKIPPED');
    expect(b4).toContain('UNVERIFIED');
  });

  it('integration: the REAL execution flow injects the persisted verification status into the dependent step brief', async () => {
    const prompts: Record<string, string> = {};
    const plan: PlanStep[] = [
      { title: 'Find the config', detail: 'locate', kind: 'explore', dependsOn: [] },
      { title: 'Patch the config', detail: 'edit it', kind: 'coder', dependsOn: ['s1'] },
    ];
    // Round 26 Phase 3: a claimed deliverable must EXIST for the step to verify — the
    // fixture provides the real file so the claim is backed by actual disk evidence.
    fs.mkdirSync(path.join(ROOT, 'app'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'app', 'settings.json'), '{ "mode": "prod" }');
    const deps = baseDeps({
      planner: async () => plan,
      stepRunner: async (_prompt, _kind, _task, stepId) =>
        stepId === 's1' ? 'FOUND: config at app/settings.json; ANSWER: the config lives there' : 'DONE: patched; VERIFIED: re-read',
    });
    const deps2: CoordinatorDeps = {
      ...deps,
      stepRunner: async (prompt, kind, t, stepId, signal) => {
        prompts[stepId] = prompt;
        return deps.stepRunner!(prompt, kind, t, stepId, signal);
      },
    };
    const out = await startTask('Find the config file and patch the config file accordingly', deps2);
    await waitTerminal(taskIdOf(out));
    expect(prompts.s2).toContain('UPSTREAM RESULTS');
    expect(prompts.s2).toContain('RESULT OF "Find the config"');
    expect(prompts.s2).toContain('config at app/settings.json'); // the result text is still injected (existing behavior)
    expect(prompts.s2).toMatch(/UPSTREAM STATUS: VERIFIED/); // with its persisted verification status
    expect(prompts.s1).not.toContain('UPSTREAM RESULTS'); // scoping unchanged
  });
});

// ============================================== FIX #3 — durable retirement & run counts

describe('FIX #3 — dynamic-agent retirement and run counts persist (serialized, observable)', () => {
  it('retire PERSISTS: register → retire → restore does NOT resurrect the retired agent', async () => {
    const def = registerDynamicAgent({ name: 'ephemeral', purpose: 'one bounded job', tools: ['read', 'grep'] }, 'task:T-1:s1');
    expect(await dynamicRosterPersistState()).toBe(true); // registration landed durably
    expect(retireDynamicAgent(def.name)).toBe(true);
    expect(await dynamicRosterPersistState()).toBe(true); // the REMOVAL landed durably too
    expect(getDynamicAgent(def.name)).toBeUndefined();
    resetDynamicAgentsForTests(); // simulate a restart (memory wiped)
    expect(await restoreDynamicAgents()).toBe(0);
    expect(getDynamicAgent(def.name)).toBeUndefined(); // not resurrected
  });

  it('run-count updates PERSIST: restored run counts reflect the latest persisted state', async () => {
    const def = registerDynamicAgent({ name: 'counter', purpose: 'reused specialist', tools: ['read'] }, 'main');
    noteDynamicRun(def.name);
    noteDynamicRun(def.name);
    expect(await dynamicRosterPersistState()).toBe(true);
    resetDynamicAgentsForTests();
    expect(await restoreDynamicAgents()).toBe(1);
    expect(getDynamicAgent(def.name)!.runs).toBe(2);
  });

  it('simultaneous mutations serialize: the LAST state always wins on disk (no stale-write race)', async () => {
    const a = registerDynamicAgent({ name: 'alpha', purpose: 'a', tools: ['read'] }, 'main');
    noteDynamicRun(a.name);
    registerDynamicAgent({ name: 'beta', purpose: 'b', tools: ['read'] }, 'main');
    expect(retireDynamicAgent(a.name)).toBe(true);
    expect(await dynamicRosterPersistState()).toBe(true);
    resetDynamicAgentsForTests();
    expect(await restoreDynamicAgents()).toBe(1);
    expect(getDynamicAgent(a.name)).toBeUndefined(); // retired AFTER the run bump: stays retired
    expect(getDynamicAgent('dyn_beta')).toBeDefined(); // registered later: present
  });

  it('persistence FAILURE is observable — no falsely reported durable success', async () => {
    const def = registerDynamicAgent({ name: 'victim', purpose: 'p', tools: ['read'] }, 'main');
    noteDynamicRun(def.name);
    expect(await dynamicRosterPersistState()).toBe(true); // every write so far landed
    // Now make the target path unwritable: a DIRECTORY sits where the file must be.
    fs.rmSync(rosterFile(), { force: true });
    fs.mkdirSync(rosterFile(), { recursive: true });
    noteDynamicRun(def.name); // fires a background persist against the obstruction...
    expect(await dynamicRosterPersistState()).toBe(false); // honestly reported, not "saved"
    // recovery: remove the obstruction and the next write lands, carrying the latest run count
    fs.rmdirSync(rosterFile());
    expect(await persistDynamicAgents()).toBe(true);
    resetDynamicAgentsForTests();
    await restoreDynamicAgents();
    expect(getDynamicAgent(def.name)!.runs).toBe(2);
  });

  it('no-op mutations write nothing: retiring an unknown agent neither changes nor persists state', async () => {
    // Order-independent: if a no-op triggered a persist, a NEW promise would be appended
    // to the chain — the tail reference would change. Same reference ⇒ no write fired.
    const tailBefore = dynamicRosterPersistState();
    expect(retireDynamicAgent('never-registered')).toBe(false);
    noteDynamicRun('never-registered'); // unknown name: no state change...
    expect(getDynamicAgent('never-registered')).toBeUndefined();
    expect(dynamicRosterPersistState()).toBe(tailBefore); // ...and no write was triggered
    await tailBefore;
  });

  it('explicit persist + restore keeps the existing round-trip behavior (registration unchanged)', async () => {
    const def = registerDynamicAgent({ name: 'classic', purpose: 'investigate the exporter', tools: ['read', 'grep'], maxRounds: 9 }, 'task:T-9:s2');
    expect(await persistDynamicAgents()).toBe(true);
    resetDynamicAgentsForTests();
    expect(await restoreDynamicAgents()).toBe(1);
    const rec = getDynamicAgent(def.name);
    expect(rec).toBeDefined();
    expect(rec!.def.responsibility).toBe(def.responsibility);
    expect(rec!.parent).toBe('task:T-9:s2');
    expect(rec!.runs).toBe(0);
  });
});
