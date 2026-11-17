/**
 * The holographic design kit injected into every visual JARVIS draws (inside the sandboxed iframe).
 * v2: the model may describe content via show_visual `blocks` (rendered by visualIR.ts) or send
 * legacy raw markup with the same class vocabulary. Either way this kit owns typography,
 * spacing, colour and overflow so the result is always on-brand and never broken.
 *
 * Identity (unchanged, by design): the visual panel is the one place the HUD uses colour —
 * holographic cyan light on near-black. Geometry, brackets, sweep and motion come from the
 * panel chrome in index.css; this kit styles only the content.
 */
import { FUTURA_CSS } from '../../main/fontFace';

/** Jost ships as static 500/700 faces; the range descriptor serves 400–700 without synthesis. */
const faces = (): string => {
  const urls = FUTURA_CSS.match(/url\(data:font\/woff2;base64,[^)]+\)/g) ?? [];
  const [medium, bold] = urls;
  if (!medium || !bold) return '';
  return `@font-face{font-family:Jost;font-weight:400 500;src:${medium} format('woff2')}` +
    `@font-face{font-family:Jost;font-weight:600 700;src:${bold} format('woff2')}`;
};

const FONT = "Futura, 'Futura PT', 'Futura Std', Jost, 'Century Gothic', 'Segoe UI', sans-serif";
const MONO = "'Cascadia Mono', Consolas, monospace";

const delays = (sel: string, n = 14): string =>
  Array.from({ length: n }, (_, i) => `${sel}:nth-child(${i + 1}){animation-delay:${120 + i * 70}ms}`).join('');

