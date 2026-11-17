/**
 * JARVIS ROUND 28 — PHASES 3–5 TESTS.
 *
 * Phase 3: integration capability expansion (native browser, deployment, productivity),
 *          honest availability, real operations naming real executor tools.
 * Phase 4: the desktop visual-verification layer (pure, platform-independent).
 * Phase 5: the bounded recovery engine — plans, budgets, user controls, durable ledger,
 *          and genuine recovery from controlled failure scenarios.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { discoverIntegrations, integrationTools, connectionState, recordIntegrationCheck } from '../src/main/integrations';
import {
  assessTargetAmbiguity,
  desktopVerifyBlock,
  didWindowChange,
  isTargetStale,
  mapCoordinates,
  verifyDesktopAction,
} from '../src/main/desktopVerify';
import {
  attemptRecovery,
  detectOperationalIssues,
  getRecoverySettings,
  recoveryPlanFor,
  recoveryStatus,
  runRecoveryFor,
  setRecoverySettings,
  dropRecoverySettingsCacheForTests,
  superviseOperations,
} from '../src/main/opsCenter';
import { queueEpisode, pendingEpisodeStoreFile, waitForDrainIdleForTests, processPendingEpisodes } from '../src/main/episodicMemory';
import { dropNativeConfigCacheForTests, setNativeConfig } from '../src/main/nativeBrowser';


const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-test-${process.pid}`);
const file = (...p: string[]): string => path.join(ROOT, ...p);

// ----------------------------------------------------------------------------- Phase 3

describe('R28 §3.1/§3.2 — integration capability expansion (real operations, honest states)', () => {
  beforeEach(async () => {
    fs.rmSync(file('brain', 'integrations.json'), { force: true });
    dropNativeConfigCacheForTests();
  });

  it('the native-browser integration names REAL tools and discovers for a background-research request', async () => {
    const hits = await discoverIntegrations('research these three product pages in my chrome browser in background tabs and summarize with sources');
    const nb = hits.find((h) => h.id === 'native-browser');
    expect(nb).toBeTruthy();
    expect(nb!.state.phase).toBe('AVAILABLE'); // no auth required for background research
    expect(nb!.matchedOperations.length).toBeGreaterThan(0);
    for (const op of nb!.matchedOperations) {
      expect(op.via.length).toBeGreaterThan(0);
      for (const v of op.via) expect(v).toMatch(/^native_browser_/); // every operation names its real executor
    }
  });

  it('the deployment integration refuses honestly when unconfigured (never pretends)', async () => {
    delete process.env.VERCEL_TOKEN;
    delete process.env.NETLIFY_AUTH_TOKEN;
    delete process.env.FLY_API_TOKEN;
    const hits = await discoverIntegrations('deploy the project to production');
    const dep = hits.find((h) => h.id === 'deployment');
    expect(dep).toBeTruthy();
    expect(dep!.state.available).toBe(false);
    expect(dep!.state.phase).toBe('NOT_CONFIGURED');
    expect(dep!.state.reason).toContain('not connected');
    // the tool surface says the same
    const out = await integrationTools.integration_discover.run({ request: 'deploy the project to production' });
    expect(out).toContain('deployment');
    expect(out).toContain('UNAVAILABLE');
  });

  it('the productivity integration is available out of the box (built-in, no auth)', async () => {
    const hits = await discoverIntegrations('add a note and set a timer for the sauce');
    const prod = hits.find((h) => h.id === 'productivity');
    expect(prod).toBeTruthy();
    expect(prod!.state.available).toBe(true);
    for (const op of prod!.matchedOperations) for (const v of op.via) expect(typeof v).toBe('string');
  });

  it('a cross-application development request surfaces repository + filesystem together with honest states', async () => {
    delete process.env.GITHUB_TOKEN;
    const hits = await discoverIntegrations('check the github issue and fix the failing test in the workspace');
    const ids = hits.map((h) => h.id);
    expect(ids).toContain('repository');
    expect(ids).toContain('filesystem');
    const repo = hits.find((h) => h.id === 'repository')!;
    expect(repo.state.available).toBe(false); // unconfigured refuses, never invented
    const fsInt = hits.find((h) => h.id === 'filesystem')!;
    expect(fsInt.state.available).toBe(true);
  });

  it('integration states stay accurate across an auth-failure cycle (Workflow H machinery)', async () => {
    process.env.GITHUB_TOKEN = 'ghp_validcredentialvalue';
    await recordIntegrationCheck('repository', { ok: true, kind: 'static', detail: 'credentials present' });
    const ok1 = await connectionState('repository');
    expect(ok1.phase).toBe('AUTHENTICATED');
    expect(ok1.available).toBe(true);
    // the credentials expire: an auth-related check fails
    await recordIntegrationCheck('repository', { ok: false, kind: 'health', error: '401 Bad credentials', authRelated: true });
    const expired = await connectionState('repository');
    expect(expired.phase).toBe('EXPIRED');
    expect(expired.available).toBe(false);
    expect(expired.lastCheck?.at).toBeGreaterThan(0); // evidence carries a timestamp
    expect(expired.reason).toContain('integration_check');
    delete process.env.GITHUB_TOKEN;
  });
});

// ----------------------------------------------------------------------------- Phase 4

describe('R28 §4 — desktop visual verification layer (pure, cross-platform)', () => {
  it('a single distinct target is unambiguous; several DIFFERENT matches refuse to guess', () => {
    const ok = assessTargetAmbiguity(['12,40  Save document', 'File menu has Save'], 'Save document');
    expect(ok.ambiguous).toBe(false);
    const bad = assessTargetAmbiguity(['10,10  Save', '50,60  Save as', '90,20  Save all'], 'Save');
    expect(bad.ambiguous).toBe(true);
    expect(bad.reason).toContain('DIFFERENT');
    expect(bad.candidates.length).toBe(3);
    const none = assessTargetAmbiguity(['10,10  Cancel'], 'Save');
    expect(none.ambiguous).toBe(true);
    expect(none.reason).toContain('re-observe');
  });

  it('coordinate mapping handles display scaling and multi-monitor origins', () => {
    expect(mapCoordinates(150, 90, { scale: 1.5 })).toEqual({ x: 100, y: 60 });
    expect(mapCoordinates(100, 100, { scale: 1 })).toEqual({ x: 100, y: 100 });
    expect(mapCoordinates(10, 10, { scale: 2, originX: -1920, originY: 0 })).toEqual({ x: -1915, y: 5 });
    expect(() => mapCoordinates(Number.NaN, 0)).toThrow(/finite/);
  });

  it('a desktop action is verified from BEFORE/AFTER screen observations with the shared evidence engine', () => {
    const ok = verifyDesktopAction({
      before: { windowTitle: 'Report.docx - Word', heading: 'Report', text: 'quarterly numbers draft' },
      after: { windowTitle: 'Report.docx - Word', heading: 'Saved', text: 'document saved to Report.docx' },
      intent: 'click Save',
      expected: 'the document is saved (the title shows saved)',
    });
    expect(ok.verdict.verdict).toBe('confirmed');
    expect(ok.line).toContain('ACTION VERIFY');
    // an unchanged screen is NOT a successful click
    const noop = verifyDesktopAction({
      before: { windowTitle: 'App', heading: 'Form', text: 'name field' },
      after: { windowTitle: 'App', heading: 'Form', text: 'name field' },
      intent: 'click Submit',
    });
    expect(noop.verdict.verdict).toBe('not-confirmed');
    expect(noop.line).toContain('NOT-CONFIRMED');
  });

  it('stale targets and window switches are detected before they cause wrong-window actions', () => {
    expect(isTargetStale('Save document', ['7,7  Save document', 'File menu'])).toBe(false);
    expect(isTargetStale('Save document', ['File menu', 'Print dialog'])).toBe(true);
    const a = { windowTitle: 'Notepad - notes.txt', heading: 'x', text: '' };
    const b = { windowTitle: 'Calculator', heading: 'x', text: '' };
    expect(didWindowChange(a, b)).toBe(true);
    expect(didWindowChange(a, a)).toBe(false);
  });

  it('the verify block guides recovery on unverified outcomes and flags window changes', () => {
    const block = desktopVerifyBlock({
      before: { windowTitle: 'App A', heading: 'List', text: 'items here' },
      after: { windowTitle: 'App B', heading: 'Other', text: 'different app' },
      intent: 'click Save',
      windowChanged: true,
    });
    expect(block).toContain('ACTION VERIFY');
    expect(block).toContain('CHANGED between observe and act');
    expect(block).toContain('re-observe');
  });
});

// ----------------------------------------------------------------------------- Phase 5

describe('R28 §5 — bounded recovery engine', () => {
  beforeEach(async () => {
    await waitForDrainIdleForTests();
    fs.rmSync(file('brain', 'recovery-log.json'), { force: true });
    fs.rmSync(file('brain', 'ops-recovery.json'), { force: true });
    fs.rmSync(file('brain', 'native-browser.json'), { force: true });
    fs.rmSync(pendingEpisodeStoreFile(), { force: true });
    dropRecoverySettingsCacheForTests();
    dropNativeConfigCacheForTests();
  });

  it('an eligible issue gets an automatic plan; human-judgment issues get recommendations', async () => {
    const planOutbox = await recoveryPlanFor({ kind: 'memory-outbox', severity: 'warn', about: 'episodic-outbox', detail: '2 episodes queued' });
    expect(planOutbox.eligible).toBe(true);
    expect(planOutbox.action).toBe('re-drain-memory-outbox');
    const planStuck = await recoveryPlanFor({ kind: 'stuck-task', severity: 'warn', about: 'task-1', detail: 'RUNNING 20 min without update' });
    expect(planStuck.eligible).toBe(false);
    expect(planStuck.action).toBe('recommendation-only');
    expect(planStuck.userAction).toBeTruthy();
  });

  it('a stuck memory outbox is genuinely recovered by the re-drain strategy (recorded in the ledger)', async () => {
    // seed a stuck pending row exactly like the detector expects (bypassing the auto-drain)
    fs.mkdirSync(path.dirname(pendingEpisodeStoreFile()), { recursive: true });
    fs.writeFileSync(
      pendingEpisodeStoreFile(),
      JSON.stringify([{ id: 'pq-recover-me', createdAt: Date.now(), status: 'pending', attempts: 0, episode: { request: 'recoverable episode', verdict: 'completed', outcome: 'the work really finished', approach: 'direct', origin: 'observed' } }], null, 1)
    );
    const issues = await detectOperationalIssues();
    const stuck = issues.find((i) => i.kind === 'memory-outbox');
    expect(stuck).toBeTruthy();
    const entry = await attemptRecovery(stuck!, { automatic: true });
    expect(entry.outcome).toBe('recovered');
    expect(entry.detail).toContain('1 recorded');
    // the ledger holds the evidence
    const log = JSON.parse(fs.readFileSync(file('brain', 'recovery-log.json'), 'utf8')) as Array<{ outcome: string; action: string }>;
    expect(log.some((l) => l.outcome === 'recovered' && l.action === 're-drain-memory-outbox')).toBe(true);
    // the episode is REALLY in memory now
    await processPendingEpisodes();
    const status = await recoveryStatus();
    expect(status.openIssues.find((i) => i.kind === 'memory-outbox')).toBeUndefined();
  });

  it('the hourly budget is enforced and recorded (no unbounded autonomous recovery)', async () => {
    await setRecoverySettings({ autoRecovery: true, maxActionsPerHour: 0 });
    const entry = await attemptRecovery({ kind: 'memory-outbox', severity: 'warn', about: 'episodic-outbox', detail: 'pending episodes exist' }, { automatic: true });
    expect(entry.outcome).toBe('budget-exceeded');
    const log = JSON.parse(fs.readFileSync(file('brain', 'recovery-log.json'), 'utf8')) as Array<{ outcome: string }>;
    expect(log.some((l) => l.outcome === 'budget-exceeded')).toBe(true);
  });

  it('disabling automatic recovery is honored (the user control wins)', async () => {
    await setRecoverySettings({ autoRecovery: false });
    const settings = await getRecoverySettings();
    expect(settings.autoRecovery).toBe(false);
    fs.mkdirSync(path.dirname(pendingEpisodeStoreFile()), { recursive: true });
    fs.writeFileSync(
      pendingEpisodeStoreFile(),
      JSON.stringify([{ id: 'pq-manual-only', createdAt: Date.now(), status: 'pending', attempts: 0, episode: { request: 'manual recovery episode', verdict: 'completed', outcome: 'finished work', approach: 'direct', origin: 'observed' } }], null, 1)
    );
    const entry = await attemptRecovery({ kind: 'memory-outbox', severity: 'warn', about: 'episodic-outbox', detail: 'pending' }, { automatic: true });
    expect(entry.outcome).toBe('not-eligible');
    expect(entry.detail).toContain('disabled by the user');
    // the USER can still run it explicitly (their action IS the authorization)
    const manual = await runRecoveryFor('episodic-outbox');
    expect(manual).toContain('RECOVERED');
  });

  it('recovery of a lost managed browser goes through the native module\u2019s own honest gate', async () => {
    // no browser executable configured in this environment → the reconnect refuses honestly
    await setNativeConfig({ autoReconnect: true, mode: 'B', selectedBrowser: '/nonexistent/browser/binary' });
    const entry = await attemptRecovery({ kind: 'browser-session', severity: 'warn', about: 'native-browser:nb-test', detail: 'the managed browser session ended (process exited)' }, { automatic: true });
    expect(entry.outcome).toBe('not-eligible');
    expect(entry.detail.toLowerCase()).toContain('no installed chromium-family browser');
    expect(entry.userAction).toBeTruthy();
  });

  it('an unknown recovery target refuses honestly (nothing invented)', async () => {
    const out = await runRecoveryFor('no-such-issue');
    expect(out).toContain('NOT DONE');
    expect(out).toContain('nothing to recover');
  });

  it('the supervision pass recovers eligible issues automatically within budget (Workflow F machinery)', async () => {
    await setRecoverySettings({ autoRecovery: true, maxActionsPerHour: 6 });
    fs.mkdirSync(path.dirname(pendingEpisodeStoreFile()), { recursive: true });
    fs.writeFileSync(
      pendingEpisodeStoreFile(),
      JSON.stringify([{ id: 'pq-supervised', createdAt: Date.now(), status: 'pending', attempts: 0, episode: { request: 'supervised recovery', verdict: 'completed', outcome: 'work outcome', approach: 'direct', origin: 'observed' } }], null, 1)
    );
    const issues = await superviseOperations();
    expect(issues.some((i) => i.kind === 'memory-outbox')).toBe(true);
    const status = await recoveryStatus();
    expect(status.history.some((h) => h.outcome === 'recovered' && h.issueKind === 'memory-outbox')).toBe(true);
  });
});
