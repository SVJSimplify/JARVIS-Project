import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 27 — CROSS-PHASE INTEGRATION WORKFLOWS (spec §4).
 * The phases must work as ONE product. These tests drive the REALISTIC user workflows the
 * Round 27 spec names, through the REAL coordinator / scheduler / registry / gate.
 *
 * A — Scheduled project maintenance: a routine is configured, its occurrence is durable
 *     BEFORE execution, the run is recorded, and crash windows reconcile.
 * D — Cross-application development: discovery + the authentication gate.
 * F — Background operations management: the Control Center sees and drives real work.
 * G — Crash recovery during recurring execution (crash-point matrix).
 * H — Integration authentication failure: EXPIRED is reported, never faked away.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { startTask, type CoordinatorDeps } from '../src/main/coordinator';
import { getTask, resetTaskStoreForTests } from '../src/main/taskStore';
import { resetCallContext } from '../src/main/toolRecord';
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
} from '../src/main/scheduler';
import { connectionState, recordIntegrationCheck, registerIntegrationExecutor, runIntegrationHealthCheck, integrationTools } from '../src/main/integrations';
import { opsOverview, opsTaskDetail, opsTaskAction } from '../src/main/opsCenter';
import { noteInvocationEvent, resetInvocationsForTests } from '../src/main/invocations';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-r27wf-${process.pid}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetTaskStoreForTests();
  resetSchedulerForTests();
  resetCallContext();
  resetInvocationsForTests();
  fs.rmSync(path.join(ROOT, 'brain', 'tasks'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'brain', 'integrations.json'), { force: true });
  fs.rmSync(path.join(ROOT, 'brain', 'episodes.json'), { force: true });
  fs.rmSync(path.join(ROOT, 'brain', 'pending-episodes.json'), { force: true });
  fs.rmSync(path.join(ROOT, 'recurring.json'), { force: true });
  fs.rmSync(path.join(ROOT, 'recurring-runs.json'), { force: true });
  delete process.env.GITHUB_TOKEN;
  delete process.env.DATABASE_URL;
  registerIntegrationExecutor(async () => ({ ok: false, detail: 'no executor in this test' }));
});

const waitStatus = async (id: string, statuses: string[]) => {
  for (let i = 0; i < 250; i++) {
    const t = await getTask(id);
    if (t && statuses.includes(t.status)) return t;
    await sleep(30);
  }
  return await getTask(id);
};

// --------------------------------------------------------------------------- Workflow A / G

