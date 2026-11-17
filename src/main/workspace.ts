import { promises as fs } from 'fs';
import { realpathSync as fsRealpathSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { classifyRealPath, osProtectedPath } from './policy';

const PROTECTED_MSG = 'That location is protected (operating-system resources are read-only). Choose another folder.';
const UNRESOLVED_MSG =
  'That path could not be resolved on the filesystem (unresolvable chain, symbolic-link cycle or filesystem error), so it cannot be verified to be outside OS-protected locations. The operation fails closed; choose an existing, resolvable folder.';

const PREFERRED_ROOT = process.env.JARVIS_FILES_ROOT ?? 'D:\\Jarvis-Files';
const FALLBACK_ROOT = path.join(os.homedir(), 'Jarvis-Files');

/**
 * All file tools, memory and screenshots live inside this folder. The preferred root is
 * bootstrapped at startup: when the drive denies access (EPERM on a second data drive is
 * the real-world case), every file tool would otherwise fail forever with raw errors.
 * The root then falls back to the user profile and tools surface a one-time notice.
 */
export let FILES_ROOT = PREFERRED_ROOT;

let notice = '';
/** One-time workspace fallback notice for tool output; empty when the preferred root works. */
export const workspaceNotice = (): string => notice;
/** The notice is informational and shows exactly once, on the next tool result. */
export const clearWorkspaceNotice = (): void => {
  notice = '';
};

async function usable(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true });
    const probe = path.join(dir, '.jarvis-write-test');
    await fs.writeFile(probe, 'ok', 'utf8');
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export const workspaceReady = (async () => {
  // An explicit JARVIS_FILES_ROOT is honoured everywhere and first: unit tests point it at
  // a fresh per-process temp dir, and without this branch the fallback below used to win,
  // so memory tests quietly read and wrote the developer's HOME on every POSIX run
  // (the first run in a clean environment passed, every later run failed on stale data).
  const explicit = process.env.JARVIS_FILES_ROOT?.trim();
  if (explicit) {
    FILES_ROOT = explicit;
    return;
  }
  // The drive-letter root only makes sense on Windows: on POSIX a literal "D:\Jarvis-Files"
  // folder would be created in the working directory, so the user-profile root is used.
  if (process.platform !== 'win32') {
    FILES_ROOT = FALLBACK_ROOT;
    return;
  }
  if (await usable(PREFERRED_ROOT)) return;
  if (await usable(FALLBACK_ROOT)) {
    FILES_ROOT = FALLBACK_ROOT;
    notice = `Note: the preferred workspace ${PREFERRED_ROOT} is not writable on this machine, so the workspace moved to ${FALLBACK_ROOT}.`;
  }
})();

/** A raw fs error as a recovery-grade message: what failed, why, and what to try. */
export function fsExplain(err: unknown, target: string): Error {
  const code = (err as NodeJS.ErrnoException)?.code ?? '';
  const map: Record<string, string> = {
    EPERM:
      'Windows denied access (the file may be locked, system-protected, or the drive may not allow writes to this process). ' +
      'If this is a data drive: it may be BitLocker-locked, permission-restricted, or blocked by Controlled Folder Access — ' +
      'check it once in File Explorer yourself; JARVIS cannot elevate its own permissions. list_drives shows which drives are readable and writable.',
    EACCES:
      'Access denied by Windows permissions on this folder. list_drives shows which locations are accessible; the Jarvis-Files workspace is always writable.',
    EBUSY: 'The file is locked by another program.',
    EISDIR: 'That path is a folder, not a file.',
    ENOTDIR: 'A parent of that path is a file, not a folder.',
    ENOENT: 'That path does not exist.',
    EROFS: 'That drive is read-only.',
  };
  const why = map[code] ?? (err instanceof Error ? err.message : String(err));
  return new Error(`${target}: ${why}`);
}

const isOutside = (rel: string) => rel.startsWith('..') || path.isAbsolute(rel);

