/**
 * BACKGROUND-MODE BROWSER STEALTH — the "research opened a full-screen browser" bug.
 *
 * In background mode the in-app browser panel must be completely invisible: it opens
 * hidden, pages run at full speed off-screen, nothing is ever shown, focused or made
 * fullscreen, and closing it must not flash it on screen either. In interactive mode the
 * cinematic open still works (regression guard for the showmanship).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Electron doubles with call recording, created via vi.hoisted so the factory can see them. */
const e = vi.hoisted(() => {
  interface Call { name: string; args: unknown[] }
  class FakeWC {
    handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
    calls: Call[] = [];
    url = 'https://example.com/';
    destroyed = false;
    on(ev: string, fn: (...a: unknown[]) => void): void { (this.handlers[ev] ??= []).push(fn); }
    once(ev: string, fn: (...a: unknown[]) => void): void { this.on(ev, fn); }
    emit(ev: string, ...a: unknown[]): void { (this.handlers[ev] ?? []).forEach((f) => f(...a)); }
    rec(name: string, ...args: unknown[]): void { this.calls.push({ name, args }); }
    count(name: string): number { return this.calls.filter((c) => c.name === name).length; }
    async executeJavaScript(): Promise<unknown> {
      this.rec('executeJavaScript');
      // A valid empty page snapshot: browser tools that settle() after an action can run
      // end-to-end against the fakes (snapshot() parses this shape).
      return JSON.stringify({ title: 'T', url: 'https://example.com/', elements: [], below: 0, dialogs: [], scroll: '0/0', text: '' });
    }
    async loadURL(u: string): Promise<void> { this.rec('loadURL', u); this.url = u; }
    getURL(): string { return this.url; }
    isDestroyed(): boolean { return this.destroyed; }
    insertCSS(): void { this.rec('insertCSS'); }
    setWindowOpenHandler(): void { this.rec('setWindowOpenHandler'); }
    setUserAgent(): void { this.rec('setUserAgent'); }
    setAudioMuted(): void { this.rec('setAudioMuted'); }
    setMenuBarVisibility(): void { this.rec('setMenuBarVisibility'); }
    reload(): void { this.rec('reload'); }
    close(): void { this.rec('close'); this.destroyed = true; }
    focus(): void { this.rec('focus'); }
    sendInputEvent(): void { this.rec('sendInputEvent'); }
    isLoading(): boolean { return false; }
    destroy(): void { this.rec('destroy'); this.destroyed = true; }
  }
  class FakeWin {
    calls: Call[] = [];
    opts: Record<string, unknown>;
    contentView = {
      views: [] as unknown[],
      addChildView(v: unknown): void { this.views.push(v); },
      removeChildView(v: unknown): void { this.views = this.views.filter((x) => x !== v); },
    };
    webContents = new FakeWC();
    destroyed = false;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      wins.push(this);
    }
    rec(name: string, ...args: unknown[]): void { this.calls.push({ name, args }); }
    count(name: string): number { return this.calls.filter((c) => c.name === name).length; }
    on(): void { /* registrations only */ }
    show(): void { this.rec('show'); }
    showInactive(): void { this.rec('showInactive'); }
    hide(): void { this.rec('hide'); }
    moveTop(): void { this.rec('moveTop'); }
    focus(): void { this.rec('focus'); }
    setAlwaysOnTop(): void { this.rec('setAlwaysOnTop'); }
    setOpacity(): void { this.rec('setOpacity'); }
    setResizable(): void { this.rec('setResizable'); }
    setFullScreen(): void { this.rec('setFullScreen'); }
    setKiosk(): void { this.rec('setKiosk'); }
    setBounds(): void { this.rec('setBounds'); }
    setMinimumSize(): void { /* hud tween only */ }
    getBounds(): { x: number; y: number; width: number; height: number } { return { x: 0, y: 0, width: 1920, height: 1080 }; }
    getContentSize(): [number, number] { return [1920, 1080]; }
    isDestroyed(): boolean { return this.destroyed; }
    destroy(): void { this.rec('destroy'); this.destroyed = true; }
    setFocusable(): void { /* hud only */ }
  }
  const wins: FakeWin[] = [];
  class FakeView {
    webContents = new FakeWC();
    constructor(public opts?: Record<string, unknown>) {}
    setBackgroundColor(): void {}
    setBounds(): void {}
    getBounds(): { x: number; y: number; width: number; height: number } { return { x: 0, y: 0, width: 1920, height: 1080 }; }
  }
  return {
    FakeWin,
    FakeView,
    FakeWC,
    wins,
    screen: { getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    app: { getPath: () => '/tmp', on: () => undefined },
    session: { fromPartition: () => ({ on: () => undefined }) },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: e.FakeWin,
  WebContentsView: e.FakeView,
  app: e.app,
  screen: e.screen,
  session: e.session,
}));
vi.mock('../src/main/hud', () => ({
  dockHud: vi.fn(),
  undockHud: vi.fn(),
  raiseHud: vi.fn(),
  focusHud: vi.fn(),
  attentionHud: vi.fn(),
  isMini: () => false,
  sendToHud: vi.fn(),
  setMini: vi.fn(),
  setLeaveHandler: vi.fn(),
  setResumeHandler: vi.fn(),
  attachHud: vi.fn(),
}));

import { focusHud } from '../src/main/hud';
import { initModes, setMode } from '../src/main/modes';
import { attachPanel, closePanel, ensurePanel, panelState, panelWebContents, showPanel, whenOpen } from '../src/main/panel';

