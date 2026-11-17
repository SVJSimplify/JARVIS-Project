import { promises as fs } from 'fs';
import * as path from 'path';
import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson } from './store';
import { getSessionTurnsForHistory } from './session';
import type { HistoryTurn } from './protocol';

/**
 * CONVERSATION HISTORY — the full-fidelity, durable record of what the user asked and
 * what JARVIS answered, stored verbatim.
 *
 * WHY THIS EXISTS: `session.ts` is a COMPACT prompt-context log — it clips the user's
 * request to 200 chars and the reply to 240 chars and keeps only 60 turns. That is the
 * right shape for prompt injection but the wrong shape for a readable history. This
 * module is the smallest compatible addition: it persists the SAME turns at the SAME
 * call sites in provider.ts, but with the complete original content, so the Conversations
 * panel shows what was actually said — never a summary, never truncated.
 *
 * - Source of truth is the live turn pipeline (provider.ts), not a disconnected recorder.
 * - Legacy compact entries already stored by session.json are surfaced honestly and
 *   marked `legacy`; nothing is invented for text that was never kept.
 * - Interrupted and failed turns are recorded too, with their error — history must not
 *   silently drop conversations that did not end perfectly.
 */

const HISTORY_FILE = path.join(FILES_ROOT, 'conversations.json');
const MAX_TURNS = 400;
const MAX_BYTES = 4 * 1024 * 1024;

export type { HistoryTurn };

let cache: HistoryTurn[] | null = null;
let fileOverride: string | null = null;

const file = (): string => fileOverride ?? HISTORY_FILE;

async function loadTurns(): Promise<HistoryTurn[]> {
  if (cache) return cache;
  const parsed = await loadJson<unknown>(file(), []);
  // Shape-check every entry (schema drift or a hand-edited file must never throw here).
  cache = (Array.isArray(parsed) ? parsed : []).filter(
    (e): e is HistoryTurn =>
      !!e && typeof e === 'object' &&
      typeof (e as HistoryTurn).t === 'number' &&
      typeof (e as HistoryTurn).user === 'string' &&
      typeof (e as HistoryTurn).reply === 'string' &&
      Array.isArray((e as HistoryTurn).actions)
  );
  return cache;
}

/** Append one finished turn with its FULL original content. Best-effort: never breaks a turn. */
export async function appendConversationTurn(e: { user: string; actions: string[]; reply: string; error?: string }): Promise<void> {
  try {
    const turns = await loadTurns();
    const turn: HistoryTurn = {
      t: Date.now(),
      user: String(e.user ?? ''),
      actions: Array.isArray(e.actions) ? e.actions.slice(0, 30) : [],
      reply: String(e.reply ?? ''),
      ...(e.error ? { error: String(e.error) } : {}),
    };
    // Skip duplicates: a retried turn lands milliseconds (not the same millisecond) after
    // the first write. Identical content within 2s of the LAST entry is one turn — a genuine
    // re-ask can never look like this (a reply takes longer than 2s to produce).
    const last = turns[turns.length - 1];
    const dup =
      last &&
      last.user === turn.user &&
      last.reply === turn.reply &&
      (last.error ?? '') === (turn.error ?? '') &&
      turn.t - last.t >= 0 &&
      turn.t - last.t <= 2000;
    if (dup) return;
    turns.push(turn);
    await persist(trimmed(turns));
  } catch (err) {
    console.warn('[history] failed to persist the conversation turn:', err instanceof Error ? err.message : err);
  }
}

/** Cap by count and by bytes: the oldest turns go first, the newest are always kept. */
function trimmed(turns: HistoryTurn[]): HistoryTurn[] {
  let out = turns.slice(-MAX_TURNS);
  while (out.length > 1 && JSON.stringify(out).length > MAX_BYTES) out = out.slice(1);
  return out;
}

async function persist(turns: HistoryTurn[]): Promise<void> {
  cache = turns;
  await fs.mkdir(path.dirname(file()), { recursive: true });
  await atomicWrite(file(), JSON.stringify(turns));
}

const stripEllipsis = (s: string): string => (s.endsWith('…') ? s.slice(0, -1) : s);

/**
 * Everything readable in the Conversations panel: full-fidelity turns (newest last)
 * plus the legacy compact entries from session.json that are not already covered.
 * Legacy entries keep their own timestamps and are marked `legacy: true`.
 */
export async function listConversations(): Promise<HistoryTurn[]> {
  const turns = await loadTurns();
  try {
    const legacy = await getSessionTurnsForHistory();
    const sameTurn = (a: HistoryTurn, b: { t: number; user: string }): boolean => {
      if (Math.abs(a.t - b.t) > 2000) return false;
      const head = stripEllipsis(b.user).slice(0, 120);
      return head.length > 0 && (a.user === b.user || a.user.startsWith(head));
    };
    const missing = legacy.filter((l) => !turns.some((t) => sameTurn(t, l)));
    return [...turns, ...missing.map((m) => ({ ...m, legacy: true }))].sort((a, b) => a.t - b.t);
  } catch {
    return [...turns].sort((a, b) => a.t - b.t);
  }
}

/** Test hook: point the store at a scratch file (or null to restore the default). */
export const setHistoryFileForTests = (f: string | null): void => {
  fileOverride = f;
  cache = null;
};
