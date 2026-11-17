import fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 22 §5 — POLICY ENFORCEMENT THROUGH EVERY PROJECT EXECUTION ROUTE (Scenario G).
 *
 * The project layer adds NO execution path of its own: project tasks run through the
 * coordinator → scoped agent steps → runToolDetailed → guard → permission service → the
 * ONE policy. These tests push deletion and OS-resource modification attempts through
 * the REAL tool pipeline inside project-task step handlers, through a delegated-style
 * second agent, and through the retry/recovery path — and prove the two hard
 * restrictions hold everywhere, while ordinary permitted work still executes.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

// These are REAL integration tests (real coordinator drives with durable fsynced saves):
// they need more wall-clock than the default 30 s. File-scoped; other suites unaffected.
vi.setConfig({ testTimeout: 150_000, hookTimeout: 60_000 });


import { resetTaskStoreForTests } from '../src/main/taskStore';
import { resetAutopilotStoreForTests, listProjects } from '../src/main/autopilot/store';
import { createProjectFromDescription, executeProject, runProjectTick, setAutopilotDeps } from '../src/main/autopilot/engine';
import { classifyFailure } from '../src/main/autopilot/engine';
import { classifyRealPath, osProtectedPath, shellVerdict, pythonVerdict, HARD_LIMITS } from '../src/main/policy';
import { resolveWrite, revalidateWriteTarget } from '../src/main/workspace';
import { until, engineTick, makeDeps, writeThroughTools, runCommandThroughTools, runPythonThroughTools, ROOT } from './helpers/autopilot';

beforeEach(() => {
  resetTaskStoreForTests();
  resetAutopilotStoreForTests();
  fs.rmSync(path.join(ROOT, 'brain', 'autopilot'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'brain', 'tasks'), { recursive: true, force: true });
  fs.rmSync(path.join(ROOT, 'projects'), { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  setAutopilotDeps(null);
});

/** Drive one project whose single task runs the given real tool call, then assert the
 *  honest policy outcome (blocked task, blocked project, no retry). */
async function blockedProjectTask(
  label: string,
  attempt: () => Promise<{ ok: boolean; text: string }>
): Promise<void> {
  const deps = makeDeps({
    planner: async () => ({
      milestones: [{ id: 'M-1', title: `${label} attempt`, detail: '' }],
      tasks: [{ id: 'PT-1', title: `Attempt ${label}`, detail: `Try to ${label}.`, kind: 'general', milestone: 'M-1', dependsOn: [], acceptance: [{ kind: 'evidence-present', detail: `${label} evidence` }] }],
    }),
    handlers: [
      {
        match: new RegExp(`Attempt ${label}`),
        run: async (ctx) => {
          const r = await attempt();
          return r.ok ? `DONE: (unexpectedly allowed) ${r.text.slice(0, 120)}` : `FAILED: ${r.text}`;
        },
      },
    ],
  });
  setAutopilotDeps(deps);
  const p = await createProjectFromDescription(`policy enforcement test — ${label}`, { planner: deps.planner });
  await executeProject(p.id, deps);
  await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'blocked');
  const after = (await listProjects())[0];
  const t = after.tasks[0];
  expect(t.state, `${label} must be blocked`).toBe('blocked');
  expect(t.lastFailure?.class).toBe('policy-blocked');
  expect(t.attempts.length).toBe(1); // NEVER retried
  expect(after.status).toBe('blocked');
  expect(after.tasks.every((x) => x.state === 'completed')).toBe(false);
}

describe('§5 — deletion attempts through project execution routes (hard restriction A)', () => {
  it('1. deleting an ordinary user file through the shell is blocked', async () => {
    const victim = path.join(ROOT, 'projects/sec/ordinary-user-file.txt');
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, 'user data');
    await blockedProjectTask('delete user file via shell', () => runCommandThroughTools(`rm ${victim}`));
    expect(fs.existsSync(victim)).toBe(true); // the file SURVIVES
  });

  it('2. deleting a project record through the shell is blocked (project history is user data)', async () => {
    const deps = makeDeps({
      planner: async () => ({
        milestones: [{ id: 'M-1', title: 'record deletion', detail: '' }],
        tasks: [{ id: 'PT-1', title: 'Attempt delete project record', detail: 'Try it.', kind: 'general', milestone: 'M-1', dependsOn: [], acceptance: [{ kind: 'evidence-present', detail: 'attempt evidence' }] }],
      }),
      handlers: [
        {
          match: /Attempt delete project record/,
          run: async () => {
            // Find a real project record file and try to rm it through the shell.
            const dir = path.join(ROOT, 'brain', 'autopilot', 'projects');
            const rec = fs.readdirSync(dir)[0];
            const r = await runCommandThroughTools(`rm "${path.join(dir, rec)}"`);
            return r.ok ? 'DONE: (unexpected)' : `FAILED: ${r.text}`;
          },
        },
      ],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('record deletion attempt', { planner: deps.planner });
    await executeProject(p.id, deps);
    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'blocked');
    // The project record file SURVIVES on disk
    const dir = path.join(ROOT, 'brain', 'autopilot', 'projects');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length).toBeGreaterThanOrEqual(1);
    expect(fs.readdirSync(dir).some((f) => f === `project-${p.id}.json`)).toBe(true);
  });

  it('3. deleting a deliverable through the shell is blocked', async () => {
    const rel = 'projects/sec-del/deliverable.txt';
    const abs = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'the deliverable');
    await blockedProjectTask('delete deliverable via shell', () => runCommandThroughTools(`rm "${abs}"`));
    expect(fs.existsSync(abs)).toBe(true);
  });

  it('4. deleting files through python (os.remove) is blocked', async () => {
    const victim = path.join(ROOT, 'projects/sec-py/victim.txt');
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, 'data');
    await blockedProjectTask('delete via python', () => runPythonThroughTools(`import os\nos.remove(r"${victim}")`));
    expect(fs.existsSync(victim)).toBe(true);
  });

  it('5. recursive deletion through python (shutil.rmtree) is blocked', async () => {
    const dir = path.join(ROOT, 'projects/sec-rmtree');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.txt'), 'data');
    await blockedProjectTask('rmtree via python', () => runPythonThroughTools(`import shutil\nshutil.rmtree(r"${dir}")`));
    expect(fs.existsSync(dir)).toBe(true);
  });
});

