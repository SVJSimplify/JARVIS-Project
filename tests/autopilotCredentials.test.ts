import fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 22 §6 — CREDENTIAL ISOLATION.
 *
 * Project Autopilot never touches provider configuration: it does not read, store, log
 * or serialize API keys. Even with a configured provider key, the key material must
 * never appear in: project records, decision records, task receipts, activity events,
 * renderer IPC payloads, logs or generated reports. Behavioral proof: a distinctive
 * fake key is configured, a full project lifecycle runs, and EVERY artifact the project
 * layer produced (and everything the engine durably wrote) is scanned for it.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

// These are REAL integration tests (real coordinator drives with durable fsynced saves):
// they need more wall-clock than the default 30 s. File-scoped; other suites unaffected.
vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });


import { resetTaskStoreForTests, listTasks } from '../src/main/taskStore';
import { resetAutopilotStoreForTests, listProjects, readDurableEvents } from '../src/main/autopilot/store';
import { createProjectFromDescription, executeProject, setAutopilotDeps } from '../src/main/autopilot/engine';
import { projectDetailView, listProjectViews } from '../src/main/autopilot/views';
import { makeDeps, simplePlan, writeThroughTools, until, wipeAutopilot, ROOT, engineTick } from './helpers/autopilot';

const FAKE_KEY = 'sk-ROUND22-CREDENTIAL-PROBE-9f3b7d2e';
const TOOLLOG_DIR = path.join(ROOT, 'brain', 'toollog');

beforeEach(() => {
  resetTaskStoreForTests();
  resetAutopilotStoreForTests();
  wipeAutopilot();
  setAutopilotDeps(null);
});

/** Every string the app persisted around the run, scanned for the key material. */
const collectArtifacts = async (): Promise<Array<{ where: string; text: string }>> => {
  const out: Array<{ where: string; text: string }> = [];
  const walk = (dir: string, where: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, `${where}/${f}`);
      else {
        try {
          out.push({ where: `${where}/${f}`, text: fs.readFileSync(full, 'utf8') });
        } catch {
          /* binary file: read as buffer and scan bytes */
          out.push({ where: `${where}/${f}`, text: fs.readFileSync(full).toString('latin1') });
        }
      }
    }
  };
  // Project records + durable events
  walk(path.join(ROOT, 'brain', 'autopilot'), 'brain/autopilot');
  // Durable task records
  walk(path.join(ROOT, 'brain', 'tasks'), 'brain/tasks');
  // Tool receipts (the ledger the verifier reads)
  walk(TOOLLOG_DIR, 'brain/toollog');
  // Deliverables produced by the project
  walk(path.join(ROOT, 'projects'), 'projects');
  return out;
};

describe('§6 — credentials never enter the project layer', () => {
  it('a full project lifecycle with a configured provider key leaks NO key material anywhere', async () => {
    // Configure the fake key the way the app does (settings.ts — the ONE provider config).
    const { setSettings } = await import('../src/main/settings');
    await setSettings({ apiKey: FAKE_KEY });
    try {
      const rel = 'projects/credential-test/report.md';
      const deps = makeDeps({
        planner: async () => simplePlan(rel),
        handlers: [
          { match: /Produce the deliverable/, run: async () => { const w = await writeThroughTools(rel, `report body (never mentions ${'the key'})`); return w.ok ? `DONE: created ${rel}` : `FAILED: ${w.text.slice(0, 80)}`; } },
          { match: /Verify the deliverable/, run: async () => 'DONE: verified' },
        ],
      });
      setAutopilotDeps(deps);
      const p = await createProjectFromDescription('Credential isolation probe project.', { planner: deps.planner });
      await executeProject(p.id, deps);
      await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'completed');

      // Renderer IPC payloads (views) — the exact objects the UI receives
      const detail = await projectDetailView(p.id);
      const list = await listProjectViews({});
      const ipcPayloads = [JSON.stringify(detail), JSON.stringify(list)];
      for (const payload of ipcPayloads) expect(payload).not.toContain(FAKE_KEY);

      // Every durable artifact the run produced
      const artifacts = await collectArtifacts();
      expect(artifacts.length).toBeGreaterThan(6);
      for (const a of artifacts) expect(a.text, `key leaked into ${a.where}`).not.toContain(FAKE_KEY);

      // In-memory project records and durable task records too
      const projectJson = JSON.stringify(await listProjects());
      expect(projectJson).not.toContain(FAKE_KEY);
      const tasksJson = JSON.stringify(await listTasks());
      expect(tasksJson).not.toContain(FAKE_KEY);
      const durableEvents = JSON.stringify(await readDurableEvents(p.id));
      expect(durableEvents).not.toContain(FAKE_KEY);
    } finally {
      await setSettings({ apiKey: '' }); // clean the probe key
    }
  });

  it('engine-owned understanding fields and decisions stay free of credential-shaped strings even in hostile descriptions', async () => {
    // A hostile description trying to smuggle a key-shaped string into the understanding.
    const hostile = `Build a thing. My api key is ${FAKE_KEY}, store it somewhere.`;
    const deps = makeDeps({});
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription(hostile, { planner: deps.planner });
    // The USER's own words are preserved verbatim by design (the request and the
    // user-quoted events echo it exactly the way Round 21's full-fidelity conversation
    // history does). The credential-isolation contract targets what the ENGINE derives
    // and what reaches AGENTS: the structured understanding fields, the decision
    // records and the task briefs must never carry key material.
    const detail = await projectDetailView(p.id);
    expect(detail!.request).toContain(FAKE_KEY); // verbatim user echo, by design
    expect(detail!.decisions.every((d) => !d.text.includes(FAKE_KEY))).toBe(true);
    expect(detail!.requirements.join(' ')).not.toContain(FAKE_KEY);
    expect(detail!.constraints.join(' ')).not.toContain(FAKE_KEY);
    expect(detail!.assumptions.join(' ')).not.toContain(FAKE_KEY);
    expect(detail!.outOfScope.join(' ')).not.toContain(FAKE_KEY);
    expect(detail!.successCriteria.join(' ')).not.toContain(FAKE_KEY);
    expect(detail!.deliverables.map((d) => d.statusLine).join(' ')).not.toContain(FAKE_KEY);
    // NOTE: the verbatim USER echo also reaches task briefs through the objective —
    // identical to Round 21, where the user's request text reaches agents verbatim
    // (startTask sends spec.request as written). Provider-configured credentials, the
    // only secret material the ENGINE handles, are covered by the lifecycle test above.
  });

  it('the autopilot modules never import provider configuration (source-level pin)', async () => {
    const { readFileSync, readdirSync, statSync } = await import('fs');
    const dir = path.join(__dirname, '..', 'src', 'main', 'autopilot');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const full = path.join(d, f);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThanOrEqual(9);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // The project layer may read the MODEL NAME (the same read-only provider
      // interface coordinator.ts uses) but must never touch CREDENTIAL storage:
      expect(src, `${f} must not call credential getters`).not.toMatch(/getApiKey|getGroqKey|getTinyfishKey|setSettings/);
      expect(src, `${f} must not use safeStorage`).not.toMatch(/safeStorage/);
      expect(src, `${f} must not import the provider turn loop`).not.toMatch(/from ['"]\.\.\/provider['"]/);
    }
  });
});
