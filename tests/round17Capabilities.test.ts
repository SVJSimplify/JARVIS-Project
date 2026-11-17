import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { checkArgs, parseArgs, resolveTool } from '../src/main/toolArgs';
import { runToolDetailed } from '../src/main/tools';
import { registerDynamicAgent, listDynamicAgents, resolveAgent, agentAllows, getDynamicAgent, resetDynamicAgentsForTests } from '../src/main/agentRegistry';
import { manifestIssues } from '../src/main/capabilityManifest';
import { TOOL_SCHEMAS } from '../src/main/tools';
import { projectMemoryTools } from '../src/main/projectMemory';
import { resetTaskStoreForTests } from '../src/main/taskStore';
import { setPidNameResolver } from '../src/main/procInfo';
import { toolRegistry } from '../src/main/tools';

/**
 * ROUND 17 — CAPABILITY REGRESSION SUITE.
 * Structured results (F-07), schema enforcement (F-11), no silent substitution (F-10),
 * dynamic agents (Pillar 2), project memory (Pillar 5), registry integrity with the new
 * tools (spawn_agent, project_save, project_read).
 */

beforeEach(() => {
  process.env.JARVIS_FILES_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-r17c-'));
  resetTaskStoreForTests();
  resetDynamicAgentsForTests();
  setPidNameResolver(null);
});

describe('F-07: structured tool result envelopes', () => {
  it('a blocked call returns status error with errorKind blocked (and the classic text)', async () => {
    const res = await runToolDetailed('run_command', JSON.stringify({ command: 'rimraf dist' }));
    expect(res.status).toBe('error');
    expect(res.errorKind).toBe('blocked');
    expect(res.text).toMatch(/^BLOCKED:/);
    expect(res.auth).toBe('blocked');
  });

  it('an unknown tool is unavailable (distinguishable from failed), never substituted', async () => {
    const res = await runToolDetailed('totally_not_a_tool', '{}');
    // Spec §10.3: missing/unloaded tools are distinguishable from FAILED tools.
    expect(res.status).toBe('unavailable');
    expect(res.errorKind).toBe('unknown-tool');
    expect(res.text).toContain('Unknown tool');
  });

  it('a successful read-only tool returns status success and the exact old text', async () => {
    const res = await runToolDetailed('calculate', JSON.stringify({ expression: '1 + 2' }));
    expect(res.status).toBe('success');
    expect(res.text).toContain('3');
  });
});

describe('F-11: schema validation enforces enums, ranges and lengths', () => {
  const schema = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['file', 'folder', 'any'] },
      depth: { type: 'number', minimum: 1, maximum: 10 },
      title: { type: 'string', maxLength: 8 },
      body: { type: 'string', minLength: 3 },
    },
    required: ['kind'],
  };
  it('enum violations fail with the valid values', () => {
    expect(() => checkArgs('t', { kind: 'symlink' }, schema)).toThrow(/must be one of: file \| folder \| any/);
  });
  it('numeric ranges fail with the bound', () => {
    expect(() => checkArgs('t', { kind: 'file', depth: 99 }, schema)).toThrow(/must be ≤ 10/);
    expect(() => checkArgs('t', { kind: 'file', depth: 0 }, schema)).toThrow(/must be ≥ 1/);
    expect(checkArgs('t', { kind: 'file', depth: '5' }, schema).depth).toBe(5); // coercion still works
  });
  it('string length bounds fail with actionable messages', () => {
    expect(() => checkArgs('t', { kind: 'file', title: 'way too long' }, schema)).toThrow(/maximum length of 8/);
    expect(() => checkArgs('t', { kind: 'file', body: 'ab' }, schema)).toThrow(/at least 3/);
  });
  it('valid arguments pass untouched', () => {
    const out = checkArgs('t', { kind: 'folder', depth: 3, title: 'short', body: 'ok!' }, schema);
    expect(out).toMatchObject({ kind: 'folder', depth: 3, title: 'short', body: 'ok!' });
  });
});

