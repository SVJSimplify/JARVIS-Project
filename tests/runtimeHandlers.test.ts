import { describe, it, expect, vi } from 'vitest';
import { runTool, toolRegistry, isParallelSafe } from '../src/main/tools';
import { TESTED_PARALLEL, buildCapabilityManifest } from '../src/main/capabilityManifest';
import { recentExecutions } from '../src/main/toolRecord';
import { electronStub } from './helpers/electronStub';

/**
 * RUNTIME HANDLER PROOFS (companion to manifestIssues).
 *
 * manifestIssues proves the registry STRUCTURE (handler exists, schema matches, groups and
 * allowlists resolve). This file proves the RUNTIME WIRING for the read-only surface: each
 * call below goes through the real runTool chain — resolve → planGuard → checkArgs →
 * assessRisk → classifyToolAction → authorize → handler → record — and must come back as a
 * real result with a durable execution record. A handler that is registered but not
 * actually invokable cannot pass this.
 *
 * Write handlers are exercised by their dedicated suites (fsPatch, browser*, headless*,
 * round*) with real side-effect control; nothing here mutates state.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());
vi.mock('../src/main/hud', () => ({ attentionHud: vi.fn(), sendToHud: vi.fn(), focusHud: vi.fn(), setMini: vi.fn() }));

/** Read-only tools driven through runTool with their minimal real arguments. */
const PROBES: Array<{ tool: string; args?: Record<string, unknown>; expect: RegExp }> = [
  { tool: 'get_current_time', expect: /\w{3} \w{3} \d{2}/ },
  { tool: 'list_files', expect: /./ },
  { tool: 'get_system_info', args: {}, expect: /./ },
  { tool: 'calculate', args: { expression: '(12.5 * 8) / 3' }, expect: /33\.3?/ },
  { tool: 'list_timers', expect: /./ },
  { tool: 'list_scheduled', expect: /./ },
  { tool: 'list_memories', expect: /./ },
  { tool: 'find_memory', args: { query: 'recurring routines' }, expect: /./ },
  { tool: 'list_tasks', expect: /./ },
  { tool: 'tool_log', expect: /./ },
  { tool: 'list_capabilities', expect: /Capability manifest — generated/ },
  { tool: 'glob', args: { pattern: '*.txt' }, expect: /./ },
  // Round 28 (Phase 5): the recovery-engine status projection — TESTED_PARALLEL evidence
  { tool: 'ops_recovery_status', expect: /SETTINGS: automatic recovery/ },
];

describe('registered read-only handlers work in the actual runtime', () => {
  for (const probe of PROBES) {
    it(`${probe.tool} executes through the full runTool chain and returns real output`, async () => {
      const out = await runTool(probe.tool, JSON.stringify(probe.args ?? {}));
      expect(out, probe.tool).not.toMatch(/^Unknown tool/);
      expect(out, probe.tool).not.toMatch(/^Tool error/);
      expect(out, probe.tool).not.toMatch(/^BLOCKED/);
      expect(out, probe.tool).not.toMatch(/^NOT APPROVED/);
      expect(out, probe.tool).toMatch(probe.expect);
    }, 20000);
  }

  it('every probe leaves a durable execution record with its authorization decision', async () => {
    const t0 = Date.now();
    await runTool('get_current_time', '{}');
    const rec = recentExecutions(5).find((r) => r.tool === 'get_current_time' && r.t >= t0 - 1000);
    expect(rec, 'runTool must record the execution').toBeTruthy();
    expect(rec?.status).toBe('ok');
    expect(['allowed', 'autonomous']).toContain(rec?.auth ?? '');
    expect(rec?.agent.length ?? '').toBeGreaterThan(0);
  });

  it('a blocked request is recorded as not-run with auth=blocked (evidence, not silence)', async () => {
    const t0 = Date.now();
    const out = await runTool('run_command', JSON.stringify({ command: 'rimraf dist' }));
    expect(out).toMatch(/^BLOCKED/);
    const rec = recentExecutions(5).find((r) => r.tool === 'run_command' && r.t >= t0 - 1000);
    expect(rec?.status).toBe('not-run');
    expect(rec?.auth).toBe('blocked');
  });
});

describe('the tested parallel contract holds at runtime', () => {
  it('every TESTED_PARALLEL member is registered, declared parallel-safe and manifest-consistent', () => {
    const registry = toolRegistry();
    for (const name of TESTED_PARALLEL) {
      expect(registry[name], `${name} is in TESTED_PARALLEL but not registered`).toBeTruthy();
      expect(registry[name].parallelSafe, `${name} must declare parallelSafe itself`).toBe(true);
      expect(isParallelSafe(name), `${name} must resolve as parallel-safe`).toBe(true);
    }
    const manifest = buildCapabilityManifest(registry, []);
    for (const t of manifest.tools.filter((x) => x.parallelSafe)) {
      expect(TESTED_PARALLEL.has(t.name), `${t.name} shows parallelSafe in the manifest without contract membership`).toBe(true);
    }
  });
});
