import { beforeEach, describe, expect, it } from 'vitest';
import { memoryTools } from '../src/main/memory';

const { list_memories, remember, save_contact, find_contact, forget, add_recurring_task } = memoryTools;

const run = (t: { run: (args: Record<string, unknown>) => Promise<string> | string }, args: Record<string, unknown>) => t.run(args);

describe('memory tools', () => {
  beforeEach(async () => {
    // Clean slate: forget everything (needle '.' matches most labels; forget caps at 3 per call).
    for (let i = 0; i < 20; i++) {
      try {
        await run(forget, { text: `cleanup-probe-${i}` });
      } catch {
        /* nothing saved */
      }
    }
  });

  it('remembers a fact once and reports duplicates instead of double-saving', async () => {
    expect(await run(remember, { fact: 'cleanup-probe-1 likes tea' })).toMatch(/Saved/);
    expect(await run(remember, { fact: 'cleanup-probe-1 likes tea' })).toMatch(/Already remembered/);
    const list = await run(list_memories, {});
    expect(list).toContain('cleanup-probe-1 likes tea');
  });

  it('strengthens a repeated habit with a count', async () => {
    await run(remember, { fact: 'cleanup-probe-2 wakes at six', category: 'habit' });
    const again = await run(remember, { fact: 'cleanup-probe-2 wakes at six', category: 'habit' });
    expect(again).toMatch(/2 times/);
  });

  it('saves and updates a contact by name without duplicating', async () => {
    expect(await run(save_contact, { name: 'Probe Person', phone: '123' })).toMatch(/saved/);
    expect(await run(save_contact, { name: 'Probe Person', email: 'p@test.dev' })).toMatch(/updated/);
    const hits = await run(find_contact, { query: 'Probe Person' });
    expect(hits).toContain('123');
    expect(hits).toContain('p@test.dev');
    const lines = hits.split('\n');
    expect(lines).toHaveLength(1); // one contact, updated
  });

  it('finds contacts by relationship too', async () => {
    await run(save_contact, { name: 'Probe Relative', relation: 'boss' });
    expect(await run(find_contact, { query: 'boss' })).toContain('Probe Relative');
  });

  it('refuses to forget when nothing matches or the match is too broad', async () => {
    await expect(run(forget, { text: 'no-such-thing-xyz' })).rejects.toThrow(/No saved memory matches/);
    await run(remember, { fact: 'cleanup-probe-3 a' });
    await run(remember, { fact: 'cleanup-probe-3 b' });
    await run(remember, { fact: 'cleanup-probe-3 c' });
    await run(remember, { fact: 'cleanup-probe-3 d' });
    await expect(run(forget, { text: 'cleanup-probe-3' })).rejects.toThrow(/matches 4 memories/);
  });

  it('forgets exactly the matching memory', async () => {
    await run(remember, { fact: 'cleanup-probe-4 unique pineapples' });
    expect(await run(forget, { text: 'pineapples' })).toMatch(/Forgot 1/);
    expect(await run(list_memories, {})).not.toContain('pineapples');
  });

  it('saves and updates recurring tasks', async () => {
    expect(await run(add_recurring_task, { task: 'cleanup-probe-5 report', schedule: 'every Friday 5 PM' })).toMatch(/saved/);
    expect(await run(add_recurring_task, { task: 'cleanup-probe-5 report', schedule: 'every Monday 9 AM' })).toMatch(/updated/);
  });

  it('rejects empty facts and requires both task and schedule', async () => {
    await expect(run(remember, { fact: '   ' })).rejects.toThrow(/Nothing to remember/);
    await expect(run(add_recurring_task, { task: 'x' })).rejects.toThrow(/task and when/);
  });

  it('lists by category', async () => {
    await run(save_contact, { name: 'Probe Categorised' });
    const contacts = await run(list_memories, { category: 'contact' });
    expect(contacts).toContain('Probe Categorised');
    expect(contacts).not.toContain('category: fact');
  });

  it('exposes every tool in the memory set to the router', () => {
    for (const name of ['remember', 'save_contact', 'find_contact', 'add_recurring_task', 'list_memories', 'forget']) {
      expect(memoryTools[name]).toBeTruthy();
    }
  });
});
