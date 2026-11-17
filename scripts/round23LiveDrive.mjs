/**
 * ROUND 23 — LIVE END-TO-END ACTIVITY DRIVE (Linux, Xvfb, mock gateway).
 *
 * The REAL JARVIS app (real main process, real renderer, real coordinator-free turn
 * loop) is pointed at a scripted local gateway on the app's real BASE_URL
 * (localhost:20128). The gateway issues TWO REAL TOOL CALLS (calculate, list_files)
 * and then the final answer — so the tool engine, permission gate, invocation ledger,
 * progress snapshots and IPC all run for real, and the driver watches the LIVE HEADER
 * SUMMARY update in the renderer as the tools execute.
 */
import { spawn } from 'child_process';
import { createServer } from 'http';
import { get as httpGet } from 'http';
import WebSocket from 'ws';
import * as fs from 'fs';

const OUT = '/tmp/r23-ui-shots';
const PORT = 9222;
const GW = 20128;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fetchJson = (url) =>
  new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); } }, 20000);
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

// ------------------------------------------------------------- mock gateway
let step = 0;
const gw = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/models') {
      res.end(JSON.stringify({ data: [{ id: 'mock-round23' }] }));
      return;
    }
    if (req.url?.endsWith('/chat/completions')) {
      step++;
      if (step === 1) {
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Running the requested checks.', tool_calls: [
            { id: 'call-1', type: 'function', function: { name: 'calculate', arguments: JSON.stringify({ expression: '2+2' }) } },
            { id: 'call-2', type: 'function', function: { name: 'list_files', arguments: JSON.stringify({ path: '.' } ) } },
          ] } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }));
      } else {
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Both checks ran. The calculation returned 4.' } }],
          usage: { prompt_tokens: 200, completion_tokens: 40 },
        }));
      }
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
gw.listen(GW);

// ------------------------------------------------------------- run the real app
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
    } catch { /* booting */ }
  }
  if (!target) throw new Error('app window never appeared');
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await sleep(2500);

  const summaryText = () => evalJs(cdp, `document.querySelector('[aria-label^="Tool activity"]')?.textContent.trim().replace(/\\s+/g, ' ') ?? null`);

  console.log('[live] header before any activity:', JSON.stringify(await summaryText()));

  // Point the REAL app at the mock model (settings.set → main process), then run the
  // REAL turn: renderer → ipc ai-chat → provider → mock gateway → REAL tools.
  await evalJs(cdp, `window.electronAPI.settings.set({ model: 'mock-round23' })`);
  await sleep(400);
  const reply = await evalJs(cdp, `window.electronAPI.ai.chat('run the two checks', () => undefined, () => undefined)`);
  console.log('[live] turn reply:', JSON.stringify(String(reply).slice(0, 90)));
  await sleep(500);

  const after = await summaryText();
  console.log('[live] header after the turn:', JSON.stringify(after));
  const snap = await evalJs(cdp, `(async () => {
    const s = await window.electronAPI.progress.get();
    return { invocations: s.invocations ?? null, turnCalls: s.turn?.calls ?? null, turnDone: s.turn?.done ?? null };
  })()`);
  console.log('[live] progress snapshot:', JSON.stringify(snap));

  // The full per-invocation history is queryable from the renderer:
  const q = await evalJs(cdp, `(async () => {
    const r = await window.electronAPI.activity.query({});
    return { scope: r.scope, total: r.total, tools: r.records.map((x) => x.tool), states: r.records.map((x) => x.state), ms: r.records.map((x) => x.ms) };
  })()`);
  console.log('[live] activity.query:', JSON.stringify(q));

  // Scope list + expanded popover with REAL records:
  const scopes = await evalJs(cdp, `(async () => (await window.electronAPI.activity.scopes()).map((s) => s.scope + ':' + s.calls))()`);
  console.log('[live] activity.scopes:', JSON.stringify(scopes));
  await evalJs(cdp, `[...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').startsWith('Tool activity')).click()`);
  await sleep(700);
  const pop = await evalJs(cdp, `(() => {
    const rows = [...document.querySelectorAll('li')].map((x) => x.textContent.trim().replace(/\\s+/g, ' ')).slice(0, 8);
    return { rows };
  })()`);
  console.log('[live] popover rows:', JSON.stringify(pop));
  await shot(cdp, 'live-popover-with-records');

  // Settings → Activity shows the same REAL history (the relocated interface):
  await evalJs(cdp, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); 'esc'`);
  await sleep(300);
  await evalJs(cdp, `[...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '') === 'Provider settings').click()`);
  await sleep(600);
  await evalJs(cdp, `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Activity').click()`);
  await sleep(900);
  const actState = await evalJs(cdp, `(() => ({
    summary: document.querySelector('[data-testid="activity-summary"]')?.textContent.trim().replace(/\\s+/g, ' ') ?? null,
    rows: [...document.querySelectorAll('li')].length,
  }))()`);
  console.log('[live] settings-activity:', JSON.stringify(actState));
  await shot(cdp, 'live-settings-activity');
  console.log('[ui-live] DONE');
  cdp.close();
  app.kill('SIGTERM');
  gw.close();
  process.exit(0);
} catch (e) {
  console.error('[ui-live] FAILED:', e.message);
  app.kill('SIGTERM');
  gw.close();
  process.exit(1);
}
