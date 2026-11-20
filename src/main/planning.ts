import { promises as fs } from 'fs';
import { atomicWrite } from './store';
import * as path from 'path';
import type { Tool } from './toolTypes';
import { FILES_ROOT } from './workspace';
import { executionSessionId } from './toolResult';

const TODO_FILE = path.join(FILES_ROOT, 'todos.json');
const PLAN_DIR = path.join(FILES_ROOT, 'plans');
const MAX_TODOS = 50;
const STATUSES = ['pending', 'in_progress', 'completed'] as const;

interface Todo {
  content: string;
  status: (typeof STATUSES)[number];
}

const planningBySession = new Map<string, boolean>();
const sessionKey = (): string => executionSessionId() ?? '__default__';
const isPlanning = (): boolean => planningBySession.get(sessionKey()) === true;

/** Tools that cannot change anything; the only ones allowed while planning. */
const READ_ONLY = new Set([
  'get_current_time', 'read', 'list_files', 'glob', 'grep', 'tinyfish_search', 'tinyfish_fetch', 'web_search', 'fetch_url', 'get_weather',
  'code_search', 'skill', 'todo_read', 'todo_write', 'ask_user', 'plan_exit', 'list_memories', 'find_contact',
  'read_notes', 'list_timers', 'list_custom_apps', 'list_windows', 'get_system_info', 'diagnostics', 'batch', 'task', 'git_checkpoint_list',
  // Round 31 (§2): read-only project intelligence is exactly what plan mode exists for.
  'inspect_project', 'project_context', 'analyze_impact',
]);

/** Returns a refusal message if `tool` is not allowed right now, else null. */
export function planGuard(tool: string): string | null {
  return isPlanning() && !READ_ONLY.has(tool)
    ? `Blocked: plan mode is read-only. Call plan_exit with the plan, then run ${tool} — execution follows the plan automatically.`
    : null;
}

/**
 * Plan mode must never outlive the turn that entered it: an interrupted or failed turn
 * cannot call plan_exit, and the stale flag would silently block every write tool on
 * unrelated later requests. Each new turn therefore starts with plan mode off.
 */
export function resetPlanMode(): void {
  planningBySession.set(sessionKey(), false);
}

const loadTodos = async (): Promise<Todo[]> => {
  try {
    return JSON.parse(await fs.readFile(TODO_FILE, 'utf8')) as Todo[];
  } catch {
    return [];
  }
};

const formatTodos = (todos: Todo[]) =>
  todos.length ? todos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join('\n') : 'Task list is empty.';

export const planningTools: Record<string, Tool> = {
  todo_write: {
    description:
      'Replace the task list for a multi-step job. Send the full list each time. Keep exactly one item in_progress; mark items completed as you finish them.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: { content: { type: 'string' }, status: { type: 'string', enum: [...STATUSES] } },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    run: async (args) => {
      const raw = Array.isArray(args.todos) ? (args.todos as Todo[]) : [];
      const todos = raw.slice(0, MAX_TODOS).map((t) => ({
        content: String(t.content ?? '').trim().slice(0, 200),
        status: STATUSES.includes(t.status) ? t.status : 'pending',
      }));
      await fs.mkdir(FILES_ROOT, { recursive: true });
      await atomicWrite(TODO_FILE, JSON.stringify(todos));
      return formatTodos(todos);
    },
  },
  todo_read: {
    description: 'Read the current task list.',
    parameters: { type: 'object', properties: {} },
    run: async () => formatTodos(await loadTodos()),
  },
  plan_enter: {
    description:
      'Enter read-only plan mode for a large or risky task: research with read-only tools, then call plan_exit with the plan. Nothing can be modified until you exit.',
    parameters: { type: 'object', properties: {} },
    run: () => {
      planningBySession.set(sessionKey(), true);
      return 'Plan mode on. Only read-only tools are available. Investigate, then call plan_exit with the plan.';
    },
  },
  plan_exit: {
    description: 'Leave plan mode and save the plan. Afterwards, summarise the plan aloud in two or three sentences and proceed to execute it — no approval step exists.',
    parameters: {
      type: 'object',
      properties: { plan: { type: 'string', description: 'The full plan, in markdown.' } },
      required: ['plan'],
    },
    run: async (args) => {
      planningBySession.set(sessionKey(), false);
      const file = path.join(PLAN_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`);
      await fs.mkdir(PLAN_DIR, { recursive: true });
      await atomicWrite(file, String(args.plan ?? ''));
      return `Plan saved to ${path.relative(FILES_ROOT, file)}. Plan mode off. Summarise it in a couple of sentences and start executing.`;
    },
  },
  ask_user: {
    description:
      'Ask the user a question only when the request is genuinely ambiguous or missing information you cannot look up. Then speak the question, offer the options, and stop calling tools until they answer. Never use this to seek permission for an allowed action.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional short choices; put your recommendation first.' },
      },
      required: ['question'],
    },
    run: (args) => {
      const options = Array.isArray(args.options) ? (args.options as unknown[]).map(String) : [];
      return `Ask the user aloud now, then end your turn and wait for their reply: ${String(args.question ?? '')}${
        options.length ? ` Options: ${options.join('; ')}.` : ''
      }`;
    },
  },
};
