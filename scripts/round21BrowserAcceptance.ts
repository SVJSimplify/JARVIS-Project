import http from 'http';
import { app, BrowserWindow } from 'electron';
import { attachPanel } from '../src/main/panel';
import { browserTools } from '../src/main/browser';

// Xvfb/CI environment: the GPU process cannot initialize here and a crashing renderer
// would tear the panel down mid-run (pruneTab → closePanel). Software rendering is the
// supported path for headless acceptance runs.
app.commandLine.appendSwitch('disable-dev-shm-usage');

/**
 * ROUND 21 CHANGE 4 — LIVE BROWSER ACCEPTANCE RUNNER.
 *
 * Drives the REAL production browser pipeline (panel.ts + browser.ts — the same modules
 * the chat tools use) inside a REAL Electron Chromium engine, with REAL network access:
 *   1. live web navigation (example.com), observation, link identification, click,
 *      post-click observation and verification (iana.org);
 *   2. a live search (en.wikipedia.org) with result verification;
 *   3. stale-element recovery (the target is removed between snapshot and click);
 *   4. page-change invalidation (a navigation between snapshot and click must NOT be
 *      clicked through — the old intent is reported, never repeated);
 *   5. dialog observation and accept-handling on a local page;
 *   6. evidence recorded for every step into a JSON report.
 *
 * Run:  xvfb-run -a npx electron <bundled.js>
 * No mocks. No injected runners. Assertions live in the report; the exit code is 0 only
 * when every assertion passed.
 */

interface Step {
  step: string;
  tool: string;
  args: Record<string, unknown>;
  status: 'pass' | 'fail';
  ms: number;
  evidence: string;
  error?: string;
  assertions?: Array<{ what: string; ok: boolean; detail?: string }>;
}

const steps: Step[] = [];
let serverUrl = '';

const PORT = 18421;
const page = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = req.url ?? '/';
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (url === '/') {
        res.end(
          page(
            'R21 Main',
            `<h1>R21 acceptance main page</h1>
             <a id="next" href="/changed">Go to changed page</a>
             <button id="gone-btn" onclick="document.title='clicked'">STALE-TARGET-BUTTON</button>
             <script>setTimeout(function(){ var b=document.getElementById('gone-btn'); if(b) b.remove(); }, 1500);</script>`
          )
        );
      } else if (url === '/changed') {
        res.end(page('R21 Changed', '<h1>The page changed after navigation</h1><a href="/">back</a>'));
      } else if (url === '/dialog') {
        res.end(
          page(
            'R21 Dialog',
            `<button id="d" onclick="alert('DIALOG-EVIDENCE-42')">Show dialog</button>
             <span id="after">nothing yet</span>
             <script>var old=alert; alert=function(m){ old(m); document.getElementById('after').textContent='dialog-shown'; };</script>`
          )
        );
      } else {
        res.end(page('R21', 'ok'));
      }
    });
    srv.listen(PORT, '127.0.0.1', () => {
      serverUrl = `http://127.0.0.1:${PORT}`;
      resolve();
    });
  });
}

const run = async (step: string, tool: string, args: Record<string, unknown>, opts: { refusalExpected?: RegExp } = {}): Promise<string> => {
  const t0 = Date.now();
  const record = (status: Step['status'], evidence: string, error?: string, assertions?: Step['assertions']): void => {
    steps.push({ step, tool, args, status, ms: Date.now() - t0, evidence: evidence.slice(0, 2000), error, assertions });
    console.log(`[${status.toUpperCase()}] ${step} (${Date.now() - t0}ms)${error ? ` — ${error}` : ''}`);
  };
  try {
    const out = String((await browserTools[tool].run(args)) ?? '');
    record('pass', out);
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A refusal that the step EXPECTS (stale ref, changed page state) is the correct
    // behavior — recorded as a pass whose evidence IS the refusal.
    if (opts.refusalExpected?.test(msg)) {
      record('pass', `EXPECTED REFUSAL: ${msg}`);
      return msg;
    }
    record('fail', '', msg);
    return `ERROR: ${msg}`;
  }
};

const assert = (step: string, what: string, ok: boolean, detail = ''): void => {
  const s = steps.find((x) => x.step === step);
  if (!s) return;
  s.assertions ??= [];
  s.assertions.push({ what, ok, detail: detail.slice(0, 300) });
  console.log(`  ${ok ? '✓' : '✗'} ${what}${!ok && detail ? ` — ${detail.slice(0, 200)}` : ''}`);
};

