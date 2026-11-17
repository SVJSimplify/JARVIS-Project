import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/hud', () => ({
  attentionHud: () => undefined,
  isMini: () => false,
  sendToHud: vi.fn(),
  setMini: () => undefined,
}));
vi.mock('../src/main/modes', () => ({ emitActivity: vi.fn() }));

import { sendToHud } from '../src/main/hud';
import { visualTools } from '../src/main/visual';
import { sanitizeVisualHtml } from '../src/main/visualSanitize';
import { HOLO_CSS, VISUAL_CSP, visualFrameDoc } from '../src/renderer/lib/holoKit';
import { esc, normalizeVisual, renderVisual, sanitizeSvg } from '../src/renderer/lib/visualIR';

describe('sanitizeVisualHtml', () => {
  it('strips script blocks and void script tags', () => {
    const r = sanitizeVisualHtml('<p>a</p><script>alert(1)</script><script src="x"/><p>b</p>');
    expect(r.html).toBe('<p>a</p><p>b</p>');
    expect(r.stripped).toContain('<script> block');
  });

  it('strips embedding tags, srcdoc and event handlers', () => {
    const r = sanitizeVisualHtml('<iframe src="https://x"></iframe><div onclick="p()" onmouseover=\'q()\'>hi</div>');
    expect(r.html).toBe('<div>hi</div>');
    expect(r.stripped).toContain('embedding tag');
    expect(r.stripped).toContain('inline event handler');
  });

  it('kills javascript: URLs in every quoting shape', () => {
    const r = sanitizeVisualHtml('<a href="javascript:alert(1)">x</a><svg><a xlink:href=\'javascript:alert(2)\'/></svg>');
    expect(r.html.toLowerCase()).not.toContain('javascript:');
    expect(r.stripped).toContain('javascript: URL');
  });

  it('keeps benign markup and inline styles intact', () => {
    const src = '<div style="width:40%"><span class="v">42</span></div>';
    expect(sanitizeVisualHtml(src).html).toBe(src);
  });

  it('reports nothing removed for clean input', () => {
    expect(sanitizeVisualHtml('<p>fine</p>').stripped).toEqual([]);
  });
});