/** ROUND 33 (§1.1): containment comparison. Windows paths are case-insensitive (and a
 *  realpath may differ from the bound root's stored casing), so on win32 both sides are
 *  case-folded before the relative computation; POSIX stays case-sensitive. Junctions and
 *  reparse points are handled by fs.realpath itself (Node resolves them like symlinks). */
const containmentRel = (from: string, to: string): string => {
  const rel = path.relative(from, to);
  if (process.platform !== 'win32') return rel;
  // A differing case alone must never read as "outside" — redo the comparison folded.
  const f = from.toLowerCase();
  const t = to.toLowerCase();
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const relFolded = path.relative(f, t);
    if (!relFolded.startsWith('..') && !path.isAbsolute(relFolded)) return relFolded;
  }
  return rel;
};

const insideRel = (rel: string): boolean => !rel.startsWith('..') && !path.isAbsolute(rel);

/** The real path of the deepest EXISTING ancestor of `full` (ROUND 33 §1.1): the final
 *  target may not exist yet (a write that will create it, a read about to fail ENOENT) —
 *  the chain up to the last existing component is what must be verified. Unresolvable
 *  components (cycle, permission, filesystem error) REFUSE: an unverified path is never
 *  safe. Returns { real, ok: false } when verification is impossible (fail-closed). */
async function deepestExistingRealPath(full: string): Promise<{ real?: string; ok: boolean }> {
  let probe = full;
  for (;;) {
    try {
      return { real: await fs.realpath(probe), ok: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        const parent = path.dirname(probe);
        if (parent === probe) return { real: probe, ok: true }; // reached the filesystem root
        probe = parent;
        continue;
      }
      // ELOOP (cycle), EACCES/EPERM (unreadable), EINVAL, ... — cannot verify → not safe.
      return { ok: false };
    }
  }
}

/** Resolve a model-supplied path inside FILES_ROOT, blocking `..` and symlink escapes. */
export async function resolveSafe(relPath: unknown): Promise<string> {
  await workspaceReady;
  await fs.mkdir(FILES_ROOT, { recursive: true });
  const full = path.resolve(FILES_ROOT, String(relPath ?? '.'));
  if (isOutside(path.relative(FILES_ROOT, full))) {
    throw new Error('Path is outside the Jarvis-Files folder.');
  }
  // ROUND 32 (§4.3): a project-bound task stays inside its project workspace.
  await assertInsideActiveBinding(full);

  // Follow symlinks on the deepest existing ancestor and re-check.
  const realRoot = await fs.realpath(FILES_ROOT);
  let probe = full;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (isOutside(path.relative(realRoot, real))) {
        throw new Error('Path is outside the Jarvis-Files folder.');
      }
      return full;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(probe);
      if (parent === probe) return full;
      probe = parent;
    }
  }
}

/** Read-only tools may look anywhere; relative paths start at FILES_ROOT. Project-bound
 *  tasks (ROUND 32 §4.3) may only look inside their bound workspace.
 *
 *  ROUND 33 (§1.1) — SYMLINK ESCAPE FIX: the Round 32 check verified the real path ONLY
 *  when the lexical path was already outside, so a lexically-inside path that resolved
 *  through a symbolic link (or Windows junction) to somewhere outside the workspace
 *  passed. The check is now TWO-SIDED for every project-bound read:
 *    1. lexical containment within the bound workspace, AND
 *    2. real-path containment of the deepest EXISTING ancestor within the canonical
 *       workspace root (the final target may not exist yet — its existing chain is what
 *       is verified; nested symlinks resolve through the same realpath walk).
 *  An unresolvable path (cycle, unreadable chain, filesystem error) REFUSES — an
 *  unverified path is never treated as safe. A lexically-outside path whose REAL path
 *  lands inside the canonical workspace (a symlinked alias back into the project) stays
 *  allowed, unchanged from Round 32.
 *
 *  The signature is unchanged (synchronous, one path in, one absolute path out): every
 *  existing caller (fsTools read/glob/grep, tools list_dir, laptopTools, deliverables)
 *  keeps compiling and gains the stronger check without any call-site change. */
