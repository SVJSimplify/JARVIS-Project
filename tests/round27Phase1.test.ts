import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 27, PHASE 1 — ROUND 26 RELIABILITY & INTEGRITY FIXES.
 *
 * §1.1  Durable recurring-run lifecycle: every occurrence has a durable identity
 *       (PENDING → RUNNING → COMPLETED/FAILED), crash windows are reconciled honestly at
 *       startup (pending-but-never-started occurrences re-arm; abandoned RUNNING
 *       executions are NEVER silently rerun), completed occurrences are never repeated,
 *       and schedule advancement stays consistent with execution state.
 * §1.2  Target-aware browser action verification: the intended element's identity and the
 *       declared expected result travel with the observation — a page change alone is
 *       NEVER a verified outcome.
 * §1.3  Operations Control Center backend: the overview/detail projections read ONLY real
 *       durable state, and the controls run the SAME authorized tools.
 * §1.4  Integration connection-state accuracy: the honest 8-state lifecycle — a stored
 *       connection record is CONNECTED, never AUTHENTICATED/AVAILABLE; availability is
 *       earned by recorded checks; EXPIRED/ERROR are reported, not invented away.
 * §1.5  Durable episodic memory: a durable pending-episode outbox survives crashes,
 *       drains with dedupe and bounded retries, and never blocks task completion.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import {
  addRecurring,
  listRecurring,
  listRecurringRuns,
  dropRecurringCacheForTests,
  dropRecurringRunCacheForTests,
  recoverRecurringRuns,
  resetSchedulerForTests,
  registerScheduledRunner,
  tick,
  type RecurringRunRecord,
} from '../src/main/scheduler';
import {
  connectionState,
  recordIntegrationCheck,
  registerIntegrationExecutor,
  runIntegrationHealthCheck,
  validateIntegration,
  integrationTools,
} from '../src/main/integrations';
import { queueEpisode, processPendingEpisodes, pendingEpisodeSummary, recallEpisodes, pendingEpisodeStoreFile, episodeStoreFile, waitForDrainIdleForTests } from '../src/main/episodicMemory';
import { opsOverview, opsTaskDetail, opsTaskAction } from '../src/main/opsCenter';
import { createTask, getTask, setSteps, markStep, setStepVerification, resetTaskStoreForTests, type StepVerification } from '../src/main/taskStore';
import { buildTaskSpec } from '../src/main/taskSpec';
import { verifyAction, actionVerifyLine } from '../src/main/externalContent';
import { noteInvocationEvent, resetInvocationsForTests } from '../src/main/invocations';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-r27p1-${process.pid}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const runsFile = (): string => path.join(ROOT, 'recurring-runs.json');

/** Write a run record DIRECTLY to the store, simulating a state a crash left behind. */
const writeRunRecords = async (records: RecurringRunRecord[]): Promise<void> => {
  fs.mkdirSync(path.dirname(runsFile()), { recursive: true });
  fs.writeFileSync(runsFile(), JSON.stringify(records, null, 1));
};

beforeEach(() => {
  resetSchedulerForTests();
  resetTaskStoreForTests();
  resetInvocationsForTests();
  fs.rmSync(path.join(ROOT, 'brain', 'episodes.json'), { force: true });
  fs.rmSync(path.join(ROOT, 'brain', 'pending-episodes.json'), { force: true });
  fs.rmSync(path.join(ROOT, 'brain', 'integrations.json'), { force: true });
  fs.rmSync(runsFile(), { force: true });
  delete process.env.GITHUB_TOKEN;
  delete process.env.DATABASE_URL;
  registerIntegrationExecutor(async () => ({ ok: false, detail: 'no executor in this test' }));
});

// ------------------------------------------------------------------ §1.1 durable recurring execution

