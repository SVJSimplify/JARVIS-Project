/**
 * THE NO-DEAD-END GUARANTEE (the "This visual could not be built — no blocks" bug).
 *
 * Every payload shape a model has ever invented for show_visual must come out of the
 * repair layer as a RENDERABLE visual — or, if there is truly nothing in it, the tool
 * must refuse at staging time so a dead panel never reaches the screen. These tests
 * pin both ends: renderer-side (never null) and staging-side (empty is rejected).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/hud', () => ({
  attentionHud: () => undefined,
  isMini: () => false,
  sendToHud: vi.fn(),
  setMini: () => undefined,
}));
vi.mock('../src/main/modes', () => ({ emitActivity: vi.fn() }));

import { sendToHud } from '../src/main/hud';
import { visualTools } from '../src/main/visual';
import { bodyFor } from '../src/renderer/components/VisualCard';
import { normalizeForStaging, normalizeVisual, renderVisual } from '../src/renderer/lib/visualIR';

/** Any input must normalize to a renderable IR whose HTML is real content. */
const expectRenderable = (input: unknown): void => {
  const { ir } = normalizeVisual(input);
  expect(ir.blocks.length).toBeGreaterThanOrEqual(1);
  const html = renderVisual(ir);
  expect(html.trim().length).toBeGreaterThan(0);
  expect(html).not.toContain('could not be built');
  expect(html).not.toContain('Not rendered');
};

