import { executionSessionId } from './toolResult';

/**
 * The AbortSignal of the currently running chat turn. Sub-agents read it so that
 * cancelling a turn also stops their model calls, instead of leaving them burning
 * provider requests for minutes after the user pressed Stop.
 */
const signals = new Map<string, AbortSignal>();
const sessionKey = (id?: string): string => id ?? executionSessionId() ?? 'default';

export const setTurnSignal = (signal: AbortSignal | null, sessionId?: string): void => {
  const id = sessionKey(sessionId);
  if (signal) signals.set(id, signal);
  else signals.delete(id);
};

export const currentTurnSignal = (sessionId?: string): AbortSignal | null => {
  const scoped = sessionId ?? executionSessionId();
  if (scoped) return signals.get(scoped) ?? null;
  // Legacy callers outside an execution scope ask for "the current turn" rather than
  // a named session. Return the most recently started live signal, not an unrelated
  // hard-coded default key; concurrent named sessions still resolve by explicit id.
  return Array.from(signals.values()).at(-1) ?? null;
};
