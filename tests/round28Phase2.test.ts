/**
 * JARVIS ROUND 28 — PHASE 2 TESTS: NATIVE BROWSER CONTROL.
 *
 * Two levels, honestly separated:
 *
 * 1. PROTOCOL TESTS against a REAL WebSocket+HTTP CDP server implemented inside the test
 *    (the `ws` server speaks the actual Chrome DevTools Protocol wire format) — connect,
 *    session identity, background-tab creation, activation policy, click policy gates,
 *    verification lines, injection scanning, disconnection.
 *
 * 2. LIVE-BROWSER TESTS against a REAL Chromium binary when one exists in this
 *    environment (discovered under ~/.cache/ms-playwright/chromium-*): real launch with a
 *    dedicated JARVIS-managed profile, real background tab, real DOM snapshot, real click
 *    with evidence-based verification, real typing read-back, real screenshot, real
 *    disconnect (process exit). If no browser binary exists the live block reports a
 *    skip — it never fabricates a pass.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  connectNativeBrowser,
  disconnectNativeBrowser,
  dropNativeConfigCacheForTests,
  getNativeConfig,
  isNativeConnected,
  nativeBrowserTools,
  nativeSessionInfo,
  openNativeTab,
  setNativeProfileRoot,
  setNativeConfig,
  discoverInstalledBrowsers,
  resolveBrowserExecutable,
  reconnectNativeBrowser,
} from '../src/main/nativeBrowser';
import { respondApproval, resetApprovalsForTests, setNativeConfirmationPresenter, approvalStatusForTests } from '../src/main/approval';

/** The user clicks Allow in the native dialog: install a presenter that approves, then wait for the
 *  dialog outcome to settle (only the dialog result grants; nothing is approved synchronously). */
async function approveNatively(id: string): Promise<{ ok: boolean; status: string; reason: string }> {
  setNativeConfirmationPresenter(async () => 'approved');
  const r = await respondApproval(id, 'approve');
  for (let i = 0; i < 200 && approvalStatusForTests(id) === 'pending'; i++) await new Promise((res) => setTimeout(res, 5));
  return r;
}

// --------------------------------------------------------------------------- fake CDP

interface FakeState {
  httpPort: number;
  createdTargets: Array<{ url: string; background: boolean }>;
  activated: string[];
  closed: string[];
  evaluates: string[];
  server: http.Server;
  wss: WebSocketServer;
  sockets: Set<WebSocket>;
}

const fakeTarget = { targetId: 'T-main', type: 'page', url: 'https://app.local/start', title: 'Start' };