let mainWin: InstanceType<typeof e.FakeWin>;
/** The panel windows are the kiosk ones; the fake main window is not. */
const panelWins = (): InstanceType<typeof e.FakeWin>[] => e.wins.filter((w) => (w.opts as Record<string, unknown>)?.kiosk === true);
const winCalls = (name: string): number => e.wins.reduce((n, w) => n + w.count(name), 0);
const resetCalls = (): void => {
  e.wins.length = 0;
  mainWin = new e.FakeWin({ show: false });
  attachPanel(mainWin as unknown as Electron.BrowserWindow);
};

describe('background-mode browser stealth', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    await initModes();
    resetCalls();
  });
  afterEach(async () => {
    await setMode('interactive');
    closePanel();
    await vi.advanceTimersByTimeAsync(100);
    vi.useRealTimers();
  });

  it('opens the panel INVISIBLY in background mode: no show, no fullscreen, no kiosk, no focus', async () => {
    await setMode('background');
    const wc = ensurePanel('RESEARCH');
    expect(wc).toBeTruthy();
    const state = panelState();
    expect(state.state).toBe('open');
    expect(state.hidden).toBe(true);
    expect(panelWins()).toHaveLength(1);
    expect(panelWins()[0].opts.show).toBe(false);
    expect((panelWins()[0].opts.webPreferences as Record<string, unknown>).backgroundThrottling).toBe(false); // hidden pages still run at full speed
    expect(winCalls('show')).toBe(0);
    expect(winCalls('setFullScreen')).toBe(0);
    expect(winCalls('setKiosk')).toBe(0);
    expect(winCalls('moveTop')).toBe(0);
    expect(winCalls('focus')).toBe(0);
    // the page is real and reachable for the tools
    expect(panelWebContents()).toBe(wc);
    await vi.advanceTimersByTimeAsync(50);
  });

  it('showPanel never surfaces the panel in background mode', async () => {
    await setMode('background');
    ensurePanel('RESEARCH');
    expect(showPanel()).toBe(false);
    expect(winCalls('show')).toBe(0);
    expect(panelState().hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
  });

  it('opens MORE tabs invisibly and closes the whole panel without ever showing it', async () => {
    await setMode('background');
    ensurePanel('RESEARCH');
    const before = winCalls('show');
    const tab2 = ensurePanel('SECOND');
    expect(tab2).toBeTruthy();
    expect(winCalls('show')).toBe(before);
    closePanel();
    await vi.advanceTimersByTimeAsync(100);
    expect(panelState().state).toBe('closed');
    expect(winCalls('show')).toBe(before); // no farewell flash
  });

  it('interactive mode keeps the cinematic open (regression guard for showmanship)', async () => {
    await setMode('interactive');
    const wc = ensurePanel('SHOW');
    const open = await (async () => {
      // flush the door animation timers
      for (let i = 0; i < 12 && panelState().state !== 'open'; i++) await vi.advanceTimersByTimeAsync(1000);
      return panelState().state === 'open';
    })();
    expect(open).toBe(true);
    expect(wc).toBeTruthy();
    expect(winCalls('show')).toBeGreaterThanOrEqual(1);
    expect(winCalls('setFullScreen')).toBeGreaterThanOrEqual(1);
    expect(winCalls('setKiosk')).toBeGreaterThanOrEqual(1);
    expect(await whenOpen()).toBe(true);
    closePanel();
    for (let i = 0; i < 10 && panelState().state !== 'closed'; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(panelState().state).toBe('closed');
  });

  it('mode flip mid-session: a panel opened visible and then backgrounded is not re-shown by showPanel', async () => {
    await setMode('interactive');
    ensurePanel('SHOW');
    for (let i = 0; i < 12 && panelState().state !== 'open'; i++) await vi.advanceTimersByTimeAsync(1000);
    expect(panelState().hidden).toBe(false);
    await setMode('background');
    expect(showPanel()).toBe(false);
    expect(winCalls('show')).toBeLessThanOrEqual(1); // only the original open
    closePanel();
    await vi.advanceTimersByTimeAsync(100);
  });

  it('a browser action in background mode never steals focus: no wc.focus, no focusHud raise', async () => {
    await setMode('background');
    ensurePanel('RESEARCH');
    const { browserTools } = await import('../src/main/browser');
    const p = browserTools.browser_key.run({ key: 'Escape' });
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    // The hidden panel must not grab OS keyboard focus mid-research…
    const wc = panelWebContents() as unknown as InstanceType<typeof e.FakeWC>;
    expect(wc.count('focus')).toBe(0);
    // …and the HUD must not raise itself above the user's work either.
    expect(vi.mocked(focusHud)).not.toHaveBeenCalled();
  });

  it('interactive mode keeps the focus hand-back after browser actions (regression guard)', async () => {
    await setMode('interactive');
    ensurePanel('SHOW');
    for (let i = 0; i < 12 && panelState().state !== 'open'; i++) await vi.advanceTimersByTimeAsync(1000);
    const { browserTools } = await import('../src/main/browser');
    const p = browserTools.browser_key.run({ key: 'Escape' });
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    // In interactive mode the kiosk panel took focus: handing it to the HUD is intended.
    expect(vi.mocked(focusHud)).toHaveBeenCalled();
    const wc = panelWebContents() as unknown as InstanceType<typeof e.FakeWC>;
    expect(wc.count('focus')).toBeGreaterThanOrEqual(1);
  });
});