describe('Workflow A/G — scheduled project maintenance & crash recovery during recurring execution', () => {
  it('A: routine configured → durable occurrence → recorded run → schedule advanced → report available', async () => {
    const runs: string[] = [];
    registerScheduledRunner(async (text) => {
      runs.push(text);
      return 'VERDICT: build is green; no issues found (npm test: 3 passed)';
    });
    const t = await addRecurring('check my project for build failures and prepare a report', { kind: 'daily', at: '09:00' });
    // force the first occurrence due now (as if the schedule came due)
    const stored = (await listRecurring()).find((x) => x.id === t.id)!;
    const occurrence = Date.now() - 1000;
    stored.nextDue = occurrence;
    await tick(Date.now());
    const after = (await listRecurring()).find((x) => x.id === t.id)!;
    expect(after.runCount).toBe(1);
    expect(after.lastResult).toContain('build is green');
    expect(after.nextDue).toBeGreaterThan(occurrence); // schedule advanced consistently
    const rec = (await listRecurringRuns(t.id))[0]!;
    expect(rec.status).toBe('completed');
    expect(rec.occurrence).toBe(occurrence); // the durable occurrence identity
    expect(rec.reply).toContain('build is green');
    expect(runs[0]).toContain('check my project');
  });

  it('G: every crash point reconciles — nothing disappears, no duplicate execution, recovery evidence retained', async () => {
    let executed = 0;
    registerScheduledRunner(async () => {
      executed++;
      return 'work done';
    });
    const t = await addRecurring('morning maintenance pass', { kind: 'interval', minutes: 5 });
    const occurrence = Date.now() - 60_000;

    // Crash point 1: BEFORE occurrence creation (nothing on disk) — the next tick simply
    // creates + runs it. No loss, no duplicate.
    const r1 = (await listRecurring()).find((x) => x.id === t.id)!;
    r1.nextDue = occurrence;
    await tick(Date.now());
    expect(executed).toBe(1);
    expect((await listRecurringRuns(t.id)).filter((r) => r.status === 'completed')).toHaveLength(1);

    // Crash point 2: AFTER PENDING creation, before RUNNING (runner never invoked) —
    // recovery re-arms the occurrence and it runs exactly once.
    const pending = { id: 'run-p', routineId: t.id, occurrence, status: 'pending' as const, attempts: 1 };
    fs.mkdirSync(path.dirname(path.join(ROOT, 'recurring-runs.json')), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'recurring-runs.json'), JSON.stringify([pending]));
    dropRecurringCacheForTests();
    dropRecurringRunCacheForTests();
    await recoverRecurringRuns();
    await tick(Date.now());
    expect(executed).toBe(2); // the re-armed occurrence ran once
    expect((await listRecurringRuns(t.id)).filter((r) => r.id === 'run-p' && r.status === 'completed')).toHaveLength(1);

    // Crash point 3: AFTER RUNNING transition (external actions MAY have happened) — the
    // abandoned run is reconciled FAILED with recovery evidence and is NEVER rerun.
    const abandoned = { id: 'run-a', routineId: t.id, occurrence: occurrence + 300_000, status: 'running' as const, startedAt: Date.now() - 5_000, attempts: 1 };
    fs.writeFileSync(path.join(ROOT, 'recurring-runs.json'), JSON.stringify([abandoned]));
    dropRecurringCacheForTests();
    dropRecurringRunCacheForTests();
    const rec = await recoverRecurringRuns();
    expect(rec.reconciled).toBe(1);
    const rec1 = (await listRecurringRuns(t.id)).find((r) => r.id === 'run-a')!;
    expect(rec1.status).toBe('failed');
    expect(rec1.recoveryNote).toContain('NOT rerun automatically');
    await tick(Date.now());
    await tick(Date.now());
    expect(executed).toBe(2); // no duplicate external action
  });
});

// --------------------------------------------------------------------------- Workflow D / H

describe('Workflow D/H — cross-application development & integration authentication failure', () => {
  // Hermetic: 'without a token' must not depend on the host's GitHub credentials.
  beforeAll(() => { delete process.env.GITHUB_TOKEN; delete process.env.GH_TOKEN; });
  it('D: discovery finds the repository capability; the authorization gate decides honestly', async () => {
    const hits = await import('../src/main/integrations').then((m) => m.discoverIntegrations('review the open issues in my repo, implement the highest-priority bug fix, run the tests, and prepare a pull request'));
    // ROUND 29 registry: local-git work stays on `repository`; GitHub API operations
    // (issues, pull requests) moved to the dedicated `github` integration with REAL tools.
    const repo = hits.find((h) => h.id === 'repository')!;
    expect(repo).toBeDefined();
    expect(repo.state.phase).toBe('NOT_CONFIGURED'); // no token: honestly unavailable
    const opNames = repo.matchedOperations.map((o) => o.name);
    expect(opNames).toContain('prepare-pull-request'); // the local git branch/commit/push part
    for (const op of repo.matchedOperations) expect(op.via).toContain('run_command');
    const gh = hits.find((h) => h.id === 'github')!;
    expect(gh).toBeDefined();
    expect(gh.state.phase).toBe('NOT_CONFIGURED');
    expect(gh.matchedOperations.map((o) => o.name)).toContain('inspect-issues');
    // every github operation names an EXISTING registered github_* tool
    for (const op of gh.matchedOperations) expect(op.via.some((t) => t.startsWith('github_'))).toBe(true);
    // the tool surface renders the honest state and the validation entry point
    const out = String(await integrationTools.integration_check.run({ id: 'repository' }));
    expect(out).toContain('NOT DONE'); // nothing configured → refuse honestly, no fallback
  });

  it('H: expired credentials are detected and NOT faked available — the user gets a meaningful explanation', async () => {
    process.env.GITHUB_TOKEN = 'gh-token-that-works-1';
    const { setIntegrationConnected } = await import('../src/main/integrations');
    await setIntegrationConnected('repository', true);
    // the credentials once validated (static check)…
    const okOut = await runIntegrationHealthCheck('repository');
    expect(okOut).toContain('Validated (static)');
    expect((await connectionState('repository')).phase).toBe('AUTHENTICATED');
    expect((await connectionState('repository')).available).toBe(true);
    // …then a real operation through the integration fails with an auth error (the
    // outcome is recorded the same way every check is recorded — honestly):
    await recordIntegrationCheck('repository', { ok: false, kind: 'health', error: 'gh api: 401 Bad credentials', authRelated: true });
    const st = await connectionState('repository');
    expect(st.phase).toBe('EXPIRED');
    expect(st.available).toBe(false);
    expect(st.reason).toContain('integration_check'); // the recovery path is named
    // the status surface shows EXPIRED — never a fake AVAILABLE
    const status = String(await integrationTools.integration_status.run({}));
    expect(status).toContain('EXPIRED');
    // and renewed credentials restore availability only through a recorded successful check
    process.env.GITHUB_TOKEN = 'gh-token-renewed-123';
    const out2 = await runIntegrationHealthCheck('repository');
    expect(out2).toContain('Validated (static)');
    expect((await connectionState('repository')).phase).toBe('AUTHENTICATED');
  });
});

