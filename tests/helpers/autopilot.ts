/**
 * ROUND 22 TEST HELPERS (Project Autopilot).
 *
 * The tests drive the REAL modules — the real autopilot engine, the real durable task
 * store/coordinator, the real policy/permission pipeline — with only the MODEL boundary
 * injected (the same deterministic-injection contract the Round 18–21 coordinator tests
 * use). The injected step runner can perform REAL tool calls through runToolDetailed
 * (full guard → permission → writeCoord → policy path) or simulate agent reports.
 */

import * as fs from 'fs';
import * as path from 'path';
import { recordExecution } from '../../src/main/toolRecord';
import { runToolDetailed } from '../../src/main/tools';
import type { CoordinatorDeps } from '../../src/main/coordinator';
import { runProjectTick } from '../../src/main/autopilot/engine';
import type { AutopilotDeps } from '../../src/main/autopilot/engine';
import type { RawPlan } from '../../src/main/autopilot/planner';
import type { ModelUnderstanding } from '../../src/main/autopilot/understanding';

export const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(__dirname, '..', '..', '.jarvis-test');

export const wipeAutopilot = (): void => {
  fs.rmSync(path.join(ROOT, 'brain', 'autopilot'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'brain', 'tasks'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'projects'), { recursive: true, force: true });
};

export const wipeTasksOnly = (): void => {
  fs.rmSync(path.join(ROOT, 'brain', 'tasks'), { recursive: true, force: true });
};

export const until = async (cond: () => boolean | Promise<boolean>, timeoutMs = 15000, everyMs = 25): Promise<void> => {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, everyMs));
  }
};

/**
 * Drive the engine the way the production ticker does: repeated runProjectTick calls
 * while waiting for a condition (project status, task states, durable verdicts).
 * `ids` may be one project or several (multi-project scenarios tick all of them).
 */