export const resolveRead = (p: unknown): string => {
  const full = path.resolve(FILES_ROOT, String(p ?? '.'));
  const b = activeBinding();
  if (b) {
    // 1. Lexical containment (cheap; catches ../ traversal) ...
    const lexicalInside = insideRel(containmentRel(b.root, full));
    // 2. ... AND real-path containment (ROUND 33 §1.1: checked for BOTH branches now).
    let real: string | undefined;
    try {
      real = fsRealpathSync(full);
    } catch {
      // Not resolvable directly (the target may not exist): walk to the deepest existing
      // ancestor synchronously. Any non-ENOENT error refuses — unverified ≠ safe.
      let probe = full;
      for (;;) {
        try {
          real = fsRealpathSync(probe);
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error(
              `UNVERIFIABLE PATH: "${displayPath(full)}" could not be resolved (symlink cycle, unreadable chain or filesystem error), so it cannot be verified to stay inside the project workspace (${b.root}). The read is refused; resolve the path manually.`
            );
          }
          const parent = path.dirname(probe);
          if (parent === probe) {
            real = probe; // reached the filesystem root — verify that
            break;
          }
          probe = parent;
        }
      }
    }
    const realInside = insideRel(containmentRel(b.real, real as string));
    if (!lexicalInside && !realInside) throw new Error(outsideMessage(full, b.root));
    if (lexicalInside && !realInside) throw new Error(outsideMessage(real as string, b.root));
    // !lexicalInside && realInside → a symlinked alias pointing back inside: allowed.
  }
  return full;
};

/**
 * ROUND 33 (§1.2) — final-moment revalidation for READS (the read-side counterpart of
 * revalidateWriteTarget). Called by the read tools IMMEDIATELY before the actual I/O, it
 * re-derives the binding containment of the resolved target so a symbolic link swapped in
 * between resolveRead and the read cannot redirect the operation outside the workspace.
 * Node has no portable O_NOFOLLOW for reads either, so the race is narrowed to the
 * smallest observable gap, not eliminated at the kernel level. No-op when no project
 * binding is active (non-project reads keep their existing behavior, byte for byte).
 */
export async function revalidateReadTarget(full: string): Promise<void> {
  const b = activeBinding();
  if (!b) return;
  const lexicalInside = insideRel(containmentRel(b.root, full));
  const deep = await deepestExistingRealPath(full);
  if (!deep.ok) {
    throw new Error(
      `UNVERIFIABLE PATH: "${displayPath(full)}" could not be resolved at read time (symlink cycle or filesystem error) — the read is refused rather than executed unverified.`
    );
  }
  const realInside = insideRel(containmentRel(b.real, deep.real as string));
  if (!realInside) throw new Error(outsideMessage(deep.real as string, b.root));
  if (!lexicalInside && !realInside) throw new Error(outsideMessage(full, b.root));
}

/** Writes may go anywhere except OS-protected locations (policy.osProtectedPath — THE one
 *  protected-path classifier, F-04). Relative paths start at FILES_ROOT. The old private
 *  PROTECTED regex list was a weaker duplicate of the policy list (it missed SysWOW64,
 *  NTUSER.DAT, registry hives, UNC admin shares and every POSIX root, and apply_patch —
 *  which only passes through here — inherited those gaps). One classifier, one truth.
 *  Round 21 (CHANGE 2): resolution is the explicit tri-state model — an UNRESOLVED write
 *  target (symlink cycle, unresolvable chain, filesystem error) fails closed instead of
 *  silently passing as "not protected" like the old boolean resolver did. */
