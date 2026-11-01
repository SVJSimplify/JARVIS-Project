import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { completeOnce } from './llm';
import { getRelevantLessons } from './learn';
import type { AgentKind, SchemaPicker } from './orchestrate';
import { getModel } from './settings';
import { runSubagent, type Runner } from './subagent';
import type { Tool } from './toolTypes';
import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson } from './store';

/** AGI-style capabilities: learn from experience, remember procedures, pursue long goals, second opinions, computation, verification, background work. */

const DIR = path.join(FILES_ROOT, 'brain');
const load = async <T>(f: string): Promise<T[]> => loadJson<T[]>(path.join(DIR, f), []);
const save = async (f: string, v: unknown): Promise<void> => {
  await fs.mkdir(DIR, { recursive: true });
  await atomicWrite(path.join(DIR, f), JSON.stringify(v));
};
const str = (v: unknown, n = 300): string => String(v ?? '').trim().slice(0, n);
const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];

interface Playbook { name: string; when: string; steps: string[]; used: number }
interface Goal { id: number; title: string; why: string; due: string; status: 'active' | 'done' | 'dropped'; notes: string[] }

/** What JARVIS has learned, injected into every turn: relevant lessons, playbook index, active goals. */
export async function getLearningPrompt(text: string): Promise<string> {
  const [lessons, pb, gs] = await Promise.all([getRelevantLessons(text), load<Playbook>('playbooks.json'), load<Goal>('goals.json')]);
  const parts: string[] = lessons ? [lessons] : [];
  if (pb.length) parts.push(`Saved playbooks (call playbook_find before similar work): ${pb.slice(-12).map((p) => `${p.name} (${p.when})`).join('; ')}`);
  const active = gs.filter((g) => g.status === 'active').slice(0, 5);
  if (active.length) parts.push(`Active long-term goals:\n${active.map((g) => `- #${g.id} ${g.title}${g.due ? ` (due ${g.due})` : ''}`).join('\n')}`);
  return parts.join('\n\n');
}

const ask = async (system: string, user: string): Promise<string> => {
  const model = await getModel();
  if (!model) throw new Error('No model set. Open Settings and choose one.');
  const r = await completeOnce(model, [{ role: 'system', content: `Today is ${new Date().toDateString()}. ${system}` }, { role: 'user', content: user }], []);
  return r.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
};

/** Blocks deletes and shell-outs — including the dynamic escapes (`__import__('os').system(...)`, `eval`, `exec`, `importlib`) that defeat a plain-text deny list. */
const PY_DENY = /(os\.(remove|unlink|rmdir|removedirs)|shutil\.rmtree|\.unlink\(|\.rmdir\(|send2trash|os\.system|subprocess|__import__|importlib|\beval\s*\(|\bexec\s*\(|\bcompile\s*\()/;

export const agiTools: Record<string, Tool> = {
  critique: {
    description:
      'Independent second opinion. Send a draft answer, plan, report or code summary with the goal; a separate reviewer with no stake in it lists concrete flaws, missing evidence, wrong assumptions and risks, then PASS or REVISE. Use before delivering anything important, then fix what it finds.',
    parameters: { type: 'object', properties: { work: { type: 'string' }, goal: { type: 'string' } }, required: ['work', 'goal'] },
    run: async (args) =>
      ask(
        'You are a ruthless, fair reviewer. Find real problems only: factual errors, unsupported claims, missing angles, wrong assumptions, risks, unclear steps. Be specific and short (under 200 words). End with "VERDICT: PASS" or "VERDICT: REVISE" plus the single most important fix.',
        `GOAL: ${str(args.goal, 1000)}\n\nWORK TO REVIEW:\n${str(args.work, 12000)}`
      ),
  },
  deliberate: {
    description:
      'Think a hard decision through before acting: proposes three genuinely different approaches, runs a pre-mortem on each (how it fails), and recommends one with a fallback. Use for ambiguous, high-stakes or multi-path problems.',
    parameters: { type: 'object', properties: { problem: { type: 'string' }, context: { type: 'string' } }, required: ['problem'] },
    run: async (args) =>
      ask(
        'You are a strategist. Give three genuinely different approaches, for each the main way it could fail, then RECOMMEND one with the reason and a fallback. Under 250 words, concrete, no filler.',
        `PROBLEM: ${str(args.problem, 2000)}\nCONTEXT: ${str(args.context, 4000)}`
      ),
  },
  playbook_save: {
    description: 'Save a reusable procedure that worked (name, when to use it, ordered steps) so the same kind of job is faster and more reliable next time.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' }, when: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } },
      required: ['name', 'when', 'steps'],
    },
    run: async (args) => {
      const name = str(args.name, 60);
      const steps = (Array.isArray(args.steps) ? args.steps : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 20);
      if (!name || !steps.length) throw new Error('name and steps are required.');
      const all = (await load<Playbook>('playbooks.json')).filter((p) => p.name.toLowerCase() !== name.toLowerCase());
      all.push({ name, when: str(args.when, 120), steps, used: 0 });
      await save('playbooks.json', all.slice(-60));
      return `Playbook "${name}" saved.`;
    },
  },
  playbook_find: {
    description: 'Find saved procedures matching the job you are about to do and return their steps. Call before any non-trivial task that may have been done before.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async (args) => {
      const q = new Set(words(str(args.query, 300)));
      const all = await load<Playbook>('playbooks.json');
      const hits = all
        .map((p) => ({ p, s: words(`${p.name} ${p.when} ${p.steps.join(' ')}`).filter((w) => q.has(w)).length }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || b.p.used - a.p.used)
        .slice(0, 3);
      if (!hits.length) return 'No matching playbook. Do the task, then playbook_save what worked.';
      hits.forEach((h) => h.p.used++);
      await save('playbooks.json', all);
      return hits.map((h) => `${h.p.name} (${h.p.when}):\n${h.p.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`).join('\n\n');
    },
  },
  goal_set: {
    description: 'Create a long-term goal that persists across sessions (project, habit, deadline). Active goals appear in every prompt so JARVIS keeps working toward them.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, why: { type: 'string' }, due: { type: 'string' } }, required: ['title'] },
    run: async (args) => {
      const all = await load<Goal>('goals.json');
      const id = Math.max(0, ...all.map((g) => g.id)) + 1;
      all.push({ id, title: str(args.title, 140), why: str(args.why, 200), due: str(args.due, 40), status: 'active', notes: [] });
      await save('goals.json', all.slice(-100)); // bounded like playbooks; goal_list can prune finished ones
      return `Goal #${id} set.`;
    },
  },
  goal_update: {
    description: 'Update a goal by id: status active, done or dropped, and/or add a progress note.',
    parameters: { type: 'object', properties: { id: { type: 'number' }, status: { type: 'string', enum: ['active', 'done', 'dropped'] }, note: { type: 'string' } }, required: ['id'] },
    run: async (args) => {
      const all = await load<Goal>('goals.json');
      const g = all.find((x) => x.id === Number(args.id));
      if (!g) return `NOT DONE: no goal #${str(args.id, 10)}.`;
      if (['active', 'done', 'dropped'].includes(String(args.status))) g.status = args.status as Goal['status'];
      if (args.note) g.notes = [...g.notes, `${new Date().toISOString().slice(0, 10)} ${str(args.note, 200)}`].slice(-10);
      await save('goals.json', all);
      return `Goal #${g.id} is ${g.status}.`;
    },
  },
  goal_list: {
    description: 'List long-term goals with status, due date and latest notes (all true includes finished ones).',
    parameters: { type: 'object', properties: { all: { type: 'boolean' } } },
    run: async (args) => {
      const gs = (await load<Goal>('goals.json')).filter((g) => args.all === true || g.status === 'active');
      return gs.length ? gs.map((g) => `#${g.id} [${g.status}] ${g.title}${g.due ? ` due ${g.due}` : ''}${g.notes.length ? ` | ${g.notes[g.notes.length - 1]}` : ''}`).join('\n') : 'No goals.';
    },
  },
  run_python: {
    description:
      'Run Python code for maths, data analysis, parsing, charts-as-data, file processing or any computation you would otherwise guess. Print results. Deleting files and shelling out are blocked. Asks the user first.',
    parameters: { type: 'object', properties: { code: { type: 'string' }, timeout_s: { type: 'number', description: 'Default 60, max 300.' } }, required: ['code'] },
    run: async (args) => {
      const code = String(args.code ?? '');
      if (!code.trim()) throw new Error('code is empty.');
      if (PY_DENY.test(code)) throw new Error('Code blocked: deleting files, shelling out and dynamic imports/eval are disabled. Use the dedicated tools.');
      const timeout = Math.min(Number(args.timeout_s) || 60, 300) * 1000;
      await fs.mkdir(path.join(DIR, 'scratch'), { recursive: true });
      const file = path.join(DIR, 'scratch', `run_${Date.now()}.py`);
      await fs.writeFile(file, code, 'utf8');
      return new Promise<string>((resolve) => {
        execFile(process.platform === 'win32' ? 'python' : 'python3', [file], { cwd: FILES_ROOT, timeout, maxBuffer: 4_000_000, windowsHide: true }, (err, stdout, stderr) => {
          const out = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim();
          const tail = out.length > 6000 ? `…${out.slice(-6000)}` : out;
          resolve(err ? `Tool error (${(err as { killed?: boolean }).killed ? 'timed out' : `exit ${String((err as { code?: unknown }).code ?? 'error')}`}):\n${tail || err.message}` : tail || '(no output)');
        });
      });
    },
  },
};

interface Job { prompt: string; kind: AgentKind; state: 'running' | 'done' | 'failed'; result: string; t: number }
const jobs = new Map<number, Job>();
let jobId = 0;
const MAX_RUNNING = 5;
const JOB_TTL_MS = 60 * 60_000; // uncollected results (full sub-agent reports) must not accumulate all session
const pruneJobs = (): void => {
  for (const [id, j] of jobs) {
    if (j.state !== 'running' && Date.now() - j.t > JOB_TTL_MS) jobs.delete(id);
  }
};
/** Running and uncollected background jobs, for the HUD. */
export const jobSummary = (): string[] =>
  [...jobs.entries()].filter(([, j]) => j.state !== 'failed').map(([id, j]) => `#${id} ${j.state === 'running' ? 'running' : 'ready'}: ${j.prompt.slice(0, 40)}`).slice(-4);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tools that spawn sub-agents, so they need the runner and schema picker. */
export const agiOrchestrated = (run: Runner, schemas: SchemaPicker): Record<string, Tool> => {
  const role = { research: 'researcher', explore: 'explorer', general: 'general' } as const;
  const agent = (prompt: string, kind: AgentKind) => runSubagent(prompt, schemas(kind), run, { role: role[kind] });
  return {
    verify_claim: {
      description: 'Fact-check a specific claim, number or statement with independent sources, looking for evidence against it too. Returns SUPPORTED, CONTRADICTED, PARTLY or UNVERIFIED with sources. Use before stating or saving anything important you are not certain of.',
      parameters: { type: 'object', properties: { claim: { type: 'string' } }, required: ['claim'] },
      run: async (args) => {
        const claim = str(args.claim, 800);
        if (!claim) throw new Error('claim is empty.');
        return agent(`Verify this claim with independent, current sources. Search for evidence against it as well as for it. Claim: ${claim}\nReport: "VERDICT:" SUPPORTED, CONTRADICTED, PARTLY or UNVERIFIED; then the key evidence, each with source URL and date; under 150 words.`, 'research').catch((e) => `Tool error: ${e instanceof Error ? e.message : String(e)}`);
      },
    },
    background_start: {
      description: 'Start a long job in the background (sub-agent: research, explore or general) and return at once with a job id, so you can keep talking or doing other work. Collect it with background_result.',
      parameters: { type: 'object', properties: { prompt: { type: 'string', description: 'Complete instructions, including what to report.' }, agent: { type: 'string', enum: ['research', 'explore', 'general'] } }, required: ['prompt'] },
      run: (args) => {
        pruneJobs();
        const prompt = str(args.prompt, 6000);
        if (!prompt) throw new Error('prompt is empty.');
        if ([...jobs.values()].filter((j) => j.state === 'running').length >= MAX_RUNNING) return `NOT DONE: ${MAX_RUNNING} jobs already running. Collect one with background_result first.`;
        const kind: AgentKind = args.agent === 'research' || args.agent === 'general' ? args.agent : 'explore';
        const id = ++jobId;
        const job: Job = { prompt, kind, state: 'running', result: '', t: Date.now() };
        jobs.set(id, job);
        agent(prompt, kind).then(
          (r) => { job.state = 'done'; job.result = r; },
          (e) => { job.state = 'failed'; job.result = e instanceof Error ? e.message : String(e); }
        );
        return `Job ${id} started (${kind}). Collect it with background_result(${id}).`;
      },
    },
    background_status: {
      description: 'List background jobs with state (running, done, failed) and age.',
      parameters: { type: 'object', properties: {} },
      run: () => ([...jobs.entries()].map(([id, j]) => `#${id} ${j.state} ${Math.round((Date.now() - j.t) / 1000)}s ${j.kind}: ${j.prompt.slice(0, 70)}`).join('\n') || 'No background jobs.'),
    },
    background_result: {
      description: 'Get a background job\'s report. If it is still running, wait up to wait_s seconds (default 0, max 60).',
      parameters: { type: 'object', properties: { id: { type: 'number' }, wait_s: { type: 'number' } }, required: ['id'] },
      run: async (args) => {
        const j = jobs.get(Number(args.id));
        if (!j) return `NOT DONE: no job #${str(args.id, 10)}.`;
        const end = Date.now() + Math.min(60, Math.max(0, Number(args.wait_s) || 0)) * 1000;
        while (j.state === 'running' && Date.now() < end) await sleep(500);
        return j.state === 'running' ? `Still running (${Math.round((Date.now() - j.t) / 1000)}s).` : j.state === 'failed' ? `Tool error: job failed: ${j.result}` : j.result;
      },
    },
  };
};
