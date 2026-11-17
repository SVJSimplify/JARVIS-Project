import { desktopCapturer, screen } from 'electron';
import type { Tool } from './toolTypes';

const MAX_WIDTH = 1400;
const JPEG_QUALITY = 70;
let pending: string[] = [];

/** Queue an image; the agent loop attaches it to the conversation after the tool round. */
export const queueImage = (jpeg: Buffer): void => {
  const url = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  pending.push(url);
  turnShot = url;
  try {
    shotListener?.(url);
  } catch {
    /* a broken display must never break the capture */
  }
};

/** The newest screenshot of the current turn — shown in the chat on desktop and phone. */
let turnShot: string | null = null;
let shotListener: ((dataUrl: string) => void) | null = null;
export const onScreenshot = (fn: ((dataUrl: string) => void) | null): void => {
  shotListener = fn;
};
export const resetTurnShot = (): void => {
  turnShot = null;
};
export const peekTurnShot = (): string | null => turnShot;

export const drainImages = (): string[] => {
  const out = pending;
  pending = [];
  return out;
};

export const visionTools: Record<string, Tool> = {
  see_screen: {
    description: 'Look at the user\'s whole desktop. The image is attached to the next message.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const d = screen.getPrimaryDisplay();
      const height = Math.round((MAX_WIDTH * d.size.height) / d.size.width);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: MAX_WIDTH, height } });
      const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
      if (!src) throw new Error('No screen available to capture.');
      queueImage(src.thumbnail.toJPEG(JPEG_QUALITY));
      return `Screen image attached. Real screen is ${d.size.width}x${d.size.height}; multiply image coordinates by ${(d.size.width / MAX_WIDTH).toFixed(3)} for click_at.`;
    },
  },
};