describe('R27 §1.1 — durable recurring-run lifecycle', () => {
  it('every occurrence gets a durable record BEFORE execution, and the lifecycle is PENDING → RUNNING → COMPLETED', async () => {
    const seen: string[] = [];
    registerScheduledRunner(async (text) => {
      // while the runner is executing, the record must already be RUNNING on disk
      const onDisk = JSON.parse(fs.readFileSync(runsFile(), 'utf-8')) as RecurringRunRecord[];
      seen.push(onDisk.find((r) => r.status === 'running')?.status ?? 'none');
      return `ran: ${text.includes('health check') ? 'ok' : '?'}`;
    });
    const t = await addRecurring('run the project health check', { kind: 'interval', minutes: 5 });
    const occurrence = t.nextDue = Date.now() - 1000;
    const stored = (await listRecurring()).find((x) => x.id === t.id)!;
    stored.nextDue = occurrence;
    await tick(Date.now());
    const runs = await listRecurringRuns(t.id);
    expect(runs.length).toBe(1);
    expect(runs[0]!.occurrence).toBe(occurrence); // durable identity = the scheduled occurrence
    expect(runs[0]!.status).toBe('completed');
    expect(runs[0]!.startedAt).toBeGreaterThan(0);
    expect(runs[0]!.finishedAt).toBeGreaterThan(runs[0]!.startedAt);
    expect(runs[0]!.attempts).toBe(1);
    expect(runs[0]!.reply).toContain('ok');
    expect(seen).toEqual(['running']); // RUNNING was durable while the side effect ran
  });

  it('crash after PENDING creation (before execution): startup recovery re-arms the occurrence and it runs exactly once', async () => {
    let calls = 0;
    registerScheduledRunner(async () => {
      calls++;
      return 'recovered work done';
    });
    const t = await addRecurring('weekly review', { kind: 'weekly', weekday: 1, at: '09:00' });
    const occurrence = Date.now() - 60_000;
    // simulate the crash window: nextDue was pre-committed past the occurrence and a
    // PENDING record exists on disk, but the runner never invoked (no RUNNING state)
    const stored = (await listRecurring()).find((x) => x.id === t.id)!;
    stored.nextDue = occurrence + 300_000; // schedule advanced past the occurrence
    await writeRunRecords([{ id: 'run-x', routineId: t.id, occurrence, status: 'pending', attempts: 1 }]);
    dropRecurringCacheForTests();
    dropRecurringRunCacheForTests();

    const rec = await recoverRecurringRuns();
    expect(rec.reArmed).toBe(1);
    // recovery pulled the routine back to the unexecuted occurrence
    expect((await listRecurring()).find((x) => x.id === t.id)!.nextDue).toBe(occurrence);
    await tick(Date.now());
    expect(calls).toBe(1); // executed once
    const runs = await listRecurringRuns(t.id);
    expect(runs.filter((r) => r.status === 'completed')).toHaveLength(1);
    // a second recovery + tick must NOT run it again (completed occurrence is never repeated)
    dropRecurringCacheForTests();
    dropRecurringRunCacheForTests();
    await recoverRecurringRuns();
    const again = (await listRecurring()).find((x) => x.id === t.id)!;
    again.nextDue = occurrence; // even if the schedule somehow points at the old occurrence
    await tick(Date.now());
    expect(calls).toBe(1);
  });

  it('crash after RUNNING transition: the abandoned execution is NEVER silently rerun — it settles FAILED with an explicit recovery note', async () => {
    let calls = 0;
    registerScheduledRunner(async () => {
      calls++;
      return 'should not be called';
    });
    const t = await addRecurring('push the deploy report', { kind: 'interval', minutes: 10 });
    const occurrence = Date.now() - 30_000;
    const stored = (await listRecurring()).find((x) => x.id === t.id)!;
    stored.nextDue = occurrence + 600_000;
    await writeRunRecords([{ id: 'run-y', routineId: t.id, occurrence, status: 'running', startedAt: Date.now() - 20_000, attempts: 1 }]);
    dropRecurringCacheForTests();
    dropRecurringRunCacheForTests();

    const rec = await recoverRecurringRuns();
    expect(rec.reconciled).toBe(1);
    const runs = await listRecurringRuns(t.id);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.recovered).toBe(true);
    expect(runs[0]!.recoveryNote).toContain('NOT rerun automatically');
    expect(runs[0]!.recoveryNote).toContain('side effects');
    await tick(Date.now());
    await tick(Date.now());
    expect(calls).toBe(0); // the possibly-already-executed occurrence is not repeated
    // the routine's failure is visible on the routine itself
    expect((await listRecurring()).find((x) => x.id === t.id)!.lastError).toContain('interrupted');
  });

  it('an occurrence with a terminal record is never executed again, and the schedule keeps advancing consistently', async () => {
    let calls = 0;
    registerScheduledRunner(async () => {
      calls++;
      return 'done';
    });
    const t = await addRecurring('tick the monitor', { kind: 'interval', minutes: 5 });
    const occurrence = Date.now() - 1000;
    const stored = (await listRecurring()).find((x) => x.id === t.id)!;
    stored.nextDue = occurrence;
    await tick(Date.now());
    const afterFirst = (await listRecurring()).find((x) => x.id === t.id)!;
    expect(afterFirst.nextDue).toBeGreaterThan(occurrence); // advancement is consistent with execution
    expect(calls).toBe(1);
    // force the schedule back to the SAME occurrence: the completed record must dedupe
    afterFirst.nextDue = occurrence;
    await tick(Date.now());
    expect(calls).toBe(1);
    const runs = await listRecurringRuns(t.id);
    expect(runs).toHaveLength(1);
  });

  it('run records survive a restart (reload from disk), and records of removed routines are cancelled', async () => {
    registerScheduledRunner(async () => 'ok');
    const t = await addRecurring('morning report', { kind: 'interval', minutes: 5 });
    const stored = (await listRecurring()).find((x) => x.id === t.id)!;
    stored.nextDue = Date.now() - 1000;
    await tick(Date.now());
    expect((await listRecurringRuns(t.id)).length).toBe(1);
    // restart simulation: drop BOTH caches, remove the routine, recover
    dropRecurringCacheForTests();
    dropRecurringRunCacheForTests();
    const { cancelRecurring } = await import('../src/main/scheduler');
    await cancelRecurring(t.id);
    const rec = await recoverRecurringRuns();
    // the completed record is history (kept); nothing pending remains to cancel — but a
    // pending record of a removed routine would be cancelled by recovery
    expect((await listRecurringRuns(t.id)).length).toBe(1);
    await writeRunRecords([{ id: 'run-z', routineId: 'ghost', occurrence: Date.now() - 5000, status: 'pending', attempts: 1 }]);
    dropRecurringRunCacheForTests();
    const rec2 = await recoverRecurringRuns();
    expect(rec2.cancelled).toBe(1);
    expect(rec.reconciled + rec.cancelled).toBe(0);
  });
});

