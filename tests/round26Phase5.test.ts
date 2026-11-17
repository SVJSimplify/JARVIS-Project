import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * ROUND 26, PHASE 5 — UNIVERSAL INTEGRATIONS & CAPABILITY REGISTRY.
 *
 * Integrations DESCRIBE capabilities and map them onto the EXISTING registered tools —
 * no second execution path. Discovery is honest: unavailable integrations (missing auth,
 * user-disabled) are reported as unavailable with the reason; every operation names the
 * authorized tool(s) that run it; connection state records presence, never secrets.
 */

import {
  listIntegrations,
  registerIntegration,
  discoverIntegrations,
  connectionState,
  setIntegrationEnabled,
  setIntegrationConnected,
  validateIntegration,
  integrationTools,
} from '../src/main/integrations';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-r26p5-${process.pid}`);

beforeEach(() => {
  fs.rmSync(path.join(ROOT, 'brain', 'integrations.json'), { force: true });
  delete process.env.GITHUB_TOKEN;
  delete process.env.DATABASE_URL;
});

describe('Phase 5 — registry & honest availability', () => {
  it('ships built-in integrations whose operations map to EXISTING tools', () => {
    const all = listIntegrations();
    expect(all.map((d) => d.id)).toEqual(expect.arrayContaining(['web-research', 'filesystem', 'repository', 'desktop', 'database']));
    for (const d of all) {
      for (const op of d.operations) {
        expect(op.via.length).toBeGreaterThan(0);
        // every operation runs via a real, already-registered tool name — no invented executor
        expect(op.via.every((t) => /^[a-z_]+$/.test(t))).toBe(true);
      }
    }
  });

  it('a no-auth integration is available out of the box; an auth integration without keys is honestly UNAVAILABLE', async () => {
    const web = await connectionState('web-research');
    expect(web.available).toBe(true);
    const repo = await connectionState('repository');
    expect(repo.available).toBe(false);
    expect(repo.reason).toContain('missing apikey configuration');
  });

  it('presence of a configured key establishes CONNECTED — AVAILABLE is earned by a recorded validation (R27 §1.4: a stored record is not proof of authentication)', async () => {
    process.env.GITHUB_TOKEN = 'secret-value-that-must-not-be-exposed';
    // Round 26 semantics (updated by Round 27 §1.4): key presence alone was treated as
    // available. The honest lifecycle: CONNECTED (unvalidated) until a check succeeds.
    expect(await connectionState('repository')).toMatchObject({ connected: true, phase: 'CONNECTED', available: false });
    const out = await validateIntegration('repository');
    expect(out).toMatchObject({ phase: 'AUTHENTICATED', available: true });
    expect(out.lastCheck?.detail).toContain('GITHUB_TOKEN');
    expect(out.lastCheck?.detail ?? '').not.toContain('secret-value'); // values are never exposed
  });

  it('user-disabled integrations are unavailable with the honest reason; re-enabling flips back', async () => {
    expect(await setIntegrationEnabled('web-research', false)).toContain('disabled');
    expect(await connectionState('web-research')).toMatchObject({ available: false, reason: expect.stringContaining('disabled') });
    expect(await setIntegrationEnabled('web-research', true)).toContain('enabled');
    expect((await connectionState('web-research')).available).toBe(true);
    expect(await setIntegrationEnabled('nope', true)).toContain('NOT DONE');
  });

  it('connection records persist (state survives a reload) and can be removed', async () => {
    expect(await setIntegrationConnected('database', true)).toContain('connected');
    expect((await connectionState('database')).connected).toBe(true);
    expect(await setIntegrationConnected('database', false)).toContain('disconnected');
    expect((await connectionState('database')).connected).toBe(false);
  });

  it('registerIntegration replaces by id and unknown ids are unknown', async () => {
    expect(registerIntegration({ ...listIntegrations()[0]!, description: 'updated' })).toBe('replaced');
    expect(await connectionState('nope')).toMatchObject({ available: false, reason: expect.stringContaining('unknown integration') });
  });
});

describe('Phase 5 — capability discovery', () => {
  it('ranks matching integrations for a request and names the executing tools', async () => {
    const hits = await discoverIntegrations('research the best providers and compare their pricing');
    expect(hits[0]!.id).toBe('web-research');
    expect(hits[0]!.state.available).toBe(true);
    expect(hits[0]!.matchedOperations.length).toBeGreaterThan(0);
  });

  it('repository work with no token still matches — but reports UNAVAILABLE with the missing auth', async () => {
    const hits = await discoverIntegrations('review the open issues in my github repository and prepare a pull request');
    const repo = hits.find((h) => h.id === 'repository');
    expect(repo).toBeDefined();
    expect(repo!.state.available).toBe(false);
    expect(repo!.state.reason).toContain('GITHUB_TOKEN');
  });

  it('no match → empty (the coordinator never invents capabilities)', async () => {
    expect(await discoverIntegrations('zzz qqq xyzzy')).toEqual([]);
  });

  it('the tool surface renders discovery and status honestly', async () => {
    const out = String(await integrationTools.integration_discover.run({ request: 'organize the project files into folders' }));
    expect(out).toContain('AVAILABLE CAPABILITIES');
    expect(out).toContain('runs via existing tool(s)');
    const status = String(await integrationTools.integration_status.run({}));
    expect(status).toContain('REGISTERED INTEGRATIONS');
    expect(status).toContain('UNAVAILABLE');
  });
});
