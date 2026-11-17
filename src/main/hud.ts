import { BrowserWindow, globalShortcut, screen } from 'electron';

const SHORTCUT = 'Control+Alt+J';
const MINI = { width: 380, height: 390, margin: 16 };
const FULL_MIN = { width: 1000, height: 700 };
const MINI_MIN = { width: 300, height: 320 };
const TWEEN_MS = 460;

let win: BrowserWindow | null = null;
let mini = false;
let saved: Electron.Rectangle | undefined;
let miniBounds: Electron.Rectangle | undefined;
let tweenTimer: NodeJS.Timeout | null = null;
let docked = false;
let wasMini = false;
let leaveHandler: (() => void) | null = null;
let resumeHandler: (() => boolean) | null = null;

export const isMini = (): boolean => mini;
export const hudVisible = (): boolean => !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized();
export const raiseHud = (): void => win?.moveTop();

/**
 * Pushes that arrive while no HUD window exists, or while its page is loading or
 * reloading, used to be dropped silently — a visual pushed at the wrong moment simply
 * never appeared. They are held here and replayed as soon as the page can receive them.
 */
interface OutboxEntry {
  channel: string;
  args: unknown[];
}
const OUTBOX_LIMIT = 24;
let outbox: OutboxEntry[] = [];
let hudReady = false;

const holdForHud = (channel: string, args: unknown[]): void => {
  outbox.push({ channel, args });
  if (outbox.length > OUTBOX_LIMIT) outbox.shift();
};

const flushOutbox = (): void => {
  const w = win;
  if (!w || w.isDestroyed() || !outbox.length) return;
  const held = outbox;
  outbox = [];
  for (const e of held) {
    try {
      w.webContents.send(e.channel, ...e.args);
    } catch {
      outbox.unshift(e); // still undeliverable: keep it queued for the next flush
      break;
    }
  }
};

export const sendToHud = (channel: string, ...args: unknown[]): boolean => {
  if (!win || win.isDestroyed() || !hudReady) {
    holdForHud(channel, args);
    return false;
  }
  try {
    win.webContents.send(channel, ...args);
    return true;
  } catch {
    // The render frame can be disposed between the destroyed check and the send
    // (renderer reload, crash or app teardown): hold the message for the next load.
    holdForHud(channel, args);
    return false;
  }
};
/** Make sure the HUD is visible and on top (used for visuals and notification clicks). */
export const attentionHud = (): void => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.moveTop();
};
export const focusHud = (): void => {
  if (docked) return; // a focused HUD would pull the foreground off the full-screen panel and bring the taskbar back
  win?.moveTop();
  win?.webContents.focus();
};

/** Called when a minimised HUD should bring a hidden panel back; returns true if it did. */
export const setResumeHandler = (fn: (() => boolean) | null): void => {
  resumeHandler = fn;
};

/** Called when the user expands the HUD while a panel owns the screen. */
export const setLeaveHandler = (fn: (() => void) | null): void => {
  leaveHandler = fn;
};

function tween(w: BrowserWindow, to: Electron.Rectangle, done?: () => void): void {
  if (tweenTimer) clearInterval(tweenTimer);
  const from = w.getBounds();
  const t0 = Date.now();
  tweenTimer = setInterval(() => {
    if (w.isDestroyed()) return void clearInterval(tweenTimer!);
    const k = Math.min(1, (Date.now() - t0) / TWEEN_MS);
    const e = 1 - Math.pow(1 - k, 4);
    const lerp = (a: number, b: number) => Math.round(a + (b - a) * e);
    w.setBounds({ x: lerp(from.x, to.x), y: lerp(from.y, to.y), width: lerp(from.width, to.width), height: lerp(from.height, to.height) });
    if (k === 1) {
      clearInterval(tweenTimer!);
      tweenTimer = null;
      done?.();
    }
  }, 16);
}

function miniTarget(from: Electron.Rectangle): Electron.Rectangle {
  const { workArea: a } = screen.getDisplayMatching(miniBounds ?? from);
  const b = miniBounds ?? {
    x: a.x + a.width - MINI.width - MINI.margin,
    y: a.y + a.height - MINI.height - MINI.margin,
    width: MINI.width,
    height: MINI.height,
  };
  return {
    ...b,
    x: Math.min(Math.max(b.x, a.x), a.x + a.width - b.width),
    y: Math.min(Math.max(b.y, a.y), a.y + a.height - b.height),
  };
}

export function setMini(on: boolean): void {
  const w = win;
  if (!w || w.isDestroyed() || on === mini) return;
  if (!on && docked) {
    docked = false;
    w.setFocusable(true);
    leaveHandler?.();
  }
  mini = on;
  if (on && resumeHandler?.()) {
    docked = true;
    w.setFocusable(false);
    wasMini = false;
  }
  if (on) {
    if (w.isMaximized()) w.unmaximize();
    saved = w.getBounds();
    w.setMinimumSize(MINI_MIN.width, MINI_MIN.height);
    w.setMaximizable(false);
    w.setAlwaysOnTop(true, 'screen-saver');
    tween(w, miniTarget(saved));
  } else {
    w.setMaximizable(true);
    w.setAlwaysOnTop(false);
    const back = saved ?? { ...w.getBounds(), width: 1400, height: 900 };
    tween(w, back, () => w.setMinimumSize(FULL_MIN.width, FULL_MIN.height));
  }
  w.webContents.send('hud-mini', on);
}

/** A full-screen panel takes over: the HUD shrinks to its movable mini form. */
export function dockHud(): void {
  if (docked) return;
  docked = true;
  wasMini = mini;
  setMini(true);
  // Clicks still work, but the HUD can't take the foreground from the full-screen panel.
  win?.setFocusable(false);
}

/** The panel is gone: put the HUD back the way it was. */
export function undockHud(): void {
  if (!docked) return;
  docked = false;
  win?.setFocusable(true);
  if (!wasMini) setMini(false);
}

export function attachHud(w: BrowserWindow): void {
  win = w;
  mini = false;
  docked = false;
  hudReady = false;
  // Replay everything pushed while the page was loading. The 300 ms grace after
  // did-finish-load covers the gap before React's first effect subscribes; without it
  // the first visual after a cold start or a renderer reload still vanished.
  w.webContents.on('did-finish-load', () => {
    hudReady = true;
    setTimeout(flushOutbox, 300);
  });
  w.webContents.on('did-start-loading', () => {
    hudReady = false; // a reload is starting: hold every push until it can be received
  });
  w.on('moved', () => {
    if (mini && !tweenTimer) miniBounds = w.getBounds();
  });
  w.on('maximize', () => mini && w.unmaximize());
  w.on('restore', () => {
    if (mini && !tweenTimer) w.setBounds(miniTarget(w.getBounds()));
  });
  w.on('closed', () => {
    win = null;
    mini = false;
  });
  if (!globalShortcut.isRegistered(SHORTCUT)) globalShortcut.register(SHORTCUT, () => setMini(!mini));
}