// ------------------------------------------------------------------ §1.2 target-aware browser verification

describe('R27 §1.2 — target-aware browser action verification', () => {
  it('an accepted click with no observable change stays NOT-CONFIRMED (interaction-only, never success)', () => {
    const v = verifyAction({ before: { url: 'https://x/list', title: 'List' }, after: { url: 'https://x/list', title: 'List' } });
    expect(v.verdict).toBe('not-confirmed');
    expect(v.observed).toBe('interaction-only');
  });

  it('navigating to the element\'s own href IS the verified intended outcome', () => {
    const v = verifyAction({
      before: { url: 'https://x/deployments', title: 'Deployments' },
      after: { url: 'https://x/deployments/42', title: 'Deployment #42' },
      intent: 'open the deployment details',
      target: { ref: 7, label: 'Deployment #42', role: 'a', href: 'https://x/deployments/42' },
    });
    expect(v.verdict).toBe('confirmed');
    expect(v.observed).toBe('intended-outcome');
    expect(v.reason).toContain('matches the intended target');
  });

  it('a page change that is NOT the intended target is honestly UNVERIFIED (navigation ≠ outcome)', () => {
    const v = verifyAction({
      before: { url: 'https://x/deployments', title: 'Deployments' },
      after: { url: 'https://x/ads', title: 'Sponsored offers' },
      intent: 'open the deployment details',
      target: { ref: 7, label: 'Deployment #42', href: 'https://x/deployments/42' },
      expected: 'the deployment details page opens',
    });
    expect(v.verdict).toBe('unclear');
    expect(v.observed).toBe('navigation');
    expect(v.reason).toContain('INTENDED outcome');
  });

  it('a declared expected result that appears in the resulting state verifies the outcome', () => {
    const v = verifyAction({
      before: { url: 'https://x/form', title: 'Form' },
      after: { url: 'https://x/form', title: 'Settings saved successfully' },
      target: { ref: 3, label: 'Save', role: 'button' },
      expected: 'a settings-saved confirmation appears',
    });
    expect(v.verdict).toBe('confirmed');
    expect(v.observed).toBe('intended-outcome');
    expect(v.reason).toContain('declared expected result');
  });

  it('unobservable state is reported as such', () => {
    const v = verifyAction({ before: null, after: { url: 'x', title: 'y' } });
    expect(v.verdict).toBe('unclear');
    expect(v.observed).toBe('unobserved');
  });

  it('the [ACTION VERIFY] line carries the honest level and the target identity', () => {
    const nav = actionVerifyLine({
      before: { url: 'https://x/a', title: 'A' },
      after: { url: 'https://x/b', title: 'B' },
      target: { label: 'Delete project', href: 'https://x/other' },
      expected: 'the project page opens',
    });
    expect(nav).toContain('OBSERVED NAVIGATION — OUTCOME UNVERIFIED');
    expect(nav).toContain('Delete project');
    const ok = actionVerifyLine({
      before: { url: 'https://x/list', title: 'List' },
      after: { url: 'https x'.replace('https x', 'https://x/item/9'), title: 'Item 9' },
      target: { label: 'Item 9', href: 'https://x/item/9' },
    });
    expect(ok).toContain('VERIFIED OUTCOME');
    const noop = actionVerifyLine({ before: { url: 'https://x/a', title: 'A' }, after: { url: 'https://x/a', title: 'A' } });
    expect(noop).toContain('NOT-CONFIRMED');
  });
});

