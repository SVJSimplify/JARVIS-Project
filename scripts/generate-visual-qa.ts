/**
 * Builds download/JARVIS_VISUAL_QA_KIT.html — a standalone, zero-JS page that renders the
 * ten representative showcase cases with the REAL production kit (holoKit CSS + visualIR
 * renderer), under the same CSP the sandboxed iframe enforces. Open it in any browser.
 * Run: npx vite-node scripts/generate-visual-qa.ts
 */
import { writeFileSync } from 'node:fs';
import { HOLO_CSS, VISUAL_CSP } from '../src/renderer/lib/holoKit';
import { normalizeVisual, renderVisual } from '../src/renderer/lib/visualIR';

const body = (blocks: unknown[]): string => {
  const { ir } = normalizeVisual({ blocks });
  return ir ? renderVisual(ir) : '<div class="callout bad"><b>Not rendered</b><p>case failed to normalise</p></div>';
};
const legacy = (html: string): string => html;

const panel = (n: number, name: string, note: string, inner: string): string => `
<section class="case">
  <div class="case-head"><span class="case-no">CASE ${n}</span><h3>${name}</h3><span class="case-note">${note}</span></div>
  <div class="holo-panel">
    <div class="holo-chrome"><span class="holo-dot"></span><span class="holo-title">Case ${n} — ${name}</span><span class="holo-x">✕</span></div>
    <div class="holo-rule"></div>
    <div class="holo-body">${inner}</div>
  </div>
</section>`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${VISUAL_CSP}">
<title>JARVIS Visual QA Kit — showcase engine v2</title>
<style>
${HOLO_CSS}
/* ---- kit chrome (not part of the shipped kit; mirrors index.css panel styling) ---- */
html{background:#000}
.kit{max-width:1160px;margin:0 auto;padding:32px 24px 80px}
.kit-title{font:600 22px/1.3 var(--font);letter-spacing:.12em;text-transform:uppercase;color:#d8fdff;text-shadow:0 0 14px rgba(95,243,255,.55);margin:0 0 4px}
.kit-sub{color:#8fc3cc;font-size:13px;margin:0 0 28px}
.case{margin:0 0 40px}
.case-head{display:flex;align-items:baseline;gap:14px;margin:0 0 10px}
.case-no{font:600 11px var(--font);letter-spacing:.22em;color:#5ff3ff;border:1px solid rgba(95,243,255,.25);padding:3px 8px}
.case-head h3{margin:0;font-size:14px;letter-spacing:.08em;color:#d8fdff}
.case-note{color:#5b7c82;font-size:12px;margin-left:auto}
.holo-panel{position:relative;border:1px solid rgba(95,243,255,.55);background:linear-gradient(180deg,rgba(95,243,255,.08),rgba(95,243,255,.015) 45%,rgba(95,243,255,.06)),rgba(2,14,20,.92);box-shadow:inset 0 0 60px rgba(95,243,255,.07),0 0 26px rgba(95,243,255,.25);border-radius:2px}
.holo-chrome{display:flex;align-items:center;gap:10px;padding:12px 20px}
.holo-dot{width:8px;height:8px;border-radius:9999px;background:#5ff3ff;box-shadow:0 0 10px #5ff3ff}
.holo-title{font:600 13px var(--font);letter-spacing:.42em;text-transform:uppercase;color:#d8fdff;text-shadow:0 0 12px rgba(95,243,255,.8)}
.holo-x{margin-left:auto;color:rgba(95,243,255,.7)}
.holo-rule{height:1px;margin:0 20px;background:linear-gradient(90deg,rgba(95,243,255,.9),rgba(95,243,255,.2) 60%,transparent)}
.holo-body{padding:0;overflow:hidden}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
</head>
<body>
<div class="kit">
<h1 class="kit-title">JARVIS Visual QA Kit</h1>
<p class="kit-sub">Showcase engine v2 — rendered with the real holoKit CSS + visualIR renderer under the real iframe CSP. Scroll and inspect each case.</p>
${panel(1, 'Simple summary', 'stats + note + tags', body([
  { type: 'stats', items: [
    { k: 'Battery', v: '5,200', unit: 'mAh', hint: 'Measured at 50% brightness' },
    { k: 'Weight', v: '206', unit: 'g', tone: 'ok' },
    { k: 'Price', v: '₹46,999', tone: 'warn', hint: 'Flagged: volatile' },
    { k: 'Refresh', v: '120', unit: 'Hz' },
  ] },
  { type: 'note', tone: 'info', title: 'Verdict', text: 'Strong battery life for the class; the price is the only concern this quarter.' },
  { type: 'tags', items: ['flagship', '2026', 'verified', 'in stock'] },
]))}
${panel(2, 'Technical explainer', 'text + flow + svg', body([
  { type: 'text', heading: 'What happens when you type a URL', body: 'The browser checks its caches, resolves the name, opens a connection and requests the page. Each hop has a cost, and each hop can fail differently.' },
  { type: 'flow', steps: [
    { label: 'Cache', note: 'browser → OS → resolver' },
    { label: 'DNS', note: 'name → IP' },
    { label: 'TCP', note: 'handshake' },
    { label: 'TLS', note: 'certificate check' },
    { label: 'HTTP', note: 'request / response' },
  ] },
  { type: 'svg', markup: '<svg viewBox="0 0 520 120" role="img"><line class="draw" x1="20" y1="60" x2="150" y2="60" stroke-width="2"/><line class="draw" x1="190" y1="60" x2="320" y2="60" stroke-width="2"/><line class="draw" x1="360" y1="60" x2="490" y2="60" stroke-width="2"/><circle cx="170" cy="60" r="14" class="pulse"/><circle cx="340" cy="60" r="14" class="pulse"/><text x="20" y="34">Client</text><text x="210" y="34">Resolver</text><text x="395" y="34">Origin</text></svg>' },
]))}
${panel(3, 'Large comparison table', '10 rows · long values · right-aligned numbers', body([
  { type: 'table', columns: [{ label: 'Model' }, { label: 'Weight', align: 'right' }, { label: 'Battery', align: 'right' }, { label: 'Verdict', align: 'center' }], rows: [
    ['iQOO 13', '206 g', '5,200 mAh', 'BUY'],
    ['OnePlus 13', '213 g', '6,000 mAh', 'BUY'],
    ['Samsung Galaxy S25 Ultra with the full official long model name', '218 g', '5,000 mAh', 'WAIT'],
    ['Pixel 10 Pro XL (very long second cell text that must wrap and never push the layout)', '223 g', '5,200 mAh', 'WAIT'],
    ['Xiaomi 15 Ultra', '226 g', '5,410 mAh', 'HOLD'],
    ['Realme GT 7 Pro', '222 g', '6,500 mAh', 'BUY'],
    ['Vivo X200 Pro', '223 g', '6,000 mAh', 'HOLD'],
    ['Nothing Phone (3)', '201 g', '5,150 mAh', 'WAIT'],
    ['Motorola Edge 60 Pro', '186 g', '6,000 mAh', 'BUY'],
    ['iPhone 17 Pro Max', '231 g', '5,088 mAh', 'HOLD'],
  ] },
]))}
${panel(4, 'Data visualisation', 'bars with tones', body([
  { type: 'bars', max: 100, items: [
    { label: 'Battery life', value: 92, display: '92' },
    { label: 'Display', value: 88, display: '88' },
    { label: 'Camera', value: 74, display: '74', tone: 'ok' },
    { label: 'Software support', value: 61, display: '61', tone: 'warn' },
    { label: 'Repairability', value: 23, display: '23', tone: 'bad' },
  ] },
  { type: 'note', tone: 'warn', title: 'Read this first', text: 'Scores are editorial, not measured; treat single-digit gaps as noise.' },
]))}
${panel(5, 'Multi-stage flowchart', 'five stages with notes', body([
  { type: 'flow', steps: [
    { label: 'Parse', note: 'intent + entities' },
    { label: 'Plan', note: 'steps + agents' },
    { label: 'Execute', note: 'tools, permissions' },
    { label: 'Verify', note: 'evidence vs criteria' },
    { label: 'Report', note: 'honest verdict' },
  ] },
]))}
${panel(6, 'Timeline', 'history view', body([
  { type: 'timeline', items: [
    { when: '2016', what: 'First consumer voice assistant with a screen — novelty phase, everything is a gimmick.' },
    { when: '2019', what: 'Offline speech arrives on phones; wake words stop needing the cloud.' },
    { when: '2022', what: 'Large language models make open dialogue possible; assistants become chat first.' },
    { when: '2024', what: 'Tool use matures: assistants run apps, browse, and act on the desktop.' },
    { when: '2026', what: 'Agentic era — planning, permissions and verified completion (this project).' },
  ] },
]))}
${panel(7, 'Long-form report', 'sections + kv + callout + list', body([
  { type: 'text', heading: 'Market position', body: 'The upper mid-range in 2026 is the most competitive segment in years. Three of the five devices below launched within eight weeks of each other, and specification sheets alone no longer separate them.' },
  { type: 'kv', items: [
    { k: 'Segment average price', v: '₹47,400' },
    { k: 'Cheapest credible option', v: '₹38,999', tone: 'ok' },
    { k: 'Most expensive tested', v: '₹62,990', tone: 'bad' },
  ] },
  { type: 'text', heading: 'Recommendation', body: 'Buy on battery and software policy, not on charging wattage. Everything else is noise at this price.' },
  { type: 'list', items: [
    { text: 'Two years of OS updates is the minimum acceptable policy now.', tone: 'warn' },
    { text: 'Verified repairability scores matter more than charger branding.' },
    { text: 'Avoid first-batch hardware; wait for the December firmware pass.', tone: 'bad' },
  ] },
]))}
${panel(8, 'Hostile content', 'long words · URLs · overflow attempts', body([
  { type: 'text', heading: 'Overflow stress', body: 'Supercalifragilisticexpialidocious_Donaudampfschifffahrtsgesellschaftskapitän Pneumonoultramicroscopicsilicovolcanoconiosis must wrap — and https://example.com/really/long/path/that/goes/on/and/on/and/never/seems/to/stop?query=abcdefghijklmnopqrstuvwxyz0123456789 is a URL that must break, not push.' },
  { type: 'table', columns: [{ label: 'Key' }, { label: 'Value' }], rows: [
    ['Tracking identifier', 'NA-2026-11-03-A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q7R8S9T0'],
    ['Endpoint', 'wss://gateway.internal.example-corp.net:8443/v2/streams/telemetry/subscribe?token=verylongtokenthatisnotasecretbutislong'],
  ] },
  { type: 'note', tone: 'bad', title: 'If you can read this without horizontal scrolling', text: 'the wrapping rules held. Nothing outside this panel should have moved.' },
]))}
${panel(9, 'Unicode & symbols', '₹ · Devanagari · CJK · arrows · math', body([
  { type: 'stats', items: [
    { k: 'भारत में कीमत', v: '₹1,29,999', unit: 'सहित' },
    { k: '日本語タイトル', v: '動作確認' },
    { k: 'Efficiency', v: '98.6', unit: '%' },
    { k: 'Delta', v: '−2.4 → +1.1' },
  ] },
  { type: 'list', items: [
    { text: 'Arrows and maths: → ← ↑ ↓ ⇒ ≈ ≠ ≤ ≥ ± × ÷ ∑ ∞ °' },
    { text: 'Devanagari: यह वाक्य सही ढंग से दिखना चाहिए।' },
    { text: 'CJK: この一文は正しく表示される必要があります。' },
    { text: 'Mixed script in one line: price ₹45k · 約2時間 · लगभग ३ घंटे.' },
  ] },
]))}
${panel(10, 'Missing fields', 'degraded data must not break the layout', body([
  { type: 'stats', items: [
    { k: 'Complete', v: '42' },
    { k: 'No hint', v: '7', unit: 'units' },
    { k: 'Value only', v: '—' },
  ] },
  { type: 'note', text: 'A note with no title still reads cleanly.' },
  { type: 'kv', items: [{ k: 'Known', v: 'yes' }, { k: 'Unknown', v: 'UNVERIFIED', tone: 'warn' }] },
]))}
${panel(11, 'Legacy raw HTML', 'escape-hatch path, same kit', legacy(
  '<h1>Legacy path</h1><h2>Still styled by the kit</h2><p>Raw markup keeps working for custom diagrams — sanitised, CSP-strapped, zero scripts.</p>' +
  '<div class="grid"><div class="card"><div class="k">Old class</div><div class="v">SAME<small>look</small></div></div>' +
  '<div class="card"><div class="k">Bars</div><div class="row"><span>One</span><div class="bar"><i style="width:70%"></i></div><span class="n">70%</span></div></div></div>' +
  '<div class="flow"><span class="node">Legacy</span><span class="arrow"></span><span class="node">Honoured</span></div>'
))}
</div>
</body>
</html>`;

const out = '/home/z/my-project/download/JARVIS_VISUAL_QA_KIT.html';
writeFileSync(out, html);
console.log(`Wrote ${out} (${html.length} bytes)`);
