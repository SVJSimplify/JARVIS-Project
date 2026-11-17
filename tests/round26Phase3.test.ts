import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 26, PHASE 3 — ACCEPTANCE-DRIVEN COMPLETION (incl. the verification-integrity fix
 * spec'd for Round 25.2, integrated here).
 *
 * THE RULE UNDER TEST: an agent's assertion that work is complete is NOT evidence that
 * the work is complete. VERIFIED requires actual, task-appropriate evidence from the
 * existing model (disk-inspected deliverables, recorded successful check commands, or
 * fetched sources); partial evidence is PARTIAL; no evidence stays UNVERIFIED; failed
 * verification is FAILED; unsettled outcomes are UNKNOWN; and a verification record can
 * never validate output it did not verify (stale guard).
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import {
  startTask,
  upstreamResultsBlock,
  claimedDeliverables,
  checkStepDeliverables,
  outcomeSummary,
  type CoordinatorDeps,
  type PlanStep,
} from '../src/main/coordinator';
import {
  createTask,
  getTask,
  markStep,
  persistTask,
  resetTaskStoreForTests,
  setSteps,
  setStepVerification,
  stampStepResult,
  validVerification,
  type TaskRecord,
  type TaskStep,
  type StepVerification,
  type StepVerificationStatus,
} from '../src/main/taskStore';
import { resetCallContext } from '../src/main/toolRecord';
import { evaluateStepEvidence, type StepEvidenceFacts } from '../src/main/verifier';
import { buildTaskSpec } from '../src/main/taskSpec';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-r26p3-${process.pid}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const baseFacts = (over: Partial<StepEvidenceFacts> = {}): StepEvidenceFacts => ({
  report: 'DONE: everything works. VERIFIED: I checked it carefully. ISSUES: none.',
  failed: false,
  unresolved: [],
  ledger: [],
  claimedPaths: [],
  verifiedPaths: 0,
  missingPaths: [],
  ...over,
});

// --------------------------------------------------------------------- unit: statuses

describe('Phase 3 (25.2 fix) — status classification rejects unsupported VERIFIED', () => {
  it('1. an agent claiming completion without evidence → UNVERIFIED (the claim is not evidence)', () => {
    const r = evaluateStepEvidence(baseFacts());
    expect(r.status).toBe('unverified');
    expect(r.evidence).toContain('no independent evidence');
  });

  it('2. a successful final response (even with successful executions) without independent evidence → UNVERIFIED', () => {
    // "successful step execution" alone must never produce VERIFIED
    const r = evaluateStepEvidence(
      baseFacts({ ledger: [{ id: 'r1', tool: 'read', status: 'ok', args: 'path=notes.md', result: 'ok', t: Date.now(), ms: 3, agent: 'task:general#s1' } as never] })
    );
    expect(r.status).toBe('unverified');
    // agent-written "verified" claims change nothing
    const r2 = evaluateStepEvidence(baseFacts({ report: 'DONE: it works. VERIFIED: double-checked by me.' }));
    expect(r2.status).toBe('unverified');
  });

  it('3. an inspected file deliverable with sufficient evidence → VERIFIED', () => {
    const r = evaluateStepEvidence(baseFacts({ claimedPaths: ['out/report.md'], verifiedPaths: 1 }));
    expect(r.status).toBe('verified');
    expect(r.evidence).toContain('1/1 claimed deliverable(s) re-inspected on disk');
  });

  it('4. a failed report (including a failed test/build step) → FAILED', () => {
    const r = evaluateStepEvidence(baseFacts({ failed: true, report: 'FAILED: npm test — 3 tests failed (exit 1)' }));
    expect(r.status).toBe('failed');
    expect(r.evidence).toContain('npm test');
  });

  it('5. incomplete evidence (some requirements evidenced, others not) → PARTIALLY VERIFIED', () => {
    const r = evaluateStepEvidence(baseFacts({ claimedPaths: ['a.md', 'b.md'], verifiedPaths: 1, missingPaths: ['b.md'] }));
    expect(r.status).toBe('partial');
    // a successful check command with deliverables missing is still only PARTIAL
    const r2 = evaluateStepEvidence(
      baseFacts({
        claimedPaths: ['a.md'],
        verifiedPaths: 0,
        missingPaths: ['a.md'],
        ledger: [{ id: 'r2', tool: 'run_command', status: 'ok', args: 'command=npm test', result: 'exit 0\nall green', t: Date.now(), ms: 5, agent: 'x' } as never],
      })
    );
    expect(r2.status).toBe('partial');
  });

  it('6. missing evidence → UNVERIFIED (claimed deliverables absent from disk; empty errors change nothing)', () => {
    const r = evaluateStepEvidence(baseFacts({ claimedPaths: ['ghost.md'], verifiedPaths: 0, missingPaths: ['ghost.md'] }));
    expect(r.status).toBe('unverified');
    // verification attempted and inconclusive → UNKNOWN, never VERIFIED
    const r2 = evaluateStepEvidence(baseFacts({ unresolved: [{ id: 'R-7' }] }));
    expect(r2.status).toBe('unknown');
    expect(r2.observed).toContain('UNKNOWN outcomes');
  });

  it('task-appropriate evidence: a recorded successful test/build command verifies; research needs actually-fetched sources', () => {
    const r = evaluateStepEvidence(
      baseFacts({
        ledger: [{ id: 'r3', tool: 'verify_command', status: 'ok', args: 'command=npm run typecheck', result: 'exit 0\nclean', t: Date.now(), ms: 9, agent: 'verifier' } as never],
      })
    );
    expect(r.status).toBe('verified');
    expect(r.method).toContain('exit 0');
    const r2 = evaluateStepEvidence(
      baseFacts({
        ledger: [{ id: 'r4', tool: 'run_command', status: 'ok', args: 'command=echo hello', result: 'exit 0\nhello', t: Date.now(), ms: 2, agent: 'x' } as never],
      })
    );
    expect(r2.status).toBe('unverified'); // a random successful command is NOT check evidence
  });
});

// ------------------------------------------------------- integration: the real engine

describe('Phase 3 (25.2 fix) — the real engine classifies steps from evidence', () => {
  beforeEach(() => {
    resetTaskStoreForTests();
    resetCallContext();
    fs.rmSync(path.join(ROOT, 'brain', 'tasks'), { recursive: true, force: true });
  });

  afterEach(() => resetCallContext());

  const baseDeps = (over: Partial<CoordinatorDeps> = {}): CoordinatorDeps => ({
    run: async () => 'OK',
    schemas: () => [],
    planner: async () => [{ title: 'Do the work', detail: 'work', kind: 'general', dependsOn: [] }],
    ...over,
  });

  const waitTerminal = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const t = await getTask(id);
      if (t && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status)) return t;
      await sleep(40);
    }
    return await getTask(id);
  };

  it('a DONE report with no evidence is persisted UNVERIFIED — never auto-promoted', async () => {
    const deps = baseDeps({ stepRunner: async () => 'DONE: I completed the work. VERIFIED: everything checks out.' });
    const out = await startTask('Write the annual summary', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1]!;
    const t = (await waitTerminal(id))!;
    const v = t.steps[0]!.verification;
    expect(v?.status).toBe('unverified');
    expect(v?.evidence).toContain('no independent evidence');
    expect(v?.resultStamp).toBe(stampStepResult(t.steps[0]!.result));
  });

  it('a DONE report whose claimed file really exists is VERIFIED with the disk evidence', async () => {
    fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'out', 'summary.md'), '# Summary\nDone.');
    const deps = baseDeps({ stepRunner: async () => 'DONE: wrote out/summary.md with the annual summary. VERIFIED: see the file.' });
    const out = await startTask('Write out/summary.md with the annual summary', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1]!;
    const t = (await waitTerminal(id))!;
    expect(t.steps[0]!.verification?.status).toBe('verified');
    expect(t.steps[0]!.verification?.evidence).toContain('1/1 claimed deliverable(s) re-inspected on disk');
  });

  it('outcomeSummary counts verified/partial/unverified steps — stale records never inflate', async () => {
    const deps = baseDeps({ stepRunner: async () => 'DONE: claimed success with no evidence whatsoever.' });
    const out = await startTask('Write the annual summary now', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1]!;
    const t = (await waitTerminal(id))!;
    const line = outcomeSummary(t);
    // every step (incl. any appended verify-fix step) was a bare claim — nothing verified
    expect(line).toMatch(/steps verified\/partial\/unverified: 0\/0\/[1-9]/);
    expect(line).not.toContain('verified (acceptance checks passed)');
  });

  it('the planner brief carries per-step completion conditions (acceptance)', async () => {
    const prompts: string[] = [];
    const plan: PlanStep[] = [{ title: 'Do the work', detail: 'work', kind: 'general', dependsOn: [], acceptance: ['the file exists', 'the test passes'] }];
    const deps = baseDeps({
      planner: async () => plan,
      stepRunner: async (prompt) => {
        prompts.push(prompt);
        return 'DONE: did it.';
      },
    });
    const out = await startTask('Write the annual summary later today', deps);
    await waitTerminal(/Task (T-[\w]+)/.exec(out)![1]!);
    expect(prompts[0]).toContain('COMPLETION CONDITIONS');
    expect(prompts[0]).toContain('the file exists');
  });
});