describe('§5 — OS-resource modification attempts (hard restriction B)', () => {
  it('6. writing an OS-protected file through the file tool is blocked (literal path)', async () => {
    const osPath = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
    expect(osProtectedPath(osPath)).toBe(true);
    await blockedProjectTask('write hosts file', () => writeThroughTools(osPath, 'malicious content'));
  });

  it('7. writing through a workspace symlink into an OS-protected location is blocked (tri-state classifier)', async () => {
    // A symlink inside the workspace that points OUTSIDE at a protected target.
    const link = path.join(ROOT, 'projects/sec-link/evil');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    const target = process.platform === 'win32' ? 'C:\\Windows\\System32\\config\\sam' : '/etc/passwd';
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'file');
    await blockedProjectTask('symlinked protected write', () => writeThroughTools(path.relative(ROOT, link), 'through the link'));
    // And the classifier itself, pinned directly:
    expect(classifyRealPath(link)).toBe('protected');
    // The write resolver refuses BEFORE any IO:
    await expect(resolveWrite(path.relative(ROOT, link))).rejects.toThrow(/protected/i);
  });

  it('8. an unresolved/cyclic symlink write target fails CLOSED (never treated as safe)', async () => {
    const a = path.join(ROOT, 'projects/sec-cycle/a');
    const b = path.join(ROOT, 'projects/sec-cycle/b');
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.symlinkSync(b, a, 'file');
    fs.symlinkSync(a, b, 'file');
    expect(classifyRealPath(a)).toBe('unresolved');
    // resolveWrite fails closed on the cyclic target
    await expect(resolveWrite('projects/sec-cycle/a')).rejects.toThrow(/resolv/i);
    // Final-moment revalidation also refuses (TOCTOU narrowing)
    await expect(revalidateWriteTarget(path.join(ROOT, 'projects/sec-cycle/a'))).rejects.toThrow(/resolv/i);
    // And through a project task:
    await blockedProjectTask('cyclic symlink write', () => writeThroughTools('projects/sec-cycle/a', 'content'));
  });

  it('9. an OS-protected write through a DELEGATED-STYLE agent (child agent context) is rule-denied AND policy-blocked', async () => {
    // The child-agent path carries the same two restrictions (CHILD_DENIED backstop).
    const { authorize, classifyToolAction } = await import('../src/main/permission');
    const { assessRisk } = await import('../src/main/guard');
    const osPath = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/hosts';
    const args = { path: osPath, content: 'child agent write' };
    const risk = await assessRisk('write_file', args);
    const { action, resource } = classifyToolAction('write_file', args, risk?.block === true);
    const decision = await authorize({ tool: 'write_file', action, resource, risk, agent: 'task:desktop#2' });
    expect(decision.allowed).toBe(false);
    expect(['blocked', 'rule-denied']).toContain(decision.auth);
    // And the full engine route blocks the project too:
    await blockedProjectTask('child agent protected write', () => writeThroughTools(osPath, 'child write'));
  });
});

