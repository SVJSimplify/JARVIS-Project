import { BrowserWindow, WebContentsView, app, screen, session } from 'electron';
import { dockHud, raiseHud, setLeaveHandler, setResumeHandler, undockHud } from './hud';
import { isBackgroundMode } from './modes';
import { barHtml } from './panelTabs';
import { sceneHtml } from './panelScene';
import { uniqueDownloadPath , verifyDownloadFile } from './fsTools';

const BG = '#000000';
const PARTITION = 'persist:jarvis-browser';
const BOOT_MS = 800;
const SEAM_MS = 180;
const OPEN_MS = 700;
const CLOSE_MS = 460;
const HOLD_MS = 220;
const FADE_MS = 260;
const LOAD_CAP_MS = 4000;
const BAR_H = 38;
const TAB_MSG = '__jtab__';
const CLOSE_MSG = '__jarvis_close__';
const CLOSE_JS = `(()=>{if(document.getElementById('__jx'))return;const b=document.createElement('button');b.id='__jx';b.textContent='✕  Close';b.onclick=()=>{if(Date.now()-(window.__jvBusy||0)<2500)return;console.log('${CLOSE_MSG}')};b.style.cssText='position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:2147483647;padding:8px 18px;border-radius:999px;border:1px solid #ffffff;background:#000000dd;color:#ffffff;font:500 12px Futura,Jost,system-ui;letter-spacing:.1em;cursor:pointer';document.documentElement.appendChild(b)})()`;

interface Tab {
  id: number;
  view: WebContentsView;
  title: string;
}
type State = 'closed' | 'opening' | 'open' | 'closing';
type Doors = [WebContentsView, WebContentsView];

let main: BrowserWindow | null = null;
let host: BrowserWindow | null = null;
let page: WebContentsView | null = null;
let bar: WebContentsView | null = null;
let tabs: Tab[] = [];
let nextId = 1;
let doors: Doors | null = null;
let state: State = 'closed';
let closeQueued = false;
let hidden = false;
let size = { width: 0, height: 0 };
let gen = 0; // bumped on every teardown so a stale open/close animation can never touch a newer panel
let lastPopup = 0;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const easeOut = (k: number) => 1 - Math.pow(1 - k, 3);
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const pageBounds = (): Electron.Rectangle => ({ x: 0, y: BAR_H, width: size.width, height: Math.max(0, size.height - BAR_H) });
const activeTab = (): Tab | undefined => tabs.find((t) => t.view === page);
const alive = () => Boolean(host && !host.isDestroyed());
/**
 * STEALTH (background mode): the panel exists, pages load and run at full speed, but it is
 * NEVER shown, focused, fullscreened or docked — autonomous research happens on a window
 * nobody sees. Every show/focus path below checks this; there is no way to surface the
 * panel while background mode is on.
 */
const stealth = (): boolean => isBackgroundMode();

function animate(ms: number, ease: (k: number) => number, step: (k: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const id = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / ms);
      if (alive()) step(ease(k));
      if (k === 1 || !alive()) {
        clearInterval(id);
        resolve();
      }
    }, 16);
  });
}

/** openness 0 = doors shut (screen covered), 1 = fully apart. */
function placeDoors(openness: number): void {
  if (!doors) return;
  const hh = Math.ceil(size.height / 2);
  doors[0].setBounds({ x: 0, y: Math.round(-hh * openness), width: size.width, height: hh });
  doors[1].setBounds({ x: 0, y: Math.round(size.height - hh + hh * openness), width: size.width, height: hh });
}

const runInDoors = (js: string) => Promise.all(doors?.map((d) => d.webContents.executeJavaScript(js).catch(() => undefined)) ?? []);
const startScene = (o: { mode: 'open' | 'close'; label?: string }) =>
  Promise.all(
    doors?.map((d, i) =>
      d.webContents
        .executeJavaScript(`start(${JSON.stringify({ ...o, label: o.label ?? '', half: i ? 'bottom' : 'top', t0: Date.now(), openAt: 0 })})`)
        .catch(() => undefined)
    ) ?? []
  );

