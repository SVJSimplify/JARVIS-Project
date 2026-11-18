import { completeOnce, type ToolSchema } from './llm';
import { getModel } from './settings';
import { runSubagent, type Runner } from './subagent';
import { currentTurnSignal } from './turnSignal';
import { asEnvelope } from './toolResult';
import { callContext } from './toolRecord';
import { registerDynamicAgent, noteDynamicRun, agentAllows, resolveAgent, type AgentDef } from './agentRegistry';
import type { Tool } from './toolTypes';

const MAX_BATCH = 10;
const NO_NEST = new Set(['batch', 'task', 'chain', 'research', 'parallel_tasks', 'background_start', 'verify_claim', 'spawn_agent']);

/** Tools a read-only "explore" sub-agent may use. */
export const EXPLORE_TOOLS = new Set([
  'read', 'list_files', 'glob', 'grep', 'tinyfish_search', 'tinyfish_fetch', 'web_search', 'fetch_url', 'code_search', 'get_weather', 'get_current_time', 'skill',
]);

/** Web-and-files tools for research sub-agents. */
export const RESEARCH_TOOLS = new Set(['search_and_read', 'tinyfish_search', 'tinyfish_fetch', 'web_search', 'fetch_url', 'code_search', 'get_weather', 'get_current_time', 'calculate', 'read', 'find_files', 'read_document']);

/** Delegation kinds: the three legacy names plus the registry agents (Module D) and the
 *  Round 25 permanent specialists (coder / reviewer / tester / planner). */
export type AgentKind = 'explore' | 'research' | 'general' | 'document' | 'browser' | 'verifier' | 'desktop' | 'data' | 'coder' | 'reviewer' | 'tester' | 'planner';
export type SchemaPicker = (kind: AgentKind, request?: string, includeAllAllowed?: boolean) => ToolSchema[];

export const AGENT_KINDS: AgentKind[] = ['explore', 'research', 'general', 'document', 'browser', 'verifier', 'desktop', 'data', 'coder', 'reviewer', 'tester', 'planner'];

const AGENT_OF: Record<AgentKind, string> = {
  explore: 'explorer',
  research: 'researcher',
  general: 'general',
  document: 'document',
  browser: 'browser',
  verifier: 'verifier',
  desktop: 'desktop',
  data: 'data',
  coder: 'coder',
  reviewer: 'reviewer',
  tester: 'tester',
  planner: 'planner',
};

/** Registry allowlist for a delegation kind — the schema layer of the tool ceiling. */
export const agentDefFor = (kind: AgentKind): AgentDef => resolveAgent(AGENT_OF[kind]);

/** Read-only agents may run in parallel; write-capable agents are serialized (Module E). */
export const isReadOnlyKind = (kind: AgentKind): boolean => {
  const a = agentDefFor(kind);
  return a.maxActions.every((x) => x === 'read');
};

export const SUBAGENT_DENIED = new Set(['background_start', 'verify_claim', 'task', 'research', 'parallel_tasks', 'ask_user', 'plan_enter', 'plan_exit', 'see_screen', 'browser_see', 'spawn_agent']);

export const batchTool = (run: Runner): Tool => ({
  description: `Run up to ${MAX_BATCH} independent tool calls in parallel and get all results at once. Use for reads, searches and lookups; not for steps that depend on each other or touch the same app or file.`,
  parameters: {
    type: 'object',
    properties: {
      calls: {
        type: 'array',
        items: {
          type: 'object',
          properties: { tool: { type: 'string' }, args: { type: 'object' } },
          required: ['tool'],
        },
      },
    },
    required: ['calls'],
  },
  run: async (args) => {
    const calls = (Array.isArray(args.calls) ? args.calls : []) as Array<{ tool: string; args?: Record<string, unknown> }>;
    if (!calls.length || calls.length > MAX_BATCH) throw new Error(`Provide 1 to ${MAX_BATCH} calls.`);
    const results = await Promise.all(
      calls.map((c) =>
        NO_NEST.has(c.tool)
          ? Promise.resolve({ text: 'Blocked: cannot nest batch or task.', status: 'error' as const })
          : run(c.tool, JSON.stringify(c.args ?? {})).then((r) => (typeof r === 'string' ? { text: r, status: 'success' as const } : r))
      )
    );
    return results.map((r, i) => `[${i + 1}] ${calls[i].tool}${r.status !== 'success' ? ' FAILED' : ''}\n${r.text}`).join('\n\n');
  },
});

const MAX_PARALLEL = 5;
const CONCURRENCY = MAX_PARALLEL;

