import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// The history store surfaces legacy compact entries from session.json; mock that source
// so these tests control it directly and never touch a real session file.
const legacyTurns: Array<{ t: number; user: string; actions: string[]; reply: string; error?: string }> = [];
vi.mock('../src/main/session', () => ({
  getSessionTurnsForHistory: async () => legacyTurns.map((e) => ({ ...e })),
}));

import { appendConversationTurn, listConversations, setHistoryFileForTests } from '../src/main/history';

const dir = () => path.join(os.tmpdir(), `jarvis-history-${process.pid}`);

beforeEach(async () => {
  await fs.mkdir(dir(), { recursive: true });
  setHistoryFileForTests(path.join(dir(), 'conversations.json'));
  legacyTurns.length = 0;
});

afterEach(async () => {
  setHistoryFileForTests(null);
  await fs.rm(dir(), { recursive: true, force: true });
});

describe('conversation history store — full-fidelity persistence', () => {
  it('stores the COMPLETE user request and COMPLETE reply verbatim (the compact session log clips at 200/240)', async () => {
    const longUser = 'Research edge-AI accelerator announcements and write me the full comparison. '.repeat(8); // 720 chars
    const longReply = '## Accelerator landscape\n\n- Tenstorrent: **grayskull** details\n\n```python\nprint("benchmark suite")\n```\n\n' + 'Analysis paragraph with citations and figures. '.repeat(100); // > 4800 chars
    await appendConversationTurn({ user: longUser, actions: ['web_search FAILED', 'web_fetch'], reply: longReply });
    const all = await listConversations();
    expect(all).toHaveLength(1);
    expect(all[0].user).toBe(longUser);
    expect(all[0].user.length).toBe(longUser.length);
    expect(all[0].reply).toBe(longReply);
    expect(all[0].reply).toContain('```python');
    expect(all[0].reply.length).toBeGreaterThan(4000);
    expect(all[0].legacy).toBeUndefined();
  });

  it('records interrupted turns with their error instead of dropping them', async () => {
    await appendConversationTurn({ user: 'cancel that mid-way', actions: ['browser_open'], reply: '', error: 'interrupted' });
    const all = await listConversations();
    expect(all[0].error).toBe('interrupted');
    expect(all[0].reply).toBe('');
  });

  it('never stores the same turn twice', async () => {
    await appendConversationTurn({ user: 'hello', actions: [], reply: 'world' });
    await appendConversationTurn({ user: 'hello', actions: [], reply: 'world' });
    expect(await listConversations()).toHaveLength(1);
  });

  it('caps the log: the oldest turns go first, the newest always survive', async () => {
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < 405; i++) {
      const store = JSON.parse(await fs.readFile(path.join(dir(), 'conversations.json'), 'utf8').catch(() => '[]'));
      // append directly through the API but with distinct timestamps is impossible (Date.now),
      // so write the file progressively and let append add the newest — after 405 appends the cap holds.
      await appendConversationTurn({ user: `turn ${i}`, actions: [], reply: `reply ${i}` });
      void store;
      void base;
    }
    const all = await listConversations();
    expect(all.length).toBeLessThanOrEqual(400);
    expect(all[all.length - 1].user).toBe('turn 404'); // newest kept
    expect(all[0].user).toBe(`turn ${all.length === 400 ? 5 : 0}`); // oldest trimmed first
  });

  it('tolerates a corrupt store file and keeps working', async () => {
    await fs.writeFile(path.join(dir(), 'conversations.json'), '{not json at all', 'utf8');
    await appendConversationTurn({ user: 'after corruption', actions: [], reply: 'still works' });
    const all = await listConversations();
    expect(all).toHaveLength(1);
    expect(all[0].user).toBe('after corruption');
    expect(all[0].reply).toBe('still works');
  });
});

describe('conversation history store — legacy compact entries', () => {
  it('surfaces legacy session.json turns, marked, without duplicating live turns', async () => {
    const now = Date.now();
    // The live store records the same turn milliseconds after session.json does, so the
    // dedupe window (±2s) matches real dual-write timing; the genuinely-old entry stays.
    legacyTurns.push(
      { t: now - 5000, user: 'old compact question that was clipped at 200 chars and ends here…', actions: ['web_search'], reply: 'old compact reply, clipped at 240 chars…' },
      { t: now - 300, user: 'already captured live', actions: [], reply: 'captured' },
    );
    await appendConversationTurn({ user: 'already captured live', actions: [], reply: 'captured' });
    const all = await listConversations();
    const legacyOnes = all.filter((t) => t.legacy);
    expect(all).toHaveLength(2); // live turn + the one genuinely-old legacy entry
    expect(legacyOnes).toHaveLength(1); // the near-simultaneous duplicate was removed
    expect(legacyOnes[0].user).toContain('old compact question');
    expect(all.find((t) => !t.legacy)?.user).toBe('already captured live');
  });

  it('sorts the merged list chronologically', async () => {
    const now = Date.now();
    legacyTurns.push({ t: now - 9000, user: 'earliest legacy', actions: [], reply: 'a' });
    await appendConversationTurn({ user: 'middle live', actions: [], reply: 'b' });
    legacyTurns.push({ t: Date.now() + 9000, user: 'later legacy', actions: [], reply: 'c' });
    const all = await listConversations();
    const times = all.map((t) => t.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});