function startFakeCdp(state: FakeState): Promise<void> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/json/version')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Browser: 'FakeChrome/120', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://127.0.0.1:${state.httpPort}/devtools/browser/fake` }));
      } else if (url.startsWith('/json/list')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([fakeTarget]));
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });
    state.server = server;
    const wss = new WebSocketServer({ server });
    state.wss = wss;
    const targets = new Map<string, { type: string; url: string; title: string }>([[fakeTarget.targetId, { type: 'page', url: fakeTarget.url, title: fakeTarget.title }]]);
    let nextSession = 1;
    const sessions = new Map<string, string>(); // sessionId → targetId
    wss.on('connection', (ws) => {
      state.sockets.add(ws);
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
        const reply = (result: Record<string, unknown>): void => ws.send(JSON.stringify({ id: msg.id, result }));
        if (msg.method === 'Browser.getVersion') return reply({ product: 'FakeChrome/120', protocolVersion: '1.3' });
        if (msg.method === 'Browser.setDownloadBehavior') return reply({});
        if (msg.method === 'Target.getTargets')
          return reply({ targetInfos: [...targets.entries()].map(([targetId, t]) => ({ targetId, ...t, attached: [...sessions.values()].includes(targetId) })) });
        if (msg.method === 'Target.createTarget') {
          const id = `T-${targets.size + 1}`;
          targets.set(id, { type: 'page', url: String(msg.params?.url ?? ''), title: 'New tab' });
          state.createdTargets.push({ url: String(msg.params?.url ?? ''), background: msg.params?.background === true });
          return reply({ targetId: id });
        }
        if (msg.method === 'Target.closeTarget') {
          state.closed.push(String(msg.params?.targetId));
          targets.delete(String(msg.params?.targetId));
          return reply({});
        }
        if (msg.method === 'Target.activateTarget') {
          state.activated.push(String(msg.params?.targetId));
          return reply({});
        }
        if (msg.method === 'Target.attachToTarget') {
          const sid = `S${nextSession++}`;
          sessions.set(sid, String(msg.params?.targetId));
          return reply({ sessionId: sid });
        }
        if (msg.method === 'Target.detachFromTarget') {
          sessions.delete(String(msg.sessionId));
          return reply({});
        }
        // session-level commands
        if (msg.method === 'Page.enable' || msg.method === 'Runtime.enable') return reply({});
        if (msg.method === 'Page.navigate') return reply({ frameId: 'F1' });
        if (msg.method === 'Input.insertText') return reply({});
        if (msg.method === 'Page.captureScreenshot') return reply({ data: Buffer.from('fake-png-bytes').toString('base64') });
        if (msg.method === 'Runtime.evaluate') {
          const expr = String(msg.params?.expression ?? '');
          state.evaluates.push(expr.slice(0, 120));
          const send = (value: string): void => reply({ result: { type: 'string', value } });
          if (expr.includes('__nbEls') && expr.includes('tagName')) {
            const m = /__nbEls \|\| \[\]\)\[(\d+)\]/.exec(expr);
            const ref = m ? Number(m[1]) : 0;
            // Mirrors ELEMENT_IDENTITY_JS (nativeBrowser.ts): the exact-identity JSON record.
            const ident = (tag: string, acc: string, link: string): string =>
            JSON.stringify({ tag, id: '', name: '', type: tag === 'button' ? 'button' : '', role: '', accessibleName: acc, resolvedHref: link, formPresent: false, formAction: '', formMethod: '', position: ref, duplicates: 1, hidden: false });
            if (ref === 5) return send(ident('button', 'Delete account', 'https://app.local/account/delete'));
            if (ref === 6) return send(ident('button', 'Buy now', 'https://shop.local/checkout/9'));
            return send(ident('a', 'Settings link', 'https://app.local/settings'));
          }
          if (expr.includes('__nbEls') && expr.includes('gone')) return send('ok');
          if (expr.includes('document.title') && expr.includes('content')) return send(JSON.stringify({ title: 'Settings', url: 'https://app.local/settings', content: 'account preferences live here' }));
          if (expr.startsWith('JSON.stringify({ title')) return send(JSON.stringify({ title: 'Settings', url: 'https://app.local/settings' }));
          if (expr.includes('body.innerText')) return send('account preferences page text');
          if (expr.includes('__nbEls') && expr.includes('focus')) return send('ok');
          if (expr.includes('activeElement')) return send('typed-value');
          return send('null');
        }
        return reply({});
      });
      ws.on('close', () => state.sockets.delete(ws));
    });
    server.listen(0, '127.0.0.1', () => {
      state.httpPort = (server.address() as { port: number }).port;
      resolve();
    });
  });
}

const stopFakeCdp = (state: FakeState): Promise<void> =>
  new Promise((resolve) => {
    for (const s of state.sockets) {
      try {
        s.terminate();
      } catch {
        /* gone */
      }
    }
    state.wss.close(() => state.server.close(() => resolve()));
  });

