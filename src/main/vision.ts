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

/** How the last desktop screenshot maps to real (physical, DPI-aware) screen pixels. */
interface ShotMap { imgW: number; imgH: number; physX: number; physY: number; physW: number; physH: number; at: number }
let lastMap: ShotMap | null = null;

/** Capture the primary screen at MAX_WIDTH, queue it for the model, remember the mapping. */
export async function captureScreen(): Promise<{ note: string }> {
  const d = screen.getPrimaryDisplay();
  const height = Math.round((MAX_WIDTH * d.size.height) / d.size.width);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: MAX_WIDTH, height } });
  const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
  if (!src) throw new Error('No screen available to capture.');
  const size = src.thumbnail.getSize();
  const k = d.scaleFactor || 1;
  lastMap = { imgW: size.width, imgH: size.height, physX: Math.round(d.bounds.x * k), physY: Math.round(d.bounds.y * k), physW: Math.round(d.size.width * k), physH: Math.round(d.size.height * k), at: Date.now() };
  queueImage(src.thumbnail.toJPEG(JPEG_QUALITY));
  return { note: `Screen image attached (${size.width}x${size.height}). Use coordinates from this image directly in click_at/drag_at/scroll_at.` };
}

/** Image coordinates (from the last see_screen) → physical screen pixels. Null when no recent map. */
export function imageToScreen(x: number, y: number): { x: number; y: number } | null {
  const m = lastMap;
  if (!m || Date.now() - m.at > 10 * 60_000) return null;
  return { x: Math.round(m.physX + (x / m.imgW) * m.physW), y: Math.round(m.physY + (y / m.imgH) * m.physH) };
}

export const visionTools: Record<string, Tool> = {
  see_screen: {
    description:
      "Look at the user's whole desktop. The image is attached to the next message. Coordinates you read off THIS image can be passed straight to click_at / drag_at / scroll_at (they are mapped to real screen pixels for you, DPI scaling included).",
    parameters: { type: 'object', properties: {} },
    run: async () => (await captureScreen()).note,
  },
};