describe('normalizeVisual', () => {
  it('degrades empty payloads to an honest note instead of a dead-end', () => {
    for (const payload of [null, undefined, {}, { blocks: [] }, { blocks: '' }, '']) {
      const { ir, warnings } = normalizeVisual(payload);
      expect(ir.blocks).toHaveLength(1);
      expect(ir.blocks[0].type).toBe('note');
      expect(warnings.join(' ')).toContain('no renderable content');
    }
  });

  it('turns raw strings and numbers into a text block', () => {
    expect(normalizeVisual('plain words').ir.blocks[0]).toMatchObject({ type: 'text', body: 'plain words' });
    expect(normalizeVisual(42).ir.blocks[0]).toMatchObject({ type: 'text', body: '42' });
  });

  it('accepts a valid stats block with optional fields', () => {
    const { ir, warnings } = normalizeVisual({ subtitle: 'Q3', blocks: [{ type: 'stats', items: [{ k: 'Speed', v: 42, unit: 'mph', hint: 'measured', tone: 'ok' }] }] });
    expect(warnings).toEqual([]);
    expect(ir?.subtitle).toBe('Q3');
    expect(ir?.blocks[0]).toEqual({ type: 'stats', items: [{ k: 'Speed', v: '42', unit: 'mph', hint: 'measured', tone: 'ok' }] });
  });

  it('drops stats items missing a key or value', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'stats', items: [{ k: '', v: '1' }, { k: 'a', v: '' }, { k: 'keep', v: 'x' }] }] });
    expect(ir?.blocks[0]).toEqual({ type: 'stats', items: [{ k: 'keep', v: 'x', unit: undefined, hint: undefined, tone: undefined }] });
  });

  it('accepts kv as an alias shape with label/value', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'kv', items: [{ label: 'Colour', value: 'Cyan' }] }] });
    expect(ir?.blocks[0]).toEqual({ type: 'kv', items: [{ k: 'Colour', v: 'Cyan', tone: undefined }] });
  });

  it('coerces bar values, keeps valid display text, drops NaN', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'bars', items: [{ label: 'A', value: '70' }, { label: 'B', value: 'nope' }, { label: 'C', value: 12.5, text: '12.5' }] }] });
    const block = ir?.blocks[0] as { type: string; items: { label: string; value: number }[]; max: number };
    expect(block.items).toHaveLength(2);
    expect(block.items[0]).toMatchObject({ label: 'A', value: 70 });
    expect(block.max).toBe(100); // max(items, 100)
  });

  it('honours an explicit bars max', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'bars', max: 500, items: [{ label: 'A', value: 250 }] }] });
    expect((ir?.blocks[0] as { max: number }).max).toBe(500);
  });

  it('normalises table columns, alignment and rows', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'table', columns: ['Name', { label: 'Price', align: 'RIGHT' }, { label: '', align: 'left' }], rows: [['a', 'b', 'c'], ['only-one'], []] }] });
    const block = ir?.blocks[0] as { columns: { label: string; align?: string }[]; rows: string[][] };
    expect(block.columns).toEqual([{ label: 'Name', align: undefined }, { label: 'Price', align: 'right' }]);
    expect(block.rows).toEqual([['a', 'b'], ['only-one']]);
  });

  it('repairs a table without columns from the row width', () => {
    const { ir, warnings } = normalizeVisual({ blocks: [{ type: 'table', columns: [], rows: [['a']] }] });
    expect((ir.blocks[0] as { columns: { label: string }[] }).columns).toEqual([{ label: 'Col 1', align: undefined }]);
    expect(warnings.join(' ')).toContain('repaired: table had no columns');
  });

  it('repairs a single-step flow into a note and accepts plain strings', () => {
    const single = normalizeVisual({ blocks: [{ type: 'flow', steps: ['only'] }] });
    expect(single.warnings.join(' ')).toContain('single-step flow');
    expect(single.ir.blocks[0]).toMatchObject({ type: 'note', title: 'only', text: 'only' });
    const { ir } = normalizeVisual({ blocks: [{ type: 'flow', steps: ['Ask', { label: 'Answer', note: 'with sources' }] }] });
    expect(ir.blocks[0]).toEqual({ type: 'flow', steps: [{ label: 'Ask', note: undefined }, { label: 'Answer', note: 'with sources' }] });
  });

  it('maps timeline and list aliases', () => {
    const { ir } = normalizeVisual({ blocks: [
      { type: 'timeline', items: [{ k: '2019', v: 'launched' }] },
      { type: 'list', items: ['plain', { text: 'rich', tone: 'warn' }, { v: '' }] },
    ] });
    expect(ir?.blocks[0]).toEqual({ type: 'timeline', items: [{ when: '2019', what: 'launched' }] });
    expect(ir?.blocks[1]).toEqual({ type: 'list', items: [{ text: 'plain', tone: undefined }, { text: 'rich', tone: 'warn' }] });
  });

  it('requires two compare options and aliases points', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'compare', options: [{ name: 'A', points: [{ label: 'price', value: '₹1' }] }, { label: 'B', points: [{ k: 'weight', v: '206g' }] }] }] });
    expect(ir?.blocks[0]).toEqual({ type: 'compare', options: [
      { name: 'A', points: [{ k: 'price', v: '₹1' }] },
      { name: 'B', points: [{ k: 'weight', v: '206g' }] },
    ] });
  });

  it('defaults note tone to info and keeps title optional', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'note', text: 'watch the margin' }] });
    expect(ir?.blocks[0]).toEqual({ type: 'note', tone: 'info', title: undefined, text: 'watch the margin' });
  });

  it('renders text with optional heading; degrades an empty body to the honest note', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'text', heading: 'Why', body: 'para one\n\npara two' }] });
    expect(ir.blocks[0]).toEqual({ type: 'text', heading: 'Why', body: 'para one\n\npara two' });
    const empty = normalizeVisual({ blocks: [{ type: 'text', body: '  ' }] });
    expect(empty.warnings.join(' ')).toContain('dropped empty text block');
    expect(empty.ir.blocks[0].type).toBe('note');
  });

  it('sanitises svg blocks and salvages anything without an svg root', () => {
    const bad = normalizeVisual({ blocks: [{ type: 'svg', markup: '<div>x</div>' }] });
    expect(bad.warnings.join(' ')).toContain('without an <svg> root');
    // the raw markup is salvaged as escaped text rather than dead-ending
    expect(bad.ir.blocks[0].type).toBe('text');
    const { ir } = normalizeVisual({ blocks: [{ type: 'svg', markup: '<svg viewBox="0 0 4 4"><script>alert(1)</script><rect onclick="x()" width="4" height="4"/></svg>' }] });
    const markup = (ir.blocks[0] as { markup: string }).markup;
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('onclick');
  });

  it('drops unknown block types with a warning and keeps the rest', () => {
    const { ir, warnings } = normalizeVisual({ blocks: [{ type: 'carousel' }, { type: 'stats', items: [{ k: 'a', v: '1' }] }] });
    expect(warnings.join(' ')).toContain('unknown block type');
    expect(ir?.blocks).toHaveLength(1);
  });

  it('caps blocks at 24', () => {
    const many = Array.from({ length: 30 }, () => ({ type: 'note', text: 'x' }));
    const { ir, warnings } = normalizeVisual({ blocks: many });
    expect(ir?.blocks).toHaveLength(24);
    expect(warnings.join(' ')).toContain('capped at 24');
  });
});

