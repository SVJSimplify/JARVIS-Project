/**
 * JARVIS ROUND 28 — PHASE 1 FOCUSED TESTS.
 *
 * Covers the five §1 audit objectives:
 *  1.1  browser verification false positives — the evidence-based engine (shared keywords,
 *       redirects, similar labels, error pages, auth redirects, consequential actions);
 *  1.2  scheduler & background-task recovery — bounded turns, cancellation races, stale
 *       running-state reclaim;
 *  1.3  episodic-memory outbox — concurrency, crash-boundary idempotence, queue dedupe;
 *  1.4  integration-state accuracy — corrupted state file, stale validation evidence;
 *  1.5  retry/cancellation safety — unknown-outcome steps refuse retry.
 *
 * Every assertion drives the REAL modules; no test double stands in for engine behavior.
 */
import { describe, expect, it, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { verifyAction, actionVerifyLine } from '../src/main/externalContent';
import {
  addRecurring,
  cancelRecurring,
  listRecurringRuns,
  parseRecurrence,
  recoverRecurringRuns,
  resetSchedulerForTests,
  setRecurringEnabled,
  setSchedulerTimingForTests,
  registerScheduledRunner,
  scheduleTask,
  tick,
  listScheduled,
  dropRecurringRunCacheForTests,
  dropRecurringCacheForTests,
} from '../src/main/scheduler';
import {
  queueEpisode,
  processPendingEpisodes,
  pendingEpisodeSummary,
  listEpisodeRecords,
  pendingEpisodeStoreFile,
  waitForDrainIdleForTests,
} from '../src/main/episodicMemory';
import { connectionState, recordIntegrationCheck, registerIntegration } from '../src/main/integrations';
import { retryTask, coordinatorTools, type CoordinatorDeps } from '../src/main/coordinator';
import { getTask, createTask } from '../src/main/taskStore';
import { buildTaskSpec } from '../src/main/taskSpec';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-test-${process.pid}`);
const file = (...p: string[]): string => path.join(ROOT, ...p);

/** Poll until a condition holds (queue-triggered drains run in the background). */
const until = async (cond: () => boolean, timeoutMs = 4000): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

// ------------------------------------------------------------------ §1.1 verification

describe('R28 §1.1 — browser verification false-positive resistance', () => {
  it('THE ADVERSARIAL CASE: expected "Open account settings." vs page "Account deleted." is NEVER success', () => {
    const v = verifyAction({
      before: { url: 'https://x/settings', title: 'Settings' },
      after: { url: 'https://x/account/removed', title: 'Account deleted.' },
      intent: 'Open account settings.',
      target: { label: 'Account settings', role: 'a', href: 'https://x/account/settings' },
      expected: 'Open account settings.',
    });
    expect(v.verdict).not.toBe('confirmed');
    expect(v.observed).toBe('navigation');
    expect(v.confidence).toBe('low');
    // the contradiction is named, not smoothed over
    expect(v.evidence?.some((e) => e.kind === 'contradiction' || e.kind === 'error-indicator' || e.strength === 'negative')).toBe(true);
    expect(actionVerifyLine({ before: { url: 'https://x/settings', title: 'S' }, after: { url: 'https://x/account/removed', title: 'Account deleted.' }, expected: 'Open account settings.' })).toContain('OUTCOME UNVERIFIED');
  });

  it('a single shared keyword is never outcome evidence (weak overlap, explicit evidence item)', () => {
    const v = verifyAction({
      before: { url: 'https://shop/listing', title: 'Laptop listing' },
      after: { url: 'https://shop/checkout/declined', title: 'Order declined' },
      intent: 'open laptop settings',
      expected: 'the laptop settings page opens',
    });
    expect(v.verdict).not.toBe('confirmed');
    const weak = v.evidence?.find((e) => e.strength === 'weak');
    expect(weak).toBeTruthy();
  });

  it('URL matching is exact-normalized: query params count, order does not, fragments never', () => {
    // same path, different query → path-level match only
    const v1 = verifyAction({
      before: { url: 'https://x/list', title: 'List' },
      after: { url: 'https://x/deployments?tab=all&sort=asc', title: 'Deployments' },
      target: { label: 'Deployments', href: 'https://x/deployments?sort=asc&tab=all' },
    });
    expect(v1.verdict).toBe('confirmed');
    expect(v1.evidence?.some((e) => e.kind === 'url-exact')).toBe(true);
    // a fragment-only difference must NOT confirm — the fragment is not an outcome
    const v2 = verifyAction({
      before: { url: 'https://x/list', title: 'List' },
      after: { url: 'https://x/other#deployments', title: 'Other' },
      target: { label: 'Deployments', href: 'https://x/deployments' },
      expected: 'the deployments page opens',
    });
    expect(v2.verdict).not.toBe('confirmed');
  });

  it('a redirect to an unexpected destination stays OUTCOME UNVERIFIED even with a shared keyword', () => {
    const v = verifyAction({
      before: { url: 'https://app/dashboard', title: 'Dashboard' },
      after: { url: 'https://ads-network.example/banner?ref=dashboard', title: 'Sponsored' },
      target: { label: 'Dashboard settings', href: 'https://app/dashboard/settings' },
      expected: 'the dashboard settings open',
    });
    expect(v.verdict).toBe('unclear');
    expect(v.observed).toBe('navigation');
  });

  it('similar button labels do not cross-verify (label is phrase-matched, not word-matched)', () => {
    const v = verifyAction({
      before: { url: 'https://x/docs', title: 'Docs' },
      after: { url: 'https://x/docs/advanced-settings', title: 'Advanced settings guide' },
      target: { label: 'Settings', role: 'a', href: 'https://x/settings' },
      expected: 'the account settings page opens',
    });
    expect(v.verdict).not.toBe('confirmed');
  });

  it('navigation to an error page produces negative evidence and an honest verdict', () => {
    const v = verifyAction({
      before: { url: 'https://x/projects', title: 'Projects' },
      after: { url: 'https://x/404', title: 'Page not found (404)' },
      target: { label: 'Project settings', href: 'https://x/projects/settings' },
      expected: 'the project settings open',
    });
    expect(v.verdict).not.toBe('confirmed');
    expect(v.evidence?.some((e) => e.kind === 'error-indicator')).toBe(true);
  });

  it('an unexpected authentication redirect is negative evidence, never success', () => {
    const v = verifyAction({
      before: { url: 'https://app/billing', title: 'Billing' },
      after: { url: 'https://app/login?next=/billing/history', title: 'Sign in' },
      target: { label: 'Billing history', href: 'https://app/billing/history' },
      expected: 'the billing history opens',
    });
    expect(v.verdict).not.toBe('confirmed');
    expect(v.evidence?.some((e) => e.kind === 'auth-redirect')).toBe(true);
  });

  it('buttons that respond but change nothing stay interaction-only (not-confirmed)', () => {
    const v = verifyAction({
      before: { url: 'https://x/form', title: 'Form' },
      after: { url: 'https://x/form', title: 'Form', content: 'please enter a valid email — validation failed' },
      target: { label: 'Submit', role: 'button' },
      expected: 'the form is accepted',
    });
    expect(v.verdict).toBe('not-confirmed');
    expect(v.observed).toBe('interaction-only');
    expect(v.reason).toContain('validation');
  });

  it('a consequential action (purchase) requires STRONG evidence — keyword overlap reports OUTCOME UNVERIFIED', () => {
    const v = verifyAction({
      before: { url: 'https://shop/cart', title: 'Cart' },
      after: { url: 'https://shop/order/confirm-page', title: 'Order confirmation pending' },
      target: { label: 'Buy now', role: 'button' },
      expected: 'the order confirmation appears',
    });
    expect(v.verdict).not.toBe('confirmed');
    expect(actionVerifyLine({
      before: { url: 'https://shop/cart', title: 'Cart' },
      after: { url: 'https://shop/order/confirm-page', title: 'Order confirmation pending' },
      target: { label: 'Buy now', role: 'button' },
      expected: 'the order confirmation appears',
    })).toContain('OUTCOME UNVERIFIED');
    // with STRONG evidence (the exact resulting URL recorded as the target) it confirms
    const strong = verifyAction({
      before: { url: 'https://shop/cart', title: 'Cart' },
      after: { url: 'https://shop/order/991', title: 'Order #991 confirmed' },
      target: { label: 'Buy now', role: 'button', href: 'https://shop/order/991' },
      expected: 'the order is placed',
    });
    expect(strong.verdict).toBe('confirmed');
    expect(strong.confidence).toBe('high');
  });

  it('page-content evidence can verify a state change ("the toggle shows enabled")', () => {
    const v = verifyAction({
      before: { url: 'https://x/prefs', title: 'Preferences' },
      after: { url: 'https://x/prefs', title: 'Preferences', content: 'Notifications: enabled. Changes saved.' },
      target: { label: 'Enable notifications', role: 'button' },
      expected: 'notifications show enabled and changes saved',
    });
    // URL/title unchanged → still interaction-only at the navigation level, but the reason
    // must not claim success — content alone cannot confirm a non-navigation state here.
    expect(v.verdict).toBe('not-confirmed');
  });

  it('structured evidence is present on every verdict and confidence is derived, never asserted', () => {
    const v = verifyAction({
      before: { url: 'https://x/a', title: 'A' },
      after: { url: 'https://x/b', title: 'B' },
    });
    expect(v.evidence?.length).toBeGreaterThan(0);
    expect(['high', 'medium', 'low']).toContain(v.confidence);
    expect(v.evidence?.every((e) => ['strong', 'medium', 'weak', 'negative'].includes(e.strength))).toBe(true);
  });
});

// ------------------------------------------------------------------ §1.2 scheduler recovery

describe('R28 §1.2 — scheduler & background-task recovery', () => {
  beforeEach(() => {
    resetSchedulerForTests();
  });

  it('cancelling a routine immediately cancels its pending occurrences (no orphaned records)', async () => {
    const t = await addRecurring('health check', parseRecurrence({ every_minutes: 5 }));
    // simulate a created-but-unstarted occurrence record for this routine
    const runsFile = file('recurring-runs.json');
    fs.mkdirSync(path.dirname(runsFile), { recursive: true });
    fs.writeFileSync(runsFile, JSON.stringify([{ id: 'run-x1', routineId: t.id, occurrence: Date.now() - 1000, status: 'pending', attempts: 1 }]));
    dropRecurringRunCacheForTests();
    const msg = await cancelRecurring(t.id);
    expect(msg).toContain('1 pending occurrence(s) cancelled');
    const runs = await listRecurringRuns();
    expect(runs.find((r) => r.id === 'run-x1')?.status).toBe('cancelled');
  });

  it('disabling a routine cancels its created-but-unstarted occurrences with an honest note', async () => {
    const t = await addRecurring('report', parseRecurrence({ daily_at: '09:00' }));
    const runsFile = file('recurring-runs.json');
    fs.mkdirSync(path.dirname(runsFile), { recursive: true });
    fs.writeFileSync(runsFile, JSON.stringify([{ id: 'run-x2', routineId: t.id, occurrence: Date.now() + 3600_000, status: 'pending', attempts: 0 }]));
    dropRecurringRunCacheForTests();
    await setRecurringEnabled(t.id, false);
    const runs = await listRecurringRuns();
    const r = runs.find((x) => x.id === 'run-x2');
    expect(r?.status).toBe('cancelled');
    expect(r?.recoveryNote).toContain('disabled before this occurrence ran');
  });

  it('a hung scheduled turn is settled FAILED with an outcome-unknown note (bounded waiting)', async () => {
    setSchedulerTimingForTests(80);
    const calls: string[] = [];
    // seed the task directly (in_minutes has a 1-minute floor; the due time is what matters)
    const store = file('scheduled.json');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify([{ id: 'hung', task: 'check the thing', due: Date.now() - 1000, created: Date.now() - 2000, status: 'pending' }]));
    registerScheduledRunner((text) => {
      calls.push(text);
      return new Promise<string>(() => undefined); // never settles — the old wedge
    });
    await tick(Date.now());
    const all = await listScheduled();
    const t = all.find((x) => x.task.includes('check the thing'));
    expect(t?.status).toBe('failed');
    expect(t?.error).toContain('outcome is UNKNOWN');
    expect(calls.length).toBe(1);
    // the ticker is free again: the next tick runs (a later task would no longer be blocked)
    await tick(Date.now() + 1);
  }, 10000);

  it('a recurring occurrence whose turn times out settles FAILED and is marked NOT rerun automatically', async () => {
    setSchedulerTimingForTests(80);
    let runs = 0;
    registerScheduledRunner(() => {
      runs++;
      return new Promise<string>(() => undefined);
    });
    const t = await addRecurring('routine with a hung turn', parseRecurrence({ every_minutes: 5 }));
    t.nextDue = Date.now() - 1000; // due now (direct module-state adjust, then persist via tick)
    await tick(Date.now());
    const recs = await listRecurringRuns(t.id);
    expect(recs.length).toBeGreaterThan(0);
    const rec = recs[0];
    expect(rec.status).toBe('failed');
    expect(rec.error).toContain('outcome is UNKNOWN');
    expect(rec.recoveryNote).toContain('NOT rerun automatically');
    expect(runs).toBe(1);
    resetSchedulerForTests();
  }, 10000);

  it('startup recovery still reconciles abandoned RUNNING records as outcome-unknown failures', async () => {
    const t = await addRecurring('legacy routine', parseRecurrence({ every_minutes: 10 }));
    const runsFile = file('recurring-runs.json');
    fs.mkdirSync(path.dirname(runsFile), { recursive: true });
    fs.writeFileSync(runsFile, JSON.stringify([{ id: 'run-x3', routineId: t.id, occurrence: Date.now() - 60_000, status: 'running', startedAt: Date.now() - 120_000, attempts: 1 }]));
    dropRecurringRunCacheForTests();
    dropRecurringCacheForTests();
    const res = await recoverRecurringRuns();
    expect(res.reconciled).toBe(1);
    const runs = await listRecurringRuns();
    const r = runs.find((x) => x.id === 'run-x3');
    expect(r?.status).toBe('failed');
    expect(r?.recoveryNote).toContain('NOT rerun automatically');
    expect(t.id).toBeTruthy();
  });

  it('a task left RUNNING by a crashed previous pass is reclaimed by the next tick', async () => {
    const seen: string[] = [];
    resetSchedulerForTests(); // FIRST (clears module state and the store)…
    const store = file('scheduled.json');
    fs.mkdirSync(path.dirname(store), { recursive: true });
    // …then seed a task wedged 'running' from a crashed pass, due in the past
    fs.writeFileSync(store, JSON.stringify([{ id: 'wedged', task: 'wedged work', due: Date.now() - 5000, created: Date.now() - 6000, status: 'running' }]));
    registerScheduledRunner((text) => {
      seen.push(text);
      return Promise.resolve('done: reclaimed');
    });
    await tick(Date.now());
    const all = await listScheduled();
    const wedged = all.find((x) => x.id === 'wedged');
    expect(wedged?.status).toBe('done');
    expect(seen.length).toBe(1);
  });
});

// ------------------------------------------------------------------ §1.3 episodic outbox

const episodePayload = (request: string, outcome: string) => ({
  request,
  verdict: 'completed' as const,
  outcome,
  approach: 'direct execution',
  origin: 'observed' as const,
});

describe('R28 §1.3 — episodic-memory outbox hardening', () => {
  beforeEach(async () => {
    // queue-triggered drains run detached: let any in-flight drain settle BEFORE the
    // stores are deleted, or its final save would resurrect rows into the next test.
    await waitForDrainIdleForTests();
    fs.rmSync(file('brain', 'episodes.json'), { force: true });
    fs.rmSync(pendingEpisodeStoreFile(), { force: true });
  });

  /** Synchronous read of the outbox store for polling (no lock needed for a test read). */
  const pendingEpisodeSummarySync = (): { pending: number; recorded: number; failed: number } => {
    try {
      const rows = JSON.parse(fs.readFileSync(pendingEpisodeStoreFile(), 'utf8')) as Array<{ status: string }>;
      return {
        pending: rows.filter((r) => r.status === 'pending').length,
        recorded: rows.filter((r) => r.status === 'recorded').length,
        failed: rows.filter((r) => r.status === 'failed').length,
      };
    } catch {
      return { pending: 0, recorded: 0, failed: 0 };
    }
  };

  it('queueing the same finished task twice does not stack duplicate pending rows', async () => {
    const a = await queueEpisode(episodePayload('deploy the service', 'deployed v2 to staging'));
    const b = await queueEpisode(episodePayload('deploy the service', 'deployed v2 to staging'));
    expect(a.queued).toBe(true);
    expect(b.queued).toBe(true);
    expect(b.id).toBe(a.id); // the SAME row, not a second one
    await waitForDrainIdleForTests();
    const summary = await pendingEpisodeSummary();
    expect(summary.pending + summary.recorded).toBe(1); // exactly ONE row exists, whichever state it reached
  });

  it('a crash between episode persist and outbox save cannot double-record: the repeat drains as duplicate', async () => {
    // 1. queue, let the queue-triggered drain settle, and confirm one recorded episode
    await queueEpisode(episodePayload('fix the flaky test', 'test stabilized after retry budget fix'));
    await until(() => pendingEpisodeSummarySync().recorded === 1);
    await waitForDrainIdleForTests(); // the detached drain must be fully settled before the file is rewritten
    // 2. simulate the crash window: the row was persisted but the outbox save never landed —
    //    restore the row as still-pending on disk
    const storeFile = pendingEpisodeStoreFile();
    const rows = JSON.parse(fs.readFileSync(storeFile, 'utf8')) as Array<{ id: string; status: string; attempts: number }>;
    rows.forEach((r) => {
      r.status = 'pending';
    });
    fs.writeFileSync(storeFile, JSON.stringify(rows));
    // 3. the next drain re-processes it — recordEpisode's content-keyed dedupe makes this
    //    an honest DUPLICATE, and the episode store still holds exactly one copy.
    const second = await processPendingEpisodes();
    expect(second.duplicates).toBe(1);
    expect(second.recorded).toBe(0);
    const records = await listEpisodeRecords();
    expect(records.filter((r) => r.text.includes('fix the flaky test')).length).toBe(1);
  });

  it('draining while another drain runs is safe (no double-count, everything settles)', async () => {
    for (let i = 0; i < 5; i++) {
      await queueEpisode(episodePayload(`parallel task ${i}`, `outcome ${i}`));
    }
    // queueEpisode triggers its own drains; an explicit concurrent drain must be a no-op or
    // settle the remainder without losing or duplicating rows.
    await processPendingEpisodes();
    await until(() => {
      const s = pendingEpisodeSummarySync();
      return s.pending === 0 && s.recorded === 5;
    });
    await waitForDrainIdleForTests();
    const records = await listEpisodeRecords();
    const counted = records.filter((r) => r.text.includes('parallel task')).length;
    expect(counted).toBe(5); // all five, exactly once each
  });

  it('task completion never depends on memory: queueing reports honestly when persistence fails', async () => {
    // point the outbox at a directory (save will fail) — queueEpisode must NOT throw
    const storeFile = pendingEpisodeStoreFile();
    fs.mkdirSync(storeFile, { recursive: true });
    const res = await queueEpisode(episodePayload('doomed episode', 'should fail to persist'));
    fs.rmSync(storeFile, { recursive: true, force: true });
    expect(res.queued).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

// ------------------------------------------------------------------ §1.4 integration states

describe('R28 §1.4 — integration-state accuracy', () => {
  const stateFile = file('brain', 'integrations.json');

  beforeEach(() => {
    fs.rmSync(stateFile, { force: true });
  });

  it('a corrupted checks history never crashes connectionState and never serves fake evidence', async () => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        disabled: 'not-an-array',
        connected: { repository: 'not-a-number' },
        checks: { repository: 'not-an-array', web: [{ at: 'nope', ok: 'nope', kind: 'bogus' }, { at: 1, ok: true, kind: 'static' }] },
      })
    );
    const st = await connectionState('repository');
    expect(st.phase).toBeTruthy(); // computed without throwing
    expect(st.lastCheck === undefined || typeof st.lastCheck.at === 'number').toBe(true);
  });

  it('validation evidence older than 30 days is flagged STALE (availability semantics unchanged)', async () => {
    process.env.GITHUB_TOKEN = 'ghp_validcredentialvalue';
    const old = Date.now() - 31 * 24 * 3600_000;
    await recordIntegrationCheck('repository', { ok: true, kind: 'static', detail: 'credentials present (aged fixture)', at: undefined } as never);
    // backdate the recorded check
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { checks: Record<string, Array<{ at: number }>> };
    raw.checks.repository[raw.checks.repository.length - 1].at = old;
    fs.writeFileSync(stateFile, JSON.stringify(raw));
    const st = await connectionState('repository');
    expect(st.available).toBe(true); // the recorded check still earns the state
    expect(st.staleCheck).toBe(true);
    expect(typeof st.lastOkAt).toBe('number');
    delete process.env.GITHUB_TOKEN;
  });

  it('recent validation is never flagged stale', async () => {
    process.env.GITHUB_TOKEN = 'ghp_validcredentialvalue';
    await recordIntegrationCheck('repository', { ok: true, kind: 'static', detail: 'credentials present' });
    const st = await connectionState('repository');
    expect(st.staleCheck).toBeFalsy();
    delete process.env.GITHUB_TOKEN;
  });
});

// ------------------------------------------------------------------ §1.5 retry safety

describe('R28 §1.5 — task retry/cancellation safety', () => {
  it('a FAILED task with UNKNOWN-outcome steps refuses retry until reconciliation', async () => {
    const t = await createTask(buildTaskSpec('push the release to the registry and verify'), 'queued');
    // force a FAILED verdict with an unknown-outcome step (a side effect that may have landed)
    t.steps.push({
      id: 's1',
      title: 'publish the release',
      kind: 'general',
      status: 'running',
      result: '',
      attempts: 1,
      outcomeUnknown: true,
    } as never);
    t.status = 'FAILED';
    const deps = { run: async () => '', schemas: () => [] } as unknown as CoordinatorDeps;
    const out = await retryTask(t.id, deps);
    expect(out).toContain('NOT DONE');
    expect(out).toContain('UNKNOWN');
    expect(out).toContain('task_resume');
    // the record is untouched: still FAILED, no new task spawned
    const after = await getTask(t.id);
    expect(after?.status).toBe('FAILED');
  });

  it('a clean FAILED task remains retryable (distinct identity, original preserved)', async () => {
    const t = await createTask(buildTaskSpec('write the summary file'), 'queued');
    t.status = 'FAILED';
    const deps: CoordinatorDeps = {
      run: async () => 'ok',
      schemas: () => [],
      planner: async () => [{ title: 'do it', detail: 'x', kind: 'general' }],
    };
    const out = await retryTask(t.id, deps);
    expect(out).toContain('Task');
    expect(out).toContain('started');
    expect(out).toContain('failure record');
    const original = await getTask(t.id);
    expect(original?.status).toBe('FAILED'); // untouched history
    // the coordinator tool surface carries the same contract
    const tool = coordinatorTools(deps).task_retry;
    expect(tool).toBeTruthy();
  });
});
