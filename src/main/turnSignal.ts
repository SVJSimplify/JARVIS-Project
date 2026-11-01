/**
 * The AbortSignal of the currently running chat turn. Sub-agents read it so that
 * cancelling a turn also stops their model calls, instead of leaving them burning
 * provider requests for minutes after the user pressed Stop.
 */
let current: AbortSignal | null = null;

export const setTurnSignal = (s: AbortSignal | null): void => {
  current = s;
};

export const currentTurnSignal = (): AbortSignal | null => current;