describe('repair pass: every legacy and mangled payload renders', () => {
  it('previous-generation IR schema (cards/tables/charts/timeline/comparison/summary)', () => {
    expectRenderable({
      subtitle: 'older schema',
      cards: [{ k: 'Speed', v: '42' }, { k: 'Range', v: '300 km' }],
      tables: [{ columns: ['A', 'B'], rows: [['1', '2']] }],
      charts: [{ title: 'Share', items: [{ label: 'X', value: 60 }, { label: 'Y', value: 40 }] }],
      timeline: [{ when: '2019', what: 'launch' }, '2020 growth'],
      comparison: { A: { points: [{ k: 'price', v: '₹1' }] }, B: { points: [{ k: 'price', v: '₹2' }] } },
      summary: 'the bottom line',
    });
  });

  it('JSON-encoded blocks string (model double-encoded)', () => {
    expectRenderable(JSON.stringify({ blocks: [{ type: 'stats', items: [{ k: 'A', v: '1' }] }] }));
    expectRenderable(JSON.stringify([{ type: 'note', text: 'hello' }]));
  });

  it('plain prose and arrays instead of a blocks object', () => {
    expectRenderable('Just a sentence the model wanted to show.');
    expectRenderable(['first paragraph', 'second paragraph']);
    expectRenderable([{ type: 'note', text: 'direct array of blocks' }]);
  });

  it('a single block object without the array wrapper', () => {
    expectRenderable({ title: 'T', type: 'table', columns: ['N'], rows: [['x']] });
    const { ir } = normalizeVisual({ type: 'stats', items: [{ k: 'A', v: '1' }] });
    expect(ir.blocks[0]).toMatchObject({ type: 'stats' });
  });

  it('typed object maps: {stats: {...}, note: {...}}', () => {
    expectRenderable({
      subtitle: 'map shape',
      stats: { items: [{ k: 'Users', v: '1.2M' }] },
      note: { text: 'mapped shape works' },
      bars: [{ label: 'a', value: 3 }, { label: 'b', value: 7 }],
    });
  });

  it('items given as an object map instead of an array', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'stats', items: { Speed: '42', Range: '300' } }] });
    expect(ir.blocks[0]).toMatchObject({ type: 'stats', items: [{ k: 'Speed', v: '42' }, { k: 'Range', v: '300' }] });
    const kv = normalizeVisual({ blocks: [{ type: 'kv', Colour: 'Cyan', Size: 'L' }] });
    expect(kv.ir.blocks[0]).toMatchObject({ type: 'kv' });
  });

  it('rows as objects: columns derived from keys', () => {
    const { ir } = normalizeVisual({
      blocks: [{ type: 'table', rows: [{ name: 'A', price: '₹1' }, { name: 'B', price: '₹2' }] }],
    });
    const block = ir.blocks[0] as { type: string; columns: { label: string }[]; rows: string[][] };
    expect(block.type).toBe('table');
    expect(block.columns.map((c) => c.label)).toEqual(['name', 'price']);
    expect(block.rows).toEqual([['A', '₹1'], ['B', '₹2']]);
  });

  it('bars without numbers degrade to a list, not to nothing', () => {
    const { ir, warnings } = normalizeVisual({ blocks: [{ type: 'bars', items: [{ label: 'alpha' }, 'beta'] }] });
    expect(warnings.join(' ')).toContain('shown as a list');
    expect(ir.blocks[0]).toMatchObject({ type: 'list' });
  });

  it('bars from an object map {A: 70, B: 30}', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'chart', data: { A: 70, B: 30 } }] });
    expect(ir.blocks[0]).toMatchObject({ type: 'bars', items: [{ label: 'A', value: 70 }, { label: 'B', value: 30 }] });
  });

  it('single-option compare degrades to key values', () => {
    const { ir, warnings } = normalizeVisual({ blocks: [{ type: 'compare', options: [{ name: 'Only', points: [{ k: 'p', v: '1' }] }] }] });
    expect(warnings.join(' ')).toContain('single-option compare');
    expect(ir.blocks[0]).toMatchObject({ type: 'kv' });
  });

  it('synonym block types all resolve', () => {
    const { ir } = normalizeVisual({
      blocks: [
        { type: 'metrics', items: [{ label: 'M', value: '1' }] },
        { type: 'bullets', items: ['a', 'b'] },
        { type: 'steps', sequence: ['s1', 's2'] },
        { type: 'events', items: [{ date: '2020', description: 'x' }] },
        { type: 'keyvalue', properties: [{ k: 'k', v: 'v' }] },
        { type: 'callout', message: 'careful' },
        { type: 'paragraphs', items: ['para one', 'para two'] },
        { type: 'chips', labels: ['x', 'y'] },
      ],
    });
    expect(ir.blocks.map((b) => b.type)).toEqual(['stats', 'list', 'flow', 'timeline', 'kv', 'note', 'text', 'tags']);
  });

  it('unknown types alone are salvaged into readable text', () => {
    const { ir, warnings } = normalizeVisual({ blocks: [{ type: 'carousel', title: 'Gallery', caption: 'six photos of the trek' }] });
    expect(warnings.join(' ')).toContain('unknown block type');
    expect(ir.blocks.length).toBeGreaterThanOrEqual(1);
    expect(renderVisual(ir)).toContain('six photos of the trek');
  });

  it('a fully hostile payload still renders something honest', () => {
    expectRenderable(Symbol('x') as unknown);
    expectRenderable(() => 'fn' as unknown);
    expectRenderable({ blocks: [undefined, null, 3] });
  });

  it('the renderer fallback (no blocks, no html) shows the heading, never an error frame', () => {
    const html = bodyFor({ id: 1, title: 'Quarterly brief', restoreMini: false });
    expect(html).toContain('Quarterly brief');
    expect(html).not.toContain('could not be built');
    expect(html).not.toContain('Not rendered');
    expect(html).toContain('Content-Security-Policy');
  });

  it('even the worst blocks payload renders via bodyFor with zero dead-end strings', () => {
    for (const payload of [null, 'nope', {}, { blocks: 'x' }, [1, 2, 3]]) {
      const html = bodyFor({ id: 2, title: 'T', blocks: payload, restoreMini: false });
      expect(html).not.toContain('could not be built');
      expect(html).not.toContain('Not rendered');
      expect(html.length).toBeGreaterThan(500); // a real framed document, not an error stub
    }
  });
});

