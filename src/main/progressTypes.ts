/**
 * Wire types for the LIVE TASK PROGRESS channel (`jarvis-progress`).
 *
 * Pure types, no imports, no electron — exactly like protocol.ts, both ends
 * (main/progress.ts and the renderer) take their shapes from here so the two
 * ends can never drift apart. Structural twin of the durable-task view
 * (taskStore.taskToView).
 */

/** One checklist row of the current turn: a tool call or phase note. */
export interface ProgressStep {
  /** Stable key within the turn (tool correlation id, or a kind:label key). */
  key: string;
  /** Tool name, or a short phase label ("Working", "Verification · T-…"). */
  label: string;
  detail?: string;
  status: 'running' | 'ok' | 'fail' | 'held';
  t: number;
  ms?: number;
}

/** The conversational turn that is (or was just) running: its task and its steps. */
export interface TurnProgress {
  task: string;
  startedAt: number;
  /** Set the moment the turn ends; steps freeze after that. */
  endedAt?: number;
  outcome?: 'running' | 'ok' | 'fail' | 'interrupted';
  /** Render window of the checklist: the NEWEST steps (bounded — the full history is in
   *  the invocation ledger, reachable through the activity query API; Round 23). */
  steps: ProgressStep[];
  /**
   * Round 23: REAL totals over every step the turn ever had — no longer derived from the
   * bounded `steps` window, which used to freeze the visible progress at ~30 tools.
   */
  done: number;
  failed: number;
  /** Total distinct invocations (and other checklist rows) recorded this turn. */
  calls?: number;
}

/**
 * Round 23: live tool-activity counts for the CURRENT activity scope (the newest scope
 * with a running invocation, else the most recent one — a fresh prompt starts a fresh
 * scope). Aggregated in the main process from the invocation ledger; the header renders
 * these directly ("8 tools · 24 calls · 2 running"). The fuller shape lives in
 * invocations.ts (InvocationSummary) — this structural twin keeps progressTypes import-free.
 */

/** A durable task's live view (taskStore record, projected for the HUD). */
export interface TaskProgressView {
  id: string;
  objective: string;
  status: string;
  note: string;
  done: number;
  total: number;
  steps: Array<{ title: string; status: string }>;
  updatedAt: number;
}

/**
 * Round 25: one agent execution's live view (agentTracker record, projected for the
 * HUD's Agents section) — which agent, what it is doing, and why it was assigned.
 */
export interface AgentProgressView {
  id: string;
  agent: string;
  kind: string;
  taskId?: string;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'waiting';
  why: string;
  note: string;
  startedAt: number;
  endedAt?: number;
}

/**
 * The whole live picture, pushed on every change and served on request.
 * `busy` is true while a turn is open or any task is active — it is
 * mode-independent on purpose: background mode still reports real-time
 * progress here, while the activity feed, speech and notifications keep
 * following the background-mode silence contract.
 */
export interface ProgressSnapshot {
  mode: 'interactive' | 'background';
  busy: boolean;
  /** What JARVIS is doing right now (latest activity), null when nothing ran yet. */
  now: { label: string; detail?: string; status: 'running' | 'ok' | 'fail' | 'held'; since: number } | null;
  /** The current turn, or the most recent one (with endedAt + outcome once finished). */
  turn: TurnProgress | null;
  tasks: TaskProgressView[];
  /**
   * Round 25: live agent executions (specialist + dynamic agents) for the Agents
   * section. Undefined only before the provider is wired (tests); the renderer treats
   * it as optional for exactly that reason.
   */
  agents?: AgentProgressView[];
  /**
   * Round 23: live tool-activity counts for the current activity scope — the compact
   * header summary data ("8 tools · 24 calls · 2 running"), aggregated by the invocation
   * ledger. Undefined only before the provider is wired (tests); the renderer treats it
   * as optional for exactly that reason.
   */
  invocations?: {
    scope: string;
    scopeKind: 'task' | 'turn' | 'session';
    tools: number;
    calls: number;
    running: number;
    completed: number;
    failed: number;
    blocked: number;
    cancelled: number;
    lastAt: number;
  };
  /** Monotonic-ish stamp (Date.now at push); the renderer drops out-of-order pushes. */
  updatedAt: number;
}
