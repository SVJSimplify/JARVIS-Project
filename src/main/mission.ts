import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { completeOnce, type ToolSchema } from './llm';
import { getModel } from './settings';
import { runSubagent, type Role, type Runner } from './subagent';
import type { Tool } from './toolTypes';
import { atomicWrite, loadJson } from './store';
import { recordMissionEnd } from './completion';
import { FILES_ROOT } from './workspace';

/**
 * MISSION CONTROL — code-driven orchestration of project-scale work.
 *
 * Inspired by the plan/execute/verify architecture of agentic coding systems (Cline's
 * checkpoints and plan/act split, OpenCode's delegating agents); implemented natively so
 * every guarantee below is enforced in CODE, not by prompting:
 *
 *  - A mission is a persistent, ordered task graph on disk. A crash or restart can never
 *    lose it: every transition is written atomically, and missions found mid-flight at
 *    boot are marked 'interrupted' instead of pretending to still run.
 *  - The executor, not the model, drives the loop: plan → checkpoint → run steps with
 *    sub-agents → verify the result with REAL project commands → auto-fix (bounded) →
 *    second-opinion critique → report. The model cannot skip, fake or shortcut a step.
 *  - Verify-then-report: a mission is 'done' only when its verification commands passed.
 *    Failures, retries and critiques are kept in the report verbatim.
 *  - Checkpoints: before the first mutating step, workspace source files (bounded, junk
 *    dirs excluded) are copied aside; mission_rollback restores exactly those bytes.
 *    Deletion is never part of a rollback (new files stay, reported honestly).
 *  - Live progress is pushed to the HUD through an injected sink (dependency inversion:
 *    this module stays Electron-free and unit-testable).
 */

export type StepKind = 'explore' | 'implement' | 'research' | 'verify';
export type StepStatus = 'pending' | 'running' | 'done' | 'failed';
export type MissionStatus = 'planning' | 'running' | 'verifying' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface MissionStep {
  title: string;
  detail: string;
  kind: StepKind;
  status: StepStatus;
  result: string;
  attempts: number;
}

export interface Mission {
  id: number;
  goal: string;
  status: MissionStatus;
  steps: MissionStep[];
  /** One human-readable line about what is happening right now (HUD + prompt). */
  note: string;
  report: string;
  checkpointFiles: string[];
  checkpointError: string;
  createdAt: number;
  updatedAt: number;
}

