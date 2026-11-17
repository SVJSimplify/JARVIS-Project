import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { executionSignal } from './toolResult';

/**
 * WORKSPACE WRITE COORDINATION (F-21, Round 18 v2) — THE one per-path write coordinator.
 *
 * Interactive turns, coordinator tasks, sub-agents, scheduled turns and background jobs
 * all run in ONE main process and all can write the same workspace files. Without
 * coordination the last writer silently wins and clobbers the other engine's work.
 *
 * WHY V2 (Round 18 Priority One): v1 identified reentrancy by an AsyncLocalStorage
 * "chain id" inherited by every async descendant. Two PARALLEL sibling branches launched
 * with Promise.all inherit the SAME chain id, so both could "re-enter" the same lock by
 * refcount and run concurrently — mutual exclusion bypassed. Inherited context cannot
 * distinguish "nested execution by the same logical operation" from "parallel siblings
 * that merely share an ancestor". Ownership is therefore EXPLICIT in v2.
 *
 * Design (Round 18 — supersedes the Round 17.1 chain design):
 *  - Canonical path identity: two spellings of the same file are the same lock
 *    (path.resolve, case-folded on Windows where the FS is case-insensitive).
 *  - Per-path locks, never a global lock: writes to different files never wait on each
 *    other; multi-path acquisition happens in sorted canonical order (deadlock-free).
 *  - EXPLICIT OWNERSHIP: a top-level withWriteLocks mints a WriteScope token and passes
 *    it to its callback: fn(scope). A nested call re-enters ONLY by passing that exact
 *    token back: withWriteLocks(paths, owner, inner, { scope }). Nothing inherited from
 *    the ambient async context can re-enter a lock — Promise.all siblings that do not
 *    hold the token serialize like any other competing writer.
 *  - THE LANE (single-executor discipline inside one lock): even among token-holding
 *    nested calls, exactly ONE frame executes inside the lock at a time. The lock keeps
 *    a stack of frames; a nested call may push ONLY when its caller frame is on top
 *    (i.e. the parent has yielded control to this child). A Promise.all sibling whose
 *    parent is deeper in the stack PARKS and runs after its siblings unwind — nested
 *    writes to one path run sequentially, never concurrently, but they all complete.
 *  - Nested releases pop exactly their own frame: an inner release can never free the
 *    lock an outer frame still needs.
 *  - NO AGE-BASED STEALING OF LIVE LOCKS: ownership liveness = the scope's live frame
 *    count (every running withWriteLocks call under the scope counts). A scope with
 *    live frames is never stolen, however old. Only a scope whose frames ALL died —
 *    bookkeeping crash or abandoned operation — becomes stealable after the stale
 *    window. This is verified owner-liveness (renewal = a live frame), not a timer.
 *  - Cancellation-aware waiting: lock waiters AND lane waiters observe the execution
 *    scope's AbortSignal and stop waiting the moment it fires. If an enclosing frame
 *    exits while same-scope siblings are parked, those siblings are rejected — never
 *    left dangling.
 *  - Release in `finally` on success, exception, cancellation and timeout — a failed
 *    write never wedges a file.
 *  - Conflicts are returned as STRUCTURED errors the model can read and act on.
 *
 * holdsWriteLock() is a DIAGNOSTIC by owner label only — labels never decide
 * reentrancy or exclusivity; the scope token and the lane stack do.
 *
 * Central authorization still runs for every write — this layer coordinates, it never
 * permits. (In-process scope is deliberate: the engines share one process, so a lock
 * here covers every route; cross-process tampering with the workspace is out of scope.)
 */

export interface WriteScope {
  /** Opaque ownership token. Identity is object identity — never compare by string. */
  readonly id: string;
}

interface ScopeState {
  id: string;
  owner: string;
  /** Live withWriteLocks calls under this scope — the owner-liveness signal. */
  frames: number;
  createdAt: number;
}

interface LaneWaiter {
  /** This waiter may push only when its parent frame is the top of the lane stack. */
  parentFrame: object;
  frame: object;
  grant: () => void;
  reject: (e: Error) => void;
}

const asFrame = (f: object | null): object => {
  if (!f) throw new Error('WRITE SCOPE ERROR: no enclosing frame — a scoped nested write must run inside its operation callback.');
  return f;
};

interface LockEntry {
  /** Diagnostic label of the acquiring call (agent/execution name) — never an identity. */
  owner: string;
  scope: ScopeState;
  /** Depth of acquisitions on this path (outer frame + re-entrant frames). */
  refs: number;
  since: number;
  /** Execution lanes: bottom = top-level frame … top = the frame currently executing. */
  laneStack: object[];
  laneQueue: LaneWaiter[];
  /** Resolves when the LAST reference releases; foreign waiters race on it. */
  gate: Promise<void>;
  __release: () => void;
}