async function pool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

const safeAgent = async (prompt: string, kind: AgentKind, schemas: SchemaPicker, run: Runner, opts: { signal?: AbortSignal; taskId?: string; stepId?: string } = {}): Promise<string> => {
  try {
    const def = agentDefFor(kind);
    return await runSubagent(prompt, schemas(kind, prompt), run, { agent: def.name, signal: opts.signal, taskId: opts.taskId, stepId: opts.stepId });
  } catch (e) {
    return `Sub-agent failed: ${e instanceof Error ? e.message : String(e)}`;
  }
};

export const taskTool = (run: Runner, schemas: SchemaPicker): Tool => ({
  description:
    'Delegate ONE self-contained job to a sub-agent with its own context; it returns one report. agent: "research" (web search and page reading, cross-checked, with sources), "explore" (read-only code and file search, default), "general" (can edit files and run commands), "coder" (implementation/debugging with project checks), "reviewer" (independent read-only code review: defects + verdict, never fixes), "tester" (run/design tests, report real results), "planner" (decompose a complex objective into a dependency-aware plan), "document" (produce validated DOCX/PDF/PPTX/XLSX artifacts), "browser" (read and act on web pages invisibly, headless first), "verifier" (independently check a deliverable against acceptance criteria). Write a complete prompt: the sub-agent knows nothing else. For several jobs at once use parallel_tasks; for a broad question use research.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Full instructions, including what to report back.' },
      agent: { type: 'string', enum: AGENT_KINDS, description: 'Default explore. coder: implement/debug with project checks. reviewer: independent read-only review. tester: run/design tests. planner: decompose complex objectives. document: produce/validate DOCX-PDF-PPTX-XLSX. browser: invisible web work (headless readers, panel only if already open). verifier: check a deliverable, never fix it. desktop: drive real apps (OCR/UIA/keyboard). data: compute and verify analysis outputs.' },
    },
    required: ['prompt'],
  },
  run: (args) => {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) throw new Error('Empty prompt.');
    return safeAgent(prompt, kindOf(args.agent), schemas, run);
  },
});

const kindOf = (v: unknown): AgentKind => {
  const s = String(v ?? '');
  return AGENT_KINDS.includes(s as AgentKind) ? (s as AgentKind) : 'explore';
};

/**
 * DYNAMIC AGENT CREATION (Pillar 2, §8.2): register a temporary specialist in the ONE
 * agent registry and run it through the ONE executor. The dynamic agent inherits the
 * central authorization (every call still passes runTool → permission), gets bounded
 * budgets, can never delegate, and its lifecycle is tracked. Children may never call
 * this (SUBAGENT_DENIED) — delegation depth stays 1.
 */