/** Derived at CALL time: the workspace root can move (EPERM fallback) after import. */
const dir = (): string => path.join(FILES_ROOT, 'brain', 'missions');
const GOAL_MAX = 4000;
const MAX_STEPS = 10;
const MAX_CONCURRENT = 2;
const MAX_MISSIONS_KEPT = 10;
const RESULT_CHARS = 4000;
const REPORT_CHARS = 9000;
const STEP_RETRY = 1; // every step is retried once with its error before the mission fails
const FIX_ROUNDS = 2; // verification failures may trigger at most this many auto-fix steps
const CHECKPOINT_MAX_FILES = 2500;
const CHECKPOINT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const CHECKPOINT_MAX_TOTAL = 60 * 1024 * 1024;
const CHECKPOINT_AGE_MS = 24 * 60 * 60_000;
const CMD_TIMEOUT_MS = 300_000;
const ACTIVE: MissionStatus[] = ['planning', 'running', 'verifying'];

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}… [clipped]` : s);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- intent (code, not prompt)

const MISSION_OBJECT = /\b(app|application|web ?app|website|web ?site|project|codebase|repo(sitory)?|program|software|game|extension|clone|portfolio|dashboard|api|backend|frontend)\b/;
const MISSION_VERB = /\b(copy|clone|duplicate|rebuild|replicate|recreate|port|migrate|scaffold|build|create|make|develop|generate|refactor|rewrite|restructure|overhaul|moderni[sz]e|convert|fork)\b/;
/** Requests about one file, one bug or one artefact are normal turn work even with a build
 *  verb present. The small noun must be the OBJECT near its verb — a phrase like "clone this
 *  project into a new folder" mentions "folder" but is still project-scale. */
const SMALL_TARGET =
  /\b(copy|move|rename|duplicate|fix|edit|read|open|delete|create|make|write|extract|convert)\b[^.!?]{0,20}\b(file|folder|directory|note|image|photo|screenshot|document|pdf|text|line|function|method|bug|error|chart|graph|report|summary|list|timer|reminder|contact|memory|password|sheet|table|row|column|doc|pptx|xlsx)\b/;

/** 'mission' when the request is project-scale work that must run through the orchestrator. */
export function classifyIntent(text: string): 'mission' | 'normal' {
  const t = String(text ?? '').toLowerCase();
  if (!t) return 'normal';
  if (SMALL_TARGET.test(t)) return 'normal';
  return MISSION_OBJECT.test(t) && MISSION_VERB.test(t) ? 'mission' : 'normal';
}

/** The directive injected into the system prompt when the classifier fires. */
export const missionIntentNote = (text: string): string =>
  classifyIntent(text) !== 'mission'
    ? ''
    : 'PROJECT-SCALE REQUEST DETECTED (enforced routing, not a suggestion): call mission_start(goal) as your FIRST tool call, passing the user\'s goal verbatim. The mission engine plans, checkpoints, executes each step with sub-agents, verifies with real build/test commands and reports. Then tell the user in one sentence that the work is underway and finish the turn; report the outcome from mission_status in a later turn. Never claim the project is finished unless mission_status shows status done.';

// ------------------------------------------------------------ plan normalisation (pure)

const KINDS: StepKind[] = ['explore', 'implement', 'research', 'verify'];

interface RawStep {
  title?: unknown;
  detail?: unknown;
  kind?: unknown;
}

/** Shape-check, dedupe, cap and type-fix a model-provided plan; a plan that cannot be
 *  parsed degrades to ONE step carrying the full goal — degraded, never broken. */
export function normalizePlan(raw: unknown, goal: string): MissionStep[] {
  const list = Array.isArray(raw) ? (raw as RawStep[]) : [];
  const out: MissionStep[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    if (out.length >= MAX_STEPS) break;
    if (!r || typeof r !== 'object') continue;
    const title = String(r.title ?? '').trim().slice(0, 140);
    const detail = String(r.detail ?? '').trim().slice(0, 4000) || title;
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = KINDS.includes(r.kind as StepKind) ? (r.kind as StepKind) : 'implement';
    out.push({ title, detail, kind, status: 'pending', result: '', attempts: 0 });
  }
  if (!out.length) {
    out.push({ title: 'Do the goal end to end', detail: goal, kind: 'implement', status: 'pending', result: '', attempts: 0 });
  }
  return out;
}

// ------------------------------------------------------------------- state transitions

/** A failed step stops the mission: later steps depend on earlier ones, so running them
 *  would build on work that never happened (the classic fake-success trap). */
export const canContinue = (m: Mission): boolean => m.steps.every((s) => s.status !== 'failed');

export function markStep(m: Mission, index: number, patch: Partial<MissionStep>): void {
  const s = m.steps[index];
  if (!s) return;
  Object.assign(s, patch);
  m.updatedAt = Date.now();
}

export const doneCount = (m: Mission): number => m.steps.filter((s) => s.status === 'done').length;

/** The truthful one-line-plus status block the model and the HUD see. */
export function missionStatusText(m: Mission, verbose = false): string {
  const head = `MISSION #${m.id} [${m.status.toUpperCase()}] — ${m.goal.slice(0, 160)}`;
  const progress = m.steps.length
    ? `${doneCount(m)}/${m.steps.length} steps done${m.note ? ` · ${m.note}` : ''}`
    : m.note || 'planning';
  const steps = m.steps.map((s, i) => `  ${i + 1}. [${s.status}] (${s.kind}) ${s.title}${s.status === 'failed' && s.result ? ` — ${clip(s.result, 200)}` : ''}`);
  const tail: string[] = [];
  if (m.report) tail.push(`Report: ${clip(m.report, verbose ? 6000 : 700)}`);
  if (m.checkpointError) tail.push(`Checkpoint: ${m.checkpointError}`);
  return [head, progress, ...steps, ...tail].filter(Boolean).join('\n');
}

// ------------------------------------------------------------------------------- store

const missions = new Map<number, Mission>();
let nextId = 1;
let loaded = false;

