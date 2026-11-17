import { promises as fs } from 'fs';
import * as path from 'path';
import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson } from './store';

/**
 * Short-term memory: a compact, persisted log of recent turns (what the user asked,
 * which tools JARVIS used, what it replied). Injected into every system prompt so
 * JARVIS always knows what it just did, even after tool-heavy turns or a restart.
 */
const SESSION_FILE = path.join(FILES_ROOT, 'session.json');
const MAX_LOG = 60;
const PROMPT_ENTRIES = 3;
const PROMPT_MAX_AGE_MS = 10 * 60 * 1000;

export interface LogEntry {
  t: number;
  user: string;
  actions: string[];
  reply: string;
  error?: string;
}

let log: LogEntry[] = [];
let loaded = false;

async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  // Shape-check every entry: schema drift or a hand-edited file used to throw inside turn setup
  // (`e.actions.length`) and fail EVERY later turn until session.json was deleted by hand.
  const parsed = await loadJson<unknown>(SESSION_FILE, []);
  log = (Array.isArray(parsed) ? parsed : []).filter(
    (e): e is LogEntry => !!e && typeof e === 'object' && typeof (e as LogEntry).user === 'string' && Array.isArray((e as LogEntry).actions)
  ).slice(-MAX_LOG);
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

export async function recordTurn(e: { user: string; actions: string[]; reply: string; error?: string }): Promise<void> {
  await load();
  log.push({
    t: Date.now(),
    user: clip(e.user.replace(/\s+/g, ' ').trim(), 200),
    actions: e.actions.slice(0, 15),
    reply: clip(e.reply.replace(/\s+/g, ' ').trim(), 240),
    error: e.error ? clip(e.error, 160) : undefined,
  });
  log = log.slice(-MAX_LOG);
  try {
    await fs.mkdir(FILES_ROOT, { recursive: true });
    await atomicWrite(SESSION_FILE, JSON.stringify(log));
  } catch (e) {
    console.warn('[session] failed to persist the turn log:', e instanceof Error ? e.message : e); // observable, still best-effort
  }
}

export async function getSessionPrompt(): Promise<string> {
  await load();
  const now = Date.now();
  const recent = log.filter((e) => now - e.t <= PROMPT_MAX_AGE_MS).slice(-PROMPT_ENTRIES);
  if (!recent.length) return '';
  const lines = recent.map((e) => {
    const mins = Math.max(0, Math.round((now - e.t) / 60000));
    const did = e.actions.length ? ` | did: ${e.actions.join(', ')}` : '';
    const out = e.error ? ` | FAILED: ${e.error}` : '';
    return `- [${mins}m ago] user: ${e.user}${did}${out}`;
  });
  return (
    'Background only (finished requests, oldest first). The CURRENT user message is the only task: never redo, resume or answer an earlier request unless the user explicitly refers to it ("again", "that one"). ' +
    'Entries are not proof of the present state: verify with tools before claiming anything is open or done.\n' +
    lines.join('\n')
  );
}

/**
 * The compact log for the Conversations panel's LEGACY section (history.ts): entries the
 * full-fidelity recorder was not yet keeping. Surfaces verbatim what was actually stored —
 * clipped text stays clipped and is marked `legacy` by the caller; nothing is invented.
 */
export async function getSessionTurnsForHistory(): Promise<LogEntry[]> {
  await load();
  return [...log];
}
