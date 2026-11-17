import os from 'os';
import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * ROUND 25 — PART 1: DELEGATION DECISIONS + SPECIALIST CONTRACTS + DYNAMIC ROSTER
 * PERSISTENCE (§2, §3, §8, §10).
 *
 * Pure-logic coverage: the delegation strategy decision (does this work deserve agents
 * at all, and which shape), the five permanent specialist categories as registry
 * entries with input/output/failure contracts, and the dynamic-roster persistence that
 * lets a restart reconstruct task-specific specialists.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import {
  AGENTS,
  agentAllows,
  resolveAgent,
  registerDynamicAgent,
  getDynamicAgent,
  listDynamicAgents,
  retireDynamicAgent,
  persistDynamicAgents,
  restoreDynamicAgents,
  resetDynamicAgentsForTests,
} from '../src/main/agentRegistry';
import { agentDefFor } from '../src/main/orchestrate';
import { decideDelegation, workstreamsOf, delegationSummary } from '../src/main/delegation';
import { buildTaskSpec } from '../src/main/taskSpec';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-r25d-${process.pid}`);
const rosterFile = (): string => path.join(ROOT, 'brain', 'agents', 'dynamic.json');

beforeEach(() => {
  resetDynamicAgentsForTests();
  fs.rmSync(path.join(ROOT, 'brain', 'agents'), { recursive: true, force: true });
});

afterEach(() => {
  resetDynamicAgentsForTests();
});

describe('delegation decision (§3)', () => {
  it('an informational request is answered DIRECTLY — no agents spawn', () => {
    const d = decideDelegation(buildTaskSpec('What is the capital of France?'));
    expect(d.strategy).toBe('direct');
    expect(d.reasons.join(' ')).toMatch(/directly/i);
    expect(d.workstreams).toEqual([]);
  });

  it('a simple self-contained action runs ONE specialist — no planning round, no fan-out', () => {
    const d = decideDelegation(buildTaskSpec('Write a short note file today.txt saying hello'));
    expect(d.strategy).toBe('single_specialist');
    expect(d.kind).toBeDefined();
    expect(d.parallelizable).toBe(false);
    expect(d.complexity).toBeLessThanOrEqual(1);
    expect(d.reasons.join(' ')).toMatch(/no planning round/);
  });

  it('a request naming several independent research streams fans out to PARALLEL read-only agents', () => {
    const spec = buildTaskSpec('Research the price of lithium on the market and also research the price of cobalt, then write a comparison file compare.md covering each of them');
    const d = decideDelegation(spec);
    expect(spec.kind).toBe('action');
    expect(d.strategy).toBe('coordinated_multi_agent');
    expect(d.workstreams.length).toBeGreaterThanOrEqual(2);
    expect(d.parallelizable).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/parallel waves/);
  });

  it('several WRITE streams share one workspace: coordinated, but NEVER parallel', () => {
    const spec = buildTaskSpec('Write a report file a.md and also write a summary file b.md and save them');
    const d = decideDelegation(spec);
    expect(d.strategy).toBe('coordinated_multi_agent');
    expect(d.workstreams.length).toBeGreaterThanOrEqual(2);
    expect(d.parallelizable).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/sequentially|avoid conflicting/i);
  });

  it('complex work is decomposed even without explicit conjunctive markers', () => {
    const spec = buildTaskSpec('Refactor the entire module comprehensively from scratch, write tests, and make sure the build passes');
    const d = decideDelegation(spec);
    expect(d.strategy).toBe('coordinated_multi_agent');
    expect(d.complexity).toBeGreaterThanOrEqual(2);
    expect(d.reasons.join(' ')).toMatch(/decomposition/);
  });

  it('the decision is DETERMINISTIC and its summary names the strategy', () => {
    const spec = buildTaskSpec('Research current news about GPUs and also research CPU benchmarks, then write a comparison file gpus-vs-cpus.md covering each of them');
    const a = decideDelegation(spec);
    const b = decideDelegation(spec);
    expect(a).toEqual(b);
    expect(delegationSummary(a)).toContain(a.strategy);
  });

  it('workstreamsOf only splits on EXPLICIT markers — never invents streams', () => {
    expect(workstreamsOf('Write a report about lithium')).toEqual([]);
    expect(workstreamsOf('Research lithium prices and also research cobalt prices')).toHaveLength(2);
  });
});

describe('permanent specialist contracts (§2A)', () => {
  it('every agent in the registry carries the FULL contract: identity, purpose, tools, budgets, input/output/failure contracts, no delegation', () => {
    for (const [name, def] of Object.entries(AGENTS)) {
      expect(def.name, name).toBe(name);
      expect(def.description.length, name).toBeGreaterThan(10);
      expect(def.responsibility.length, name).toBeGreaterThan(10);
      expect(def.maxRounds, name).toBeGreaterThan(0);
      expect(def.maxMs, name).toBeGreaterThan(0);
      expect(def.contextBudgetChars, name).toBeGreaterThan(0);
      expect(def.inputContract.length, name).toBeGreaterThan(10);
      expect(def.outputContract.length, name).toBeGreaterThan(10);
      expect(def.failureStrategy.length, name).toBeGreaterThan(10);
      expect(def.delegationPolicy, name).toBe('none');
      expect(def.maxActions.every((a) => ['read', 'write', 'execute', 'config'].includes(a)), name).toBe(true);
    }
  });

  it('the five specialist CATEGORIES exist: research, coding, review, testing, planning', () => {
    for (const kind of ['research', 'coder', 'reviewer', 'tester', 'planner'] as const) {
      expect(agentDefFor(kind).name).toBe(kind === 'research' ? 'researcher' : kind);
    }
    for (const name of ['researcher', 'coder', 'reviewer', 'tester', 'planner']) {
      expect(AGENTS[name], `specialist ${name}`).toBeDefined();
    }
  });

  it('the CODER implements and runs checks; the REVIEWER is read-only and can never fix', () => {
    const coder = resolveAgent('coder');
    expect(agentAllows(coder, 'write_file')).toBe(true);
    expect(agentAllows(coder, 'edit_file')).toBe(true);
    expect(agentAllows(coder, 'run_command')).toBe(true);
    expect(agentAllows(coder, 'diagnostics')).toBe(true);
    expect(agentAllows(coder, 'spawn_agent')).toBe(false);
    expect(agentAllows(coder, 'task')).toBe(false);

    const reviewer = resolveAgent('reviewer');
    expect(reviewer.maxActions.every((a) => a === 'read')).toBe(true);
    expect(agentAllows(reviewer, 'read')).toBe(true);
    expect(agentAllows(reviewer, 'grep')).toBe(true);
    expect(agentAllows(reviewer, 'diagnostics')).toBe(true);
    expect(agentAllows(reviewer, 'write_file')).toBe(false);
    expect(agentAllows(reviewer, 'edit_file')).toBe(false);
    expect(agentAllows(reviewer, 'run_command')).toBe(false);
    expect(agentAllows(reviewer, 'spawn_agent')).toBe(false);
  });

  it('the TESTER can write tests and run suites; the PLANNER is analysis-only', () => {
    const tester = resolveAgent('tester');
    expect(agentAllows(tester, 'write_file')).toBe(true);
    expect(agentAllows(tester, 'run_command')).toBe(true);
    expect(agentAllows(tester, 'apply_patch')).toBe(true);
    expect(agentAllows(tester, 'spawn_agent')).toBe(false);

    const planner = resolveAgent('planner');
    expect(planner.maxActions.every((a) => a === 'read')).toBe(true);
    expect(agentAllows(planner, 'todo_write')).toBe(true);
    expect(agentAllows(planner, 'write_file')).toBe(false);
    expect(agentAllows(planner, 'run_command')).toBe(false);
    expect(agentAllows(planner, 'start_task')).toBe(false);
  });

  it('registry agents can never delegate: the delegation tools are outside every static allowlist', () => {
    for (const name of ['coder', 'reviewer', 'tester', 'planner', 'researcher', 'explorer', 'data', 'document', 'verifier']) {
      const def = resolveAgent(name);
      for (const tool of ['spawn_agent', 'task', 'parallel_tasks', 'background_start', 'start_task']) {
        if (typeof def.tools === 'function') continue; // 'general' uses a predicate — SUBAGENT_DENIED strips these at schema level
        expect(agentAllows(def, tool), `${name} → ${tool}`).toBe(false);
      }
    }
  });
});

describe('dynamic task-specific agents (§2B, §8)', () => {
  it('invalid configurations are REFUSED, never degraded silently', () => {
    expect(() => registerDynamicAgent({ name: 'x', purpose: 'p', tools: [] }, 'main')).toThrow(/at least one tool/);
    expect(() => registerDynamicAgent({ name: 'general', purpose: 'p', tools: ['read'] }, 'main')).toThrow(/collides with a permanent agent/);
    registerDynamicAgent({ name: 'dup', purpose: 'p', tools: ['read'] }, 'main');
    expect(() => registerDynamicAgent({ name: 'dup', purpose: 'p', tools: ['read'] }, 'main')).toThrow(/already registered/);
  });

  it('a registered specialist is bounded: delegation tools stripped, budgets clamped, dyn_ prefix forced', () => {
    const def = registerDynamicAgent(
      { name: 'CSV Analyst!', purpose: 'parse big csv exports', tools: ['read', 'spawn_agent', 'task', 'start_task', 'write_file'], maxRounds: 999, maxMs: 999_999_999 },
      'main'
    );
    expect(def.name).toBe('dyn_csv_analyst');
    expect(agentAllows(def, 'read')).toBe(true);
    expect(agentAllows(def, 'spawn_agent')).toBe(false);
    expect(agentAllows(def, 'task')).toBe(false);
    expect(def.maxRounds).toBeLessThanOrEqual(24);
    expect(def.maxMs).toBeLessThanOrEqual(8 * 60_000);
    expect(def.delegationPolicy).toBe('none');
  });

  it('retireDynamicAgent cleans up a finished specialist (no orphaned roster entries)', () => {
    const def = registerDynamicAgent({ name: 'temp', purpose: 'p', tools: ['read'] }, 'main');
    expect(getDynamicAgent(def.name)).toBeDefined();
    expect(retireDynamicAgent(def.name)).toBe(true);
    expect(getDynamicAgent(def.name)).toBeUndefined();
    expect(retireDynamicAgent(def.name)).toBe(false);
    expect(listDynamicAgents()).toEqual([]);
  });

  it('the roster SURVIVES a restart: persist → wipe memory → restore round-trips the exact definition', async () => {
    const def = registerDynamicAgent({ name: 'survivor', purpose: 'investigate the flaky exporter', tools: ['read', 'grep'], maxRounds: 9 }, 'task:T-123:s1');
    getDynamicAgent(def.name)!.runs = 3;
    expect(await persistDynamicAgents()).toBe(true);
    expect(fs.existsSync(rosterFile())).toBe(true);
    resetDynamicAgentsForTests();
    expect(getDynamicAgent(def.name)).toBeUndefined();
    const restored = await restoreDynamicAgents();
    expect(restored).toBe(1);
    const rec = getDynamicAgent('dyn_survivor');
    expect(rec).toBeDefined();
    expect(rec!.def.responsibility).toBe(def.responsibility);
    expect(rec!.runs).toBe(3);
    expect(rec!.parent).toBe('task:T-123:s1');
    expect(agentAllows(rec!.def, 'grep')).toBe(true);
  });

  it('restore is DEFENSIVE: expired rows are pruned, collisions skipped, tampered defs rejected', async () => {
    const good = registerDynamicAgent({ name: 'keeper', purpose: 'p', tools: ['read'] }, 'main');
    void good;
    expect(await persistDynamicAgents()).toBe(true);
    // Craft a hostile roster: expired entry, name collision with a permanent agent, a
    // def whose tools are not an array (the persisted shape is not trusted blindly), a
    // name/def mismatch, an empty allowlist, and one valid extra.
    const raw = JSON.parse(fs.readFileSync(rosterFile(), 'utf8')) as { agents: unknown[] };
    raw.agents.push(
      { name: 'dyn_old', parent: 'x', createdAt: Date.now() - 25 * 60 * 60_000, runs: 0, def: { name: 'dyn_old', responsibility: 'x', tools: ['read'] } },
      { name: 'general', parent: 'x', createdAt: Date.now(), runs: 0, def: { name: 'general', responsibility: 'hijack', tools: ['read'] } },
      { name: 'dyn_bad', parent: 'x', createdAt: Date.now(), runs: 0, def: { name: 'dyn_bad', responsibility: 'x', tools: 'read' } },
      { name: 'dyn_mismatch', parent: 'x', createdAt: Date.now(), runs: 0, def: { name: 'dyn_other', responsibility: 'x', tools: ['read'] } },
      { name: 'dyn_empty', parent: 'x', createdAt: Date.now(), runs: 0, def: { name: 'dyn_empty', responsibility: 'x', tools: ['spawn_agent'] } },
      { name: 'dyn_valid', parent: 'y', createdAt: Date.now(), runs: 2, def: { name: 'dyn_valid', responsibility: 'ok', tools: ['read', 'grep'] } }
    );
    fs.writeFileSync(rosterFile(), JSON.stringify(raw));
    resetDynamicAgentsForTests();
    const restored = await restoreDynamicAgents();
    expect(restored).toBe(2); // keeper + valid only
    expect(getDynamicAgent('dyn_keeper')).toBeDefined();
    expect(getDynamicAgent('dyn_valid')).toBeDefined();
    expect(getDynamicAgent('dyn_old')).toBeUndefined();
    expect(getDynamicAgent('general')).toBeUndefined(); // the permanent agent is never shadowed by a roster row
    expect(resolveAgent('general').responsibility).toBe(AGENTS.general.responsibility); // and never hijacked
    expect(getDynamicAgent('dyn_bad')).toBeUndefined();
    expect(getDynamicAgent('dyn_mismatch')).toBeUndefined();
    expect(getDynamicAgent('dyn_empty')).toBeUndefined();
    // the restored allowlist is a real Set again, delegation tools stripped
    expect(agentAllows(getDynamicAgent('dyn_valid')!.def, 'grep')).toBe(true);
  });

  it('restore with no file (or a corrupt one) is a clean zero, never an error', async () => {
    expect(await restoreDynamicAgents()).toBe(0);
    fs.mkdirSync(path.dirname(rosterFile()), { recursive: true });
    fs.writeFileSync(rosterFile(), '{not json');
    expect(await restoreDynamicAgents()).toBe(0);
  });
});