// ------------------------------------------------------------------ §1.4 integration connection states

describe('R27 §1.4 — integration connection-state accuracy', () => {
  it('the honest ladder: NOT_CONFIGURED → CONNECTED → AUTHENTICATED → TESTED, each earned', async () => {
    // 1. nothing configured
    expect(await connectionState('repository')).toMatchObject({ phase: 'NOT_CONFIGURED', available: false });
    // 2. a stored connection record exists — CONNECTED, NOT available (no invented auth)
    await import('../src/main/integrations').then((m) => m.setIntegrationConnected('repository', true));
    expect(await connectionState('repository')).toMatchObject({ phase: 'CONNECTED', available: false });
    // 3. static validation (credential present, sane) — AUTHENTICATED, available
    process.env.GITHUB_TOKEN = 'gh-token-value-12345';
    const afterStatic = await validateIntegration('repository');
    expect(afterStatic.phase).toBe('AUTHENTICATED');
    expect(afterStatic.available).toBe(true);
    expect(afterStatic.lastCheck?.kind).toBe('static');
    // 4. a recorded successful HEALTH check — TESTED
    await recordIntegrationCheck('repository', { ok: true, kind: 'health', detail: 'ls-remote succeeded' });
    expect((await connectionState('repository')).phase).toBe('TESTED');
    // values are never stored or exposed
    const raw = fs.readFileSync(path.join(ROOT, 'brain', 'integrations.json'), 'utf-8');
    expect(raw).not.toContain('gh-token-value-12345');
  });

  it('an auth-related failure after success marks the integration EXPIRED; other failures mark ERROR', async () => {
    process.env.GITHUB_TOKEN = 'gh-token-value-12345';
    await validateIntegration('repository');
    expect((await connectionState('repository')).phase).toBe('AUTHENTICATED');
    await recordIntegrationCheck('repository', { ok: false, kind: 'health', error: '401 Bad credentials', authRelated: true });
    expect((await connectionState('repository')).phase).toBe('EXPIRED');
    expect((await connectionState('repository')).available).toBe(false);
    // non-auth operational failure → ERROR
    process.env.GITHUB_TOKEN = '0123456789abcdef';
    await validateIntegration('repository');
    await recordIntegrationCheck('repository', { ok: false, kind: 'health', error: 'ECONNRESET', authRelated: false });
    expect((await connectionState('repository')).phase).toBe('ERROR');
  });

  it('a health check runs through the injected executor (the authorized path) and records the ACTUAL outcome', async () => {
    registerIntegrationExecutor(async (tool, args) => {
      expect(tool).toBe('web_search');
      expect((args as { query: string }).query).toBeTruthy();
      return { ok: true, detail: '5 results', authRelated: false };
    });
    const out = await runIntegrationHealthCheck('web-research');
    expect(out).toContain('Health check SUCCEEDED');
    expect(out).toContain('TESTED');
    expect((await connectionState('web-research')).lastCheck?.kind).toBe('health');
    // failing check flips the honest state (was AVAILABLE — auth none — now ERROR)
    registerIntegrationExecutor(async () => ({ ok: false, detail: 'network unreachable', authRelated: false }));
    const out2 = await runIntegrationHealthCheck('web-research');
    expect(out2).toContain('Health check FAILED');
    expect((await connectionState('web-research')).phase).toBe('ERROR');
  });

  it('validation failures are honest: missing or implausible credentials never become AUTHENTICATED', async () => {
    // a stored connection record exists, but NO credentials: validation fails honestly
    const { setIntegrationConnected } = await import('../src/main/integrations');
    await setIntegrationConnected('database', true);
    const none = await validateIntegration('database');
    expect(none.available).toBe(false);
    expect(none.phase).toBe('ERROR'); // a recorded FAILED check, no prior success
    expect(none.lastCheck?.error).toContain('no credentials/configuration present');
    process.env.DATABASE_URL = 'short';
    const bad = await validateIntegration('database');
    expect(bad.available).toBe(false);
    expect(bad.lastCheck?.ok).toBe(false);
    expect(bad.lastCheck?.error).toContain('truncated or invalid');
    expect((await connectionState('database')).phase).toBe('ERROR');
  });

  it('the tool surfaces render the phase and the validation entry point', async () => {
    process.env.GITHUB_TOKEN = 'gh-token-value-12345';
    const status = String(await integrationTools.integration_status.run({}));
    expect(status).toContain('CONNECTED');
    expect(status).toContain('NOT_CONFIGURED');
    const check = String(await integrationTools.integration_check.run({ id: 'repository' }));
    expect(check).toContain('Validated (static)');
    expect(check).toContain('AUTHENTICATED');
  });
});