const locks = new Map<string, LockEntry>();
const scopes = new Map<string, ScopeState>();
/** The frame whose fn extent is currently executing — the ONLY reentrancy evidence. */
const frameAls = new AsyncLocalStorage<{ frame: object }>();
let scopeCounter = 0;
let frameCounter = 0;

/** How long a lock whose scope DIED may sit before another acquirer may steal it. */
let STALE_LOCK_MS = 5 * 60_000;
/** How long an acquirer waits for a live conflicting lock before reporting a conflict. */
let ACQUIRE_TIMEOUT_MS = 30_000;

/** Test hook: shorten lock windows so conflict/stale behavior is testable in milliseconds. */
export const setWriteCoordTimeoutsForTests = (acquireMs?: number, staleMs?: number): void => {
  if (acquireMs !== undefined) ACQUIRE_TIMEOUT_MS = acquireMs;
  if (staleMs !== undefined) STALE_LOCK_MS = staleMs;
};

/** Canonical lock identity for a filesystem target. */
export const canonicalWritePath = (p: string): string => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/**
 * DIAGNOSTIC ONLY: does any live lock on this path carry this owner label? Owner labels
 * are annotations, NOT ownership — exclusivity and reentrancy are decided by the scope
 * token and the lane stack, never by comparing strings.
 */
export const holdsWriteLock = (target: string, owner: string): boolean => {
  const cur = locks.get(canonicalWritePath(target));
  return !!cur && cur.owner === owner;
};

/** FOR TESTS AND DIAGNOSTICS ONLY: current lock table (canonical path → owner label). */
export const writeLocks = (): Array<{ path: string; owner: string; heldMs: number }> =>
  [...locks.entries()].map(([k, v]) => ({ path: k, owner: v.owner, heldMs: Date.now() - v.since }));

/** FOR TESTS AND DIAGNOSTICS ONLY: live scope ids and their frame counts. */
export const liveWriteScopes = (): Array<{ id: string; owner: string; frames: number }> =>
  [...scopes.values()].map((s) => ({ id: s.id, owner: s.owner, frames: s.frames }));

export const clearWriteLocks = (): void => {
  locks.clear();
  scopes.clear();
};

/**
 * TEST-ONLY: simulate the abandoned-owner precondition — a scope whose bookkeeping
 * crashed so its frame count hit zero WHILE it still holds locks (in production this
 * requires a crash the finally-blocks cannot survive). Exercises the REAL steal path.
 */
export const simulateAbandonedScopeForTests = (scope: WriteScope): void => {
  const s = scopes.get(scope.id);
  if (s) s.frames = 0;
};

/**
 * Run `fn` while holding the write lock for `target`. Conflicting writes wait up to
 * ACQUIRE_TIMEOUT_MS, then fail with a structured WRITE CONFLICT the model can read and
 * act on — never a silent overwrite. The callback receives the scope token: pass it back
 * to nested withWriteLocks/withWriteLocks calls to re-enter this operation's locks.
 */
export async function withWriteLock<T>(
  target: string,
  owner: string,
  fn: (scope: WriteScope) => Promise<T>,
  opts?: { scope: WriteScope }
): Promise<T> {
  return withWriteLocks([target], owner, fn, opts);
}

/**
 * Multi-file variant used by transactional writers (apply_patch writes several files in
 * one all-or-nothing pass). Locks are acquired in canonical order — a consistent global
 * order is the deadlock-freedom argument when two engines lock overlapping file sets.
 *
 * Re-entrancy: pass the scope token your enclosing frame received as opts.scope. A
 * nested call whose target is already held by the SAME scope re-enters it (refs++), and
 * the lane stack guarantees that sibling nested calls (Promise.all) execute one at a
 * time inside the lock instead of concurrently. A call WITHOUT opts.scope is a fresh,
 * independent acquisition — it waits like any other writer.
 */