describe('renderVisual', () => {
  it('escapes hostile text everywhere', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'stats', items: [{ k: '<script>x</script>', v: '"><img>' }] }] });
    const html = renderVisual(ir!);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img&gt;');
  });

  it('renders bars with clamped widths and display values', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'bars', items: [{ label: 'A', value: 250, display: '250 units' }, { label: 'B', value: 0 }] }] });
    const html = renderVisual(ir!);
    expect(html).toContain('style="width:100%"');
    expect(html).toContain('style="width:2%"');
    expect(html).toContain('250 units');
  });

  it('renders tables with header, alignment classes and wrapper', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'table', columns: [{ label: 'N' }, { label: 'P', align: 'right' }], rows: [['a', 'b']] }] });
    const html = renderVisual(ir!);
    expect(html).toMatch(/^<div class="tablewrap"><table><thead><tr><th>N<\/th><th class="al-right">P<\/th><\/tr><\/thead><tbody><tr><td>a<\/td><td class="al-right">b<\/td><\/tr><\/tbody><\/table><\/div>$/);
  });

  it('renders flow with arrows between nodes', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'flow', steps: ['a', 'b', 'c'] }] });
    const html = renderVisual(ir!);
    expect(html.match(/class="arrow"/g)).toHaveLength(2);
    expect(html.match(/class="node"/g)).toHaveLength(3);
  });

  it('renders compare with a column count variable', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'compare', options: [
      { name: 'A', points: [{ k: 'p', v: '1' }] },
      { name: 'B', points: [{ k: 'p', v: '2' }] },
    ] }] });
    expect(renderVisual(ir!)).toContain('style="--cols:2"');
  });

  it('renders text paragraphs from blank-line splits', () => {
    const { ir } = normalizeVisual({ blocks: [{ type: 'text', heading: 'H', body: 'one\n\ntwo' }] });
    const html = renderVisual(ir!);
    expect(html).toContain('<h2>H</h2>');
    expect(html.match(/<p>/g)).toHaveLength(2);
  });

  it('esc() makes everything inert', () => {
    expect(esc('<b class="x">\'&"')).toBe('&lt;b class=&quot;x&quot;&gt;&#39;&amp;&quot;');
  });
});

