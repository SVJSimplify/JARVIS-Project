import { AsyncLocalStorage } from 'async_hooks';

/**
 * STRUCTURED TOOL RESULTS (F-07) and EXECUTION-SCOPE CANCELLATION (F-09).
 *
 * F-07 — every tool execution dispatches through runToolDetailed, which returns a
 * structured envelope beside the human-readable text. Consumers (provider turn loop,
 * sub-agents, chain/batch aggregation) read `status` instead of inferring success by
 * sniffing words like ERROR/BLOCKED in the text. The classic text prefixes remain in the
 * text itself for backwards compatibility with anything that predates the envelope, but
 * they are no longer the mechanism.
 *
 * F-09 — an execution scope carries the AbortSignal that governs the work currently
 * running: the interactive turn signal for direct tool calls, the task/step signal for
 * coordinator and sub-agent work. runToolDetailed refuses to start a tool when its scope
 * is already cancelled, and tool implementations read executionSignal() to cancel fetches
 * and kill spawned processes mid-flight.
 *
 * Envelope schema (Pillar 4, §10.2):
 *   { status: 'success' | 'error' | 'cancelled' | 'unavailable' | 'conflict',
 *     text, errorKind?, soft?, auth? }
 */

export type ToolStatus = 'success' | 'error' | 'cancelled' | 'unavailable' | 'conflict';

export interface ToolResultEnvelope {
  /** Human-readable result exactly as tools returned it before (backwards compatible). */
  text: string;
  status: ToolStatus;
  /** Machine-readable class for non-success results. */
  errorKind?: 'blocked' | 'unknown-tool' | 'plan-blocked' | 'schema' | 'transient' | 'exception' | 'cancelled' | 'conflict' | string;
  /** True when the tool ran and honestly reported NOT DONE (a soft failure, not a crash). */
  soft?: boolean;
  /** The authorization decision that governed the call, kept beside the status. */
  auth?: string;
  /** Round 20 (CHANGE 1): true when the outcome receipt could not be durably persisted.
   *  The text still carries the real result plus a RECEIPT PENDING note; consumers that
   *  account for actions (completion audit, verification) must treat this call as
   *  requiring ledger reconciliation — never as a reason to repeat the action. */
  receiptPending?: boolean;
}

export const successEnvelope = (text: string, auth?: string): ToolResultEnvelope => ({ text, status: 'success', auth });

interface ScopeState {
  status: ToolStatus;
  errorKind?: string;
  soft?: boolean;
  signal?: AbortSignal;
  sessionId?: string;
}
const als = new AsyncLocalStorage<ScopeState>();

/** Run `fn` inside a fresh result/signal scope (innermost scope wins for signals). */
export async function runWithExecutionScope<T>(scope: { signal?: AbortSignal; sessionId?: string }, fn: () => Promise<T>): Promise<T> {
  const parent = als.getStore();
  return als.run({ status: 'success', signal: scope.signal ?? parent?.signal, sessionId: scope.sessionId ?? parent?.sessionId }, fn);
}

/** Tools may narrow the status of their own call mid-run (e.g. conflict detection). */
export const setToolStatus = (patch: { status?: ToolStatus; errorKind?: string; soft?: boolean }): void => {
  const cur = als.getStore();
  if (!cur) return;
  if (patch.status) cur.status = patch.status;
  if (patch.errorKind) cur.errorKind = patch.errorKind;
  if (patch.soft !== undefined) cur.soft = patch.soft;
};

/** The status observed for the call running in this scope (default success). */
export const currentToolStatus = (): { status: ToolStatus; errorKind?: string; soft?: boolean } => {
  const cur = als.getStore();
  if (!cur) return { status: 'success' };
  return { status: cur.status, errorKind: cur.errorKind, soft: cur.soft };
};

/** The cancellation signal governing the work running in this scope, if any. */
export const executionSignal = (): AbortSignal | undefined => als.getStore()?.signal;

/** The durable conversation/session owning the current tool call, when present. */
export const executionSessionId = (): string | undefined => als.getStore()?.sessionId;

/** Combine the scope signal with any extra signals (timeouts) into one, without denying plain timeouts when no scope exists. */
export const withTimeout = (ms: number, extra?: AbortSignal[]): AbortSignal =>
  AbortSignal.any([...(executionSignal() ? [executionSignal() as AbortSignal] : []), ...(extra ?? []), AbortSignal.timeout(ms)]);

/** Normalize a legacy string runner result into an envelope (text-prefix fallback stays for un-migrated callers). */
export const asEnvelope = (r: string | ToolResultEnvelope, failureRe: RegExp): ToolResultEnvelope => {
  if (typeof r !== 'string') return r;
  return failureRe.test(r) ? { text: r, status: 'error', errorKind: 'exception' } : { text: r, status: 'success' };
};