export async function engineTick(
  ids: string | string[],
  deps: AutopilotDeps,
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 45000,
  everyMs = 60
): Promise<void> {
  const idList = Array.isArray(ids) ? ids : [ids];
  const start = Date.now();
  for (;;) {
    for (const id of idList) await runProjectTick(id, deps).catch(() => undefined);
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`engineTick timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export interface StepHandler {
  /** Match on the step/task brief text. */
  match: RegExp;
  /** Produce the step report; may perform REAL tool calls. */
  run: (ctx: { prompt: string; taskId: string; stepId: string; kind: string }) => string | Promise<string>;
}

/** A deterministic step runner (the coordinator's test hook) that can make REAL tool
 *  calls and always leaves durable execution evidence for the verifier. */
export function fakeStepRunner(handlers: StepHandler[]): NonNullable<CoordinatorDeps['stepRunner']> {
  return async (prompt, kind, t, stepId) => {
    const handler = handlers.find((h) => h.match.test(prompt));
    let report: string;
    if (handler) {
      report = await handler.run({ prompt, taskId: t.id, stepId, kind });
    } else {
      report = 'DONE: step completed.';
    }
    // Durable evidence for THIS step (what the real tool pipeline would produce): a
    // successful read execution proves the step ran; handlers that write files record
    // their own write_file receipt so file-exists checks see the write evidence.
    await recordExecution({
      id: `fake-${t.id}-${stepId}-${Math.random().toString(36).slice(2, 8)}`,
      t: Date.now(),
      ms: 1,
      tool: 'read',
      agent: 'test-step-agent',
      taskId: t.id,
      stepId,
      args: JSON.stringify({ path: '.' }),
      auth: 'allowed',
      status: 'ok',
      result: report.slice(0, 200),
      retries: 0,
    }).catch(() => undefined);
    return report;
  };
}

/** Write a deliverable through the REAL tool pipeline (guard → permission → writeCoord
 *  → resolveWrite/revalidateWriteTarget) and record the write receipt. Returns the
 *  envelope so tests can assert the gate verdict itself. */
export const writeThroughTools = async (relPath: string, content: string, taskId?: string): Promise<{ ok: boolean; text: string }> => {
  const r = await runToolDetailed('write_file', JSON.stringify({ path: relPath, content, task_id: taskId ?? '' }));
  return { ok: r.status === 'success', text: r.text };
};

/** Run a REAL shell command through the tool pipeline (policy-gated). */
export const runCommandThroughTools = async (command: string): Promise<{ ok: boolean; text: string }> => {
  const r = await runToolDetailed('run_command', JSON.stringify({ command }));
  return { ok: r.status === 'success', text: r.text };
};

/** Run REAL python code through the tool pipeline (policy-gated). */
export const runPythonThroughTools = async (code: string): Promise<{ ok: boolean; text: string }> => {
  const r = await runToolDetailed('run_python', JSON.stringify({ code }));
  return { ok: r.status === 'success', text: r.text };
};

// ----------------------------------------------------------------- deterministic model fakes

export const planOf = (raw: RawPlan) => async (): Promise<RawPlan> => raw;

export const understandingOf = (over: Partial<ModelUnderstanding>): NonNullable<AutopilotDeps['understanding']> => async () => over;

/** Deps bundle: real coordinator hooks + injected autopilot planner/understanding/replanner.
 *  NOTE: the autopilot planner goes ONLY to the autopilot engine — the coordinator keeps
 *  its own TaskSpec-plan contract (deterministic fallbackPlan in tests), exactly as in
 *  production where the two layers never share a planner. */
export function makeDeps(opts: {
  handlers?: StepHandler[];
  planner?: AutopilotDeps['planner'];
  understanding?: AutopilotDeps['understanding'];
  replanner?: AutopilotDeps['replanner'];
}): AutopilotDeps {
  return {
    coordinator: {
      run: async () => ({ text: 'unused', status: 'success' as const }),
      schemas: () => [],
      stepRunner: fakeStepRunner(opts.handlers ?? []),
    },
    // NO-OP model boundaries by default: the tests must never depend on the provider
    // settings of the machine they run on (a leftover settings.json on the shared
    // userData path once made every deterministic creation wait on a dead provider).
    planner: opts.planner ?? (async () => null),
    understanding: opts.understanding ?? (async () => null),
    replanner: opts.replanner,
  };
}

/** Simple two-task plan: produce a deliverable, then verify it. */
export const simplePlan = (deliverablePath: string, opts?: { firstTitle?: string; secondTitle?: string }): RawPlan => ({
  milestones: [{ id: 'M-1', title: 'Deliver', detail: 'produce and verify', acceptance: [{ kind: 'evidence-present', detail: 'the deliverable was verified' }] }],
  tasks: [
    {
      id: 'PT-1',
      title: opts?.firstTitle ?? 'Produce the deliverable',
      detail: `Write the file ${deliverablePath} with the requested content using the ordinary file tools.`,
      kind: 'general',
      milestone: 'M-1',
      dependsOn: [],
      expectedOutput: `the file ${deliverablePath} exists`,
      acceptance: [{ kind: 'file-nonempty', detail: `the deliverable ${deliverablePath} is non-empty`, target: deliverablePath }],
      deliverables: [{ name: 'primary deliverable', path: deliverablePath, format: 'md' }],
    },
    {
      id: 'PT-2',
      title: opts?.secondTitle ?? 'Verify the deliverable',
      detail: 'Re-check the deliverable on disk and report evidence.',
      kind: 'verifier',
      milestone: 'M-1',
      dependsOn: ['PT-1'],
      acceptance: [{ kind: 'evidence-present', detail: 'the deliverable was re-checked on disk' }],
    },
  ],
});

/** Engine deps for "model-less" creation (deterministic floor everywhere). */
export const floorDeps = (extra?: Partial<AutopilotDeps>): AutopilotDeps => ({
  coordinator: {
    run: async () => ({ text: 'unused', status: 'success' as const }),
    schemas: () => [],
    stepRunner: fakeStepRunner([]),
  },
  ...extra,
});