function addDoors(): void {
  doors?.forEach((d) => host?.contentView.addChildView(d));
}
function removeDoors(): void {
  doors?.forEach((d) => host?.contentView.removeChildView(d));
  void runInDoors('stop()');
}

function refreshBar(): void {
  const d = JSON.stringify({ tabs: tabs.map((t) => ({ id: t.id, title: t.title })), active: activeTab()?.id });
  void bar?.webContents.executeJavaScript(`setTabs(${d})`).catch(() => undefined);
}

const dlLog: string[] = [];
export const downloadLog = (): string => (dlLog.length ? dlLog.slice(-5).join('\n') : 'No downloads yet.');
let dlWired = false;
function wireDownloads(): void {
  if (dlWired) return;
  dlWired = true;
  session.fromPartition(PARTITION).on('will-download', (_e, item) => {
    // Never overwrite: the save path is uniquified (name (1).ext, …) and confined to a
    // bare filename inside the downloads directory. Code-enforced — page content cannot
    // choose to replace an existing user file.
    void uniqueDownloadPath(app.getPath('downloads'), item.getFilename()).then((file) => {
      item.setSavePath(file);
      item.once('done', (_d, state) => {
        // Round 18 §8.5: a 'completed' download is VERIFIED (size + magic bytes) before
        // it is reported — a click does not prove the file is real.
        void verifyDownloadFile(file)
          .then((v) => {
            dlLog.push(state === 'completed' ? `${v.ok ? 'completed+verified' : 'completed UNVERIFIED'}: ${v.evidence}` : `${state}: ${file}`);
          })
          .catch(() => {
            dlLog.push(`${state}: ${file}`);
          })
          .finally(() => {
            if (dlLog.length > 20) dlLog.splice(0, dlLog.length - 20); // read five-at-a-time; never unbounded
          });
      });
    });
  });
}

/** Alerts, confirms and prompts never block the page: they are recorded, and answered per browser_dialog (default dismiss). */
export const DIALOG_JS = `(() => { if (window.__jvDlg) return; window.__jvDlg = []; window.__jvDlgMode = 'dismiss'; window.__jvDlgText = null;
  window.alert = (m) => { window.__jvDlg.push('alert: ' + m); };
  window.confirm = (m) => { window.__jvDlg.push('confirm: ' + m); return window.__jvDlgMode === 'accept'; };
  window.prompt = (m, d) => { window.__jvDlg.push('prompt: ' + m); return window.__jvDlgMode === 'accept' ? (window.__jvDlgText === null ? (d || '') : window.__jvDlgText) : null; }; })()`;

/**
 * Round 20 (CHANGE 8): dialog-policy persistence hook. browser.ts registers its
 * applyDialogPolicy here; the dom-ready hook below calls it AFTER DIALOG_JS re-installs
 * the default-dismiss handlers, so a per-tab "accept dialogs" decision survives
 * navigation instead of silently resetting.
 */
let dialogPolicyApplier: ((wc: Electron.WebContents) => void) | null = null;
export const setDialogPolicyApplier = (fn: (wc: Electron.WebContents) => void): void => {
  dialogPolicyApplier = fn;
};

function createTab(): Tab {
  wireDownloads();
  const view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true } });
  view.setBackgroundColor('#ffffff');
  const tab: Tab = { id: nextId++, view, title: 'New tab' };
  tabs.push(tab);
  wirePage(view.webContents, tab);
  return tab;
}

function activate(tab: Tab): void {
  if (!alive()) return;
  if (page && page !== tab.view) host!.contentView.removeChildView(page);
  page = tab.view;
  page.setBounds(pageBounds());
  host!.contentView.addChildView(page);
  if (state !== 'open') addDoors(); // keep the shutter on top while animating
  refreshBar();
}

/** Open a new tab (or the panel itself if closed) and return its page. */
export function openTab(label = 'PANEL'): Electron.WebContents {
  if (!page || state === 'closed' || state === 'closing') return ensurePanel(label);
  const t = createTab();
  activate(t);
  return t.view.webContents;
}