describe('show_visual tool', () => {
  beforeEach(() => {
    vi.mocked(sendToHud).mockClear();
  });

  const stage = async (args: Record<string, unknown>): Promise<string> =>
    visualTools.show_visual.run(args) as Promise<string>;
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10)); // projection rides a macrotask

  it('accepts blocks-only and reports the visual as already on screen', async () => {
    const out = await stage({ title: 'T', subtitle: 'S', blocks: [{ type: 'stats', items: [{ k: 'a', v: '1' }] }] });
    expect(out).toContain('on screen now');
    expect(out.toLowerCase()).not.toContain('not on screen');
    await flush(); // drain the projection macrotask so it cannot leak into the next test
  });

  it('projects the normalized payload with id and restoreMini without any gate', async () => {
    await stage({ title: 'Payload', blocks: [{ type: 'note', text: 'hello' }] });
    await flush();
    expect(vi.mocked(sendToHud)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendToHud)).toHaveBeenCalledWith('jarvis-visual', expect.objectContaining({
      title: 'Payload',
      blocks: [{ type: 'note', tone: 'info', text: 'hello' }], // projected blocks are the NORMALIZED form
      restoreMini: false,
    }));
    const payload = vi.mocked(sendToHud).mock.calls[0][1] as Record<string, unknown>;
    expect(typeof payload.id).toBe('number');
  });

  it('sanitises the legacy html path before projecting', async () => {
    await stage({ title: 'X', html: '<p>ok</p><script>steal()</script>' });
    await flush();
    const payload = vi.mocked(sendToHud).mock.calls[0][1] as { html?: string };
    expect(payload.html).toBe('<p>ok</p>');
  });

  it('refuses to project nothing, with repair guidance', async () => {
    await expect(stage({ title: 'Empty' })).rejects.toThrow(/blocks \(preferred\) or html/);
    await expect(stage({ title: 'Empty', blocks: [] })).rejects.toThrow(/nothing renderable/);
    await expect(stage({ title: 'Empty', blocks: {} })).rejects.toThrow(/nothing renderable/);
    await expect(stage({ title: 'Empty', html: '   <script>x</script>   ' })).rejects.toThrow(/empty after sanitising/);
    expect(vi.mocked(sendToHud)).not.toHaveBeenCalled();
  });

  it('keeps the size caps and the title requirement', async () => {
    await expect(stage({ html: 'x' })).rejects.toThrow(/title is required/);
    await expect(stage({ title: 'Big', html: 'x'.repeat(60_001) })).rejects.toThrow(/limit is 60000/);
    await expect(stage({ title: 'Big', blocks: [{ type: 'note', text: 'y'.repeat(60_001) }] })).rejects.toThrow(/limit is 60000/);
  });
});

describe('holoKit frame contract', () => {
  it('ships the Jost faces, wrapping rules and empty-state hiding', () => {
    expect(HOLO_CSS.match(/@font-face/g)).toHaveLength(2);
    expect(HOLO_CSS).toContain('overflow-wrap:anywhere');
    expect(HOLO_CSS).toContain('.tablewrap');
    expect(HOLO_CSS).toContain(':empty{display:none');
  });

  it('runs NO code in the frame: no script-src, empty sandbox handled by the component', () => {
    expect(VISUAL_CSP).not.toContain('script-src');
    expect(VISUAL_CSP).toContain("default-src 'none'");
    expect(VISUAL_CSP).toContain('font-src data:');
  });

  it('wraps content in a CSP-strapped document', () => {
    const doc = visualFrameDoc('<p>hi</p>');
    expect(doc).toContain('Content-Security-Policy');
    expect(doc.endsWith('<p>hi</p></body></html>')).toBe(true);
  });
});
