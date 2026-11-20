import { readFileSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { fullStamp, groupConversations, preview, splitFences, stamp, CONVERSATION_GAP_MS } from '../src/renderer/lib/conversations';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const src = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

const turn = (t: number, user = 'question', reply = 'answer', extra: Record<string, unknown> = {}) => ({
  t,
  user,
  reply,
  actions: [] as string[],
  ...extra,
});

describe('conversation grouping', () => {
  it('keeps turns within the 10-minute window in one conversation, older first', () => {
    const base = Date.now();
    const groups = groupConversations([turn(base), turn(base + 5 * 60_000), turn(base + 9 * 60_000)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].turns).toHaveLength(3);
    expect(groups[0].turns.map((t) => t.t)).toEqual([base, base + 5 * 60_000, base + 9 * 60_000]);
  });

  it('starts a new conversation after a gap of 10 minutes or more', () => {
    const base = Date.now();
    const groups = groupConversations([turn(base), turn(base + CONVERSATION_GAP_MS)]);
    expect(groups).toHaveLength(2);
    expect(groups[0].end).toBe(base);
    expect(groups[1].start).toBe(base + CONVERSATION_GAP_MS);
  });

  it('sorts defensively: unsorted input still yields chronological groups', () => {
    const base = Date.now();
    const groups = groupConversations([turn(base + 60_000, 'second'), turn(base, 'first')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].turns[0].user).toBe('first');
  });

  it('handles an empty history', () => {
    expect(groupConversations([])).toEqual([]);
  });
});

describe('reply rendering — fences and previews', () => {
  it('passes plain text through as one block', () => {
    expect(splitFences('Just a normal answer.')).toEqual([{ code: false, content: 'Just a normal answer.', lang: '' }]);
  });

  it('splits fenced code with a language tag and keeps surrounding text', () => {
    const blocks = splitFences('Before.\n```python\nprint("hi")\n```\nAfter.');
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ code: false, content: 'Before.\n', lang: '' });
    expect(blocks[1]).toEqual({ code: true, content: 'print("hi")', lang: 'python' });
    expect(blocks[2]).toEqual({ code: false, content: '\nAfter.', lang: '' });
  });

  it('renders an unclosed fence as code to the end instead of swallowing the reply', () => {
    const blocks = splitFences('Intro\n```bash\nnpm test');
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({ code: true, content: 'npm test', lang: 'bash' });
  });

  it('handles multiple code blocks in one long reply', () => {
    const reply = 'A\n```js\nx()\n```\nB\n```ts\ny()\n```\nC';
    const blocks = splitFences(reply);
    expect(blocks.filter((b) => b.code)).toHaveLength(2);
    expect(blocks[blocks.length - 1].content).toBe('\nC');
  });

  it('previews the first meaningful line only', () => {
    expect(preview('\n\n  second line wins  \nthird')).toBe('second line wins');
    expect(preview('x'.repeat(200)).length).toBeLessThanOrEqual(161);
    expect(preview('short')).toBe('short');
  });
});

describe('timestamps', () => {
  it('shows time only for today, date and time otherwise', () => {
    const now = new Date(2026, 10, 5, 12, 0, 0); // Nov 5 2026, local
    const sameDay = new Date(2026, 10, 5, 9, 14, 0).getTime();
    const otherDay = new Date(2026, 9, 1, 9, 14, 0).getTime(); // Oct 1
    expect(stamp(sameDay, now)).toBe('09:14');
    expect(stamp(otherDay, now)).toBe('Oct 1 · 09:14');
    expect(fullStamp(sameDay)).toMatch(/Nov 5, 2026 · 09:14:00/);
  });
});

describe('round 15 source guards — the layout fix and the panel stay wired', () => {
  it('the header reserves the native overlay width via env(titlebar-area-*)', () => {
    const css = src('src/renderer/index.css');
    expect(css).toMatch(/padding-right:\s*calc\(100vw - env\(titlebar-area-width/);
    // The old fixed reserves must be gone from the header element.
    const win = src('src/renderer/components/JarvisWindow.tsx');
    expect(win).not.toMatch(/pr-40/);
    expect(win).not.toMatch(/pr-36/);
  });

  it('the header control cluster has fixed, non-shrinking hit targets', () => {
    const win = src('src/renderer/components/JarvisWindow.tsx');
    expect(win).toMatch(/ml-auto flex items-center gap-1/);
    expect(win).toMatch(/grid h-7 w-7 place-items-center/);
    // The compact history entry is now labelled "History" and opens the conversations panel.
    expect(win).toContain("label: 'History'");
    expect(win).toMatch(/setPanel\('conversations'\)/);
  });

  it('the Conversations panel registers as a modal (Esc must not cancel a running turn)', () => {
    const panel = src('src/renderer/components/ConversationsPanel.tsx');
    expect(panel).toMatch(/pushModal\(\)/);
    expect(panel).toMatch(/popModal\(\)/);
  });

  it('the full-fidelity history is wired: provider records, main serves, preload exposes', () => {
    expect(src('src/main/provider.ts')).toMatch(/appendConversationTurn/);
    expect(src('src/main/index.ts')).toMatch(/ipcMain\.handle\('history-list'/);
    expect(src('src/preload/index.ts')).toMatch(/history:\s*\{\s*list:/);
    expect(src('types/electron.d.ts')).toMatch(/history:\s*\{[\s\S]*list: \(\) => Promise<HistoryTurn\[\]>;\s*\}/s);
  });
});
