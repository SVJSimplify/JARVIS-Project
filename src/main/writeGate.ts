import { withWriteLocks, canonicalWritePath, setWriteCoordTimeoutsForTests, writeLocks } from './writeCoord';
import { callContext } from './toolRecord';

/**
 * COMPATIBILITY FACADE — there is ONE write coordinator: src/main/writeCoord.ts.
 *
 * This module used to be a second, disconnected implementation (Round 16 lineage). The
 * coordination engines were consolidated so there is exactly one lock table, one set of
 * semantics (chain-based reentrancy, no age-based stealing of live locks, cancellation-
 * aware waiting) and one conflict contract. The Round 16 API names live on here because
 * several call sites and the round16b regression suite import them; they are thin
 * re-exports, NOT a second engine. New code should import from writeCoord.ts directly.
 */

/** Round 16 name of the canonical path key. */
export const canonicalPathKey = canonicalWritePath;

/** Round 16 test hook: the wait timeout IS the acquire timeout. */
export const setWriteWaitTimeoutForTests = (ms: number): void => setWriteCoordTimeoutsForTests(ms);

/** Holder identity comes from the call context, so conflict reports name the ACTUAL other engine. */
export function withPathLock<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  let who = 'main';
  try {
    who = callContext().agent || 'main';
  } catch {
    who = 'main';
  }
  return withWriteLocks(paths, who, fn);
}

/** Diagnostics for tests: current holders. */
export const lockHolders = (): Array<{ path: string; holder: string; heldMs: number }> =>
  writeLocks().map((l) => ({ path: l.path, holder: l.owner, heldMs: l.heldMs }));
