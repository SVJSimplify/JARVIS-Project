/**
 * THE NO-DEAD-END NET (round 2 of "all types of this error must not occur").
 *
 * Bug #1 taught that a model-invented payload can break any single boundary, so the
 * renderer now has THREE independent nets: the repair pass (visualIR), the catch-all
 * in bodyFor (emergencyDoc), and a React ErrorBoundary around the whole HUD. These
 * tests attack the render path with payloads designed to make SOMETHING throw — and
 * pin that nothing ever does, and that the HUD always receives a full HTML document.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/hud', () => ({
  attentionHud: () => undefined,
  isMini: () => false,
  sendToHud: vi.fn(),
  setMini: () => undefined,
}));
vi.mock('../src/main/modes', () => ({ emitActivity: vi.fn() }));

import { visualTools } from '../src/main/visual';
import ErrorBoundary from '../src/renderer/components/ErrorBoundary';
import { feedTime } from '../src/renderer/components/ActivityFeed';
import { bodyFor, isRenderableVisual } from '../src/renderer/components/VisualCard';

/** The one promise: a document comes back — full frame, never a crash, never a dead end. */
const expectSurvives = (payload: unknown, title: string): string => {
  const html = bodyFor({ title, ...(payload as object) } as Parameters<typeof bodyFor>[0]);
  expect(typeof html).toBe('string');
  expect(html).toContain('<!doctype html>');
  expect(html).not.toContain('could not be built');
  expect(html).not.toContain('undefined');
  return html;
};

describe('the render net: adversarial payloads never throw, always render', () => {
  it('scalar and empty payloads (null, numbers, booleans, no content at all)', () => {
    expect(bodyFor(null)).toContain('<!doctype html>');
    expect(bodyFor(undefined)).toContain('<!doctype html>');
    expectSurvives({ blocks: 0 }, 'Number blocks');
    expectSurvives({ blocks: true }, 'Boolean blocks');
    expectSurvives({}, 'Nothing at all');
  });

  it('a block whose field value cannot even be stringified (toString throws)', () => {
    const evil = { toString(): never { throw new Error('boom'); } };
    expectSurvives({ blocks: [{ type: 'stats', items: [{ k: evil, v: '1' }] }] }, 'Hostile toString');
    expectSurvives({ blocks: [{ type: 'note', text: evil }] }, 'Hostile note');
  });

  it('a Proxy that throws on every property access (simulates a broken structured clone)', () => {
    const evil = new Proxy({}, { get() { throw new Error('boom'); } });
    expectSurvives({ blocks: evil }, 'Hostile proxy');
  });

  it('a depth bomb: 50,000 nested arrays must not stack-overflow the render path', () => {
    let bomb: unknown = 'bottom';
    for (let i = 0; i < 50_000; i++) bomb = [bomb];
    expectSurvives({ blocks: bomb }, 'Depth bomb');
  });

  it('an oversized payload: 2 MB of text degrades calmly instead of hanging or throwing', () => {
    expectSurvives({ blocks: [{ type: 'note', text: 'x'.repeat(2_000_000) }] }, 'Oversized note');
  });

  it('wrong-shaped items (functions die over IPC but the net holds anyway)', () => {
    expectSurvives({ blocks: [{ type: 'bars', items: 'not-an-array' }] }, 'Bars as string');
    expectSurvives({ blocks: [{ type: 'table', columns: 5, rows: 'x' }] }, 'Table scalars');
    expectSurvives({ blocks: [Symbol.for('nope')] as unknown as object }, 'Symbol block');
  });

  it('the normal paths are unchanged: blocks render, legacy html passes through', () => {
    const fromBlocks = bodyFor({ title: 'DNS', blocks: [{ type: 'stats', items: [{ k: 'TTL', v: '60' }] }] });
    expect(fromBlocks).toContain('TTL');
    const fromHtml = bodyFor({ title: 'Legacy', html: '<div class="grid"><div class="card"><span class="k">A</span><span class="v">1</span></div></div>' });
    expect(fromHtml).toContain('class="grid"');
    const empty = expectSurvives({}, 'Untitled labour');
    expect(empty).toContain('without content');
  });
});