const fileOf = (id: number): string => path.join(dir(), `mission-${id}.json`);

async function save(m: Mission): Promise<void> {
  m.updatedAt = Date.now();
  await fs.mkdir(dir(), { recursive: true });
  await atomicWrite(fileOf(m.id), JSON.stringify(m));
}

/** Load every stored mission; flag ones that were mid-flight when the process died. */
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir())).filter((f) => /^mission-\d+\.json$/.test(f)).sort();
  } catch {
    return;
  }
  for (const n of names.slice(-MAX_MISSIONS_KEPT)) {
    const m = await loadJson<Mission | null>(path.join(dir(), n), null);
    if (!m || !Array.isArray(m.steps) || typeof m.goal !== 'string') continue;
    if (ACTIVE.includes(m.status)) {
      // The process restarted under it: it is not running any more and must never be
      // reported as such. Resumable honestly, not silently "done".
      m.status = 'interrupted';
      m.note = 'interrupted by an app restart; start a new mission or ask to continue it';
      await atomicWrite(path.join(dir(), n), JSON.stringify(m));
    }
    missions.set(m.id, m);
    if (m.id >= nextId) nextId = m.id + 1;
  }
}

/** Old finished checkpoints are housekeeping data of this app, not user files: prune at boot. */
async function pruneOldCheckpoints(): Promise<void> {
  await ensureLoaded();
  const now = Date.now();
  for (const m of missions.values()) {
    if (ACTIVE.includes(m.status) || !m.checkpointFiles.length) continue;
    if (now - m.updatedAt < CHECKPOINT_AGE_MS) continue;
    await fs.rm(path.join(dir(), `checkpoint-${m.id}`), { recursive: true, force: true }).catch(() => undefined);
    m.checkpointFiles = [];
    await atomicWrite(fileOf(m.id), JSON.stringify(m)).catch(() => undefined);
  }
}

export const missionBoot = (): Promise<void> => pruneOldCheckpoints();

// -------------------------------------------------------------- progress sink (injected)

export interface MissionProgress {
  id: number;
  status: MissionStatus;
  note: string;
  done: number;
  total: number;
}
type Emitter = (p: MissionProgress) => void;
let emit: Emitter = () => undefined;

/** Wired from the main process (hud.sendToHud); keeps this module Electron-free for tests. */
export const setMissionEmitter = (fn: Emitter): void => {
  emit = fn;
};

const progress = (m: Mission): void =>
  emit({ id: m.id, status: m.status, note: m.note, done: doneCount(m), total: m.steps.length });

// ------------------------------------------------------------------------ checkpoints

const CHECKPOINT_SKIP = new Set(['node_modules', '.git', 'dist', 'release', 'out', '.venv', '__pycache__', '.next', 'brain', 'plans', 'todos.json', '.jarvis-write-test']);

async function* walkShallow(root: string, rel = ''): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!CHECKPOINT_SKIP.has(e.name)) yield* walkShallow(root, next);
    } else if (e.isFile()) yield next;
  }
}

/** Pure selection logic (unit-tested): which of the walked files go into the checkpoint. */
export const checkpointEligible = (rel: string, size: number, countSoFar: number, bytesSoFar: number): boolean =>
  countSoFar < CHECKPOINT_MAX_FILES && size <= CHECKPOINT_MAX_FILE_BYTES && bytesSoFar + size <= CHECKPOINT_MAX_TOTAL;

/** Copy a workspace's source files into a checkpoint folder; returns the manifest of
 *  relative paths. Injectable root/dest keep this unit-testable; the real callers pass
 *  FILES_ROOT and the mission's own checkpoint folder. */
