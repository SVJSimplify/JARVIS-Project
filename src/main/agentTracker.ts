import type { AgentProgressView } from './progressTypes';

/**
 * AGENT TRACKER (Round 25 §9) — the live, bounded mirror of WHICH agents are active,
 * what each is doing, and WHY it was assigned.
 *
 * One process-level registry of agent executions, updated at the three places the
 * engine already controls an agent's lifecycle (the coordinator's step assignment, the
 * subagent executor's begin/end, and coordinator-mediated subtask runs). The HUD reads
 * it through the progress snapshot's `agents` provider — the SAME push channel every
 * other live view uses; there is no second UI pipeline.
 *
 * Design rules (inherited from progress.ts):
 *  - Electron-free and injection-friendly: never touches the UI directly.
 *  - Never throws: a tracking bug must not break the agent it tracks.
 *  - Bounded: a cap on tracked runs; finished runs age out; every string clipped.
 *  - Privacy: it carries labels/notes the engine chose, never raw tool args, prompts
 *    or secrets (the same clipping discipline as the activity feed).
 */

export type AgentRunStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'waiting';

export interface AgentRun {
  /** Correlation id (`step:<taskId>:<stepId>` / `subtask:<taskId>:<stepId>:<n>` / `agent:<n>`). */
  id: string;
  /** Registry agent name ('general', 'researcher', 'dyn_csv_analyst', ...). */
  agent: string;
  /** Delegation kind ('coder', 'reviewer', ... 'explore'). */
  kind: string;
  /** Owning durable task, when the run belongs to one. */
  taskId?: string;
  stepId?: string;
  /** Why this agent was assigned (the delegation decision or step title). */
  why: string;
  status: AgentRunStatus;
  note: string;
  startedAt: number;
  endedAt?: number;
}

const MAX_RUNS = 24;
const AGE_OUT_MS = 30 * 60_000;
const CAP = 160;

const clip = (s: unknown, n: number): string => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const runs = new Map<string, AgentRun>();

const sweep = (): void => {
  const now = Date.now();
  for (const [id, r] of runs) {
    if (r.status !== 'running' && r.status !== 'waiting' && now - (r.endedAt ?? r.startedAt) > AGE_OUT_MS) runs.delete(id);
  }
  while (runs.size > MAX_RUNS) {
    const oldest = [...runs.values()].filter((r) => r.status !== 'running' && r.status !== 'waiting').sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))[0];
    if (!oldest) break;
    runs.delete(oldest.id);
  }
};

/** An agent execution began (assigned and starting work). */
export function agentBegin(init: {
  id: string;
  agent: string;
  kind: string;
  taskId?: string;
  stepId?: string;
  why: string;
  note?: string;
}): void {
  try {
    runs.set(init.id, {
      id: init.id,
      agent: clip(init.agent, 40),
      kind: clip(init.kind, 20),
      taskId: init.taskId,
      stepId: init.stepId,
      why: clip(init.why, CAP),
      status: 'running',
      note: clip(init.note ?? '', CAP),
      startedAt: Date.now(),
    });
    sweep();
  } catch {
    /* tracking must never break the agent */
  }
}

/** A waiting state (e.g. queued behind the concurrency gate). */
export function agentWaiting(id: string, note: string): void {
  try {
    const r = runs.get(id);
    if (r && r.status === 'running') {
      r.status = 'waiting';
      r.note = clip(note, CAP);
    }
  } catch {
    /* tracking must never break the agent */
  }
}

/** Back to running after a wait (a slot was acquired). */
export function agentResume(id: string): void {
  try {
    const r = runs.get(id);
    if (r && r.status === 'waiting') r.status = 'running';
  } catch {
    /* tracking must never break the agent */
  }
}

/** An agent execution reached a terminal state. */
export function agentEnd(id: string, status: Exclude<AgentRunStatus, 'running' | 'waiting'>, note?: string): void {
  try {
    const r = runs.get(id);
    if (!r) return;
    r.status = status;
    r.endedAt = Date.now();
    if (note !== undefined) r.note = clip(note, CAP);
    sweep();
  } catch {
    /* tracking must never break the agent */
  }
}

/** Progress note on a running agent (bounded, clipped). */
export function agentNote(id: string, note: string): void {
  try {
    const r = runs.get(id);
    if (r && (r.status === 'running' || r.status === 'waiting')) r.note = clip(note, CAP);
  } catch {
    /* tracking must never break the agent */
  }
}

/** Live views for the HUD: active runs first, then the newest finished ones. */
export function agentViews(): AgentProgressView[] {
  const weight = (r: AgentRun): number => (r.status === 'running' || r.status === 'waiting' ? 0 : 1);
  return [...runs.values()]
    .sort((a, b) => weight(a) - weight(b) || b.startedAt - a.startedAt)
    .slice(0, 8)
    .map((r) => ({
      id: r.id,
      agent: r.agent,
      kind: r.kind,
      taskId: r.taskId,
      status: r.status,
      why: r.why,
      note: r.note,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    }));
}

/** Test helper. */
export const resetAgentTrackerForTests = (): void => {
  runs.clear();
};
