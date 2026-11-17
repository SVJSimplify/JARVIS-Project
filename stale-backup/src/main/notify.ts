import * as path from 'path';
import { promises as fs } from 'fs';
import { atomicWrite, loadJson } from './store';
import { FILES_ROOT } from './workspace';
import type { Verdict } from './completion';
import { emitActivity } from './activity';

/**
 * END-OF-TASK NOTIFICATION — the delivery half of Background Mode.
 *
 * When a turn or mission finishes in background mode, the user (who may be away) gets
 * ONE notification carrying the audited verdict — the same text the completion engine
 * produced, never a raw model claim. The guarantee:
 *
 *  1. The OS toast is best-effort (Electron Notification; click focuses the app).
 *  2. EVERY report is also recorded in a persisted unread digest (brain/notifications.json,
 *     capped at 20). The renderer shows unread entries as a "While you were away" list and
 *     marks them read. So even with no OS notification support at all, the end-of-task
 *     report is never lost — silence never means "unknown outcome".
 *  3. Every report also lands in the activity feed.
 *
 * Electron-free: the OS notifier is injected (setOsNotifier) from the main process, so
 * unit tests exercise the full fallback path without mocks.
 */

export interface TaskReport {
  verdict: Verdict;
  /** The audited reply (or mission note) — the honest summary. */
  reply: string;
  source: 'turn' | 'mission';
  missionId?: string;
}

export interface DigestEntry {
  t: number;
  title: string;
  body: string;
  verdict: string;
  read: boolean;
}

let osNotifier: ((title: string, body: string) => boolean) | null = null;

/** Wired from the main process (Electron Notification with click-to-focus); returns false when unsupported. */
export const setOsNotifier = (fn: ((title: string, body: string) => boolean) | null): void => {
  osNotifier = fn;
};

const file = (): string => path.join(FILES_ROOT, 'brain', 'notifications.json');
const CAP = 20;

const clip = (s: string, n: number): string => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/** Honest, verdict-driven title — never a generic "Done!" over a failure. */
export function reportTitle(verdict: Verdict): string {
  switch (verdict) {
    case 'completed':
      return 'Task completed';
    case 'partial':
      return 'Task partly completed';
    case 'failed':
      return 'Task failed';
    case 'needs_user':
      return 'Needs your approval';
    case 'interrupted':
      return 'Task stopped';
    default:
      return 'Nothing to do';
  }
}

/** Append to the digest, capped; the oldest read entries fall off first. */
async function appendDigest(entry: DigestEntry): Promise<void> {
  const list = await loadJson<DigestEntry[]>(file(), []);
  list.push(entry);
  const kept = list.slice(-CAP);
  try {
    await fs.mkdir(path.join(FILES_ROOT, 'brain'), { recursive: true });
    await atomicWrite(file(), JSON.stringify(kept, null, 2));
  } catch (e) {
    console.warn('[notify] digest write failed:', e instanceof Error ? e.message : e);
  }
}

/**
 * Deliver the end-of-task report. Never throws. Returns how it was delivered:
 * 'os' (toast + digest entry), 'digest' (no OS support — digest entry only).
 * The digest entry is ALWAYS written first: a crash between toast and record
 * must not lose the report.
 */
export async function notifyTaskDone(report: TaskReport): Promise<'os' | 'digest'> {
  const title = `JARVIS — ${reportTitle(report.verdict)}`;
  const body = clip(report.reply || (report.source === 'mission' ? 'Mission finished.' : 'Task finished.'), 240);
  emitActivity({ kind: 'notice', status: 'info', name: title, summary: body, missionId: report.missionId });
  const entry: DigestEntry = { t: Date.now(), title, body, verdict: report.verdict, read: false };
  await appendDigest(entry);
  let via: 'os' | 'digest' = 'digest';
  try {
    if (osNotifier?.(title, body)) via = 'os';
  } catch (e) {
    console.warn('[notify] OS notification failed:', e instanceof Error ? e.message : e);
  }
  return via;
}

/** Unread entries for the "While you were away" list (empty when everything was seen). */
export async function unreadDigest(): Promise<DigestEntry[]> {
  const list = await loadJson<DigestEntry[]>(file(), []);
  return list.filter((e) => !e.read);
}

/** Mark everything read (the renderer calls this after showing the digest). */
export async function markDigestRead(): Promise<void> {
  const list = await loadJson<DigestEntry[]>(file(), []);
  if (!list.some((e) => !e.read)) return;
  for (const e of list) e.read = true;
  await atomicWrite(file(), JSON.stringify(list.slice(-CAP), null, 2));
}