export async function resolveWrite(p: unknown): Promise<string> {
  await workspaceReady;
  await fs.mkdir(FILES_ROOT, { recursive: true });
  const raw = String(p ?? '.');
  const full = path.resolve(FILES_ROOT, raw);
  const check = (x: string): void => {
    if (osProtectedPath(x)) throw new Error(PROTECTED_MSG);
  };
  // The RAW literal is classified FIRST (the guard does the same): on POSIX a
  // Windows-style or UNC path is treated as relative by path.resolve and would land
  // harmlessly inside the workspace, hiding the protected target it names.
  check(raw);
  check(full);
  const real = classifyRealPath(full);
  if (real === 'protected') throw new Error(PROTECTED_MSG);
  if (real === 'unresolved') throw new Error(UNRESOLVED_MSG);
  // ROUND 32 (§4.3): a project-bound task writes ONLY inside its project workspace —
  // traversal and symlink escapes are caught with resolved paths.
  await assertInsideActiveBinding(full);
  return full;
}

/**
 * Round 21 (CHANGE 2): final-moment revalidation for TOCTOU narrowing. Called INSIDE the
 * per-path write lock, immediately before the I/O, this re-checks the literal and the
 * real-path classification after the caller's earlier resolveWrite — so a symlink (or
 * parent directory) swapped in between validation and execution is re-classified. Node
 * has no portable O_NOFOLLOW, so the race window is narrowed to the smallest observable
 * gap, not eliminated at the kernel level; that residual is documented honestly.
 */
