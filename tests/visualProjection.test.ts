/**
 * The visual is shown the moment show_visual succeeds — there is no stage → "ready to
 * see it?" → yes/no gate anymore. That gate was a confirmation prompt (banned by the
 * autonomy policy) and the reason visuals often never appeared: the model could forget
 * to ask, the user's reply could miss the yes/no patterns, and an unclaimed visual
 * expired after ten minutes. These tests pin the replacement contract: one call, one
 * projection, no permission round trip.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/hud', () => ({
  attentionHud: vi.fn(),
  isMini: () => false,
  sendToHud: vi.fn(),
  setMini: vi.fn(),
}));
vi.mock('../src/main/modes', () => ({ emitActivity: vi.fn() }));

import { attentionHud, sendToHud, setMini } from '../src/main/hud';
import { visualTools } from '../src/main/visual';

const run = async (args: Record<string, unknown>): Promise<string> =>
  visualTools.show_visual.run(args) as Promise<string>;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10)); // projection rides a macrotask

describe('show_visual projects immediately', () => {
  beforeEach(() => {
    vi.mocked(sendToHud).mockClear();
    vi.mocked(attentionHud).mockClear();
    vi.mocked(setMini).mockClear();
  });

  it('sends exactly one jarvis-visual push per successful call', async () => {
    await run({ title: 'T', blocks: [{ type: 'stats', items: [{ k: 'a', v: '1' }] }] });
    await flush();
    expect(vi.mocked(sendToHud)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendToHud)).toHaveBeenCalledWith(
      'jarvis-visual',
      expect.objectContaining({ title: 'T', restoreMini: false })
    );
  });

  it('brings the HUD to attention without asking anyone', async () => {
    await run({ title: 'T', html: '<p>x</p>' });
    expect(vi.mocked(attentionHud)).toHaveBeenCalledTimes(1);
    await flush(); // drain the projection macrotask so it cannot leak into the next test
  });

  it('carries a numeric id so the renderer can key its animation', async () => {
    await run({ title: 'T', blocks: [{ type: 'note', text: 'x' }] });
    await flush();
    const payload = vi.mocked(sendToHud).mock.calls[0][1] as Record<string, unknown>;
    expect(typeof payload.id).toBe('number');
  });

  it('the tool result never asks the model to seek permission', async () => {
    const out = await run({ title: 'T', blocks: [{ type: 'note', text: 'x' }] });
    expect(out).toContain('on screen now');
    expect(out).not.toMatch(/NOT on screen|ready to see|Shall I|ask the user/i);
    await flush(); // drain the projection macrotask so it cannot leak into the next test
  });

  it('the tool description forbids the permission ask', () => {
    const d = visualTools.show_visual.description;
    expect(d).toContain('on screen the instant you call this tool');
    expect(d).toMatch(/NEVER ask permission/i);
    expect(d).not.toContain('NOT shown immediately');
  });
});