// ------------------------------------------------------------------ §1.5 durable episodic memory

describe('R27 §1.5 — durable episodic-memory recording', () => {
  beforeEach(async () => {
    // ROUND 28: the queue drains itself, so detached drains from a previous test must be
    // settled before the stores are reset — otherwise a late save resurrects rows here.
    await waitForDrainIdleForTests();
    fs.rmSync(episodeStoreFile(), { force: true });
    fs.rmSync(pendingEpisodeStoreFile(), { force: true });
  });

  it('a completed task\'s episode is first DURABLY queued (survives a crash before recording)', async () => {
    const r = await queueEpisode({ taskId: 't1', request: 'fix the login bug', verdict: 'completed', outcome: 'patch applied and tests pass', approach: 'single specialist', origin: 'observed' });
    expect(r.queued).toBe(true);
    // the DURABLE row is on disk (the queue itself is the crash guarantee; ROUND 28 the
    // queue-triggered drain then settles it — the row never depends on a caller draining)
    const raw = JSON.parse(fs.readFileSync(pendingEpisodeStoreFile(), 'utf-8')) as Array<{ status: string; episode: { request: string } }>;
    expect(raw.some((row) => row.episode.request === 'fix the login bug')).toBe(true);
    await waitForDrainIdleForTests();
    // after the (auto-triggered) drain the episode is retrievable — memory of finished work
    expect((await recallEpisodes('login bug')).length).toBe(1);
  });

  it('the drain validates, dedupes, records, and marks the pending row — duplicates never stack', async () => {
    // ROUND 28 NOTE: queueEpisode now drains itself (bounded) — the queue no longer relies
    // on every caller remembering to drain. The guarantee asserted is unchanged: two
    // identical settles leave ONE episode, one durable row, zero pending.
    const payload = { taskId: 't2', request: 'migrate the config format', verdict: 'completed' as const, outcome: 'config migrated; checks pass', approach: 'direct execution', origin: 'observed' as const };
    await queueEpisode(payload);
    await queueEpisode({ ...payload }); // an identical settle (e.g. after a retry) must dedupe
    for (let i = 0; i < 100 && (await pendingEpisodeSummary()).pending > 0; i++) await new Promise((r) => setTimeout(r, 20));
    await processPendingEpisodes();
    const summary = await pendingEpisodeSummary();
    expect(summary.pending).toBe(0);
    expect(summary.recorded).toBe(1);
    const hits = await recallEpisodes('config format migration');
    expect(hits.length).toBe(1);
    expect(hits[0]!.request).toContain('migrate the config format');
  });

  it('invalid content is preserved as FAILED for investigation (never silently dropped)', async () => {
    // a row that bypassed queue-time validation (older version, hand-edit, partial write)
    const outbox = pendingEpisodeStoreFile();
    fs.mkdirSync(path.dirname(outbox), { recursive: true });
    fs.writeFileSync(
      outbox,
      JSON.stringify([{ id: 'pq-bad', createdAt: Date.now(), status: 'pending', attempts: 0, episode: { request: '', verdict: 'completed', outcome: '', approach: '' } }], null, 1)
    );
    const res = await processPendingEpisodes();
    expect(res.failed).toBe(1);
    const summary = await pendingEpisodeSummary();
    expect(summary.failed).toBe(1);
    expect(summary.failures[0]!.lastError).toContain('invalid content');
  });

  it('a crash between queueing and recording is recovered by the next drain (restart-safe)', async () => {
    await queueEpisode({ request: 'update the pricing page', verdict: 'partial', outcome: 'page updated; screenshot missing', approach: 'browser + write', origin: 'observed' });
    // (restart: the store is file-backed; a new process reads the same rows. ROUND 28: the
    // queue-triggered drain settles it; an explicit drain after it is idempotent.)
    for (let i = 0; i < 100 && (await pendingEpisodeSummary()).pending > 0; i++) await new Promise((r) => setTimeout(r, 20));
    const res = await processPendingEpisodes();
    expect(res.recorded).toBe(0); // already settled — nothing was lost or duplicated
    expect((await pendingEpisodeSummary()).pending).toBe(0);
    expect((await recallEpisodes('pricing page update')).length).toBe(1);
  });

  it('memory failure never blocks task completion: queueEpisode reports honestly and never throws', async () => {
    const bad = await queueEpisode({ request: 'x', verdict: 'nonsense' as never, outcome: '', approach: '' });
    expect(bad.queued).toBe(false);
    expect(bad.error).toContain('rejected');
    expect(await processPendingEpisodes()).toMatchObject({ failed: 0, recorded: 0 });
  });
});

