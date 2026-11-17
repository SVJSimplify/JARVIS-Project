import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, safeStorage: { isEncryptionAvailable: () => false } }));

import { getProgressSnapshot, initProgress, isRelatedRequest, noteActivity, noteTurnEnd, noteTurnStart, onProgress, resetProgressForTests } from '../../src/main/progress';
import { bodyRetryHintMs, transientMessage } from '../../src/main/llm';

describe('task progress resets by relevance', () => {
  beforeEach(() => {
    resetProgressForTests();
    initProgress({});
  });

  it('a follow-up keeps the checklist; an unrelated request clears it', () => {
    noteTurnStart('open youtube and find vinicius junior highlights');
    noteActivity({ kind: 'tool', cid: 'a', label: 'browser_open', status: 'ok' });
    noteTurnEnd({});
    noteTurnStart('now click the first video');
    expect(getProgressSnapshot().turn?.steps.length).toBe(1);
    noteTurnEnd({});
    noteTurnStart('summarise my downloads folder');
    expect(getProgressSnapshot().turn?.steps.length).toBe(0);
  });

  it('word overlap and time window decide relatedness', () => {
    const now = Date.now();
    expect(isRelatedRequest({ task: 'build the vinicius highlights playlist', startedAt: now }, 'add more vinicius highlights', now)).toBe(true);
    expect(isRelatedRequest({ task: 'build the vinicius highlights playlist', startedAt: now - 3_600_000 }, 'also add more', now)).toBe(false);
    expect(isRelatedRequest(null, 'anything')).toBe(false);
  });

  it('listeners receive the same snapshot as the HUD', () => {
    const seen: number[] = [];
    const off = onProgress((s) => seen.push(s.turn?.steps.length ?? -1));
    noteTurnStart('task');
    noteActivity({ kind: 'tool', cid: 'x', label: 'read_file', status: 'busy' });
    off();
    expect(seen).toEqual([0, 1]);
  });
});

describe('provider transient errors', () => {
  const body = '{"error":{"message":"[codex/gpt-6-luna] [502]: fetch failed (cause: ERR_HTTP2_INVALID_SESSION: The session has been destroyed) (reset after 20s)"}}';
  it('honours the relay reset hint (capped)', () => {
    expect(bodyRetryHintMs(body)).toBe(20_000);
    expect(bodyRetryHintMs('retry after 90 seconds')).toBe(25_000);
    expect(bodyRetryHintMs('nothing')).toBe(0);
  });
  it('explains an upstream drop in plain words', () => {
    const m = transientMessage(503, body, 4);
    expect(m).toMatch(/lost its connection/);
    expect(m).not.toMatch(/\{"error"/);
  });
});

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendConversationTurn, chatTurns, createChat, deleteChat, getActiveChatId, getChatContextPrompt, listChats, renameChat, setActiveChat, setHistoryFileForTests } from '../../src/main/history';

describe('chats', () => {
  beforeEach(() => {
    const d = mkdtempSync(join(tmpdir(), 'jini-chats-'));
    setHistoryFileForTests(join(d, 'conversations.json'), join(d, 'chats.json'));
  });

  it('keeps turns and context separate per chat', async () => {
    const a = await createChat();
    await appendConversationTurn({ user: 'plan my trip to goa', actions: [], reply: 'ok' });
    const b = await createChat();
    await appendConversationTurn({ user: 'fix the login bug', actions: [], reply: 'done' });
    expect((await chatTurns(a.id)).map((t) => t.user)).toEqual(['plan my trip to goa']);
    expect(await getChatContextPrompt(b.id)).toMatch(/login bug/);
    expect(await getChatContextPrompt(b.id)).not.toMatch(/goa/);
    const list = await listChats();
    expect(list.find((c) => c.id === a.id)?.title).toBe('plan my trip to goa');
    await setActiveChat(a.id);
    expect(await getActiveChatId()).toBe(a.id);
    await renameChat(a.id, 'Goa');
    expect((await listChats()).find((c) => c.id === a.id)?.title).toBe('Goa');
    await deleteChat(a.id);
    expect(await chatTurns(a.id)).toEqual([]);
    expect(await getActiveChatId()).not.toBe(a.id);
  });
});
