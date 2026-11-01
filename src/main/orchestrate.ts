import { completeOnce, type ToolSchema } from './llm';
import { getModel } from './settings';
import { runSubagent, type Role, type Runner } from './subagent';
import { currentTurnSignal } from './turnSignal';
import type { Tool } from './toolTypes';

const MAX_BATCH = 10;
const NO_NEST = new Set(['batch', 'task', 'chain', 'research', 'parallel_tasks', 'background_start', 'verify_claim']);

/** Tools a read-only "explore" sub-agent may use. */
export const EXPLORE_TOOLS = new Set([
  'read', 'list_files', 'glob', 'grep', 'tinyfish_search', 'tinyfish_fetch', 'web_search', 'fetch_url', 'code_search', 'get_weather', 'get_current_time', 'skill',
]);

/** Tools no sub-agent may use: recursion, user dialogue, mode switches and shared-state screen capture. */
/** Web-and-files tools for research sub-agents. */
export const RESEARCH_TOOLS = new Set(['search_and_read', 'tinyfish_search', 'tinyfish_fetch', 'web_search', 'fetch_url', 'code_search', 'get_weather', 'get_current_time', 'calculate', 'read', 'find_files', 'read_document']);

export type AgentKind = 'explore' | 'research' | 'general';
export type SchemaPicker = (kind: AgentKind) => ToolSchema[];
const ROLE_OF: Record<AgentKind, Role> = { explore: 'explorer', research: 'researcher', general: 'general' };
const kindOf = (v: unknown): AgentKind => (v === 'general' || v === 'research' ? v : 'explore');

export const SUBAGENT_DENIED = new Set(['background_start', 'verify_claim', 'task', 'research', 'parallel_tasks', 'ask_user', 'plan_enter', 'plan_exit', 'see_screen', 'browser_see']);

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
        NO_NEST.has(c.tool) ? Promise.resolve('Blocked: cannot nest batch or task.') : run(c.tool, JSON.stringify(c.args ?? {}))
      )
    );
    return results.map((r, i) => `[${i + 1}] ${calls[i].tool}\n${r}`).join('\n\n');
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

const safeAgent = async (prompt: string, kind: AgentKind, schemas: SchemaPicker, run: Runner): Promise<string> => {
  try {
    return await runSubagent(prompt, schemas(kind), run, { role: ROLE_OF[kind] });
  } catch (e) {
    return `Sub-agent failed: ${e instanceof Error ? e.message : String(e)}`;
  }
};

export const taskTool = (run: Runner, schemas: SchemaPicker): Tool => ({
  description:
    'Delegate ONE self-contained job to a sub-agent with its own context; it returns one report. agent: "research" (web search and page reading, cross-checked, with sources), "explore" (read-only code and file search, default), "general" (can edit files and run commands). Write a complete prompt: the sub-agent knows nothing else. For several jobs at once use parallel_tasks; for a broad question use research.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Full instructions, including what to report back.' },
      agent: { type: 'string', enum: ['explore', 'research', 'general'], description: 'Default explore.' },
    },
    required: ['prompt'],
  },
  run: (args) => {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) throw new Error('Empty prompt.');
    return safeAgent(prompt, kindOf(args.agent), schemas, run);
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
          properties: { prompt: { type: 'string' }, agent: { type: 'string', enum: ['explore', 'research', 'general'] } },
          required: ['prompt'],
        },
      },
    },
    required: ['tasks'],
  },
  run: async (args) => {
    const tasks = (Array.isArray(args.tasks) ? args.tasks : []) as Array<{ prompt?: string; agent?: string }>;
    if (!tasks.length || tasks.length > MAX_PARALLEL) throw new Error(`Provide 1 to ${MAX_PARALLEL} tasks.`);
    const reports = await pool(tasks, CONCURRENCY, (t) => safeAgent(String(t.prompt ?? ''), kindOf(t.agent), schemas, run));
    return reports.map((r, i) => `[Agent ${i + 1}] ${String(tasks[i].prompt ?? '').slice(0, 80)}\n${r}`).join('\n\n');
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
      const out = String(await run(st.tool, raw));
      outs.push(out);
      const failed = /^(Tool error|NOT APPROVED|BLOCKED)/.test(out);
      report.push(`[${i + 1}] ${st.tool}${failed ? ' FAILED' : ''}\n${clipText(out, failed || i === steps.length - 1 ? 3000 : 500)}`);
      if (failed) {
        report.push(`Stopped at step ${i + 1}; ${steps.length - i - 1} step(s) not run.`);
        break;
      }
    }
    return report.join('\n\n');
  },
});
