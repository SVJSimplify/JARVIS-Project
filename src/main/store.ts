import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * Shared persistence helpers for every JSON store (memory, settings, lessons, user model,
 * session, goals/playbooks/jobs). A plain writeFile torn by a crash or power loss used to make
 * the next launch parse-fail and silently reset the store to empty — losing long-term memory
 * and API keys. Writing to a temp file and renaming is atomic on Windows and POSIX.
 *
 * Round 17.1 concurrency fixes (the Round 17 review findings):
 *  - The temp filename used to be FIXED (`file.tmp`): two concurrent writers of the same
 *    store collided — one rename won, the other failed or renamed a half-written file.
 *    Temp names are now collision-resistant (pid + timestamp + random) per write.
 *  - Per-path op chains serialize the write-rename pairs (and read-modify-write slots via
 *    withStoreLock) so concurrent operations on one file land in order, whole.
 *  - The temp file is fsynced before the rename and the directory is fsynced after
 *    (where the platform supports it), so a power cut cannot leave an empty store.
 */

/** One serialized op-chain per key: the resolved file path, or `rmw:<path>` for RMW slots. */
const opChains = new Map<string, Promise<unknown>>();
let pendingStoreOps = 0;

const pathKey = (file: string): string =>
  process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

/**
 * Chain `op` after every previously queued op for the same key. The chain never stays
 * rejected: a failed op settles its own slot, later ops still run.
 *
 * The map is intentionally never pruned: its keys are store file paths (a fixed, small
 * set — memory, settings, session, projects, …), so one settled promise per store is the
 * steady-state cost. Chasing microtask-exact pruning here would add races for no gain.
 */
function enqueueFor<T>(key: string, op: () => Promise<T>): Promise<T> {
  const prev = opChains.get(key) ?? Promise.resolve();
  const tracked = async (): Promise<T> => {
    pendingStoreOps++;
    try {
      return await op();
    } finally {
      pendingStoreOps--;
    }
  };
  const slot = prev.then(tracked, tracked);
  opChains.set(key, slot.catch(() => undefined));
  return slot;
}

/** Count of store operations queued-but-not-finished across ALL chains. ROUND 28: lets
 *  test quiescence helpers distinguish "no drain running" from "a drain (or the queueEpisode
 *  that will trigger one) is still sitting in a lock chain" — the latter fires later. */
export const storeOpsPending = (): number => pendingStoreOps;

const randomSuffix = (): string =>
  `${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export async function atomicWrite(file: string, data: string | Buffer): Promise<void> {
  // Serialize same-path writes: two overlapping temp-rename pairs can no longer interleave.
  return enqueueFor(pathKey(file), async () => {
    const tmp = `${file}.${randomSuffix()}.tmp`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(data);
      await handle.sync(); // durability: the content survives the rename even on power loss
    } finally {
      await handle.close();
    }
    // Round 20 (CHANGE 3): keep the last known-good version beside the store. The rename
    // itself is atomic, so this backup is not about torn writes — it protects the data
    // from a later BUGGY writer or media damage: loadJson can then recover the previous
    // good state instead of resetting a memory store to empty. Crash-safe at every point:
    // before the copy → old backup + old main; after the copy → backup=old, main=old;
    // after the rename → backup=old, main=new. Every pair is consistent.
    try {
      await fs.copyFile(file, `${file}.bak`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[store] ${file}: could not refresh the .bak backup:`, e instanceof Error ? e.message : e);
      } // ENOENT = first write ever; there is no previous version to keep
    }
    try {
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.unlink(tmp).catch(() => undefined); // never leave debris behind
      throw e;
    }
    // fsync the containing directory where supported (POSIX); Windows ignores this. The
    // rename of the temp file is atomic on both platforms; the dir fsync is what makes
    // the RENAME itself survive a power cut on POSIX — claimed here only where supported.
    try {
      const dir = await fs.open(path.dirname(file), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      /* directory fsync unsupported — the rename itself is still atomic */
    }
  });
}

/**
 * Append without a read-modify-write race on the whole file: O_APPEND is atomic per write
 * on Windows and POSIX, and a crash can only ever cost the tail of the last line, never
 * the existing content. Round 20 (CHANGE 3): the appended bytes are fsynced before the
 * handle closes, so a receipt that reported itself durable IS on stable storage — the
 * ledger's reconciliation queries may rely on it. (Per-append fsync costs one flush per
 * record; receipt volume is low and the durability of evidence is the point of the file.)
 */
export async function atomicAppend(file: string, data: string): Promise<void> {
  const handle = await fs.open(file, 'a');
  try {
    await handle.appendFile(data, 'utf8');
    await handle.sync(); // CHANGE 3: evidence is only evidence once it survives a power cut
  } finally {
    await handle.close();
  }
}

/**
 * Serialized read-modify-write for a JSON store: `fn` runs only after every previously
 * queued modifier for the same file settled, and its result is the slot's outcome. Two
 * concurrent modifiers can no longer load the same base state and lose each other's
 * update (the project_save race).
 */
export function withStoreLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  return enqueueFor(`rmw:${pathKey(file)}`, fn);
}

/** Reads and parses a JSON store; a damaged file is logged, not silently treated as "no data yet".
 *
 * Round 20 (CHANGE 3) — CORRUPT-FILE RECOVERY, in order:
 *  1. the damaged main file is QUARANTINED (renamed to `<file>.corrupt-<ts>`): the broken
 *     bytes are never silently destroyed, so the damage stays diagnosable;
 *  2. the `.bak` copy written by atomicWrite (the last known-good version) is tried; when
 *     it parses, it becomes the main file again (atomicWrite) and is returned — memory,
 *     settings and keys survive a corrupt write instead of resetting to empty;
 *  3. only with no readable backup does the store start fresh (fallback), loudly.
 * Recovery is idempotent: a second call after a successful recovery just parses the file.
 */
export async function loadJson<T>(file: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[store] ${file} could not be read:`, e instanceof Error ? e.message : e);
    }
    return fallback;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    console.warn(`[store] ${file} could not be parsed and starts fresh:`, e instanceof Error ? e.message : e);
    // 1. Quarantine the damaged bytes (best-effort; a name collision just skips it).
    const quarantine = `${file}.corrupt-${Date.now().toString(36)}`;
    await fs.rename(file, quarantine).catch(() => undefined);
    // 2. Try the last known-good backup.
    try {
      const bak = await fs.readFile(`${file}.bak`, 'utf8');
      const recovered = JSON.parse(bak) as T;
      await atomicWrite(file, bak); // restore the recovered state as the main file
      console.warn(`[store] ${file} recovered from its .bak backup`);
      return recovered;
    } catch {
      return fallback; // 3. loudly fresh: the warning above is the trace
    }
  }
}