describe('§5 — policy blocks survive the retry/recovery path', () => {
  it('10. a policy block is not laundered into a transient failure by the recovery classifier', async () => {
    // The classifier reads the DURABLE record: a failure whose evidence contains a
    // policy message is ALWAYS policy-blocked, on retries too.
    const fake: never = {
      id: 'T-x',
      status: 'FAILED',
      note: 'steps could not be scheduled',
      spec: { request: 'PROJECT TASK PT-1 — "delete things"' },
      steps: [{ result: 'FAILED: BLOCKED: Deletion is disabled on this laptop. Do not retry it another way.' }],
      verification: undefined,
    } as never;
    const cls = classifyFailure(fake as Parameters<typeof classifyFailure>[0]);
    expect(cls.class).toBe('policy-blocked');
    expect(cls.evidence).toMatch(/Deletion is disabled/);
  });

  it('ordinary permitted operations through project execution STILL work (both restrictions stay surgical)', async () => {
    const rel = 'projects/sec-ok/allowed.md';
    const deps = makeDeps({
      planner: async () => ({
        milestones: [{ id: 'M-1', title: 'ordinary work', detail: '' }],
        tasks: [{ id: 'PT-1', title: 'Ordinary write', detail: 'Write an ordinary workspace file.', kind: 'general', milestone: 'M-1', dependsOn: [], acceptance: [{ kind: 'file-nonempty', detail: 'the ordinary file exists', target: rel }], deliverables: [{ name: 'Allowed artifact', path: rel, format: 'md' }] }],
      }),
      handlers: [
        {
          match: /Ordinary write/,
          run: async () => {
            const w = await writeThroughTools(rel, 'fully permitted ordinary content');
            return w.ok ? `DONE: created ${rel}` : `FAILED: unexpected refusal: ${w.text.slice(0, 120)}`;
          },
        },
        { match: /Verify the deliverable/, run: async () => 'DONE: verified' },
      ],
    });
    setAutopilotDeps(deps);
    const p = await createProjectFromDescription('ordinary permitted work', { planner: deps.planner });
    await executeProject(p.id, deps);
    await engineTick(p.id, deps, async () => (await listProjects())[0]?.status === 'completed');
    expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
    expect((await listProjects())[0].status).toBe('completed');
  });

  it('the two hard restrictions are still EXACTLY two (nothing new was added)', () => {
    expect(HARD_LIMITS).toHaveLength(2);
    expect(HARD_LIMITS[0]).toMatch(/Deletion is disabled/);
    expect(HARD_LIMITS[1]).toMatch(/Operating-system resources are read-only/);
  });
});