export async function withWriteLocks<T>(
  targets: string[],
  owner: string,
  fn: (scope: WriteScope) => Promise<T>,
  opts?: { scope?: WriteScope }
): Promise<T> {
  const keys = [...new Set(targets.map(canonicalWritePath))].sort();
  if (!keys.length) return fn(opts?.scope ?? mintScope());

  const myFrame = { frame: `f${++frameCounter}` };
  const callerFrame = frameAls.getStore()?.frame ?? null;

  // Resolve the owning scope: the explicit token re-enters its locks; otherwise this is
  // a fresh top-level operation with a brand-new token. Ambient context NEVER confers
  // ownership — the Round 18 fix for the Promise.all reentrancy bypass.
  let scope: ScopeState;
  if (opts?.scope) {
    const s = scopes.get(opts.scope.id);
    if (!s) throw new Error(`WRITE SCOPE ERROR: the passed write scope is no longer live (its operation already exited). Do not reuse scope tokens across operations.`);
    scope = s;
  } else {
    scope = { id: mintScopeId(), owner, frames: 0, createdAt: Date.now() };
    scopes.set(scope.id, scope);
  }
  scope.frames += 1;

  const token: WriteScope = Object.freeze({ id: scope.id });

  const releaseOne = (key: string, entry: LockEntry): void => {
    entry.refs -= 1;
    if (entry.refs > 0) {
      // An outer frame of this scope still needs the lock: pop our lane and let a
      // parked same-scope sibling (parent now on top) take the lane — drainLane hands
      // over synchronously and takes the sibling's reference before we return.
      const i = entry.laneStack.lastIndexOf(myFrame);
      if (i >= 0) entry.laneStack.splice(i, 1);
      drainLane(entry);
      return;
    }
    // Last reference: the lock goes away. Any still-parked siblings lost their
    // ancestor — reject them instead of leaving them dangling forever.
    for (const w of entry.laneQueue.splice(0)) {
      w.reject(new Error(`WRITE CONFLICT: the enclosing write operation (${entry.owner}) exited before a nested sibling could run.`));
    }
    if (locks.get(key) === entry) locks.delete(key);
    entry.__release(); // wake foreign waiters after the map removal so the next acquirer wins cleanly
  };

  interface Holding {
    key: string;
    entry: LockEntry;
  }
  const acquired: Holding[] = [];
  const releaseAll = (): void => {
    for (const h of acquired.reverse()) releaseOne(h.key, h.entry);
  };

  const throwConflict = (key: string, cur: LockEntry, extra = ''): Error =>
    new Error(
      `WRITE CONFLICT: another execution (${cur.owner}) has been writing ${key} for ${Math.round((Date.now() - cur.since) / 1000)}s. ` +
        'Do not write blindly: re-read the file, reconcile your change with what is there now, then try again.' +
        (extra ? ` ${extra}` : '')
    );

  const signal = executionSignal();

  const waitOnce = async (cur: LockEntry): Promise<void> => {
    // Round 20 (CHANGE 2): ONE stable named listener per wait, registered BEFORE the
    // aborted check (the old check-then-register window lost an abort that fired in
    // between — the listener on an already-aborted signal never fires, and the wait
    // drifted until the tick). Every exit path (gate, abort, timeout, rejection) removes
    // the exact same listener and clears the tick timer; settled is exactly-once.
    if (signal?.aborted) throw new Error('cancelled');
    const tickHandle: { clear: () => void } = { clear: () => undefined };
    const tick = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(250, Math.max(1, ACQUIRE_TIMEOUT_MS)));
      tickHandle.clear = () => clearTimeout(timer); // the timer never outlives the wait it belongs to
    });
    try {
      if (signal) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => settle(() => reject(new Error('cancelled')));
          let settled = false;
          const settle = (fn: () => void): void => {
            if (settled) return; // exactly one resolve/reject attempt, ever
            settled = true;
            signal.removeEventListener('abort', onAbort); // the exact same named listener
            fn();
          };
          // Register FIRST, check SECOND: the two-step order makes the
          // abort-between-check-and-listener race impossible.
          signal.addEventListener('abort', onAbort);
          if (signal.aborted) return settle(() => reject(new Error('cancelled')));
          void Promise.race([cur.gate, tick]).then(
            () => settle(resolve),
            (e: Error) => settle(() => reject(e))
          );
        });
      } else {
        await Promise.race([cur.gate, tick]);
      }
    } finally {
      tickHandle.clear(); // clear the tick timer on every path: gate, abort, timeout, rejection
    }
  };

  try {
    for (const key of keys) {
      const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
      for (;;) {
        if (signal?.aborted) throw new Error('cancelled');
        const cur = locks.get(key);
        if (!cur) {
          // Free: take it, and this call's frame becomes the executing lane.
          let releaseEntry!: () => void;
          const gate = new Promise<void>((r) => (releaseEntry = r));
          const entry: LockEntry = { owner, scope, refs: 1, since: Date.now(), laneStack: [myFrame], laneQueue: [], gate, __release: releaseEntry };
          locks.set(key, entry);
          acquired.push({ key, entry });
          break;
        }
        if (cur.scope === scope) {
          const top = cur.laneStack[cur.laneStack.length - 1];
          if (top === myFrame || top === callerFrame) {
            // GENUINE NESTED re-entry: the frame on top is this call's own frame (a
            // multi-key call re-touching a path it already took this call) or the
            // enclosing frame transferring the lane down to this child.
            cur.refs += 1;
            if (top === callerFrame) cur.laneStack.push(myFrame);
            acquired.push({ key, entry: cur });
            break;
          }
          if (callerFrame !== null && cur.laneStack.includes(callerFrame)) {
            // PARALLEL SIBLING: our parent frame is in the stack but a sibling child of
            // ours is executing. We must NOT run concurrently with it — park until the
            // lane unwinds back to our parent, then take the lane. Mutual exclusion
            // holds; every sibling still completes, in order. drainLane increments refs
            // AT GRANT TIME (synchronously inside the granting frame's release), so the
            // lock can never be deleted between the grant and our continuation.
            //
            // Round 20 (CHANGE 2): the abort listener is registered BEFORE the waiter
            // enters the queue and the aborted state is re-checked AFTER registration —
            // the old push-then-register order could leave a waiter parked FOREVER when
            // the signal aborted in between (a listener on an already-aborted signal
            // never fires). ONE stable named listener per waiter; the abort path removes
            // the waiter from the queue (requirement 6) so a cancelled sibling can never
            // later be granted the lane (requirement 9); grant/reject remove the exact
            // same listener; double settlement is impossible.
            await new Promise<void>((resolve, reject) => {
              const w: LaneWaiter = {
                parentFrame: asFrame(callerFrame),
                frame: myFrame,
                grant: () => resolve(),
                reject: (err) => reject(err),
              };
              let settled = false;
              const onAbort = (): void => {
                if (settled) return; // grant or a foreign rejection won the race
                settled = true;
                const i = cur.laneQueue.indexOf(w);
                if (i >= 0) cur.laneQueue.splice(i, 1); // cancelled waiters leave the queue
                reject(new Error('cancelled'));
              };
              const settleGranted = (): void => {
                if (settled) return; // exactly one settle, ever
                settled = true;
                if (signal) signal.removeEventListener('abort', onAbort); // the exact same listener
                resolve();
              };
              const settleForeignReject = (err: Error): void => {
                if (settled) return;
                settled = true;
                if (signal) signal.removeEventListener('abort', onAbort);
                reject(err);
              };
              w.grant = settleGranted;
              w.reject = settleForeignReject;
              if (signal) signal.addEventListener('abort', onAbort);
              if (signal?.aborted) {
                onAbort(); // already-aborted: never queue onto a dead scope
                return;
              }
              cur.laneQueue.push(w);
            }).catch((e: Error) => {
              throw e.message === 'cancelled' ? new Error('cancelled') : e;
            });
            // The lane (and our ref) were taken by drainLane at grant time; our frame is
            // already on the lane stack.
            acquired.push({ key, entry: cur });
            break;
          }
          // Same scope token, but this call does not descend from the executing frame
          // (e.g. a second top-level call reusing one token). It competes fairly.
          if (Date.now() > deadline) throw throwConflict(key, cur, 'The same scope token is already executing elsewhere; scope tokens are per-operation.');
          await waitOnce(cur);
          continue;
        }
        // Dead-scope steal: the holder's frames ALL exited without releasing
        // (bookkeeping crash). Age ALONE never steals a lock — a live scope keeps it.
        if (Date.now() - cur.since > STALE_LOCK_MS && cur.scope.frames === 0) {
          for (const w of cur.laneQueue.splice(0)) w.reject(throwConflict(key, cur));
          if (locks.get(key) === cur) locks.delete(key);
          cur.__release();
          pruneScope(cur.scope);
          continue;
        }
        if (Date.now() > deadline) throw throwConflict(key, cur, '');
        await waitOnce(cur);
      }
    }
    // Run fn with OUR frame as the lane identity — nested scoped calls recognize this
    // extent as the top of the lane stack and may transfer the lane to their children.
    return await frameAls.run({ frame: myFrame }, () => fn(token));
  } finally {
    releaseAll();
    scope.frames = Math.max(0, scope.frames - 1);
    pruneScope(scope);
  }
};

const mintScopeId = (): string => `wscope-${Date.now().toString(36)}-${++scopeCounter}-${Math.random().toString(36).slice(2, 8)}`;
const mintScope = (): WriteScope => Object.freeze({ id: mintScopeId() });

/** Drop a scope's registry entry once nothing references it (no frames, no locks). */
const pruneScope = (s: ScopeState): void => {
  if (s.frames > 0) return;
  for (const entry of locks.values()) if (entry.scope === s) return;
  scopes.delete(s.id);
};

/**
 * After a lane pop, hand the lane to the first parked sibling whose parent frame is now
 * on top. The grant PUSHES the waiter's frame synchronously so exactly one waiter can
 * accept the lane; the resolved waiter simply continues inside it.
 */
const drainLane = (entry: LockEntry): void => {
  for (;;) {
    const top = entry.laneStack[entry.laneStack.length - 1];
    const i = entry.laneQueue.findIndex((w) => w.parentFrame === top);
    if (i < 0) return;
    const w = entry.laneQueue.splice(i, 1)[0];
    entry.laneStack.push(w.frame);
    entry.refs += 1; // the granted sibling owns a reference FROM THIS SYNCHRONOUS MOMENT
    w.grant();
  }
};