/** Indices of in-app tabs whose title or URL contains `q`. */
export function findTabs(q: string): number[] {
  const k = q.toLowerCase();
  return tabs.flatMap((t, i) => (t.title.toLowerCase().includes(k) || t.view.webContents.getURL().toLowerCase().includes(k) ? [i] : []));
}

export function switchTab(i: number): string {
  const t = tabs[i];
  if (!t) return `NOT DONE: no tab ${i}. Call browser_tabs for the current list; indexes are 0-based.`;
  activate(t);
  return 'Switched.';
}

export function closeTab(i?: number): string {
  const t = i === undefined ? activeTab() : tabs[i];
  if (!t) return `NOT DONE: no tab ${i ?? ''}. Call browser_tabs for the current list; indexes are 0-based.`;
  if (tabs.length === 1) return closePanel();
  const idx = tabs.indexOf(t);
  const wasActive = t.view === page;
  tabs.splice(idx, 1);
  if (wasActive) activate(tabs[Math.min(idx, tabs.length - 1)]);
  if (!t.view.webContents.isDestroyed()) t.view.webContents.close();
  refreshBar();
  return 'Tab closed.';
}

/**
 * Ground truth for every browser tool result. Tab indexes in this list are the SAME indexes
 * switchTab and closeTab take — destroyed tabs are pruned at once, so the numbers shown
 * here can never point at a different tab (the reported "tab state lies" bug).
 */
export interface PanelSnapshot {
  state: State;
  hidden: boolean;
  tabCount: number;
  activeTitle: string;
  activeUrl: string;
}

export function panelState(): PanelSnapshot {
  const a = activeTab();
  let url = '';
  try {
    url = a && !a.view.webContents.isDestroyed() ? a.view.webContents.getURL() : '';
  } catch {
    url = '';
  }
  return { state, hidden, tabCount: tabs.length, activeTitle: a?.title ?? '', activeUrl: url };
}

/** Bring a panel hidden behind the expanded HUD back on screen; false when there is nothing to show. Never shows in stealth. */
export function showPanel(): boolean {
  if (stealth()) return false;
  if (state === 'closed' || state === 'closing' || !hidden || !alive()) return false;
  hidden = false;
  host!.show();
  goFullscreen();
  dockHud();
  raiseHud();
  return true;
}

export const listTabs = (): string => {
  if (!tabs.length) return 'No tabs open — the in-app browser panel is closed.';
  return tabs
    .map((t, i) => {
      let url = '';
      try {
        url = t.view.webContents.isDestroyed() ? '(crashed)' : t.view.webContents.getURL();
      } catch {
        url = '(crashed)';
      }
      return `${i}${t.view === page ? '*' : ''} ${t.title} | ${url}`;
    })
    .join('\n');
};

/**
 * A tab whose webContents is gone (manual Ctrl+W race, crash, teardown) is removed from the
 * registry the moment it dies. Leaving it in used to make browser_tabs list a ghost and made
 * every index after it point one tab too far — the model then closed or switched the wrong tab.
 */
function pruneTab(t: Tab): void {
  const i = tabs.indexOf(t);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (page === t.view) {
    page = null;
    if (tabs.length) activate(tabs[Math.min(i, tabs.length - 1)]);
    else if (state !== 'closed') closePanel();
  }
  refreshBar();
}

function teardown(): void {
  gen++;
  state = 'closed';
  closeQueued = false;
  hidden = false;
  // Detach the registry BEFORE closing anything: every close fires 'destroyed', and the
  // pruneTab handler must see an empty list (indexOf -1) rather than splice this array
  // mid-iteration or re-activate a tab while the window is going away.
  // The active page is one of the tabs' views, so closing `dying` closes it too.
  const dying = tabs;
  tabs = [];
  page = null;
  dying.forEach((t) => !t.view.webContents.isDestroyed() && t.view.webContents.close());
  if (bar && !bar.webContents.isDestroyed()) bar.webContents.close();
  bar = null;
  doors?.forEach((d) => !d.webContents.isDestroyed() && d.webContents.close());
  if (host && !host.isDestroyed()) host.destroy();
  doors = null;
  page = null;
  host = null;
  undockHud();
}