// ------------------------------------------------------------- stale-verification guard

describe('Phase 3 (25.2 fix) — stale verification cannot validate changed output', () => {
  beforeEach(() => {
    resetTaskStoreForTests();
    fs.rmSync(path.join(ROOT, 'brain', 'tasks'), { recursive: true, force: true });
  });

  it('7. a retry that changes the output invalidates the old verification record', async () => {
    const t = await createTask(buildTaskSpec('retry me'), 'queued');
    await setSteps(t, [{ title: 'work once', detail: 'd', kind: 'general', dependsOn: [] }]);
    const s = t.steps[0]!;
    await markStep(t, s.id, { status: 'done', result: 'first output: v1' });
    await setStepVerification(t, s.id, {
      checkedAt: Date.now(),
      intended: 'x',
      action: 'a',
      toolResult: 'v1',
      observed: 'observed v1',
      method: 'disk re-inspection',
      evidence: 'v1 exists',
      status: 'verified',
    });
    expect(validVerification(s)?.status).toBe('verified');
    // the retry changes the result — the old record must NOT verify the new output
    await markStep(t, s.id, { status: 'done', result: 'second output: v2 (changed)' });
    expect(validVerification(s)).toBeUndefined();
    const block = upstreamResultsBlock(t, { ...s, dependsOn: [s.id], result: 'second output: v2 (changed)' });
    expect(block).toContain('UNVERIFIED');
    expect(block).not.toMatch(/UPSTREAM STATUS: VERIFIED/);
  });

  it('8. a valid verification record survives task restoration (persist → reload)', async () => {
    const t = await createTask(buildTaskSpec('durable verification'), 'queued');
    await setSteps(t, [{ title: 'stable work', detail: 'd', kind: 'general', dependsOn: [] }]);
    const s = t.steps[0]!;
    await markStep(t, s.id, { status: 'done', result: 'stable output: final' });
    await setStepVerification(t, s.id, {
      checkedAt: Date.now(),
      intended: 'x',
      action: 'a',
      toolResult: 'final',
      observed: 'observed on disk',
      method: 'disk re-inspection',
      evidence: 'the artifact exists',
      status: 'verified',
    });
    await persistTask(t);
    const id = t.id;
    resetTaskStoreForTests(); // simulate a restart: cache dropped, store reloaded from disk
    const restored = await getTask(id);
    const rs = restored!.steps[0]!;
    expect(rs.verification?.resultStamp).toBe(stampStepResult(rs.result));
    expect(validVerification(rs)?.status).toBe('verified');
  });
});