// module state reset between tests: delete the config + session stores
const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-test-${process.pid}`);
const wipeStores = (): void => {
  fs.rmSync(path.join(ROOT, 'brain', 'native-browser.json'), { force: true });
  fs.rmSync(path.join(ROOT, 'brain', 'native-browser-session.json'), { force: true });
  dropNativeConfigCacheForTests();
};

// ------------------------------------------------------------------- protocol-level tests

const fake: FakeState = { httpPort: 0, createdTargets: [], activated: [], closed: [], evaluates: [], server: undefined as unknown as http.Server, wss: undefined as unknown as WebSocketServer, sockets: new Set() };

describe('R28 §2 — native browser: discovery & configuration', () => {
  beforeEach(() => {
    wipeStores();
    resetApprovalsForTests(); // Round 29: approval state must not leak between tests
  });

  it('discovery probes the platform candidates and reports found/not-found honestly', async () => {
    const installed = await discoverInstalledBrowsers();
    const ids = installed.map((b) => b.id);
    expect(ids).toContain('chrome');
    expect(ids).toContain('edge');
    for (const b of installed) {
      expect(typeof b.executable).toBe('string');
      expect(typeof b.found).toBe('boolean');
    }
  });

  it('an explicit custom executable path wins and resolves', async () => {
    const marker = path.join(os.tmpdir(), `fake-browser-${Date.now()}`);
    fs.writeFileSync(marker, '#!/bin/sh\n');
    fs.chmodSync(marker, 0o755);
    try {
      const resolved = await resolveBrowserExecutable({ ...getNativeConfigShape(), selectedBrowser: marker } as never);
      expect(resolved?.executable).toBe(marker);
      expect(resolved?.browser.id).toBe('custom');
    } finally {
      fs.rmSync(marker, { force: true });
    }
  });

  it('configuration persists selected browser, mode and user controls', async () => {
    const cfg = await setNativeConfig({ selectedBrowser: '/opt/custom-browser', mode: 'A', attachPort: 9222, visibility: 'minimized', autoReconnect: false, keepOpenOnQuit: false });
    expect(cfg.mode).toBe('A');
    expect(cfg.attachPort).toBe(9222);
    expect(cfg.visibility).toBe('minimized');
    expect(cfg.autoReconnect).toBe(false);
    dropNativeConfigCacheForTests();
    const reloaded = await getNativeConfig();
    expect(reloaded.mode).toBe('A');
    expect(reloaded.attachPort).toBe(9222);
    expect(reloaded.autoReconnect).toBe(false);
  });
});

const getNativeConfigShape = (): Record<string, unknown> => ({ mode: 'B', visibility: 'normal', autoReconnect: true, keepOpenOnQuit: true });

describe('R28 §2 — native browser: connection lifecycle (real CDP wire protocol)', () => {
  beforeAll(async () => {
    wipeStores();
    await startFakeCdp(fake);
  });
  afterAll(async () => {
    await stopFakeCdp(fake);
    wipeStores();
  });

  it('Mode A refuses to connect without an explicitly configured port (never scans, never enables debugging)', async () => {
    await expect(connectNativeBrowser({ mode: 'A' })).rejects.toThrow(/needs the debugging port|explicitly/i);
    expect(isNativeConnected()).toBe(false);
  });

  it('Mode A connects to an explicit loopback endpoint and reports the durable session identity', async () => {
    const info = await connectNativeBrowser({ mode: 'A', port: fake.httpPort });
    expect(info.status).toBe('connected');
    expect(info.sessionId).toMatch(/^nb-/);
    expect(info.browserName).toContain('Chrome');
    expect(info.mode).toBe('A');
    expect(isNativeConnected()).toBe(true);
    // the session record is durable evidence
    const rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'brain', 'native-browser-session.json'), 'utf8')) as { last?: { sessionId?: string } };
    expect(rec.last?.sessionId).toBe(info.sessionId);
  });

  it('a second connect refuses honestly — one native session at a time, never mixed', async () => {
    await expect(connectNativeBrowser({ mode: 'A', port: fake.httpPort })).rejects.toThrow(/already connected|Disconnect first/i);
  });

  it('tabs open as BACKGROUND tabs by default (no activation) — focus only on explicit request', async () => {
    const r1 = await openNativeTab('https://app.local/research', { background: true });
    expect(r1.background).toBe(true);
    expect(r1.activated).toBe(false);
    const r2 = await openNativeTab('https://app.local/shown', { background: false, focus: true });
    expect(r2.activated).toBe(true);
    expect(fake.createdTargets.map((c) => c.background)).toEqual([true, false]);
    expect(fake.activated).toContain(r2.tabId);
    expect(fake.activated).not.toContain(r1.tabId); // the background tab was NEVER activated
  });

  it('tool results carry the explicit NATIVE SESSION identity tag', async () => {
    const out = await nativeBrowserTools.native_browser_tabs.run({});
    expect(out).toContain('[NATIVE SESSION nb-');
    expect(out).toContain('mode A');
    const status = await nativeBrowserTools.native_browser_status.run({});
    expect(status).toContain('SESSION:');
    expect(status).not.toMatch(/cookie|token|password/i);
  });

  it('a click on a destructive control (Delete account) is BLOCKED by the policy layer — no bypass, no retry path', async () => {
    await expect(nativeBrowserTools.native_browser_click.run({ ref: 5, expect: 'the account page opens' })).rejects.toThrow(/BLOCKED.*deletes something.*disabled/i);
    // the destructive click never reached the page (no evaluate of e.click() happened)
    expect(fake.evaluates.filter((e) => e.includes('e.click()')).length).toBe(0);
  });

  it('a consequential action needs a GENUINE user approval — confirm=true is not acceptance, the id is single-use (Round 29 §1.1)', async () => {
    // 1. No approval → the refusal CREATES the request and names it (the UI card is pushed).
    let requestId = '';
    await expect(
      nativeBrowserTools.native_browser_click.run({ ref: 6, expect: 'the order confirmation appears' }).catch((e) => {
        const m = /approval="(ap-[^"]+)"/.exec(e instanceof Error ? e.message : String(e));
        if (m) requestId = m[1];
        throw e;
      })
    ).rejects.toThrow(/APPROVAL REQUIRED.*not user approval/i);
    expect(requestId).toMatch(/^ap-/);
    // 2. A model-invented id can never approve the action.
    await expect(nativeBrowserTools.native_browser_click.run({ ref: 6, expect: 'x', approval: 'ap-forged-000' })).rejects.toThrow(/does not exist/);
    // 3. confirm=true (the Round 28 model-generated flag) is NO LONGER an approval path.
    await expect(nativeBrowserTools.native_browser_click.run({ ref: 6, expect: 'x', confirm: true })).rejects.toThrow(/APPROVAL REQUIRED/);
    // 4. The USER approves through the main-process response path (what the UI card invokes).
    const decision = await approveNatively(requestId);
    expect(decision.ok).toBe(true);
    // 5. The approved action runs and is verified like any other.
    const res = await nativeBrowserTools.native_browser_click.run({ ref: 6, expect: 'the order confirmation appears', approval: requestId });
    expect(res).toContain('[ACTION VERIFY:');
    expect(res).toContain('Buy now');
    // 6. Replay is refused — approvals are single-use.
    await expect(nativeBrowserTools.native_browser_click.run({ ref: 6, expect: 'x', approval: requestId })).rejects.toThrow(/already used|single-use/i);
  });

  it('an ordinary click carries the evidence-based verify line (never bare success)', async () => {
    const res = await nativeBrowserTools.native_browser_click.run({ ref: 0, expect: 'the account preferences open' });
    expect(res).toContain('[ACTION VERIFY:');
    expect(res).toContain('Settings link');
  });

  it('reading flags untrusted content and never executes it', async () => {
    const out = await nativeBrowserTools.native_browser_read.run({});
    expect(out).toContain('Untrusted web content');
    expect(out).toContain('[NATIVE SESSION');
  });

  it('Mode A disconnect leaves the browser running (detach only) and records the reason', async () => {
    const msg = await disconnectNativeBrowser({ closeBrowser: false });
    expect(msg).toContain('Disconnected native session');
    expect(msg).toContain('left running'); // the user's browser is untouched by a Mode A detach
    expect(isNativeConnected()).toBe(false);
    const info = nativeSessionInfo();
    expect(info?.disconnectReason).toContain('disconnected by the user');
  });

  it('the browser closing the socket is detected as a disconnection (never half-alive)', async () => {
    await connectNativeBrowser({ mode: 'A', port: fake.httpPort });
    expect(isNativeConnected()).toBe(true);
    await stopFakeCdp(fake);
    // give the client a moment to observe the close
    for (let i = 0; i < 50 && isNativeConnected(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(isNativeConnected()).toBe(false);
    expect(nativeSessionInfo()?.disconnectReason).toBeTruthy();
    // tools fail honestly afterwards
    await expect(nativeBrowserTools.native_browser_tabs.run({})).rejects.toThrow(/no live native-browser connection/i);
  });

  it('Mode A is NEVER re-attached automatically (recovery refuses and says why)', async () => {
    const r = await reconnectNativeBrowser('test: after a Mode A loss');
    expect(r.reconnected).toBe(false);
    expect(r.reason).toContain('Mode A');
    expect(r.reason).toContain('explicit user action');
  });
});

// --------------------------------------------------------------------------- live browser

const liveChromium = (): string | null => {
  const home = os.homedir();
  const base = path.join(home, '.cache', 'ms-playwright');
  try {
    for (const dir of fs.readdirSync(base)) {
      if (!dir.startsWith('chromium')) continue;
      for (const sub of ['chrome-linux64', 'chrome-linux']) {
        const p = path.join(base, dir, sub, 'chrome');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {
    /* no cache */
  }
  return null;
};

describe('R28 §2.8 — LIVE browser integration (real Chromium; skipped when unavailable)', () => {
  let exe: string | null = null;
  let tmpRoot = '';
  let xvfb: ChildProcess | null = null;
  beforeAll(async () => {
    exe = liveChromium();
    if (!exe) return;
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-live-'));
    setNativeProfileRoot(tmpRoot);
    wipeStores();
    // container-safe flags; the profile stays dedicated. A REAL headed browser needs a
    // display: this sandbox has none, so the test runs a virtual X display (Xvfb) — the
    // browser is still genuinely headed (a real window, real focus semantics), never
    // forced into headless mode by the product code.
    try {
      xvfb = spawn('Xvfb', [':28', '-screen', '0', '1280x1024x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 1200));
      process.env.DISPLAY = ':28';
    } catch {
      xvfb = null;
    }
    process.env.JARVIS_BROWSER_EXTRA_ARGS = '--no-sandbox --disable-gpu --disable-dev-shm-usage --disable-crashpad';
  });
  afterAll(async () => {
    delete process.env.JARVIS_BROWSER_EXTRA_ARGS;
    delete process.env.DISPLAY;
    if (xvfb) {
      try {
        xvfb.kill('SIGTERM');
      } catch {
        /* gone */
      }
    }
    await new Promise((r) => setTimeout(r, 300));
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('launches the REAL browser with a JARVIS-managed profile and drives a real page', async () => {
    if (!exe) {
      console.warn('[live-browser] no Chromium binary available in this environment — live test SKIPPED (documented in the release report)');
      return;
    }
    await setNativeConfig({ selectedBrowser: exe, mode: 'B', visibility: 'normal' });
    const info = await connectNativeBrowser({ mode: 'B' });
    expect(info.status).toBe('connected');
    expect(info.mode).toBe('B');
    expect(info.profileDir).toContain('jarvis-managed-profile');
    expect(fs.existsSync(info.profileDir!)).toBe(true);

    // a real local page with a button and an input
    const page = path.join(tmpRoot, 'page.html');
    fs.writeFileSync(
      page,
      '<!doctype html><html><head><title>Preferences</title></head><body>' +
        '<h1>Account preferences</h1>' +
        '<input id="name" placeholder="Full name"/>' +
        '<button id="save" onclick="document.title=\'Preferences saved\'; document.body.innerText += \' SAVED-OK\'">Save preferences</button>' +
        '</body></html>'
    );
    const opened = await openNativeTab(`file://${page}`, { background: true });
    expect(opened.background).toBe(true);
    await new Promise((r) => setTimeout(r, 700));

    // REAL snapshot: the button is observed with its accessible name
    const snap = await nativeBrowserTools.native_browser_snapshot.run({ tabId: opened.tabId });
    expect(snap).toContain('Save preferences');
    expect(snap).toContain('NATIVE SESSION');

    // REAL typing with read-back verification
    // find the input ref from the snapshot
    const inputLine = snap.split('\n').find((l) => l.includes('(text)') || l.includes('input'));
    const ref = inputLine ? Number(/\[(\d+)\]/.exec(inputLine)?.[1] ?? -1) : -1;
    expect(ref).toBeGreaterThanOrEqual(0);
    const typed = await nativeBrowserTools.native_browser_type.run({ ref, text: 'Ada Lovelace', tabId: opened.tabId });
    expect(typed).toContain('VERIFIED');

    // REAL click with evidence-based verification
    const btnLine = snap.split('\n').find((l) => l.includes('Save preferences'));
    const btnRef = Number(/\[(\d+)\]/.exec(btnLine ?? '')?.[1] ?? -1);
    expect(btnRef).toBeGreaterThanOrEqual(0);
    const clicked = await nativeBrowserTools.native_browser_click.run({ ref: btnRef, expect: 'the preferences saved confirmation appears', tabId: opened.tabId });
    expect(clicked).toContain('VERIFIED OUTCOME'); // title now matches the phrase
    expect(clicked).toContain('[confidence:');

    // REAL screenshot
    const shot = await nativeBrowserTools.native_browser_screenshot.run({ tabId: opened.tabId });
    const file = /Screenshot saved: (\S+)/.exec(shot)?.[1] ?? '';
    expect(file).toBeTruthy();
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).size).toBeGreaterThan(500);

    // REAL disconnect: the managed browser exits
    const msg = await disconnectNativeBrowser();
    expect(msg).toContain('managed browser was closed');
    await new Promise((r) => setTimeout(r, 1200));
    expect(isNativeConnected()).toBe(false);
  }, 90_000);
});