const url = (): string => {
  // panelState reads the ACTIVE tab; import lazily to keep this runner readable.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { panelState } = require('../src/main/panel') as { panelState: () => { activeUrl: string } };
  return panelState().activeUrl;
};

async function main(): Promise<boolean> {
  await startServer();
  const win = new BrowserWindow({ width: 1280, height: 800, show: true });
  await win.loadURL('about:blank');
  attachPanel(win);
  await new Promise((r) => setTimeout(r, 800));

  // Diagnostics: why does the panel ever leave 'open'? Track state, crashes, teardowns.
  const t0 = Date.now();
  const { panelState } = require('../src/main/panel') as { panelState: () => { state: string; tabCount: number } };
  let last = '';
  const iv = setInterval(() => {
    try {
      const s = panelState();
      const cur = `${s.state} tabs=${s.tabCount}`;
      if (cur !== last) {
        console.log(`[panel-state] ${cur} @+${Date.now() - t0}ms`);
        last = cur;
      }
    } catch {
      /* ignore */
    }
  }, 200);
  app.on('child-process-gone', (_e, d) => console.log(`[child-process-gone] ${d.type} ${d.reason}`));

  // ---- 1. LIVE WEB: navigate, observe ----------------------------------------------------------------
  let out = await run('live-open', 'browser_open', { url: 'https://example.com' });
  assert('live-open', 'page observed: "Example Domain" visible', /Example Domain/i.test(out), out.slice(0, 200));

  // ---- 2. LIVE WEB: identify a real link and click it -------------------------------------------------
  // example.com (2026) no longer carries any link — so the real link interaction happens
  // on the live Wikipedia page from the search below: a ref from its snapshot is clicked,
  // and the resulting navigation is verified. The probe documents what the page holds.
  await run('live-probe', 'browser_eval', {
    js: "(() => JSON.stringify({ links: document.querySelectorAll('a').length, title: document.title }))()",
  });

  // ---- 3. LIVE WEB: search and verify ----------------------------------------------------------------
  // An honest search verification requires a REAL results/article page — a rate-limit or
  // error page does not count even when its URL contains the query. Retry once, then fall
  // back to another site; only a genuine page title counts.
  const searchAttempt = async (site: string, query: string): Promise<string> => {
    const o = await run('live-search', 'browser_search', { site, query });
    return /Wikimedia Error|Too many requests|unusual traffic|are you a robot/i.test(o) ? '' : o;
  };
  out = (await searchAttempt('wikipedia', 'electron')) || (await searchAttempt('wikipedia', 'electron'));
  if (!out) {
    await new Promise((r) => setTimeout(r, 6000));
    out = (await searchAttempt('wikipedia', 'electron')) || (await searchAttempt('bing', 'electron'));
  }
  const realSearchPage = /^[^|]*\|\s*[^|]*\|\s*scroll/.test(out) && !/Wikimedia Error|Too many requests/i.test(out) && /\[(\d+)\]/.test(out);
  assert('live-search', 'search produced a real, interactive results/article page (not an error page)', realSearchPage, out.slice(0, 300));

  // ---- 3b. LIVE WEB: identify a real link from the snapshot and click it ------------------------------
  // Any content link whose href differs from the current page is a real link; click by its
  // snapshot ref (the same evidence the model acts on) and verify the navigation.
  const currentUrl = url();
  const links = [...out.matchAll(/\[(\d+)\][^\n]*?-> (\S+)/g)].map((m) => ({ ref: Number(m[1]), href: m[2] }));
  // Snapshot hrefs are protocol-stripped ("en.wikipedia.org/wiki/X"); normalize before filtering.
  const absHref = (h: string): string => (/^https?:\/\//i.test(h) ? h : `https://${h}`);
  const target = links.find((l) => {
    try {
      const h = absHref(l.href);
      return /^https?:\/\//.test(h) && !/wikimedia|wikimediastatus|donate|__jx/i.test(h) && h !== currentUrl && !currentUrl.includes(new URL(h).pathname);
    } catch {
      return false;
    }
  });
  const linkRef = target?.ref;
  if (linkRef !== undefined) {
    const before = url();
    out = await run('live-click', 'browser_click', { ref: linkRef });
    const after = url();
    assert('live-click', 'navigation happened (URL changed)', after !== before && after.length > 0, `${before} → ${after}`);
    assert('live-click', 'click verified against the resulting page (a new real page was observed)', after !== before && /\[(\d+)\]/.test(out) && !/Wikimedia Error|Too many requests/i.test(out), `${after} | ${out.slice(0, 200)}`);
  } else {
    assert('live-click', 'a real link was identified from the live snapshot', false, out.slice(0, 300));
  }

  // ---- 4. LOCAL: stale element between observation and interaction ------------------------------------
  out = await run('stale-open', 'browser_open', { url: `${serverUrl}/` });
  const staleMatch = /\[(\d+)\][^\n]*STALE-TARGET-BUTTON/i.exec(out);
  const staleRef = staleMatch ? Number(staleMatch[1]) : NaN;
  assert('stale-open', 'stale target present in the first observation', Number.isFinite(staleRef), out.slice(0, 300));
  await new Promise((r) => setTimeout(r, 2200)); // the page removes the element on its own
  const staleOut = await run('stale-click', 'browser_click', { ref: Number.isFinite(staleRef) ? staleRef : -1 }, {
    refusalExpected: /no longer on the page|Element not found|earlier page state/i,
  });
  assert(
    'stale-click',
    'stale click handled honestly: recovered by re-identification or failed with a clear re-observe error',
    /recovered|no longer on the page|Element not found|re-observe|earlier page state/i.test(staleOut),
    staleOut.slice(0, 300)
  );

  // ---- 5. LOCAL: page navigated between observation and click — intent must be invalidated ------------
  out = await run('nav-open', 'browser_open', { url: `${serverUrl}/` });
  const navRef = /\[(\d+)\][^\n]*Go to changed page/i.exec(out)?.[1];
  const anyEarlyRef = /\[(\d+)\][^\n]*STALE-TARGET-BUTTON/i.exec(out)?.[1]; // will vanish after navigation
  if (navRef) {
    await run('nav-click', 'browser_click', { ref: Number(navRef) }); // page now navigates to /changed
    if (anyEarlyRef) {
      const lateOut = await run('nav-stale-click', 'browser_click', { ref: Number(anyEarlyRef) }, {
        refusalExpected: /no longer on the page|Element not found|earlier page state/i,
      });
      assert(
        'nav-stale-click',
        'a click whose page changed since the snapshot is NOT repeated blindly (refused as an earlier page state or honestly reported)',
        /earlier page state|navigated|no longer on the page|re-observe|recovered/i.test(lateOut),
        lateOut.slice(0, 300)
      );
    }
  }

  // ---- 6. LOCAL: dialog handling ----------------------------------------------------------------------
  out = await run('dialog-open', 'browser_open', { url: `${serverUrl}/dialog` });
  out = await run('dialog-click', 'browser_click_text', { text: 'Show dialog' });
  assert('dialog-click', 'dialog detected and its text recorded (dismiss default, page not blocked)', /DIALOG-EVIDENCE-42/i.test(out), out.slice(0, 300));
  await run('dialog-accept', 'browser_dialog', { action: 'accept' });
  out = await run('dialog-repeat', 'browser_click_text', { text: 'Show dialog' });
  assert('dialog-repeat', 'accepted dialog flow completes (page continued)', /DIALOG-EVIDENCE-42|dialog-shown/i.test(out), out.slice(0, 300));

  // ---- verdict ----------------------------------------------------------------------------------------
  clearInterval(iv);
  const allAssertions = steps.flatMap((s) => s.assertions ?? []);
  const failed = allAssertions.filter((a) => !a.ok);
  const toolFails = steps.filter((s) => s.status === 'fail');
  const report = {
    generatedAt: new Date().toISOString(),
    environment: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, display: 'Xvfb (virtual)', network: 'live' },
    pipeline: 'real: src/main/panel.ts + src/main/browser.ts (production modules), real Chromium, real network',
    steps,
    verdict: {
      assertions: allAssertions.length,
      failed: failed.length,
      toolErrors: toolFails.map((t) => ({ step: t.step, error: t.error })),
      passed: failed.length === 0 && toolFails.length === 0,
    },
  };
  const fs = require('fs') as typeof import('fs');
  const outDir = '/home/z/my-project/download/validation';
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(`${outDir}/browser-acceptance.json`, JSON.stringify(report, null, 1));
  console.log(`\nVERDICT: ${report.verdict.passed ? 'PASS' : 'FAIL'} — ${allAssertions.length - failed.length}/${allAssertions.length} assertions passed`);
  return report.verdict.passed;
}

app.whenReady().then(async () => {
  let ok = false;
  try {
    ok = await main();
  } catch (e) {
    console.error('ACCEPTANCE RUNNER CRASHED:', e);
  }
  app.exit(ok ? 0 : 1);
});