// -------------------------------------------------- Round 25.1 provenance stays intact

describe('Phase 3 — Round 25.1 dependency provenance remains intact', () => {
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
    if (s.verification && !s.verification.resultStamp) s.verification = { ...s.verification, resultStamp: stampStepResult(s.result) };
    return s;
  };
  const ver = (status: StepVerificationStatus, evidence = 'evidence line'): StepVerification => ({
    checkedAt: Date.now(),
    intended: 'i',
    action: 'a',
    toolResult: 'r',
    observed: 'observed',
    method: 'disk re-inspection',
    evidence,
    status,
  });
  const taskWith = (steps: TaskStep[]): TaskRecord =>
    ({
      id: 'T-R26',
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

  it('9. VERIFIED upstream results still carry status + evidence references downstream', () => {
    const t = taskWith([step('s1', 'general', { verification: ver('verified', '1/1 claimed deliverable(s) on disk') }), step('s2', 'coder', { dependsOn: ['s1'] })]);
    const block = upstreamResultsBlock(t, t.steps[1]!);
    expect(block).toContain('UPSTREAM STATUS: VERIFIED');
    expect(block).toContain('evidence: 1/1 claimed deliverable(s) on disk');
  });

  it('unverified / partial / failed upstream statuses render honestly (no silent promotion)', () => {
    const unverified = taskWith([step('s1', 'general', { verification: ver('unverified', 'no independent evidence recorded') }), step('s2', 'coder', { dependsOn: ['s1'] })]);
    expect(upstreamResultsBlock(unverified, unverified.steps[1]!)).toContain('not substantiated by independent evidence');
    const partial = taskWith([step('s1', 'general', { verification: ver('partial', '1/2 on disk') }), step('s2', 'coder', { dependsOn: ['s1'] })]);
    const pb = upstreamResultsBlock(partial, partial.steps[1]!);
    expect(pb).toContain('PARTIALLY VERIFIED');
    const failed = taskWith([step('s1', 'general', { verification: ver('failed', 'acceptance failed') }), step('s2', 'coder', { dependsOn: ['s1'] })]);
    expect(upstreamResultsBlock(failed, failed.steps[1]!)).toContain('UPSTREAM STATUS: FAILED');
  });

  it('claimedDeliverables excludes the coordinator\u2019s own DELIVERABLE CHECK block', () => {
    const report = 'DONE: wrote out/a.md and out/b.md\n\n[DELIVERABLE CHECK: 0/2 claimed file(s) verified on disk — NOT FOUND: out/a.md, out/b.md.]';
    expect(claimedDeliverables(report)).toEqual(['out/a.md', 'out/b.md']);
  });

  it('checkStepDeliverables still flags missing claims (existing behavior preserved)', async () => {
    const flagged = await checkStepDeliverables('DONE: wrote totally-missing-thing.md');
    expect(flagged).toContain('DELIVERABLE CHECK');
    expect(flagged).toContain('NOT FOUND');
  });
});