// --------------------------------------------------------------------------- Workflow F

describe('Workflow F — background operations management through the Control Center', () => {
  const baseDeps = (over: Partial<CoordinatorDeps> = {}): CoordinatorDeps => ({
    run: async () => 'OK',
    schemas: () => [],
    planner: async () => [{ title: 'Do the work', detail: 'work', kind: 'general', dependsOn: [] }],
    ...over,
  });

  it('active operations are visible with real step state; pause/resume work through the same authorized tools; the gate refusals are visible', async () => {
    // a real driven task that blocks until paused
    const deps = baseDeps({
      stepRunner: async (_p, _k, _t, _s, signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener('abort', () => resolve('FAILED: the step was aborted while paused'), { once: true });
        }),
    });
    const out = await startTask('Prepare the weekly release notes draft', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1]!;
    for (let i = 0; i < 250; i++) {
      if ((await getTask(id))?.status === 'RUNNING') break;
      await sleep(30);
    }
    // the overview sees the running operation with honest step state
    let ov = await opsOverview();
    const running = ov.tasks.running.find((t) => t.id === id);
    expect(running).toBeDefined();
    expect(running!.stepsTotal).toBeGreaterThan(0);
    expect(running!.canPause).toBe(true);
    // a gate refusal is visible in the approvals surface
    noteInvocationEvent({ id: 1, t: Date.now(), kind: 'tool', cid: 'c9', label: 'run_command', detail: 'rm -rf /', status: 'fail', blocked: true } as never);
    ov = await opsOverview();
    expect(ov.approvals.recentBlocked.some((b) => b.tool === 'run_command')).toBe(true);
    // the user pauses through the Control Center (the SAME authorized tool path)
    const pauseMsg = await opsTaskAction(id, 'pause');
    expect(pauseMsg).toContain('pause requested');
    const paused = await waitStatus(id, ['PAUSED']);
    expect(paused?.status).toBe('PAUSED');
    // detail projection works for the paused task
    const detail = await opsTaskDetail(id);
    expect(detail?.status).toBe('PAUSED');
    expect(detail?.timeline.some((e) => e.label.includes('→ PAUSED'))).toBe(true);
    // resume completes the work
    const resumeMsg = await opsTaskAction(id, 'resume');
    expect(resumeMsg).toContain('resumed');
    await waitStatus(id, ['COMPLETED', 'FAILED']);
    // the overview's history now includes the terminal task
    ov = await opsOverview();
    expect(ov.tasks.recent.some((t) => t.id === id)).toBe(true);
  }, 40_000);
});
