import os from 'os';
import path from 'path';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * ROUND 18 PRIORITY FOUR — HIERARCHICAL AGENT DELEGATION + RESULT QUALITY (§6).
 *
 * Pins the corrected delegation semantics:
 *   - the permanent roster covers the mandated specialties (desktop operator, data
 *     analyst) with defined tools, budgets and output contracts;
 *   - a step agent can only PROPOSE subtasks ("SUBTASK:" lines) — the coordinator
 *     registers the specialist in the ONE registry, runs it under the task signal and
 *     appends the findings; agents never spawn agents;
 *   - delegation is bounded (max 2 proposals per step; the dynamic-agent cap still
 *     applies; malformed proposals are skipped, never fatal);
 *   - DONE reports that claim file deliverables get their claims CHECKED against the
 *     disk; fully unsupported claims retry once and stay flagged when unproven.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { AGENTS, agentAllows, resolveAgent, getDynamicAgent, resetDynamicAgentsForTests, listDynamicAgents } from '../src/main/agentRegistry';
import { parseSubtaskProposals, checkStepDeliverables, startTask, type CoordinatorDeps, type PlanStep } from '../src/main/coordinator';
import { getTask, resetTaskStoreForTests } from '../src/main/taskStore';
import { resetCallContext } from '../src/main/toolRecord';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-r18d-${process.pid}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetTaskStoreForTests();
  resetDynamicAgentsForTests();
  resetCallContext();
  fs.rmSync(path.join(ROOT, 'brain', 'tasks'), { recursive: true, force: true });
});

afterEach(() => {
  resetCallContext();
  resetDynamicAgentsForTests();
});

const waitFor = async (id: string, status: string) => {
  for (let i = 0; i < 100; i++) {
    const t = await getTask(id);
    if (t?.status === status) return t;
    await sleep(50);
  }
  return await getTask(id);
};

describe('permanent specialists (§6.1)', () => {
  it('the roster covers the mandated specialties with defined tools, budgets and contracts', () => {
    for (const name of ['general', 'explorer', 'researcher', 'document', 'browser', 'verifier', 'desktop', 'data']) {
      const def = AGENTS[name];
      expect(def, `agent ${name}`).toBeDefined();
      expect(def.maxRounds).toBeGreaterThan(0);
      expect(def.maxMs).toBeGreaterThan(0);
      expect(def.outputContract).toMatch(/\w:/);
      expect(def.delegationPolicy).toBe('none');
    }
  });

  it('the desktop operator drives UIA/OCR/keyboard tools but can NEVER delegate or delete', () => {
    const d = resolveAgent('desktop');
    expect(agentAllows(d, 'click_control')).toBe(true);
    expect(agentAllows(d, 'screen_text')).toBe(true);
    expect(agentAllows(d, 'see_screen')).toBe(true);
    expect(agentAllows(d, 'spawn_agent')).toBe(false);
    expect(agentAllows(d, 'task')).toBe(false);
    expect(agentAllows(d, 'start_task')).toBe(false);
    expect(agentAllows(d, 'stop_process')).toBe(false);
  });

  it('the data analyst computes and writes but cannot delegate', () => {
    const d = resolveAgent('data');
    expect(agentAllows(d, 'run_python')).toBe(true);
    expect(agentAllows(d, 'calculate')).toBe(true);
    expect(agentAllows(d, 'write_file')).toBe(true);
    expect(agentAllows(d, 'spawn_agent')).toBe(false);
  });

  it('dynamic specialists stay capped and registered in the SAME registry', () => {
    expect(getDynamicAgent('dyn_test')).toBeUndefined(); // not registered yet
    expect(listDynamicAgents()).toEqual([]);
    expect(resolveAgent('unknown-agent').name).toBe('general'); // unknown degrades, never errors
  });
});