describe('normalizeForStaging: the tool rejects only true emptiness', () => {
  it('returns null ONLY for payloads with nothing at all in them', () => {
    for (const empty of [null, undefined, '', '   ', [], {}, { blocks: [] }, { blocks: {} }, { blocks: ['  ', ''] }]) {
      const { ir } = normalizeForStaging(empty);
      expect(ir).toBeNull();
    }
  });

  it('returns a renderable IR for every shape a model might send', () => {
    for (const shape of [
      'text',
      [{ type: 'note', text: 'x' }],
      { type: 'text', body: 'x' },
      { cards: [{ k: 'a', v: '1' }] },
      { blocks: { stats: { items: [{ k: 'a', v: '1' }] } } },
      JSON.stringify({ blocks: [{ type: 'list', items: ['a'] }] }),
    ]) {
      const { ir } = normalizeForStaging(shape);
      expect(ir).not.toBeNull();
      expect(ir!.blocks.length).toBeGreaterThanOrEqual(1);
    }
  });
});

/** Projected runs deliver on a macrotask (mini-expand choreography); give the timer a tick. */
const flush = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 10));
};

describe('show_visual end to end: no dead panel can ever reach the screen', () => {
  const stage = async (args: Record<string, unknown>): Promise<string> =>
    visualTools.show_visual.run(args) as Promise<string>;

  it('projects a legacy-schema payload repaired into canonical blocks', async () => {
    vi.mocked(sendToHud).mockClear();
    const out = await stage({
      title: 'Legacy',
      cards: [{ k: 'Speed', v: '42' }],
      charts: [{ items: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] }],
    });
    expect(out).toContain('on screen now');
    await flush();
    const payload = vi.mocked(sendToHud).mock.calls[0][1] as { blocks: { type: string }[] };
    expect(payload.blocks.map((b) => b.type)).toEqual(['stats', 'bars']);
  });

  it('reports genuine repairs in the tool result so the model learns', async () => {
    vi.mocked(sendToHud).mockClear();
    const out = await stage({
      title: 'Repaired',
      blocks: [{ type: 'carousel', caption: 'junk block' }, { type: 'bars', items: [{ label: 'a' }, { label: 'b' }] }, { type: 'note', text: 'kept' }],
    });
    expect(out).toContain('content repaired');
    expect(out).toContain('unknown block type');
    await flush();
    const payload = vi.mocked(sendToHud).mock.calls[0][1] as { blocks: { type: string }[] };
    expect(payload.blocks.map((b) => b.type)).toEqual(['list', 'note']); // bars→list repair, unknown dropped, note kept
  });

  it('refuses an empty payload with guidance instead of projecting an empty panel', async () => {
    vi.mocked(sendToHud).mockClear();
    await expect(stage({ title: 'Empty', blocks: [] })).rejects.toThrow(/nothing renderable/);
    await expect(stage({ title: 'Empty', blocks: '' })).rejects.toThrow(/nothing renderable/);
    // nothing was projected: the HUD must never have been touched
    expect(vi.mocked(sendToHud)).not.toHaveBeenCalled();
  });

  it('what is projected survives the renderer re-validation unchanged', async () => {
    vi.mocked(sendToHud).mockClear();
    await stage({ title: 'Round trip', subtitle: 'S', blocks: [{ type: 'table', rows: [{ a: 1, b: 2 }] }] });
    await flush();
    const payload = vi.mocked(sendToHud).mock.calls[0][1] as { blocks: unknown };
    const re = normalizeVisual(payload.blocks);
    expect(re.ir.blocks[0]).toMatchObject({ type: 'table' });
    expect(re.warnings).toEqual([]); // already canonical: the renderer repairs nothing
    expect(renderVisual(re.ir)).toContain('<table>');
  });
});