export const spawnAgentTool = (run: Runner, schemas: SchemaPicker): Tool => ({
  description:
    'Create and run a TEMPORARY task-specific specialist when none of the permanent agents (explore/research/general/document/browser/verifier) fits the job. The specialist uses the shared tool runtime, inherits the same policy, has bounded budgets, and returns one structured report. Give a short name, a clear purpose, complete instructions, and the exact list of tools it needs.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short specialist name, e.g. csv_analyst. A dyn_ prefix is added automatically.' },
      purpose: { type: 'string', description: 'One sentence: what this specialist is for.' },
      instructions: { type: 'string', description: 'Complete self-contained instructions, including what to report back.' },
      tools: { type: 'array', items: { type: 'string' }, description: 'Exact tool names the specialist may use (from list_capabilities). Delegation tools are removed automatically.' },
      maxRounds: { type: 'number', description: 'Optional round budget, clamped to 24.' },
    },
    required: ['name', 'purpose', 'instructions', 'tools'],
  },
  run: async (args) => {
    const who = callContext();
    const def: AgentDef = registerDynamicAgent(
      {
        name: String(args.name ?? ''),
        purpose: String(args.purpose ?? ''),
        tools: Array.isArray(args.tools) ? (args.tools as unknown[]).map(String) : [],
        maxRounds: Number(args.maxRounds) || undefined,
      },
      who.agent
    );
    // The specialist only ever sees the tools from its own allowlist — the SAME schemas
    // the runtime can actually dispatch (no invented capabilities), narrowed by the def.
    const toolsForChild = schemas('general', String(args.instructions ?? ''), true).filter((s) => agentAllows(def, s.function.name));
    noteDynamicRun(def.name);
    try {
      return await runSubagent(String(args.instructions ?? ''), toolsForChild, run, { agent: def.name });
    } catch (e) {
      return `Sub-agent failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
});

export const parallelTasksTool = (run: Runner, schemas: SchemaPicker): Tool => ({
  description: `Run up to ${MAX_PARALLEL} independent sub-agents AT THE SAME TIME and get all their reports. Use for separate jobs that do not depend on each other (compare several products, survey several folders, research several topics).`,
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: { prompt: { type: 'string' }, agent: { type: 'string', enum: ['explore', 'research', 'general', 'desktop', 'data', 'coder', 'reviewer', 'tester', 'planner'] } },
          required: ['prompt'],
        },
      },
    },
    required: ['tasks'],
  },
  run: async (args) => {
    const tasks = (Array.isArray(args.tasks) ? args.tasks : []) as Array<{ prompt?: string; agent?: string }>;
    if (!tasks.length || tasks.length > MAX_PARALLEL) throw new Error(`Provide 1 to ${MAX_PARALLEL} tasks.`);
    // PARALLEL WRITE SAFETY (Module E): read-only agents run concurrently; write-capable
    // agents run one at a time — there is one shared workspace, and conflicting writes are
    // exactly the corruption this must never cause. The split is visible in the report.
    const readOnly = tasks.filter((t) => isReadOnlyKind(kindOf(t.agent)));
    const writers = tasks.filter((t) => !isReadOnlyKind(kindOf(t.agent)));
    const report: string[] = [];
    const runOne = async (t: { prompt?: string; agent?: string }) => safeAgent(String(t.prompt ?? ''), kindOf(t.agent), schemas, run);
    if (readOnly.length) {
      const roReports = await pool(readOnly, CONCURRENCY, runOne);
      readOnly.forEach((t, i) => report.push(`[Agent · read-only · ${kindOf(t.agent)}] ${String(t.prompt ?? '').slice(0, 80)}\n${roReports[i]}`));
    }
    if (writers.length) {
      for (const t of writers) {
        const r = await runOne(t);
        report.push(`[Agent · write-capable · ${kindOf(t.agent)}] ${String(t.prompt ?? '').slice(0, 80)}\n${r}`);
      }
      if (readOnly.length && writers.length) report.push(`(write-capable agents ran one at a time after the read-only agents, to keep concurrent edits from colliding)`);
    }
    return report.join('\n\n');
  },
});

const parseList = (text: string): string[] => {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const v = JSON.parse(m[0]) as unknown;
    return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
};

/** Plan, fan out researcher sub-agents in parallel, then synthesize one cited answer. */
export const researchTool = (run: Runner, schemas: SchemaPicker): Tool => ({
  description:
    'Deep research on a question: plans sub-questions, runs several research sub-agents in parallel (search, read pages, cross-check), then synthesizes one answer with sources. Use for anything needing more than one or two lookups: comparisons, recommendations, current facts, "find out everything about X". depth: "quick" (1 agent, default, fastest), "standard" (3), "deep" (4).',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The research question with all needed context and constraints.' },
      depth: { type: 'string', enum: ['quick', 'standard', 'deep'] },
    },
    required: ['question'],
  },
  run: async (args) => {
    const question = String(args.question ?? '').trim();
    if (!question) throw new Error('Empty question.');
    const model = await getModel();
    if (!model) throw new Error('No model set. Open Settings and choose one.');
    const n = args.depth === 'deep' ? 4 : args.depth === 'standard' ? 3 : 1;
    const today = new Date().toLocaleDateString('en-GB', { dateStyle: 'full' });
    /** Every URL that actually flowed through the research tools (search hits, fetched pages).
     *  Appended to the answer programmatically: the Sources section is built from evidence,
     *  not from the model's memory — it can never cite a page that was never read. */
    const appendSources = (reports: string[]): string => {
      const urls = [...new Set(reports.flatMap((r) => r.match(/https?:\/\/[^\s)\]}"'<>]+/g) ?? []))].slice(0, 12);
      return urls.length
        ? `\n\nSources (pages actually fetched during this research, newest evidence first):\n${urls.map((u) => `- ${u}`).join('\n')}`
        : '\n\nSources: none — no pages were actually fetched, so treat every claim above as UNVERIFIED.';
    };
    if (n === 1) {
      // One agent, no synthesis: date-anchored so the answer cannot be built from stale
      // training memory, and with the same programmatic Sources footer.
      const report = await safeAgent(
        `Today is ${today}. ${question}\n\nAnswer with evidence and source URLs from pages you actually fetch, not from memory. DATE DISCIPLINE: check every date and number against the pages you fetch; never state a date, sum or event you did not see in a tool result this run, and mark anything you could not confirm as UNVERIFIED. Prefer recent sources; pass recency_minutes when the topic is time-sensitive.`,
        'research',
        schemas,
        run
      );
      return report + appendSources([report]);
    }

    const plan = await completeOnce(
      model,
      [
        { role: 'system', content: `Today is ${today}. You plan research. Split the question into ${n} or fewer distinct, non-overlapping sub-questions that together fully answer it, each self-contained with every constraint from the original. Reply with ONLY a JSON array of strings.` },
        { role: 'user', content: question },
      ],
      [],
      currentTurnSignal() ?? undefined
    ).catch(() => ({ content: '', toolCalls: [] }));
    const subs = parseList(plan.content).slice(0, n);
    const jobs = subs.length ? subs : [question];

    const reports = await pool(jobs, CONCURRENCY, (q) =>
      safeAgent(`Today is ${today}. Overall question: ${question}\n\nYour sub-question: ${q}\n\nAnswer your sub-question with evidence and source URLs from pages you actually fetch. DATE DISCIPLINE: every date and number must come from a page fetched THIS run; mark anything unconfirmed as UNVERIFIED; flag stale dates instead of repeating them.`, 'research', schemas, run)
    );

    const brief = reports.map((r, i) => `### Agent ${i + 1}: ${jobs[i]}\n${r}`).join('\n\n');
    const final = await completeOnce(
      model,
      [
        {
          role: 'system',
          content: `Today is ${today}. Synthesize research reports into one answer. Lead with the direct answer. Resolve or flag conflicts between agents, drop unsupported claims, keep the key evidence, and end with "Sources:" listing the URLs used. DATE DISCIPLINE: today is ${today} — check every date in the reports against it; never present a past event as current or future, and replace any date you cannot support with UNVERIFIED. Be concise and concrete (under 400 words).`,
        },
        { role: 'user', content: `Question: ${question}\n\nReports:\n${brief}` },
      ],
      [],
      currentTurnSignal() ?? undefined
    ).catch(() => ({ content: '', toolCalls: [] }));
    // The synthesized text plus the deterministic source list from actually-fetched URLs.
    // An empty synthesis (provider hiccup) falls back to the raw agent reports, never to a stub.
    const body = final.content.trim();
    const answer = (body ? `Research run on ${today}.\n\n${body}` : brief) + appendSources(reports);
    return answer;
  },
});