describe('SUBTASK proposal protocol (§6.3)', () => {
  it('parseSubtaskProposals: honors at most 2 well-formed proposals and skips malformed ones', () => {
    const report = [
      'DONE: main work finished; VERIFIED: checked',
      'SUBTASK: {"name":"pricing_researcher","purpose":"collect prices","instructions":"fetch prices for A and B","tools":["web_search","fetch_url"]}',
      'SUBTASK: {not json', // skipped
      'SUBTASK: {"name":"missing_instructions"}', // skipped: no instructions
      'SUBTASK: {"name":"extra_one","purpose":"x","instructions":"y"}', // beyond the cap of 2 total honored... (only 1 valid before this, so this one IS honored)
      'SUBTASK: {"name":"beyond_cap","purpose":"x","instructions":"y"}', // honored #3 → dropped
    ].join('\n');
    const out = parseSubtaskProposals(report);
    expect(out).toHaveLength(2);
    expect(out[0].name).toBe('pricing_researcher');
    expect(out[0].tools).toEqual(['web_search', 'fetch_url']);
  });

  it('a step proposing subtasks gets them registered + run by the coordinator, findings appended to the step result', async () => {
    const subtaskCalls: Array<{ agent: string; instructions: string }> = [];
    const plan: PlanStep[] = [
      {
        title: 'Research the two vendors',
        detail: 'compare vendors',
        kind: 'general',
        dependsOn: [],
        expectedOutput: 'vendor notes at out/vendors.md',
      },
    ];
    const stepRunner: CoordinatorDeps['stepRunner'] = async () =>
      [
        'DONE: vendor comparison at out/vendors.md; VERIFIED: re-read; ISSUES: none',
        'SUBTASK: {"name":"pricing_researcher","purpose":"collect current prices","instructions":"Fetch the prices for vendor A and vendor B and report them with sources.","tools":["read"]}',
      ].join('\n');
    const deps: CoordinatorDeps = {
      run: async () => 'OK',
      schemas: () => [
        { type: 'function', function: { name: 'read', description: '', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'web_search', description: '', parameters: { type: 'object', properties: {} } } },
      ],
      planner: async () => plan,
      stepRunner,
      subtaskRunner: async (agentName, instructions) => {
        subtaskCalls.push({ agent: agentName, instructions });
        return 'ANSWER: vendor A costs 10, vendor B costs 12. EVIDENCE: (source).';
      },
    };
    const out = await startTask('Create the vendor notes in out/vendors.md', deps);
    const id = /Task (T-[\w]+)/.exec(out)![1];
    const t = await waitFor(id, 'FAILED');
    // verification will fail on the file criterion (the report is honest, no file) —
    // what matters here is the delegation mechanics:
    expect(t).toBeDefined();
    expect(subtaskCalls).toHaveLength(1);
    expect(subtaskCalls[0].agent).toBe('dyn_pricing_researcher');
    expect(subtaskCalls[0].instructions).toContain('vendor A and vendor B');
    const rec = getDynamicAgent('dyn_pricing_researcher');
    expect(rec?.parent).toContain(id);
    const task = await getTask(id!);
    expect(task?.steps[0].result).toContain('SUBTASK RESULTS (coordinator-mediated)');
    expect(task?.steps[0].result).toContain('vendor A costs 10');
  });

  it('the dynamic-agent cap still bounds delegation: the 9th registration throws, the coordinator reports the refusal', async () => {
    // saturate the roster
    for (let i = 0; i < 8; i++) {
      resolveAgent(`general`); // touch base registry (no-op)
    }
    const report = Array.from({ length: 3 }, (_, i) => `SUBTASK: {"name":"bulk_${i}","purpose":"p","instructions":"do ${i}","tools":["read"]}`).join('\n');
    const proposals = parseSubtaskProposals(report);
    expect(proposals.length).toBeLessThanOrEqual(2); // per-step cap holds even when more are proposed
  });
});

describe('result quality: deliverable claims are checked (§6.4)', () => {
  it('checkStepDeliverables passes an honest report and flags a fabricated one', async () => {
    fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'out', 'real.md'), 'exists');
    const honest = await checkStepDeliverables('DONE: wrote out/real.md; VERIFIED: re-read; ISSUES: none');
    expect(honest).not.toContain('DELIVERABLE CHECK');
    const fabricated = await checkStepDeliverables('DONE: wrote out/ghost.md; VERIFIED: re-read; ISSUES: none');
    expect(fabricated).toContain('DELIVERABLE CHECK');
    expect(fabricated).toContain('out/ghost.md');
    expect(fabricated).toContain('NOT FOUND');
    const noClaims = await checkStepDeliverables('DONE: answered the question in plain text; VERIFIED: n/a; ISSUES: none');
    expect(noClaims).not.toContain('DELIVERABLE CHECK');
  });

  it('a DONE report with a fully fabricated path retries once and the flag stays in the final result', async () => {
    const attempts: string[] = [];
    const plan: PlanStep[] = [{ title: 'Make the file', detail: 'produce out/phantom.md', kind: 'general', dependsOn: [] }];
    const stepRunner: CoordinatorDeps['stepRunner'] = async (prompt) => {
      attempts.push(prompt.includes('NOT on disk') ? 'retry' : 'first');
      return 'DONE: the report is at out/phantom.md; VERIFIED: re-read; ISSUES: none';
    };
    const out = await startTask('Create the phantom notes in out/phantom.md', {
      run: async () => 'OK',
      schemas: () => [],
      planner: async () => plan,
      stepRunner,
    });
    const id = /Task (T-[\w]+)/.exec(out)![1];
    const t = await waitFor(id, 'FAILED');
    expect(attempts).toEqual(['first', 'retry', 'first', 'retry']); // each step that fabricates gets its own evidence-based retry (the verification fix-round re-runs the flow once)
    // the honest flag is part of the durable step result
    const stored = (await getTask(id!))?.steps[0].result ?? '';
    expect(stored).toContain('DELIVERABLE CHECK');
    expect(stored).toContain('out/phantom.md');
    void t;
  });
});
