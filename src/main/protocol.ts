/**
 * The wire protocol between the main process and the HUD renderer for interaction
 * modes and the activity feed. Pure types, no imports, no electron — both sides
 * (main/modes.ts and types/electron.d.ts) take their shapes from here so the two
 * ends can never drift apart.
 */

export type InteractionMode = 'interactive' | 'background';

export type ActivityKind = 'tool' | 'progress' | 'speech' | 'visual' | 'mode' | 'task' | 'agent' | 'verify';

export interface ActivityEvent {
  id: number;
  t: number;
  /** Correlation id: a tool's start and its result share one; the feed replaces in place. */
  cid?: string;
  kind: ActivityKind;
  label: string;
  detail?: string;
  status?: 'busy' | 'ok' | 'fail' | 'held';
  ms?: number;
  /** Round 23 (task-scoped activity): the durable task that owns this invocation, when
   *  one exists. Optional: conversational-turn calls run without one and are scoped by
   *  the turn bucket in the invocation ledger instead. */
  taskId?: string;
  /** Round 23: the invocation was stopped by its execution scope (cancelled mid-run/before run). */
  cancelled?: boolean;
  /** Round 23: policy blocked the invocation — it never ran. */
  blocked?: boolean;
  /** Round 23: the invocation-ledger scope the event was recorded under (stamped by the
   *  main process before the push). The renderer filters live pushes with it, so activity
   *  from one task/prompt can never leak into another task's view. */
  scope?: string;
}

export interface NotifyPayload {
  title: string;
  body: string;
  /** One short line the renderer may speak aloud as the end-of-task notification. */
  speakLine: string;
  ok: boolean;
  interrupted: boolean;
  task: string;
  reply: string;
  steps: number;
  failures: number;
  held: number;
}

export interface ModeInfo {
  mode: InteractionMode;
  events: ActivityEvent[];
}

/**
 * One full-fidelity conversation turn (history.ts): what the user asked and what JARVIS
 * answered, stored verbatim — never a summary, never truncated. `actions` are the tool
 * descriptions executed during the turn; `error` is set when the turn failed or was
 * interrupted. `legacy` marks turns recovered from the old compact session log, whose
 * text was clipped at write time.
 */
export interface HistoryTurn {
  /** Epoch ms when the turn finished. */
  t: number;
  user: string;
  actions: string[];
  reply: string;
  error?: string;
  legacy?: boolean;
}