describe('the IPC boundary: malformed pushes are dropped at the door', () => {
  it('isRenderableVisual rejects null, non-objects and empty titles', () => {
    expect(isRenderableVisual(null)).toBe(false);
    expect(isRenderableVisual(undefined)).toBe(false);
    expect(isRenderableVisual('visual')).toBe(false);
    expect(isRenderableVisual({ title: '' })).toBe(false);
    expect(isRenderableVisual({ title: '   ' })).toBe(false);
    expect(isRenderableVisual({ blocks: [{ type: 'note', text: 'x' }] })).toBe(false);
  });
  it('isRenderableVisual accepts a real visual push', () => {
    expect(isRenderableVisual({ title: 'DNS', blocks: [{ type: 'stats', items: [] }] })).toBe(true);
  });
});

describe('the staging gate: unserialisable blocks get retry guidance, not a TypeError', () => {
  it('circular blocks are refused with a clean, actionable message', () => {
    const a: Record<string, unknown> = { type: 'note', text: 'self' };
    a.self = a; // circular
    let msg = '';
    try {
      visualTools.show_visual.run({ title: 'Loop', blocks: a });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain('not serialisable');
    expect(msg).toContain('plain JSON');
    expect(msg).not.toContain('TypeError');
  });

  it('BigInt blocks are refused the same clean way', () => {
    let msg = '';
    try {
      visualTools.show_visual.run({ title: 'Big', blocks: [{ type: 'stats', items: [{ k: 'n', v: 1n }] }] });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain('not serialisable');
  });

  it('a normal call still projects (the guard changed no behaviour)', () => {
    const out = visualTools.show_visual.run({ title: 'OK', blocks: [{ type: 'note', text: 'fine' }] });
    expect(String(out)).toContain('is on screen now');
  });
});

describe('the activity feed clock: garbage timestamps never print "Invalid Date"', () => {
  it('valid ticks format, everything else degrades to a placeholder', () => {
    expect(feedTime(new Date('2026-01-01T10:20:30').getTime())).toBe('10:20:30');
    expect(feedTime(undefined)).toBe('--:--:--');
    expect(feedTime(null)).toBe('--:--:--');
    expect(feedTime('not-a-number')).toBe('--:--:--');
    expect(feedTime(Number.NaN)).toBe('--:--:--');
    expect(feedTime(Number.POSITIVE_INFINITY)).toBe('--:--:--');
  });
});

describe('the ErrorBoundary: a component crash can never blank the HUD for good', () => {
  it('getDerivedStateFromError wraps any thrown value into state', () => {
    const err = new Error('component went bang');
    expect(ErrorBoundary.getDerivedStateFromError(err).error).toBe(err);
    expect(ErrorBoundary.getDerivedStateFromError('just a string').error).toBeInstanceOf(Error);
    expect(ErrorBoundary.getDerivedStateFromError(undefined).error).toBeInstanceOf(Error);
  });

  it('renders the recovery card with a way back, and children when healthy', () => {
    const b = new ErrorBoundary({ children: null });
    expect(b.render()).toBeNull(); // healthy boundary renders nothing itself

    b.state = { error: new Error('boom') };
    const tree = b.render() as { props: { children: unknown } };
    expect(tree).toBeTruthy();
    const texts: string[] = [];
    const walk = (n: unknown): void => {
      if (n == null || typeof n !== 'object') {
        if (typeof n === 'string' || typeof n === 'number') texts.push(String(n));
        return;
      }
      const el = n as { props?: { children?: unknown } };
      if (el.props && 'children' in el.props) {
        const kids = el.props.children;
        Array.isArray(kids) ? kids.forEach(walk) : walk(kids);
      }
    };
    walk(tree);
    const all = texts.join(' ');
    expect(all).toContain('System fault contained');
    expect(all).toContain('Try again');
    expect(all).toContain('Reload HUD');
    expect(all).toContain('JINI is still running');
  });
});
