import type { Message, ToolCall, ToolSchema } from './llm';
import type { ToolResultEnvelope } from './toolResult';

/**
 * Cline-inspired lifecycle extension points for Jini's existing sub-agent loop.
 * These hooks observe or veto a run; they do not replace the provider, tool router,
 * permission gate, task store, or durable execution receipts.
 */
export interface AgentRuntimeContext {
  agentId: string;
  agentName: string;
  taskId?: string;
  model: string;
}
export interface AgentRuntimeHooks {
  beforeRun?(ctx: AgentRuntimeContext & { prompt: string }): Promise<void | { stop: true; reason: string }> | void | { stop: true; reason: string };
  beforeModel?(ctx: AgentRuntimeContext & { round: number; messages: readonly Message[]; tools: readonly ToolSchema[] }): Promise<void | { stop: true; reason: string }> | void | { stop: true; reason: string };
  afterModel?(ctx: AgentRuntimeContext & { round: number; content: string; toolCalls: readonly ToolCall[] }): Promise<void> | void;
  beforeTool?(ctx: AgentRuntimeContext & { round: number; call: ToolCall }): Promise<void | { stop: true; reason: string }> | void | { stop: true; reason: string };
  afterTool?(ctx: AgentRuntimeContext & { round: number; call: ToolCall; result: ToolResultEnvelope }): Promise<void> | void;
  afterRun?(ctx: AgentRuntimeContext & { status: 'completed' | 'failed' | 'aborted'; output?: string; error?: string }): Promise<void> | void;
  onEvent?(event: { type: 'run-start' | 'model-start' | 'model-end' | 'tool-start' | 'tool-end' | 'run-end'; agentId: string; agentName: string; round?: number; tool?: string; status?: string }): Promise<void> | void;
}

/** Observability hooks are best-effort; extension bugs must not hide real task outcomes. */
export async function emitAgentHook(
  hooks: AgentRuntimeHooks | undefined,
  event: Parameters<NonNullable<AgentRuntimeHooks['onEvent']>>[0]
): Promise<void> {
  try { await hooks?.onEvent?.(event); } catch (error) { console.warn('[agent-hooks] event observer failed', error); }
}