function wirePage(wc: Electron.WebContents, tab: Tab): void {
  wc.on('page-title-updated', (_e, title) => {
    tab.title = title;
    refreshBar();
  });
  // A dead tab must leave the registry at once (see pruneTab) instead of haunting the list.
  wc.on('destroyed', () => pruneTab(tab));
  // A renderer crash blanks the tab: reload it up to twice, then prune it honestly.
  let crashes = 0;
  wc.on('render-process-gone', (_e, d) => {
    if (d.reason === 'clean-exit') return pruneTab(tab);
    if (++crashes > 2) return pruneTab(tab);
    setTimeout(() => {
      if (!wc.isDestroyed() && wc.getURL()) wc.reload();
    }, 400);
  });
  // Redirects and SPA route changes never fire page-title-updated: the bar and browser_tabs
  // would keep showing the old URL — reported "lying" tab state.
  const refreshUrl = (): void => {
    if (!tab.view.webContents.isDestroyed()) refreshBar();
  };
  wc.on('did-navigate', refreshUrl);
  wc.on('did-navigate-in-page', refreshUrl);
  wc.on('dom-ready', () => {
    void wc.executeJavaScript(CLOSE_JS).catch(() => undefined);
    void wc.executeJavaScript(DIALOG_JS).catch(() => undefined);
    // Round 20 (CHANGE 8): re-apply the persisted per-tab dialog policy on EVERY new
    // document (after DIALOG_JS has re-installed its handlers).
    try {
      dialogPolicyApplier?.(wc);
    } catch {
      /* a stale policy must never break the page load */
    }
    void wc.insertCSS('::-webkit-scrollbar{display:none}');
  });
  wc.on('console-message', (...a: unknown[]) => {
    const first = a[0] as { message?: string } | undefined;
    if ((typeof first?.message === 'string' ? first.message : a[2]) === CLOSE_MSG) closePanel();
  });
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown' || !i.control) return;
    const k = i.key.toLowerCase();
    if (k === 'w') closeTab();
    else if (k === 't') void openTab().loadURL('https://www.google.com').catch(() => undefined);
    else if (k === 'tab') switchTab((tabs.indexOf(activeTab()!) + 1) % tabs.length);
    else return;
    e.preventDefault();
  });
  // YouTube: click its own Skip button the moment it appears, so ads never block a video.
  wc.on('dom-ready', () => {
    let host = '';
    try {
      host = new URL(wc.getURL()).hostname;
    } catch {
      return;
    }
    if (!/(^|\.)youtube\.com$/.test(host)) return;
    void wc
      .executeJavaScript(
        "(() => { if (window.__jarvisSkip) return; window.__jarvisSkip = setInterval(() => { const b = [...document.querySelectorAll('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')].find((x) => x.offsetParent !== null); if (b) b.click(); const o = document.querySelector('.ytp-ad-overlay-close-button'); if (o) o.click(); }, 700); })()"
      )
      .catch(() => undefined);
  });

  wc.setWindowOpenHandler(({ url }) => {
    // Pages (ads, OAuth, target=_blank) spam window.open: only real http(s) links, throttled and capped.
    const now = Date.now();
    if (/^https?:/i.test(url) && now - lastPopup > 1500 && tabs.length < 8) {
      lastPopup = now;
      void openTab().loadURL(url).catch(() => undefined);
    }
    return { action: 'deny' };
  });
}

/** Cover the whole display, taskbar included. Windows ignores the constructor flags until the window is shown. */
function goFullscreen(): void {
  if (!host || host.isDestroyed()) return;
  const bounds = screen.getDisplayMatching(host.getBounds()).bounds;
  host.setResizable(true); // Windows refuses fullscreen on non-resizable windows
  host.setAlwaysOnTop(true, 'screen-saver');
  host.setFullScreen(true);
  host.setKiosk(true);
  host.setBounds(bounds);
  host.moveTop();
  host.focus(); // the taskbar only hides for the foreground window
}

