import { promises as fs } from 'fs';
import * as path from 'path';
import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson } from './store';
import { getSessionTurnsForHistory } from './session';
import type { ChatInfo, HistoryTurn } from './protocol';

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

export type { ChatInfo, HistoryTurn };

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
export async function appendConversationTurn(e: { user: string; actions: string[]; reply: string; error?: string; chatId?: string }): Promise<void> {
  try {
    const turns = await loadTurns();
    const turn: HistoryTurn = {
      t: Date.now(),
      user: String(e.user ?? ''),
      actions: Array.isArray(e.actions) ? e.actions.slice(0, 30) : [],
      reply: String(e.reply ?? ''),
      ...(e.error ? { error: String(e.error) } : {}),
      chatId: e.chatId ?? (await getActiveChatId()),
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
    await touchChat(turn.chatId!, turn.user);
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

// ------------------------------------------------------------------ chats

/**
 * CHATS — separate conversation threads. The index (titles, timestamps) lives in
 * chats.json; turns stay in conversations.json tagged with chatId. Turns recorded
 * before chats existed belong to DEFAULT_CHAT. The active chat decides which thread a
 * new desktop turn joins and which thread's recent turns are given to the model.
 */
export const DEFAULT_CHAT = 'default';
const CHATS_FILE = path.join(FILES_ROOT, 'chats.json');
interface ChatIndex { active: string; chats: Array<Omit<ChatInfo, 'turns'>> }
let chatIndex: ChatIndex | null = null;
let chatsOverride: string | null = null;
const chatsFile = (): string => chatsOverride ?? CHATS_FILE;
const chatListeners = new Set<() => void>();
export const onChatsChanged = (fn: () => void): (() => void) => (chatListeners.add(fn), () => chatListeners.delete(fn));
const notifyChats = (): void => chatListeners.forEach((fn) => { try { fn(); } catch { /* listener errors never break storage */ } });

async function loadIndex(): Promise<ChatIndex> {
  if (chatIndex) return chatIndex;
  const raw = await loadJson<Partial<ChatIndex>>(chatsFile(), {});
  const chats = (Array.isArray(raw.chats) ? raw.chats : []).filter((c) => c && typeof c.id === 'string' && typeof c.title === 'string');
  chatIndex = { active: typeof raw.active === 'string' ? raw.active : DEFAULT_CHAT, chats };
  if (!chats.some((c) => c.id === DEFAULT_CHAT) && (await loadTurns()).some((t) => !t.chatId || t.chatId === DEFAULT_CHAT)) {
    const first = (await loadTurns())[0];
    chats.push({ id: DEFAULT_CHAT, title: 'Earlier conversations', createdAt: first?.t ?? Date.now(), updatedAt: Date.now() });
  }
  return chatIndex;
}

async function saveIndex(): Promise<void> {
  if (!chatIndex) return;
  await fs.mkdir(path.dirname(chatsFile()), { recursive: true });
  await atomicWrite(chatsFile(), JSON.stringify(chatIndex));
  notifyChats();
}

const titleFrom = (text: string): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? `${t.slice(0, 47).trimEnd()}…` : t || 'New chat';
};

async function touchChat(id: string, firstUser: string): Promise<void> {
  const idx = await loadIndex();
  let c = idx.chats.find((x) => x.id === id);
  if (!c) {
    c = { id, title: titleFrom(firstUser), createdAt: Date.now(), updatedAt: Date.now() };
    idx.chats.push(c);
  } else {
    if (c.title === 'New chat') c.title = titleFrom(firstUser);
    c.updatedAt = Date.now();
  }
  await saveIndex();
}

export async function getActiveChatId(): Promise<string> {
  return (await loadIndex()).active;
}

export async function listChats(): Promise<ChatInfo[]> {
  const idx = await loadIndex();
  const turns = await loadTurns();
  const count = new Map<string, number>();
  for (const t of turns) count.set(t.chatId ?? DEFAULT_CHAT, (count.get(t.chatId ?? DEFAULT_CHAT) ?? 0) + 1);
  return idx.chats.map((c) => ({ ...c, turns: count.get(c.id) ?? 0 })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createChat(title = 'New chat'): Promise<ChatInfo> {
  const idx = await loadIndex();
  const c = { id: `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, title: titleFrom(title), createdAt: Date.now(), updatedAt: Date.now() };
  idx.chats.push(c);
  idx.active = c.id;
  await saveIndex();
  return { ...c, turns: 0 };
}

export async function setActiveChat(id: string): Promise<void> {
  const idx = await loadIndex();
  if (!idx.chats.some((c) => c.id === id)) throw new Error('No such chat.');
  idx.active = id;
  await saveIndex();
}

export async function renameChat(id: string, title: string): Promise<void> {
  const idx = await loadIndex();
  const c = idx.chats.find((x) => x.id === id);
  if (!c) throw new Error('No such chat.');
  c.title = titleFrom(title);
  await saveIndex();
}

/** Deletes the chat AND its turns (the user asked for it; nothing else references them). */
export async function deleteChat(id: string): Promise<void> {
  const idx = await loadIndex();
  idx.chats = idx.chats.filter((c) => c.id !== id);
  const turns = await loadTurns();
  await persist(turns.filter((t) => (t.chatId ?? DEFAULT_CHAT) !== id));
  if (idx.active === id) idx.active = idx.chats.sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? (await createChat()).id;
  await saveIndex();
}

export async function chatTurns(id: string): Promise<HistoryTurn[]> {
  const all = id === DEFAULT_CHAT ? await listConversations() : await loadTurns();
  return all.filter((t) => (t.chatId ?? DEFAULT_CHAT) === id);
}

/** The model's view of THIS chat: its last few exchanges, so follow-ups stay in-thread. */
export async function getChatContextPrompt(id: string): Promise<string> {
  const turns = (await loadTurns()).filter((t) => (t.chatId ?? DEFAULT_CHAT) === id).slice(-6);
  if (!turns.length) return '';
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  return (
    'This chat so far (oldest first). Use it to resolve follow-ups ("it", "that", "again"); verify current state with tools before claiming anything:\n' +
    turns.map((t) => `- user: ${clip(t.user.replace(/\s+/g, ' '), 400)}\n  you: ${t.error ? `[failed: ${clip(t.error, 160)}]` : clip(t.reply.replace(/\s+/g, ' '), 500)}`).join('\n')
  );
}

/** Test hook: point the store at a scratch file (or null to restore the default). */
export const setHistoryFileForTests = (f: string | null, chats: string | null = null): void => {
  fileOverride = f;
  chatsOverride = chats;
  cache = null;
  chatIndex = null;
};
