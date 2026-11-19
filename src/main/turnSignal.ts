import { executionSessionId } from './toolResult';

/**
 * The AbortSignal of the currently running chat turn. Sub-agents read it so that
 * cancelling a turn also stops their model calls, instead of leaving them burning
 * provider requests for minutes after the user pressed Stop.
 */
const signals = new Map<string, AbortSignal>();
const sessionKey = (id?: string): string => id ?? executionSessionId() ?? '__default__';

export const setTurnSignal = (signal: AbortSignal | null, sessionId?: string): void => {
  const id = sessionKey(sessionId);
  if (signal) signals.set(id, signal);
  else signals.delete(id);
};

export const currentTurnSignal = (sessionId?: string): AbortSignal | null =>
  signals.get(sessionKey(sessionId)) ?? null;