async function runOpen(wc: Electron.WebContents, label: string): Promise<void> {
  const g = gen;
  try {
    await openSequence(wc, label, g);
  } catch (err) {
    // A door loadURL rejection (window torn down mid-boot, quit during the animation) must not
    // leave the panel stuck in 'opening' forever: tear down so the next open starts fresh.
    console.error('[panel] open failed:', err instanceof Error ? err.message : err);
    if (g === gen) teardown();
  }
}

async function openSequence(wc: Electron.WebContents, label: string, g: number): Promise<void> {
  const loaded = new Promise<void>((resolve) => {
    wc.once('did-stop-loading', () => resolve());
    setTimeout(resolve, LOAD_CAP_MS);
  });
  dockHud();
  const html = `data:text/html;charset=utf-8,${encodeURIComponent(sceneHtml())}`;
  await Promise.all(doors!.map((d) => d.webContents.loadURL(html)));
  if (!alive() || g !== gen) return;

  const t0 = Date.now();
  await startScene({ mode: 'open', label: label.toUpperCase() });
  host!.show();
  goFullscreen();
  raiseHud();
  await animate(FADE_MS, easeOut, (k) => host!.setOpacity(k));
  await Promise.all([loaded, sleep(Math.max(0, BOOT_MS - (Date.now() - t0)))]);
  if (!alive() || g !== gen) return;

  await runInDoors(`setOpenAt(${Date.now() + SEAM_MS})`);
  await sleep(SEAM_MS);
  await animate(OPEN_MS, easeInOut, (k) => placeDoors(k));
  if (!alive() || g !== gen) return;
  removeDoors();
  state = 'open';
  if (closeQueued) closePanel();
}

async function runClose(): Promise<void> {
  const g = gen;
  state = 'closing';
  addDoors();
  placeDoors(1);
  await startScene({ mode: 'close' });
  await animate(CLOSE_MS, easeOut, (k) => placeDoors(1 - k));
  if (g !== gen) return;
  await sleep(HOLD_MS);
  if (g !== gen) return;
  undockHud();
  await animate(FADE_MS, easeOut, (k) => host?.setOpacity(1 - k));
  if (g !== gen) return;
  teardown();
}

/** Open (or reuse) the full-screen panel and return its page. `label` is shown during the intro.
 *  In stealth (background mode) the same panel is built INVISIBLY: no doors, no animation,
 *  no show/focus/fullscreen ever — the caller works against a hidden, live page. */