export async function revalidateWriteTarget(full: string): Promise<void> {
  const check = (x: string): void => {
    if (osProtectedPath(x)) throw new Error(PROTECTED_MSG);
  };
  check(full);
  // The FINAL component may itself be a symlink planted after validation: lstat (never
  // following) exposes it, and its current target is classified directly.
  try {
    const st = await fs.lstat(full);
    if (st.isSymbolicLink()) {
      const target = await fs.realpath(full);
      check(target);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ELOOP') throw new Error(UNRESOLVED_MSG); // cycle planted on the final component
    // ENOENT (new file) and other lstat errors fall through to the classification below.
  }
  const real = classifyRealPath(full);
  if (real === 'protected') throw new Error(PROTECTED_MSG);
  if (real === 'unresolved') throw new Error(UNRESOLVED_MSG);
}

export const isInsideRoot = (full: string): boolean => {
  const rel = path.relative(FILES_ROOT, full);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Short path for messages: relative inside Jarvis-Files, absolute elsewhere. */
export const displayPath = (full: string): string => (isInsideRoot(full) ? path.relative(FILES_ROOT, full) || '.' : full);

// ------------------------------------------------------- ROUND 32 (§4.3): project boundaries

/**
 * PROJECT WORKSPACE BINDING — the enforcement layer for project workspace boundaries.
 *
 * Round 31 stores a workspace on each project and carries it in the dispatched brief,
 * but a line of text is not a security boundary. Round 32 binds the DURABLE TASK to its
 * project workspace at launch (coordinator.launchSpec parses the brief's
 * "PROJECT WORKSPACE:" line) and enforces the boundary at the ONE path-resolution choke
 * point every file tool already uses (resolveRead / resolveSafe / resolveWrite):
 *
 *  - project-bound reads and writes must resolve INSIDE the bound workspace;
 *  - `..` traversal and symlink escapes are caught with resolved (real) paths;
 *  - cross-project file access is REFUSED for a bound task;
 *  - non-project work (no binding) keeps its existing behavior unchanged.
 *
 * This is not a second filesystem permission system: it is the existing resolver layer
 * gaining one more predicate when — and only when — a project binding is active. The
 * binding lives in memory for the lifetime of the task's execution context (a restart
 * re-binds from the durable brief at resume).
 */

interface WorkspaceBinding {
  /** The project workspace as named in the brief (absolute). */
  root: string;
  /** The resolved real root (symlinks in the project path itself are pinned here). */
  real: string;
  boundAt: number;
}

const taskWorkspaces = new Map<string, WorkspaceBinding>();

/** Bind a durable task to a project workspace (called by the coordinator at launch/resume). */
export async function bindTaskWorkspace(taskId: string, root: string): Promise<void> {
  const abs = path.resolve(String(root ?? '').trim());
  if (!abs) return;
  let real = abs;
  try {
    real = await fs.realpath(abs);
  } catch {
    // an not-yet-existing workspace is fine: pin the lexical absolute path
  }
  taskWorkspaces.set(taskId, { root: abs, real, boundAt: Date.now() });
}

/** Remove the binding (task finished/cancelled — the boundary is per execution context). */
export const unbindTaskWorkspace = (taskId: string): void => {
  taskWorkspaces.delete(taskId);
};

/** The binding of a specific task (or undefined). Exported for tests and the Ops Center. */
export const boundWorkspaceForTask = (taskId: string): { root: string; real: string } | undefined => {
  const b = taskWorkspaces.get(taskId);
  return b ? { root: b.root, real: b.real } : undefined;
};

/** The current task count bound (diagnostics). */
export const boundWorkspaceCount = (): number => taskWorkspaces.size;

/**
 * ALL currently bound task workspaces (ROUND 33 §6): the Operations Center's execution-
 * boundaries view is built from this REAL state — bound task id, workspace path, canonical
 * path and bind time. Never invented, never simulated.
 */
export const boundWorkspacesList = (): Array<{ taskId: string; root: string; real: string; boundAt: number }> =>
  [...taskWorkspaces.entries()].map(([taskId, b]) => ({ taskId, root: b.root, real: b.real, boundAt: b.boundAt }));

/**
 * The ambient task-id getter, injected by toolRecord (which owns the call context) so
 * this module never imports the context layer — no cycles, and the resolver keeps its
 * existing signature.
 */
let taskIdGetter: () => string | undefined = () => undefined;
export const setTaskIdGetter = (fn: () => string | undefined): void => {
  taskIdGetter = fn;
};

/** The active binding for the CURRENT execution context (undefined outside project work). */
const activeBinding = (): WorkspaceBinding | undefined => {
  const id = taskIdGetter();
  return id ? taskWorkspaces.get(id) : undefined;
};

const outsideMessage = (target: string, root: string): string =>
  `OUTSIDE PROJECT WORKSPACE: "${displayPath(target)}" is outside this task's project workspace (${root}). ` +
  'Cross-project file access is refused for project-bound work — a task for one project must not read or modify another project. ' +
  'Work only inside the project workspace; if this work genuinely needs another location, the user must start it as non-project work or move it into the project.';

/** The boundary predicate for a RESOLVED absolute target against the ACTIVE binding.
 *  ROUND 33 (§1.1): unresolvable paths (cycle, unreadable chain) now REFUSE for the
 *  lexical-inside branch too — an unverified path is never treated as safe — and the
 *  containment comparisons are case-folding on Windows. */
const assertInsideActiveBinding = async (full: string): Promise<void> => {
  const b = activeBinding();
  if (!b) return;
  // Lexical containment first (cheap, catches ../ traversal).
  const lexicalInside = insideRel(containmentRel(b.root, full));
  // Real-path containment of the deepest existing ancestor — checked in BOTH branches
  // (ROUND 33 §1.1): a lexically-inside target whose chain resolves outside is refused,
  // and an unreadable/unresolvable chain refuses instead of passing unverified.
  const deep = await deepestExistingRealPath(full);
  if (!deep.ok) {
    throw new Error(
      `UNVERIFIABLE PATH: "${displayPath(full)}" could not be resolved (symlink cycle, unreadable chain or filesystem error), so it cannot be verified to stay inside the project workspace (${b.root}). The operation fails closed.`
    );
  }
  const realInside = insideRel(containmentRel(b.real, deep.real as string));
  if (!realInside) throw new Error(outsideMessage(deep.real as string, b.root));
  if (!lexicalInside && !realInside) throw new Error(outsideMessage(full, b.root));
  // !lexicalInside && realInside → a symlinked alias pointing back inside: allowed.
};