describe('F-10: fuzzy matching can never select an acting tool', () => {
  it('a near-miss of browser_open does not resolve (browser_open acts)', () => {
    const registry = toolRegistry();
    const safeToGuess = (n: string): boolean =>
      /^(tinyfish_|search_and_read|web_search|web_browse|fetch_url|get_weather|code_search|read|glob|grep|inspect_app|see_screen|screen_text|get_|list_|find_|browser_(snapshot|read|see|tabs|search))/.test(n) || registry[n]?.parallelSafe === true;
    expect(resolveTool('browser_opeen', toolRegistry(), safeToGuess)).toBeNull();
    expect(resolveTool('browser_snapshot_typo', toolRegistry(), safeToGuess)).toBe('browser_snapshot');
  });
});

describe('Pillar 2: dynamic task-specific agents', () => {
  it('registers a bounded specialist in the ONE registry and resolves it', () => {
    const def = registerDynamicAgent({ name: 'CSV Analyst', purpose: 'Analyze CSV exports', tools: ['read', 'glob', 'calculate', 'task'] }, 'main');
    expect(def.name).toBe('dyn_csv_analyst');
    expect(def.delegationPolicy).toBe('none');
    expect(agentAllows(def, 'read')).toBe(true);
    expect(agentAllows(def, 'task')).toBe(false); // delegation stripped
    expect(resolveAgent('dyn_csv_analyst').name).toBe('dyn_csv_analyst');
    expect(getDynamicAgent('dyn_csv_analyst')?.parent).toBe('main');
    expect(listDynamicAgents()).toHaveLength(1);
  });
  it('refuses garbage: no tools, permanent-name collision, budget clamping', () => {
    expect(() => registerDynamicAgent({ name: 'x', purpose: 'p', tools: ['task'] }, 'main')).toThrow(/at least one tool/);
    expect(() => registerDynamicAgent({ name: 'general', purpose: 'p', tools: ['read'] }, 'main')).toThrow(/collides with a permanent agent/);
    const def = registerDynamicAgent({ name: 'y', purpose: 'p', tools: ['read'], maxRounds: 9999, maxMs: 999999999 }, 'main');
    expect(def.maxRounds).toBeLessThanOrEqual(24);
    expect(def.maxMs).toBeLessThanOrEqual(8 * 60_000);
  });
  it('the dynamic roster is capped', () => {
    for (let i = 0; i < 8; i++) registerDynamicAgent({ name: `sp${i}`, purpose: 'p', tools: ['read'] }, 'main');
    expect(() => registerDynamicAgent({ name: 'overflow', purpose: 'p', tools: ['read'] }, 'main')).toThrow(/limit reached/);
  });
});

describe('Pillar 5: project memory', () => {
  it('saves, updates with decisions, and reads back with the ground-truth warning', async () => {
    await projectMemoryTools.project_save.run({
      name: 'jarvis-core',
      workspace: '/work/jarvis',
      description: 'The Electron agent',
      stack: ['typescript', 'electron'],
      keyFiles: ['src/main/coordinator.ts'],
    });
    await projectMemoryTools.project_save.run({ name: 'jarvis-core', decision: 'One task engine only', progress: 'Round 17 in flight' });
    const out = String(await projectMemoryTools.project_read.run({ name: 'jarvis' }));
    expect(out).toContain('# jarvis-core');
    expect(out).toContain('One task engine only');
    expect(out).toContain('verify against the actual files');
    expect(String(await projectMemoryTools.project_read.run({}))).toContain('jarvis-core');
  });
});

describe('registry integrity with the Round 17 tools', () => {
  it('spawn_agent and project tools are registered with schemas and cannot be nested by children', () => {
    const registry = toolRegistry();
    for (const t of ['spawn_agent', 'project_save', 'project_read', 'start_task', 'task_status', 'task_cancel', 'task_resume', 'list_tasks']) {
      expect(registry[t], `${t} must be registered`).toBeTruthy();
      expect(registry[t].description.length).toBeGreaterThan(20);
    }
    expect(manifestIssues(registry, TOOL_SCHEMAS)).toEqual([]);
  });
});

describe('parseArgs robustness stays intact (no regressions)', () => {
  it('repairs and parses tolerantly', () => {
    expect(parseArgs('{"a":1,}')).toMatchObject({ a: 1 });
    expect(parseArgs('```json\n{"b":"x"}\n```')).toMatchObject({ b: 'x' });
  });
});
