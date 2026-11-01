import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

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

/** Resolve a model-supplied path inside FILES_ROOT, blocking `..` and symlink escapes. */
export async function resolveSafe(relPath: unknown): Promise<string> {
  await workspaceReady;
  await fs.mkdir(FILES_ROOT, { recursive: true });
  const full = path.resolve(FILES_ROOT, String(relPath ?? '.'));
  if (isOutside(path.relative(FILES_ROOT, full))) {
    throw new Error('Path is outside the Jarvis-Files folder.');
  }

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

/** Read-only tools may look anywhere; relative paths start at FILES_ROOT. */
export const resolveRead = (p: unknown): string => path.resolve(FILES_ROOT, String(p ?? '.'));

/** Writes may go anywhere except system, startup, SSH-key and browser-profile folders. Relative paths start at FILES_ROOT. */
const PROTECTED = [
  /^[a-z]:\\windows(\\|$)/i,
  /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\programdata(\\|$)/i,
  /^[a-z]:\\(\$recycle\.bin|system volume information|boot|recovery)(\\|$)/i,
  /\\appdata\\roaming\\microsoft\\windows\\start menu\\programs\\startup(\\|$)/i,
  /\\\.ssh(\\|$)/i,
  /\\appdata\\local\\(google\\chrome|microsoft\\edge|bravesoftware)\\user data(\\|$)/i,
];

export async function resolveWrite(p: unknown): Promise<string> {
  await workspaceReady;
  await fs.mkdir(FILES_ROOT, { recursive: true });
  const full = path.resolve(FILES_ROOT, String(p ?? '.'));
  const check = (x: string): void => {
    if (PROTECTED.some((re) => re.test(x))) throw new Error('That location is protected (system, startup, SSH keys or browser profiles). Choose another folder.');
  };
  check(full);
  let probe = full;
  for (;;) {
    try {
      check(await fs.realpath(probe)); // also catches symlinks into protected folders
      return full;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(probe);
      if (parent === probe) return full;
      probe = parent;
    }
  }
}

export const isInsideRoot = (full: string): boolean => {
  const rel = path.relative(FILES_ROOT, full);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Short path for messages: relative inside Jarvis-Files, absolute elsewhere. */
export const displayPath = (full: string): string => (isInsideRoot(full) ? path.relative(FILES_ROOT, full) || '.' : full);