export function ensurePanel(label = 'PANEL'): Electron.WebContents {
  if (!main || main.isDestroyed()) throw new Error('No window available.');
  if (page && state !== 'closing') {
    if (hidden && alive() && !stealth()) {
      hidden = false;
      host!.show();
      goFullscreen();
      dockHud();
      raiseHud();
    }
    return page.webContents;
  }
  if (state === 'closing') teardown();

  state = 'opening';
  closeQueued = false;
  const d = screen.getDisplayMatching(main.getBounds()).bounds;
  size = { width: d.width, height: d.height };
  host = new BrowserWindow({
    ...d,
    frame: false,
    show: false,
    fullscreen: true,
    kiosk: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    resizable: true,
    fullscreenable: true,
    hasShadow: false,
    backgroundColor: BG,
    webPreferences: { sandbox: true, backgroundThrottling: false },
  });
  host.setAlwaysOnTop(true, 'screen-saver');
  host.setOpacity(0);
  host.on('closed', () => {
    host = null;
    if (state !== 'closed') teardown();
  });
  host.on('resize', () => {
    if (!alive()) return;
    const [width, height] = host!.getContentSize();
    size = { width, height };
    bar?.setBounds({ x: 0, y: 0, width, height: BAR_H });
    page?.setBounds(pageBounds());
  });

  tabs = [];
  nextId = 1;
  bar = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
  bar.setBackgroundColor('#000000');
  bar.setBounds({ x: 0, y: 0, width: size.width, height: BAR_H });
  host.contentView.addChildView(bar);
  bar.webContents.on('did-finish-load', refreshBar);
  bar.webContents.on('console-message', (...a: unknown[]) => {
    const first = a[0] as { message?: string } | undefined;
    const msg = typeof first?.message === 'string' ? first.message : String(a[2] ?? '');
    if (!msg.startsWith(TAB_MSG)) return;
    // Anything logged from a page that happens to start with the marker must never throw
    // inside this handler (an uncaught throw here would kill the tab bar for the session).
    let m: { a: string; i?: number };
    try {
      m = JSON.parse(msg.slice(TAB_MSG.length)) as { a: string; i?: number };
    } catch {
      return;
    }
    if (m.a === 'select') switchTab(m.i ?? 0);
    else if (m.a === 'close') closeTab(m.i);
    else if (m.a === 'new') void openTab().loadURL('https://www.google.com').catch(() => undefined);
  });
  void bar.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(barHtml())}`);
  const first = createTab();
  activate(first);

  if (stealth()) {
    // Invisible open: no doors, no animation, no dock — the page is simply live and hidden.
    hidden = true;
    state = 'open';
    return first.view.webContents;
  }

  doors = [0, 1].map(() => {
    const v = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
    v.setBackgroundColor(BG);
    return v;
  }) as Doors;
  addDoors();
  placeDoors(0);

  void runOpen(first.view.webContents, label);
  return first.view.webContents;
}

/** HUD expanded while a page is open: hide the panel but keep every tab alive. */
function suspendPanel(): void {
  if (state === 'open' && alive()) {
    host!.hide();
    hidden = true;
  } else closePanel();
}

export function closePanel(): string {
  if (state === 'closed') return 'Already closed.';
  // Stealth never shows a hidden panel just to close it: teardown straight away.
  if (stealth()) {
    teardown();
    return 'Closed.';
  }
  if (hidden && alive()) {
    hidden = false;
    host!.show();
    raiseHud();
  }
  if (state === 'opening') {
    closeQueued = true;
    return 'Closing.';
  }
  if (state === 'open') void runClose();
  return 'Closed.';
}

export function panelWebContents(): Electron.WebContents {
  if (!page || state === 'closing') throw new Error('Browser is not open. Use browser_open first.');
  return page.webContents;
}

/**
 * Resolve once the panel is fully open (doors apart, page visible). Tools that open the
 * panel must await this: `ensurePanel` returns the page immediately while the intro
 * animation still runs, and a failed/aborted open tears everything down — reporting a
 * snapshot from that hidden, doomed context is exactly how a tool used to claim success
 * while the user saw nothing.
 */
export function whenOpen(timeoutMs = 15000): Promise<boolean> {
  if (state === 'open' && alive()) return Promise.resolve(true);
  if (state === 'closed') return Promise.resolve(false);
  return new Promise((resolve) => {
    const g = gen;
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (g !== gen || !alive() || state === 'closed') {
        clearInterval(iv);
        resolve(false);
      } else if (state === 'open') {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        resolve(false);
      }
    }, 60);
  });
}

export const panelBounds = (): Electron.Rectangle => page!.getBounds();

export function attachPanel(w: BrowserWindow): void {
  main = w;
  setLeaveHandler(suspendPanel);
  setResumeHandler(() => {
    if (!hidden || !alive() || stealth()) return false;
    hidden = false;
    host!.show();
    raiseHud();
    return true;
  });
  // Restoring the HUD from the taskbar must not push the browser away: re-assert it, HUD on top.
  const reassert = (): void => {
    if (state === 'closed' || hidden || !alive() || stealth()) return;
    host!.setAlwaysOnTop(true, 'screen-saver');
    host!.showInactive();
    host!.moveTop();
    raiseHud();
  };
  w.on('restore', () => {
    reassert();
    setTimeout(reassert, 200);
  });
  w.on('show', reassert);
  w.on('closed', () => {
    main = null;
    teardown();
  });
}
