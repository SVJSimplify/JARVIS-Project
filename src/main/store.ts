import { promises as fs } from 'fs';

/**
 * Shared persistence helpers for every JSON store (memory, settings, lessons, user model,
 * session, goals/playbooks/jobs). A plain writeFile torn by a crash or power loss used to make
 * the next launch parse-fail and silently reset the store to empty — losing long-term memory
 * and API keys. Writing to a temp file and renaming is atomic on Windows and POSIX.
 */
export async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Append without a read-modify-write race on the whole file: O_APPEND is atomic per write
 * on Windows and POSIX, and a crash can only ever cost the tail of the last line, never
 * the existing content.
 */
export async function atomicAppend(file: string, data: string): Promise<void> {
  const handle = await fs.open(file, 'a');
  try {
    await handle.appendFile(data, 'utf8');
  } finally {
    await handle.close();
  }
}

/** Reads and parses a JSON store; a damaged file is logged, not silently treated as "no data yet". */
export async function loadJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[store] ${file} could not be parsed and starts fresh:`, e instanceof Error ? e.message : e);
    }
    return fallback;
  }
}