// ------------------------------------------------------------------ §1.3 Operations Control Center backend

describe('R27 §1.3 — Operations Control Center (backend projections & controls)', () => {
  it('the overview projects ONLY real state: tasks, routines, executions, gate refusals, memory, integrations', async () => {
    // a real durable task in the store
    const t = await createTask(buildTaskSpec('write the quarterly summary file'), 'test');
    await setSteps(t, [{ title: 'Draft the summary' }, { title: 'Verify the numbers' }]);
    const t2 = (await getTask(t.id))!;
    await markStep(t2, t2.steps[0]!.id, { status: 'done', result: 'draft written to summary.md' });
    // a real gate refusal in the ledger
    noteInvocationEvent({ id: 1, t: Date.now(), kind: 'tool', cid: 'c1', label: 'run_command', detail: 'rm -rf', status: 'fail', blocked: true } as never);
    const ov = await opsOverview();
    const all = [...ov.tasks.running, ...ov.tasks.queued, ...ov.tasks.paused, ...ov.tasks.interrupted, ...ov.tasks.recent];
    const mine = all.find((x) => x.id === t.id);
    expect(mine).toBeDefined();
    expect(mine!.stepsDone).toBe(1);
    expect(mine!.stepsTotal).toBe(2);
    expect(mine!.canPause).toBe(false); // not driven — honest controls
    expect(ov.approvals.pendingInteractive).toBe(0);
    expect(ov.approvals.recentBlocked.length).toBe(1);
    expect(ov.approvals.recentBlocked[0]!.tool).toBe('run_command');
    expect(ov.integrations.length).toBeGreaterThanOrEqual(5);
    expect(ov.integrations.every((i) => typeof i.phase === 'string')).toBe(true);
    expect(ov.memory.pendingEpisodes).toBe(0);
  });

  it('task detail exposes steps, evidence and a timeline grounded in records; stale verification is shown as absent', async () => {
    const t = await createTask(buildTaskSpec('produce the report'), 'test');
    await setSteps(t, [{ title: 'Write the report' }]);
    const t2 = (await getTask(t.id))!;
    const step = t2.steps[0]!;
    await markStep(t2, step.id, { status: 'done', result: 'report.md written' });
    const v: StepVerification = {
      checkedAt: Date.now(),
      intended: 'report.md exists',
      action: 'write_file',
      toolResult: 'wrote report.md',
      observed: 'stat confirms report.md (120 bytes)',
      method: 'disk re-inspection',
      evidence: 'stat report.md → file, 120 bytes',
      status: 'verified',
    };
    await setStepVerification(t2, step.id, v);
    const d = await opsTaskDetail(t.id);
    expect(d).not.toBeNull();
    expect(d!.steps[0]!.verification?.status).toBe('verified');
    expect(d!.steps[0]!.verification?.evidence).toContain('120 bytes');
    expect(d!.timeline.some((e) => e.kind === 'created')).toBe(true);
    expect(d!.timeline.some((e) => e.kind === 'step-end')).toBe(true);
    // stale verification: change the result under the record → validVerification yields none
    const t3 = (await getTask(t.id))!;
    await markStep(t3, step.id, { result: 'report.md rewritten differently' });
    const d2 = (await opsTaskDetail(t.id))!;
    expect(d2.steps[0]!.verification).toBeUndefined();
  });

  it('task controls run the authorized tools and refuse honestly on unknown ids', async () => {
    const out = await opsTaskAction('no-such-task', 'pause');
    expect(out).toContain('NOT DONE');
    const bad = opsTaskAction('x', 'explode' as never);
    await expect(bad).rejects.toThrow('unsupported action');
  });
});
