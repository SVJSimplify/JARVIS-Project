/**
 * ROUND 23 — REAL-APP UI DRIVER (Linux, Xvfb).
 *
 * Launches the REAL JARVIS app (`electron .` — the true main process with all IPC
 * handlers), connects to it over the Chrome DevTools Protocol, and drives the ACTUAL
 * renderer through the Round 23 flows:
 *
 *   header summary present at three desktop sizes → expand popover → Settings →
 *   Activity section → Transcript section → back out.
 *
 * Screenshots land in /tmp/r23-ui-shots. Nothing in the app is modified.
 */
import { spawn } from 'child_process';
import { get as httpGet } from 'http';
import WebSocket from 'ws';
import * as fs from 'fs';

const OUT = '/tmp/r23-ui-shots';
const PORT = 9222;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchJson = (url) =>
  new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.id && this.pending.has(msg.id)) { const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); }
  }); }
  static async connect(url) { return new Promise((resolve, reject) => { const ws = new WebSocket(url, { perMessageDeflate: false }); ws.on('open', () => resolve(new Cdp(ws))); ws.on('error', reject); }); }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 15000);
    });
  }
  close() { this.ws.close(); }
}

const evalJs = async (cdp, expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`renderer error: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
  return r.result?.value;
};

const shot = async (cdp, name) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'));
};

const app = spawn('npx', ['electron', '.', '--no-sandbox', `--remote-debugging-port=${PORT}`], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, DISPLAY: process.env.DISPLAY ?? ':99', NODE_ENV: 'production', JARVIS_FILES_ROOT: '/tmp/jarvis-startup-check-r23' },
  stdio: 'ignore',
});

try {
  let target = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const list = await fetchJson(`http://127.0.0.1:${PORT}/json/list`);
      target = list.find((t) => t.type === 'page' && !/devtools/i.test(t.url));
      if (target) break;
    } catch { /* not up yet */ }
  }
  if (!target) throw new Error('the real app window never appeared');

  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await sleep(3000); // React mount + first pulls

  const SIZES = [
    { name: 'min-1000x700', width: 1000, height: 700 },
    { name: 'mid-1180x800', width: 1180, height: 800 },
    { name: 'full-1400x900', width: 1400, height: 900 },
  ];

  for (const s of SIZES) {
    // REAL window resize (Browser domain): a true desktop resize, not an emulation.
    let resized = false;
    try {
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: target.id });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: s.width, height: s.height, windowState: 'normal' } });
      resized = true;
    } catch {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: s.width, height: s.height, deviceScaleFactor: 1, mobile: false });
    }
    await sleep(900);
    const probe = await evalJs(cdp, `(() => {
      const btns = [...document.querySelectorAll('button')];
      const b = btns.find((x) => (x.getAttribute('aria-label') || '').startsWith('Tool activity'));
      return { width: window.innerWidth, buttons: btns.length, summary: !!b, summaryText: b ? b.textContent.trim().replace(/\\s+/g, ' ') : null,
               invocations: (typeof window.electronAPI !== 'undefined') ? 'bridge-ok' : 'no-bridge' };
    })()`);
    console.log(`[probe] ${s.name} (resized=${resized}): ${JSON.stringify(probe)}`);
    await shot(cdp, `header-${s.name}`);
    if (probe.summary) {
      await evalJs(cdp, `[...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').startsWith('Tool activity')).click()`);
      await sleep(700);
      const pop = await evalJs(cdp, `(() => {
        const el = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('Full history'));
        return { popoverOpen: !!el, rows: document.querySelectorAll('li').length };
      })()`);
      console.log(`[popover] ${s.name}: ${JSON.stringify(pop)}`);
      await shot(cdp, `popover-${s.name}`);
      await evalJs(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'esc'`);
      await sleep(300);
    }
  }

  // Settings → Activity (the relocated section), driven like a user.
  await evalJs(cdp, `[...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '') === 'Provider settings').click()`);
  await sleep(700);
  const nav = await evalJs(cdp, `(() => {
    const btns = [...document.querySelectorAll('button')];
    const act = btns.find((x) => x.textContent.trim() === 'Activity');
    const tra = btns.find((x) => x.textContent.trim() === 'Transcript');
    const prov = btns.find((x) => x.textContent.trim() === 'Provider & Voice');
    if (act) act.click();
    return { activity: !!act, transcript: !!tra, provider: !!prov };
  })()`);
  await sleep(1000);
  const actState = await evalJs(cdp, `(() => {
    const sel = document.querySelector('select');
    return { summaryVisible: !!document.querySelector('[data-testid="activity-summary"]'),
             summaryText: document.querySelector('[data-testid="activity-summary"]')?.textContent.trim().replace(/\\s+/g, ' ') ?? null,
             scopeOptions: sel ? sel.options.length : 0 };
  })()`);
  console.log(`[settings] nav=${JSON.stringify(nav)} activity=${JSON.stringify(actState)}`);
  await shot(cdp, 'settings-activity-1400x900');

  await evalJs(cdp, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Transcript').click()`);
  await sleep(700);
  const traState = await evalJs(cdp, `(() => {
    const h2 = [...document.querySelectorAll('h2')].map((x) => x.textContent.trim());
    return { transcriptTitle: h2.includes('Transcript'), emptyState: document.body.textContent.includes('Nothing heard yet.') };
  })()`);
  console.log(`[settings] transcript=${JSON.stringify(traState)}`);
  await shot(cdp, 'settings-transcript-1400x900');

  // Back out: Escape closes Settings; the execution view must be intact.
  await evalJs(cdp, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'esc'`);
  await sleep(600);
  const after = await evalJs(cdp, `(() => ({ settingsClosed: !document.querySelector('[aria-label="Settings"]'), header: !!document.querySelector('header') }))()`);
  console.log(`[return] ${JSON.stringify(after)}`);

  console.log('[ui-drive] DONE');
  cdp.close();
  app.kill('SIGTERM');
  process.exit(0);
} catch (e) {
  console.error('[ui-drive] FAILED:', e.message);
  app.kill('SIGTERM');
  process.exit(1);
}