export async function snapshotInto(root: string, dest: string): Promise<{ files: string[]; error: string }> {
  const files: string[] = [];
  try {
    let bytes = 0;
    for await (const rel of walkShallow(root)) {
      const full = path.join(root, rel);
      const st = await fs.stat(full).catch(() => null);
      if (!st || !checkpointEligible(rel, st.size, files.length, bytes)) continue;
      await fs.mkdir(path.dirname(path.join(dest, rel)), { recursive: true });
      await fs.copyFile(full, path.join(dest, rel)).catch(() => undefined);
      files.push(rel);
      bytes += st.size;
    }
    if (!files.length) return { files: [], error: 'no checkpoint taken (nothing to snapshot)' };
    return { files, error: '' };
  } catch (e) {
    return { files, error: `checkpoint incomplete after ${files.length} file(s): ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Copy the workspace's source files aside for mission `id`. */
export const makeCheckpoint = (id: number): Promise<{ files: string[]; error: string }> =>
  snapshotInto(FILES_ROOT, path.join(dir(), `checkpoint-${id}`));

/** Restore exactly the checkpointed bytes into `root`. Files the mission created NEW are
 *  never deleted (deletion is disabled on this machine) — they are listed honestly instead. */
export async function restoreFrom(dest: string, files: string[], root: string): Promise<string> {
  let restored = 0;
  const failed: string[] = [];
  for (const rel of files) {
    const from = path.join(dest, rel);
    const data = await fs.readFile(from).catch(() => null);
    if (!data) continue;
    const to = path.join(root, rel);
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.writeFile(to, data);
      restored++;
    } catch (e) {
      failed.push(`${rel}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const current = new Set<string>();
  for await (const rel of walkShallow(root)) current.add(rel);
  const extra = [...current].filter((r) => !files.includes(r)).slice(0, 20);
  return [
    restored === files.length ? `Restored ${restored}/${files.length} checkpointed file(s).` : `Restored only ${restored}/${files.length} checkpointed file(s).`,
    failed.length ? `Failed to restore: ${failed.join('; ')}` : '',
    `Files created after the checkpoint were NOT deleted (deletion is disabled): ${extra.length ? extra.join(', ') : 'none'}.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Roll the workspace back to mission `id`'s checkpoint. */
const rollbackCheckpoint = (id: number, files: string[]): Promise<string> =>
  restoreFrom(path.join(dir(), `checkpoint-${id}`), files, FILES_ROOT);

// ------------------------------------------------------------------ project detection

interface ProjectFacts {
  root: string;
  scripts: string[];
  summary: string;
}

/** Parse the package.json scripts worth running for verification, in priority order (pure). */
export const verifyScripts = (scripts: Record<string, unknown>): string[] =>
  ['typecheck', 'test', 'build'].filter((k) => typeof scripts[k] === 'string');

export async function detectProject(): Promise<ProjectFacts | null> {
  const candidates = [FILES_ROOT, ...(await fs.readdir(FILES_ROOT, { withFileTypes: true }).catch(() => []))]
    .map((e) => (typeof e === 'string' ? e : e.name))
    .slice(0, 41);
  for (const name of candidates) {
    const root = name === FILES_ROOT ? FILES_ROOT : path.join(FILES_ROOT, name);
    const pkg = await loadJson<{ name?: string; scripts?: Record<string, unknown> } | null>(path.join(root, 'package.json'), null);
    if (!pkg) continue;
    const scripts = verifyScripts(pkg.scripts ?? {});
    return {
      root,
      scripts,
      summary: `npm project "${pkg.name ?? '?'}" at ${root}${scripts.length ? `; scripts: ${scripts.join(', ')}` : '; no standard scripts'}`,
    };
  }
  const hasPy = await fs
    .stat(path.join(FILES_ROOT, 'requirements.txt'))
    .then(() => true, () => false);
  return hasPy ? { root: FILES_ROOT, scripts: [], summary: 'python project at FILES_ROOT (requirements.txt); no npm scripts' } : null;
}

const runCmd = (command: string, cwd: string, timeout: number): Promise<string> =>
  new Promise((resolve) => {
    execFile(
      process.platform === 'win32' ? 'powershell.exe' : 'bash',
      process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-lc', command],
      { cwd, timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        const out = `${stdout}${stderr}`.trim();
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
        const killed = (err as { killed?: boolean })?.killed;
        resolve(killed ? `TIMEOUT after ${Math.round(timeout / 1000)}s\n${out.slice(-3000)}` : `exit ${code}\n${out.slice(-3000)}`);
      }
    );
  });

const failedRun = (out: string): boolean => !out.startsWith('exit 0');

// ------------------------------------------------------------------- the executor

interface ExecutorDeps {
  run: Runner;
  schemas: (kind: 'explore' | 'research' | 'general') => ToolSchema[];
}

const ROLE_OF: Record<StepKind, Role> = { explore: 'explorer', implement: 'general', research: 'researcher', verify: 'general' };

const parsePlanJson = (text: string): unknown => {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as unknown;
  } catch {
    return null;
  }
};

async function planWithModel(goal: string, facts: string, signal?: AbortSignal): Promise<MissionStep[]> {
  const model = await getModel();
  if (!model) throw new Error('No model set. Open Settings and choose one.');
  const r = await completeOnce(
    model,
    [
      {
        role: 'system',
        content:
          `Today is ${new Date().toDateString()}. You break a build goal into a short ordered plan of sub-agent steps. ` +
          `Reply with ONLY a JSON array, 2 to ${MAX_STEPS} items, each: {"title": short imperative, "detail": complete self-contained instructions for a sub-agent that knows NOTHING else (include exact paths, names and requirements), "kind": "explore"|"implement"|"research"|"verify"}. ` +
          'First step explores what already exists (kind explore). Middle steps implement or research. Final step verifies the whole result (kind verify: build, run or test it and check the output).',
      },
      { role: 'user', content: `GOAL: ${goal}\n\nPROJECT CONTEXT:\n${facts || '(no project detected — files live in the Jarvis-Files workspace)'}` },
    ],
    [],
    signal
  );
  return normalizePlan(parsePlanJson(r.content), goal);
}

const stepPrompt = (m: Mission, i: number, extra: string): string => {
  const s = m.steps[i];
  const prior = m.steps
    .slice(Math.max(0, i - 6), i)
    .map((p) => `- ${p.title}: ${clip(p.result || '(no report)', 700)}`)
    .join('\n');
  return [
    `MISSION GOAL: ${m.goal}`,
    `You are executing step ${i + 1} of ${m.steps.length}: "${s.title}"`,
    `STEP INSTRUCTIONS: ${s.detail}`,
    prior ? `RESULTS OF EARLIER STEPS (already done, build on them; do not redo them):\n${prior}` : 'This is the first step.',
    extra,
    'Finish the step completely, verify your own work with the tools, then write your FINAL REPORT as: "DONE:" what was produced (exact paths); "VERIFIED:" how you checked it; "ISSUES:" anything left. If you could not complete the step, start the report with "FAILED:" and say exactly why.',
  ].join('\n\n');
};

const stepFailed = (report: string): boolean => /^FAILED:|^(Tool error|BLOCKED|NOT APPROVED|Sub-agent failed)/.test(report.trim());

const SCHEMA_KIND: Record<StepKind, 'explore' | 'research' | 'general'> = { explore: 'explore', research: 'research', implement: 'general', verify: 'general' };

async function runStep(m: Mission, i: number, deps: ExecutorDeps, signal: AbortSignal, extra = ''): Promise<string> {
  const s = m.steps[i];
  const report = await runSubagent(stepPrompt(m, i, extra), deps.schemas(SCHEMA_KIND[s.kind]), deps.run, {
    role: ROLE_OF[s.kind],
    signal,
  });
  return clip(String(report ?? '').trim() || 'FAILED: sub-agent returned an empty report.', RESULT_CHARS);
}

async function verifyProject(m: Mission): Promise<string> {
  const facts = await detectProject();
  if (!facts || !facts.scripts.length) return 'No build/test commands detected, so verification was done by the step sub-agents only.';
  const tried: string[] = [];
  for (const script of facts.scripts.slice(0, 2)) {
    m.note = `verifying: ${script}`;
    progress(m);
    const out = await runCmd(`npm run ${script}`, facts.root, CMD_TIMEOUT_MS);
    tried.push(`npm run ${script} → ${clip(out, 1200)}`);
    if (failedRun(out)) return `VERIFICATION FAILED on ${script}:\n${tried.join('\n')}`;
  }
  return `VERIFICATION PASSED:\n${tried.join('\n')}`;
}

async function drive(m: Mission, deps: ExecutorDeps, signal: AbortSignal): Promise<void> {
  try {
    // 1. PLAN
    m.note = 'planning steps';
    m.status = 'planning';
    progress(m);
    const facts = await detectProject();
    m.steps = normalizePlan(await planWithModel(m.goal, facts?.summary ?? '', signal), m.goal);
    await save(m);
    progress(m);

    // 2. CHECKPOINT before the first mutating step
    if (m.steps.some((s) => s.kind === 'implement')) {
      m.note = 'taking a checkpoint of the workspace';
      progress(m);
      const cp = await makeCheckpoint(m.id);
      m.checkpointFiles = cp.files;
      m.checkpointError = cp.error;
      await save(m);
    }

    // 3. EXECUTE steps in order; one retry with the error, then the mission fails honestly.
    m.status = 'running';
    for (let i = 0; i < m.steps.length; i++) {
      if (signal.aborted) throw new Error('cancelled');
      const s = m.steps[i];
      s.status = 'running';
      s.attempts++;
      m.note = `step ${i + 1}/${m.steps.length}: ${s.title}`;
      progress(m);
      await save(m);
      let report = await runStep(m, i, deps, signal);
      for (let retry = 0; stepFailed(report) && retry < STEP_RETRY && !signal.aborted; retry++) {
        report = await runStep(m, i, deps, signal, `Your previous attempt failed with:\n${clip(report, 1500)}\nUnderstand why, then do the step a different, correct way.`);
        s.attempts++;
      }
      s.result = report;
      s.status = stepFailed(report) ? 'failed' : 'done';
      m.note = s.status === 'failed' ? `step ${i + 1} FAILED: ${clip(report, 120)}` : `step ${i + 1}/${m.steps.length} done`;
      await save(m);
      progress(m);
      if (s.status === 'failed') {
        m.status = 'failed';
        m.report = `Mission stopped at step ${i + 1} of ${m.steps.length} ("${s.title}") after ${s.attempts} attempt(s) with different instructions.\n\nStep failure:\n${report}\n\nNothing after that step was run. Completed steps: ${m.steps
          .filter((x) => x.status === 'done')
          .map((x) => x.title)
          .join('; ') || 'none'}. The workspace checkpoint (mission_rollback) can restore pre-mission files.`;
        await save(m);
        progress(m);
        void recordMissionEnd('failed', `mission step ${i + 1} failed: ${clip(s.title, 80)}`);
        return;
      }
    }

    // 4. VERIFY with real project commands; auto-fix up to FIX_ROUNDS times.
    //    Research/explore-only missions have nothing to build: running npm scripts for them
    //    would be theatre, so verification is theirs (the step reports) plus the critique.
    m.status = 'verifying';
    m.note = 'verifying the result';
    progress(m);
    await save(m);
    let verification = '';
    const codeMission = m.steps.some((s) => s.kind === 'implement' || s.kind === 'verify');
    for (let round = 0; round <= FIX_ROUNDS && codeMission; round++) {
      if (signal.aborted) throw new Error('cancelled');
      verification = await verifyProject(m);
      if (!verification.startsWith('VERIFICATION FAILED') || round === FIX_ROUNDS) break;
      // Auto-fix: one bounded repair step with the verifier's output as evidence.
      m.steps.push({
        title: 'Fix verification failures',
        detail: `The project verification failed. Re-run it yourself, find the root cause, fix it, and re-run until it passes.\n\nVerifier output:\n${clip(verification, 2500)}`,
        kind: 'implement',
        status: 'pending',
        result: '',
        attempts: 0,
      });
      const fi = m.steps.length - 1;
      const s = m.steps[fi];
      s.status = 'running';
      s.attempts = 1;
      m.note = `auto-fix round ${round + 1}: fixing verification failures`;
      progress(m);
      await save(m);
      const report = await runStep(m, fi, deps, signal);
      s.result = report;
      s.status = stepFailed(report) ? 'failed' : 'done';
      await save(m);
      progress(m);
      if (s.status === 'failed') break;
    }
    const verified = !verification.startsWith('VERIFICATION FAILED'); // no-code missions: empty verification is a pass with the step reports + critique

    // 5. Second opinion on the whole deliverable (bounded; recorded, never silent).
    let critique = '';
    try {
      const model = await getModel();
      if (model && !signal.aborted) {
        const r = await completeOnce(
          model,
          [
            { role: 'system', content: 'You review a finished piece of work against its goal. In under 120 words list concrete flaws or missing parts, then end with "VERDICT: PASS" or "VERDICT: REVISE".' },
            { role: 'user', content: `GOAL: ${m.goal}\n\nFINAL REPORT:\n${m.steps.map((s, i) => `${i + 1}. ${s.title} → ${clip(s.result, 900)}`).join('\n')}\n\n${verification}` },
          ],
          [],
          signal
        );
        critique = clip(r.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), 1500);
      }
    } catch {
      critique = '(reviewer unavailable — skipped)';
    }

    // 6. Report: the truth, including verification and critique, whatever they say.
    m.status = verified && canContinue(m) ? 'done' : 'failed';
    m.note = verified ? 'finished and verified' : 'finished but verification failed';
    m.report = clip(
      [
        `GOAL: ${m.goal}`,
        m.steps.map((s, i) => `${i + 1}. [${s.status}] ${s.title} — ${clip(s.result, 800)}`).join('\n'),
        verification,
        critique ? `REVIEW: ${critique}` : '',
        m.checkpointError ? `Checkpoint: ${m.checkpointError}` : 'A pre-mission checkpoint exists (mission_rollback restores it).',
      ]
        .filter(Boolean)
        .join('\n\n'),
      REPORT_CHARS
    );
    await save(m);
    progress(m);
    // The completion guarantee counts missions too: verified success or honest failure.
    void recordMissionEnd(m.status === 'done' ? 'completed' : 'failed', clip(m.note, 120));
  } catch (e) {
    const aborted = signal.aborted || (e instanceof Error && e.message === 'cancelled');
    m.status = aborted ? 'cancelled' : 'failed';
    m.note = aborted ? 'cancelled by the user' : `failed: ${e instanceof Error ? e.message : String(e)}`;
    m.report = clip(
      aborted
        ? `Mission cancelled. Completed before cancellation: ${m.steps.filter((s) => s.status === 'done').map((s) => s.title).join('; ') || 'nothing'}.`
        : `Mission failed before completing: ${e instanceof Error ? e.message : String(e)}`,
      3000
    );
    await save(m).catch(() => undefined);
    progress(m);
    void recordMissionEnd(aborted ? 'interrupted' : 'failed', clip(m.note, 120));
  }
}

// ----------------------------------------------------------------------- public tools

const controllers = new Map<number, AbortController>();

async function startMission(goal: string, deps: ExecutorDeps): Promise<string> {
  await ensureLoaded();
  const g = goal.trim().slice(0, GOAL_MAX);
  if (!g) return 'NOT DONE: the goal is empty.';
  const active = [...missions.values()].filter((m) => ACTIVE.includes(m.status));
  const same = active.find((m) => m.goal.slice(0, 200) === g.slice(0, 200));
  if (same) return `NOT DONE: mission #${same.id} is already running with this goal (${same.note}). Check mission_status instead of starting a duplicate.`;
  if (active.length >= MAX_CONCURRENT) {
    return `NOT DONE: ${active.length} missions are already running (${active.map((m) => `#${m.id}`).join(', ')}). Wait for one to finish or cancel it with mission_cancel.`;
  }
  const m: Mission = {
    id: nextId++,
    goal: g,
    status: 'planning',
    steps: [],
    note: 'queued',
    report: '',
    checkpointFiles: [],
    checkpointError: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  missions.set(m.id, m);
  await save(m);
  const ctl = new AbortController();
  controllers.set(m.id, ctl);
  void drive(m, deps, ctl.signal).finally(() => controllers.delete(m.id));
  return `Mission #${m.id} started. The engine plans the steps, checkpoints the workspace, runs every step with sub-agents, verifies the result with real build/test commands and reports — automatically. Track it with mission_status; the user is told progress live. Do not redo the work yourself.`;
}

const getMission = async (id: unknown): Promise<Mission | undefined> => {
  await ensureLoaded();
  return missions.get(Number(id));
};

/** System-prompt block: where every mission stands, so the model always tells the truth about it. */
export async function getMissionPrompt(): Promise<string> {
  await ensureLoaded();
  if (!missions.size) return '';
  const list = [...missions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const active = list.filter((m) => ACTIVE.includes(m.status));
  const fresh = list.filter((m) => !ACTIVE.includes(m.status) && Date.now() - m.updatedAt < 30 * 60_000);
  const parts = active.map((m) => `${missionStatusText(m)}\nWhen the user asks about progress, answer from mission_status — never guess, never claim it finished.`);
  parts.push(...fresh.map((m) => `${missionStatusText(m)}${m.report ? `\nOutcome (mention it once, briefly): ${clip(m.report, 350)}` : ''}`));
  return parts.length ? `MISSIONS (background work; state below is persisted ground truth):\n${parts.join('\n\n')}` : '';
}

export const missionTools = (deps: ExecutorDeps): Record<string, Tool> => ({
  mission_start: {
    description:
      'Start an AUTONOMOUS multi-step mission for project-scale work (build/clone/copy/refactor an app or project): the engine plans the steps, checkpoints the workspace, executes each step with sub-agents, verifies with the project\'s real build/test commands (auto-fixing up to twice), gets a second opinion and writes a report. Returns at once with the mission id; it runs in the background and the user sees live progress. Use for "generate a copy of this app" style requests instead of hand-rolling dozens of tool calls.',
    parameters: { type: 'object', properties: { goal: { type: 'string', description: 'The complete goal, verbatim from the user, with every requirement.' } }, required: ['goal'] },
    run: (args) => startMission(String(args.goal ?? ''), deps),
  },
  mission_status: {
    description: 'Ground-truth status of a mission (or the latest one): every step with its real status, current activity and the report when finished. Never guess mission progress; read it here.',
    parameters: { type: 'object', properties: { id: { type: 'number' }, verbose: { type: 'boolean' } } },
    run: async (args) => {
      await ensureLoaded();
      const m = args.id !== undefined ? await getMission(args.id) : [...missions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!m) return args.id !== undefined ? `NOT DONE: no mission #${String(args.id)}.` : 'No missions have been started.';
      return missionStatusText(m, args.verbose === true);
    },
  },
  mission_wait: {
    description: 'Wait for a mission to finish (up to 2 minutes) and return its status. Use when the user is actively waiting for the result.',
    parameters: { type: 'object', properties: { id: { type: 'number' }, wait_s: { type: 'number' } } },
    run: async (args) => {
      await ensureLoaded();
      const m = args.id !== undefined ? await getMission(args.id) : [...missions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!m) return 'No missions have been started.';
      const end = Date.now() + Math.min(120, Math.max(0, Number(args.wait_s) || 60)) * 1000;
      while (ACTIVE.includes(m.status) && Date.now() < end) await sleep(1000);
      return ACTIVE.includes(m.status) ? `Still running after the wait: ${missionStatusText(m)}` : missionStatusText(m, true);
    },
  },
  mission_cancel: {
    description: 'Cancel a running mission. Steps already done stay done; the report says exactly how far it got.',
    parameters: { type: 'object', properties: { id: { type: 'number' } } },
    run: async (args) => {
      await ensureLoaded();
      const m = args.id !== undefined ? await getMission(args.id) : [...missions.values()].find((x) => ACTIVE.includes(x.status));
      if (!m) return 'NOT DONE: no such running mission.';
      if (!ACTIVE.includes(m.status)) return `Mission #${m.id} already ${m.status}.`;
      controllers.get(m.id)?.abort();
      return `Mission #${m.id} cancellation requested; it stops at the next step boundary and mission_status will show how far it got.`;
    },
  },
  mission_rollback: {
    description: 'Restore the workspace files exactly as they were before a mission started (from its checkpoint). Files the mission created afterwards are kept and listed — nothing is deleted.',
    parameters: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
    run: async (args) => {
      const m = await getMission(args.id);
      if (!m) return `NOT DONE: no mission #${String(args.id)}.`;
      if (!m.checkpointFiles.length) return `NOT DONE: mission #${m.id} has ${m.checkpointError ? `no usable checkpoint (${m.checkpointError})` : 'no checkpoint (it never reached a file-changing step)'}.`;
      return rollbackCheckpoint(m.id, m.checkpointFiles);
    },
  },
});
