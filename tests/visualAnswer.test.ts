import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/hud', () => ({
  attentionHud: () => undefined,
  isMini: () => false,
  sendToHud: () => undefined,
  setMini: () => undefined,
}));

import { answerPendingVisual, visualTools } from '../src/main/visual';

const stage = async (): Promise<void> => {
  await visualTools.show_visual.run({ title: 't', html: '<p>x</p>' });
};

describe('staged visual yes/no short-circuit', () => {
  beforeEach(() => {
    // expire any staged visual from a previous case
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 20 * 60_000);
    vi.useRealTimers();
    answerPendingVisual('no');
  });

  it('accepts a bare yes and courtesy tails', async () => {
    await stage();
    expect(answerPendingVisual('yes')).toBe('Here it is, sir.');
    await stage();
    expect(answerPendingVisual('yes, sir.')).toBe('Here it is, sir.');
    await stage();
    expect(answerPendingVisual('sure, thanks')).toBe('Here it is, sir.');
  });

  it('accepts a bare no', async () => {
    await stage();
    expect(answerPendingVisual('no thanks')).toBe('Very well, sir. I will keep it off the screen.');
  });

  it('does NOT swallow a sentence that merely starts with a yes-word', async () => {
    await stage();
    expect(answerPendingVisual('Sure, but first check my email')).toBeNull();
    await stage();
    expect(answerPendingVisual('Show me the weather instead')).toBeNull();
    await stage();
    expect(answerPendingVisual('ok now open spotify')).toBeNull();
  });

  it('does NOT swallow a redirect that starts with no', async () => {
    await stage();
    expect(answerPendingVisual('no, open Spotify instead')).toBeNull();
  });
});
