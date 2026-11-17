import { describe, it, expect, vi } from 'vitest';
import { toolRegistry, TOOL_SCHEMAS, capabilityPrompt, runTool, isParallelSafe } from '../src/main/tools';
import { buildCapabilityManifest, manifestForPrompt, manifestReport, manifestIssues } from '../src/main/capabilityManifest';
import { electronStub } from './helpers/electronStub';

/**
 * CAPABILITY MANIFEST PROOFS.
 *
 * Spec: the model must know its ACTUAL capabilities. A tool that is implemented but not
 * registered is incomplete; registered but not exposed is incomplete; exposed but not
 * executable is a serious defect. These tests enforce registry↔manifest↔schema parity.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());
vi.mock('../src/main/hud', () => ({ attentionHud: vi.fn(), sendToHud: vi.fn(), focusHud: vi.fn(), setMini: vi.fn() }));

const registry = () => toolRegistry();
/** The schema list exactly as tools.schemas() builds it — derived from the live registry. */
const liveSchemas = () =>
  Object.entries(registry()).map(([name, t]) => ({
    type: 'function' as const,
    function: { name, description: t.description, parameters: t.parameters },
  }));

describe('registry integrity: the model-visible surface IS the executable surface', () => {
  it('has zero manifest issues across the whole registry', () => {
    const issues = manifestIssues(registry(), liveSchemas());
    expect(issues, issues.join('\n')).toEqual([]);
  });

  it('keeps the static exported schema list in parity with the registry', () => {
    // TOOL_SCHEMAS is a module-load snapshot; the live set must never be smaller in a way
    // that hides a registered tool from the model. Grouped routers derive from the same
    // source, so any drift here is a wiring bug.
    const snap = new Set(TOOL_SCHEMAS.map((s) => s.function.name));
    const live = new Set(liveSchemas().map((s) => s.function.name));
    for (const n of live) expect(snap.has(n), `${n} is live but missing from TOOL_SCHEMAS`).toBe(true);
  });

  it('every tool exposes an object schema whose required params are declared', () => {
    for (const [name, t] of Object.entries(registry())) {
      const params = t.parameters as { type?: string; properties?: Record<string, unknown>; required?: string[] } | undefined;
      expect(params, `${name} parameters`).toBeTruthy();
      expect(params?.type, `${name} parameters.type`).toBe('object');
      for (const r of params?.required ?? []) expect(params?.properties?.[r], `${name}.${r}`).toBeTruthy();
    }
  });
});

describe('the generated manifest reflects the registry', () => {
  const manifest = () => buildCapabilityManifest(registry(), liveSchemas());

  it('counts every registered tool', () => {
    expect(manifest().toolCount).toBe(Object.keys(registry()).length);
    expect(manifest().toolCount).toBeGreaterThan(80);
  });

  it('maps tools to router groups and marks the rest as core', () => {
    const m = manifest();
    expect(m.tools.find((t) => t.name === 'browser_click')?.group).toBe('browser');
    expect(m.tools.find((t) => t.name === 'run_command')?.group).toBe('files');
    expect(m.tools.find((t) => t.name === 'run_command')?.required).toEqual(['command']);
    expect(m.tools.find((t) => t.name === 'get_current_time')?.group).toBe('core');
  });

  it('carries the hard policy limits verbatim', () => {
    const m = manifest();
    expect(m.limits).toHaveLength(2);
    expect(m.limits.some((l) => /deletion/i.test(l))).toBe(true);
    expect(m.limits.some((l) => /read-only/i.test(l))).toBe(true);
  });

  it('lists the delegation agents from the agent registry', () => {
    const names = manifest().agents.map((a) => a.name);
    expect(names).toContain('general');
    expect(names).toContain('researcher');
    expect(names).toContain('verifier');
  });
});

describe('the model receives the manifest in its system prompt', () => {
  it('prompt context states tool counts, agents and limits', () => {
    const text = capabilityPrompt();
    expect(text).toMatch(/CAPABILITIES \(generated from the live tool registry\): \d+ tools/);
    expect(text).toMatch(/list_capabilities/);
    expect(text).toMatch(/HARD LIMITS/);
    expect(text).toMatch(/Deletion is disabled/i);
    expect(text).toMatch(/AGENTS available for delegation/);
  });

  it('lists every tool with its parameters', () => {
    const report = manifestReport(buildCapabilityManifest(registry(), liveSchemas()));
    for (const name of ['browser_click', 'run_command', 'list_capabilities', 'start_task', 'make_document']) {
      expect(report).toContain(name);
    }
    expect(report).toMatch(/required: command/);
    // The report must survive the provider's 12k tool-result truncation with its tail intact.
    expect(report.length).toBeLessThanOrEqual(11500);
    expect(report).toMatch(/HARD LIMITS: Deletion is disabled/);
  });
});

describe('list_capabilities is itself a real, working tool', () => {
  it('is registered and returns the generated catalogue', async () => {
    const t = registry().list_capabilities;
    expect(t).toBeTruthy();
    const out = await t.run({ group: 'browser' });
    expect(out).toContain('browser_click');
    expect(out).not.toContain('REGISTRY INTEGRITY ISSUES');
    const full = await t.run({});
    expect(full).toMatch(/Capability manifest — generated/);
    expect(full).toMatch(/HARD LIMITS/);
  });

  it('runs through the same execution route as any tool (authorization gate applied)', async () => {
    const out = await runTool('list_capabilities', JSON.stringify({}));
    expect(out).toMatch(/Capability manifest/);
    expect(out).not.toMatch(/^(Tool error|Unknown tool|BLOCKED|NOT APPROVED|NOT DONE)/);
    // list_capabilities is pure in-memory, but it does NOT declare parallelSafe: only the
    // reviewed TESTED_PARALLEL contract members may claim concurrency rights.
    expect(isParallelSafe('list_capabilities')).toBe(false);
  });
});

describe('parallel-safe is declared per tool and pinned by a tested contract', () => {
  it('every declared parallel-safe tool is in TESTED_PARALLEL and every member exists', () => {
    const issues = manifestIssues(registry(), liveSchemas());
    expect(issues, issues.join('\n')).toEqual([]); // includes: declared ⇒ TESTED_PARALLEL member, and every member registered
    const declared = Object.entries(registry())
      .filter(([, t]) => t.parallelSafe === true)
      .map(([n]) => n);
    expect(declared.length).toBeGreaterThan(20);
    // Non-declaration is the default: a write tool must never be parallel-safe.
    for (const writer of ['write_file', 'edit_file', 'run_command', 'browser_click']) {
      expect(registry()[writer]?.parallelSafe ?? false, `${writer} must not be parallel-safe`).toBe(false);
      expect(isParallelSafe(writer)).toBe(false);
    }
  });

  it('isParallelSafe reads the declaration, nothing else', () => {
    for (const name of ['get_current_time', 'list_files', 'read', 'web_search', 'browser_tabs']) {
      expect(isParallelSafe(name), name).toBe(true);
    }
    expect(isParallelSafe('does_not_exist_tool')).toBe(false);
  });
});