export const HOLO_CSS = `
${faces()}
:root{
  --holo:#5ff3ff;--holo-hot:#d8fdff;--holo-dim:#3fb4c4;--steel:#8fc3cc;--body:#bfe9ee;
  --line:rgba(95,243,255,.22);--line-soft:rgba(95,243,255,.13);
  --warn:#ffb454;--bad:#ff6b6b;--ok:#7dffb2;
  --accent:#5ff3ff;--hot:#d8fdff;--font:${FONT};--mono:${MONO};
  /* spacing scale — every gap in this kit comes from here */
  --s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:20px;--s6:24px;--s7:32px;
  --r:2px; --measure:75ch;
}
html,body{margin:0;background:transparent;color:var(--holo-hot);font:400 15px/1.6 var(--font)}
body{padding:var(--s6) var(--s7) var(--s7);overflow-x:hidden}
/* ---------- typography ---------- */
h1{margin:0 0 var(--s2);font-size:clamp(20px,2.4vw,25px);font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--holo-hot);text-shadow:0 0 14px rgba(95,243,255,.55);overflow-wrap:anywhere}
h2{display:flex;align-items:center;gap:var(--s3);margin:var(--s5) 0 var(--s2);font-size:12px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:var(--holo);overflow-wrap:anywhere}
h2::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent)}
h3{margin:var(--s3) 0 var(--s1);font-size:13px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--steel);overflow-wrap:anywhere}
p{margin:0 0 var(--s3);color:var(--body);max-width:var(--measure);overflow-wrap:anywhere}
p:last-child{margin-bottom:0}
.hint{margin:var(--s1) 0 0;font-size:12px;line-height:1.5;color:var(--steel);overflow-wrap:anywhere}
a{color:var(--holo)}
.muted{color:var(--steel)}.hot{color:var(--holo-hot)}.glow{text-shadow:0 0 12px rgba(95,243,255,.7)}
.warn{color:var(--warn)}.bad{color:var(--bad)}.ok{color:var(--ok)}
b,strong{font-weight:600;color:var(--holo-hot)}
/* ---------- cards & stats ---------- */
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:var(--s3);margin:var(--s3) 0}
.grid>*{min-width:0}
.card{position:relative;padding:var(--s4);background:linear-gradient(160deg,rgba(95,243,255,.10),rgba(95,243,255,.02));border:1px solid var(--line);border-radius:var(--r);box-shadow:inset 0 0 24px rgba(95,243,255,.05),0 0 16px rgba(95,243,255,.07);overflow:hidden}
.card::before,.card::after{content:'';position:absolute;width:9px;height:9px;border:1px solid var(--holo)}
.card::before{top:-1px;left:-1px;border-right:0;border-bottom:0}
.card::after{right:-1px;bottom:-1px;border-left:0;border-top:0}
.k{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--steel);overflow-wrap:anywhere}
.v{font-size:clamp(22px,3vw,34px);font-weight:600;line-height:1.15;color:var(--holo-hot);text-shadow:0 0 16px rgba(95,243,255,.5);font-variant-numeric:tabular-nums;overflow-wrap:anywhere;margin-top:var(--s1)}
.v small{margin-left:var(--s1);font-size:14px;font-weight:400;color:var(--steel);text-shadow:none;letter-spacing:0}
.v.ok{color:var(--ok)}.v.warn{color:var(--warn)}.v.bad{color:var(--bad)}
/* ---------- bars ---------- */
.bar{position:relative;height:8px;margin:var(--s2) 0;overflow:hidden;background:rgba(95,243,255,.1);border-radius:var(--r)}
.bar>i{display:block;height:100%;width:50%;transform-origin:left;background:linear-gradient(90deg,var(--holo-dim),var(--holo));box-shadow:0 0 12px var(--holo);animation:barIn .9s cubic-bezier(.2,.8,.2,1) both .3s;border-radius:var(--r)}
.bar>i.ok{background:linear-gradient(90deg,#2e8f5b,var(--ok))}
.bar>i.warn{background:linear-gradient(90deg,#8f6a2e,var(--warn))}
.bar>i.bad{background:linear-gradient(90deg,#8f3a3a,var(--bad))}
.row{display:grid;grid-template-columns:minmax(90px,180px) 1fr minmax(56px,auto);align-items:center;gap:var(--s3);margin:var(--s2) 0}
.row>span{overflow-wrap:anywhere;min-width:0}
.row .n{text-align:right;font-family:var(--mono);font-size:13px;color:var(--holo);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.row .bar{margin:0}
/* ---------- tables ---------- */
.tablewrap{margin:var(--s3) 0;border:1px solid var(--line-soft);border-radius:var(--r);overflow-x:auto;background:rgba(0,0,0,.18)}
table{width:100%;margin:0;border-collapse:collapse;font-size:13.5px}
th{padding:9px var(--s3);border-bottom:1px solid var(--holo);text-align:left;font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:var(--holo);text-shadow:0 0 8px rgba(95,243,255,.4);white-space:nowrap}
td{padding:9px var(--s3);border-bottom:1px solid var(--line-soft);color:#cdeff3;overflow-wrap:break-word}
tbody tr:last-child td{border-bottom:0}
tbody tr:nth-child(even) td{background:rgba(95,243,255,.03)}
tr:hover td{background:rgba(95,243,255,.06)}
.al-left{text-align:left}.al-right{text-align:right;font-variant-numeric:tabular-nums}.al-center{text-align:center}
td.al-right,th.al-right{text-align:right}
td.al-center,th.al-center{text-align:center}
/* ---------- flow / process ---------- */
.flow{display:flex;flex-wrap:wrap;align-items:center;gap:var(--s2);margin:var(--s4) 0}
.node{padding:10px var(--s4);border:1px solid var(--holo);background:rgba(95,243,255,.08);letter-spacing:.04em;box-shadow:0 0 14px rgba(95,243,255,.2),inset 0 0 12px rgba(95,243,255,.08);border-radius:var(--r);overflow-wrap:anywhere;text-align:center;min-width:0}
.node small{display:block;margin-top:var(--s1);max-width:24ch;font-size:11px;line-height:1.45;letter-spacing:.02em;color:var(--steel);text-transform:none}
.arrow{color:var(--holo);text-shadow:0 0 8px var(--holo)}
.arrow:empty::before{content:'→'}
/* ---------- timeline ---------- */
.timeline{position:relative;margin:var(--s4) 0 var(--s4) var(--s1);padding-left:var(--s5);border-left:1px solid var(--line)}
.timeline>*{position:relative;margin-bottom:var(--s4);overflow-wrap:anywhere}
.timeline>*:last-child{margin-bottom:var(--s1)}
.timeline>*::before{content:'';position:absolute;left:-25px;top:6px;width:9px;height:9px;border-radius:50%;background:var(--holo);box-shadow:0 0 10px var(--holo)}
.timeline b{display:block;margin-bottom:2px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--holo)}
.timeline p{margin:0;max-width:var(--measure)}
/* ---------- lists / tags / callouts / kv / compare ---------- */
.list{margin:var(--s3) 0;padding:0;list-style:none}
.list>li{position:relative;padding:var(--s2) 0 var(--s2) var(--s5);border-bottom:1px solid var(--line-soft);color:var(--body);overflow-wrap:anywhere}
.list>li:last-child{border-bottom:0}
.list>li::before{content:'';position:absolute;left:4px;top:15px;width:6px;height:6px;background:var(--holo);box-shadow:0 0 8px var(--holo);transform:rotate(45deg)}
.list>li.ok::before{background:var(--ok);box-shadow:0 0 8px var(--ok)}
.list>li.warn::before{background:var(--warn);box-shadow:0 0 8px var(--warn)}
.list>li.bad::before{background:var(--bad);box-shadow:0 0 8px var(--bad)}
.tagrow{display:flex;flex-wrap:wrap;gap:var(--s2);margin:var(--s3) 0}
.tag{display:inline-block;padding:3px 10px;border:1px solid var(--line);border-radius:var(--r);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--holo);overflow-wrap:anywhere}
.callout{position:relative;margin:var(--s3) 0;padding:var(--s3) var(--s4);border:1px solid var(--line);border-left:3px solid var(--holo);border-radius:var(--r);background:rgba(95,243,255,.06)}
.callout p{margin:0;max-width:none}
.callout b{display:block;margin-bottom:var(--s1);font-size:12px;letter-spacing:.16em;text-transform:uppercase}
.callout.ok{border-left-color:var(--ok)}.callout.ok b{color:var(--ok)}
.callout.warn{border-left-color:var(--warn);background:rgba(255,180,84,.05)}.callout.warn b{color:var(--warn)}
.callout.bad{border-left-color:var(--bad);background:rgba(255,107,107,.05)}.callout.bad b{color:var(--bad)}
.kv{margin:var(--s3) 0}
.kvrow{display:flex;align-items:baseline;justify-content:space-between;gap:var(--s4);padding:7px 0;border-bottom:1px solid var(--line-soft)}
.kvrow:last-child{border-bottom:0}
.kvrow .k{flex:0 1 auto}
.kvrow .v2{font-family:var(--mono);font-size:13px;color:var(--holo-hot);text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere;min-width:0}
.kvrow .v2.ok{color:var(--ok)}.kvrow .v2.warn{color:var(--warn)}.kvrow .v2.bad{color:var(--bad)}
.compare{display:grid;grid-template-columns:repeat(var(--cols,2),minmax(0,1fr));gap:var(--s3);margin:var(--s3) 0}
.compare .option{display:flex;flex-direction:column}
.compare .pts{margin-top:var(--s2);display:flex;flex-direction:column;gap:6px;min-width:0}
.compare .pt{display:flex;justify-content:space-between;gap:var(--s3);padding-bottom:6px;border-bottom:1px solid var(--line-soft);font-size:13px}
.compare .pt:last-child{border-bottom:0;padding-bottom:0}
.compare .pk{color:var(--steel);overflow-wrap:anywhere}
.compare .pv{color:var(--holo-hot);text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
/* ---------- code, svg, misc ---------- */
code,pre{font-family:var(--mono);color:var(--holo-hot)}
code{font-size:.92em;overflow-wrap:anywhere}
pre{overflow:auto;padding:var(--s3) var(--s4);background:rgba(0,0,0,.35);border:1px solid var(--line-soft);border-radius:var(--r)}
hr{height:1px;margin:var(--s5) 0;border:0;opacity:.6;background:linear-gradient(90deg,transparent,var(--holo),transparent)}
img{max-width:100%;height:auto}
.viz-svg{display:flex;justify-content:center;margin:var(--s3) 0}
svg{max-width:100%;height:auto;overflow:visible;font-family:var(--font);filter:drop-shadow(0 0 5px rgba(95,243,255,.45))}
svg [stroke]:not([stroke=none]):not([stroke*="var("]){stroke:var(--holo)}
svg :is(rect,circle,ellipse,polygon,path):not([fill]){fill:rgba(95,243,255,.08)}
svg text:not([fill]){fill:var(--holo-hot);font-size:13px;letter-spacing:.04em;overflow-wrap:normal}
.draw{stroke-dasharray:1000;stroke-dashoffset:1000;animation:draw 1.6s ease forwards .2s}
.pulse{animation:pulse 2.2s ease-in-out infinite}
/* graceful degradation: model omitted a field, the layout must not show a hole */
.v:empty,.k:empty,.n:empty,.hint:empty,.node:empty,.tag:empty,.callout p:empty,.list>li:empty,.timeline b:empty{display:none}
.node:not(:has(small)):not(:empty){padding:10px var(--s4)}
/* ---------- entrance motion ---------- */
body>*,.grid>*,.flow>*,.timeline>*,.list>*{animation:holoIn .55s cubic-bezier(.2,.8,.2,1) both}
${delays('body>*')}${delays('.grid>*')}${delays('.flow>*')}${delays('.timeline>*')}${delays('.list>*')}
@keyframes holoIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes barIn{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes pulse{50%{opacity:.45}}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-thumb{background:rgba(95,243,255,.35)}::-webkit-scrollbar-track{background:transparent}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
`;

/** No script-src on purpose: showcase content is data, never code. Animations are pure CSS. */
export const VISUAL_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** The full document handed to the sandboxed iframe: CSP, fonts, kit, content. */
export const visualFrameDoc = (html: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VISUAL_CSP}">` +
  `<style>${HOLO_CSS}</style></head><body>${html}</body></html>`;