const MAX_CHAIN = 8;
const firstValue = (out: string): string => (out.split('\n')[0] ?? '').split(' | ')[0].trim();
const clipText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Dependent steps in order, stopping at the first failure; {{N}} injects the first line of step N's result. */
export const chainTool = (run: Runner): Tool => ({
  description: `Run up to ${MAX_CHAIN} steps IN ORDER and stop at the first failure. Use for dependent steps: find a file then open or read it, launch an app then type, search then open. In a later step's args, {{N}} is replaced by the first line of step N's result (the text before " | "). For independent reads use batch instead.`,
  parameters: {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        items: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool'] },
      },
    },
    required: ['steps'],
  },
  run: async (args) => {
    const steps = (Array.isArray(args.steps) ? args.steps : []) as Array<{ tool: string; args?: Record<string, unknown> }>;
    if (!steps.length || steps.length > MAX_CHAIN) throw new Error(`Provide 1 to ${MAX_CHAIN} steps.`);
    const outs: string[] = [];
    const report: string[] = [];
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i];
      if (NO_NEST.has(st.tool)) {
        report.push(`[${i + 1}] ${st.tool} FAILED\nCannot nest batch, task or chain.`);
        break;
      }
      const raw = JSON.stringify(st.args ?? {}).replace(/\{\{(\d+)\}\}/g, (_m, n: string) => JSON.stringify(firstValue(outs[Number(n) - 1] ?? '')).slice(1, -1));
      // F-07: the structured envelope decides failure; the legacy text prefixes remain
      // only as a display contract. Exactly ONE call per step.
      const res = asEnvelope(await run(st.tool, raw), /^(Tool error|BLOCKED|CANCELLED)/);
      outs.push(res.text);
      const failed = res.status !== 'success';
      report.push(`[${i + 1}] ${st.tool}${failed ? ' FAILED' : ''}\n${clipText(res.text, failed || i === steps.length - 1 ? 3000 : 500)}`);
      if (failed) {
        report.push(`Stopped at step ${i + 1}; ${steps.length - i - 1} step(s) not run.`);
        break;
      }
    }
    return report.join('\n\n');
  },
});
