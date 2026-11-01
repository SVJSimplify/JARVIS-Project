/**
 * The holographic design kit injected into every visual JARVIS draws (inside the sandboxed iframe).
 * Models write plain markup with these classes and get a polished, consistent look without styling anything themselves.
 */
const FONT = "Futura, 'Futura PT', Jost, 'Century Gothic', 'Segoe UI', sans-serif";
const MONO = "'Cascadia Mono', Consolas, monospace";

const delays = (sel: string, n = 14): string =>
  Array.from({ length: n }, (_, i) => `${sel}:nth-child(${i + 1}){animation-delay:${120 + i * 70}ms}`).join('');

export const HOLO_CSS = `
:root{--holo:#5ff3ff;--holo-hot:#d8fdff;--holo-dim:#3fb4c4;--steel:#7fb2bb;--line:rgba(95,243,255,.22);--warn:#ffb454;--bad:#ff6b6b;--ok:#7dffb2;--accent:#5ff3ff;--hot:#d8fdff;--font:${FONT};--mono:${MONO}}
html,body{margin:0;background:transparent;color:var(--holo-hot);font:400 15px/1.55 var(--font)}
body{padding:22px 26px 30px}
h1{margin:0 0 6px;font-size:26px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--holo-hot);text-shadow:0 0 14px rgba(95,243,255,.6)}
h2{display:flex;align-items:center;gap:12px;margin:22px 0 10px;font-size:12px;font-weight:600;letter-spacing:.34em;text-transform:uppercase;color:var(--holo)}
h2::after{content:'';flex:1;height:1px;background:linear-gradient(90deg,var(--line),transparent)}
h3{margin:0 0 6px;font-size:13px;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:var(--steel)}
p{margin:0 0 10px;color:#bfe9ee}
a{color:var(--holo)}
.muted{color:var(--steel)}.hot{color:var(--holo-hot)}.glow{text-shadow:0 0 12px rgba(95,243,255,.7)}.warn{color:var(--warn)}.bad{color:var(--bad)}.ok{color:var(--ok)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:12px 0}
.card{position:relative;padding:14px 16px;background:linear-gradient(160deg,rgba(95,243,255,.10),rgba(95,243,255,.02));border:1px solid var(--line);box-shadow:inset 0 0 24px rgba(95,243,255,.05),0 0 16px rgba(95,243,255,.07)}
.card::before,.card::after{content:'';position:absolute;width:9px;height:9px;border:1px solid var(--holo)}
.card::before{top:-1px;left:-1px;border-right:0;border-bottom:0}
.card::after{right:-1px;bottom:-1px;border-left:0;border-top:0}
.k{font-size:11px;letter-spacing:.26em;text-transform:uppercase;color:var(--steel)}
.v{font-size:34px;font-weight:600;line-height:1.15;color:var(--holo-hot);text-shadow:0 0 16px rgba(95,243,255,.55);font-variant-numeric:tabular-nums}
.v small{margin-left:4px;font-size:14px;color:var(--steel);text-shadow:none}
.bar{position:relative;height:8px;margin:8px 0;overflow:hidden;background:rgba(95,243,255,.1)}
.bar>i{display:block;height:100%;width:50%;transform-origin:left;background:linear-gradient(90deg,var(--holo-dim),var(--holo));box-shadow:0 0 12px var(--holo);animation:barIn .9s cubic-bezier(.2,.8,.2,1) both .3s}
.row{display:grid;grid-template-columns:minmax(90px,170px) 1fr 64px;align-items:center;gap:12px;margin:8px 0}
.row .n{text-align:right;font-family:var(--mono);color:var(--holo)}
.row .bar{margin:0}
.flow{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:14px 0}
.node{padding:10px 16px;border:1px solid var(--holo);background:rgba(95,243,255,.08);letter-spacing:.06em;box-shadow:0 0 14px rgba(95,243,255,.25),inset 0 0 12px rgba(95,243,255,.08)}
.arrow{color:var(--holo);text-shadow:0 0 8px var(--holo)}
.arrow:empty::before{content:'→'}
.timeline{position:relative;margin:14px 0 14px 8px;padding-left:26px;border-left:1px solid var(--line)}
.timeline>*{position:relative;margin-bottom:16px}
.timeline>*::before{content:'';position:absolute;left:-31px;top:7px;width:9px;height:9px;border-radius:50%;background:var(--holo);box-shadow:0 0 10px var(--holo)}
.tag{display:inline-block;padding:2px 9px;border:1px solid var(--line);font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--holo)}
table{width:100%;margin:10px 0;border-collapse:collapse;font-size:14px}
th{padding:8px 12px;border-bottom:1px solid var(--holo);text-align:left;font-size:11px;font-weight:600;letter-spacing:.24em;text-transform:uppercase;color:var(--holo);text-shadow:0 0 8px rgba(95,243,255,.5)}
td{padding:9px 12px;border-bottom:1px solid var(--line);color:#cdeff3}
tr:hover td{background:rgba(95,243,255,.06)}
.list{margin:10px 0;padding:0;list-style:none}
.list>li{position:relative;padding:8px 0 8px 22px;border-bottom:1px solid var(--line)}
.list>li::before{content:'';position:absolute;left:4px;top:15px;width:6px;height:6px;background:var(--holo);box-shadow:0 0 8px var(--holo);transform:rotate(45deg)}
code,pre{font-family:var(--mono);color:var(--holo-hot)}
pre{overflow:auto;padding:12px 14px;background:rgba(0,0,0,.35);border:1px solid var(--line)}
hr{height:1px;margin:18px 0;border:0;opacity:.6;background:linear-gradient(90deg,transparent,var(--holo),transparent)}
svg{max-width:100%;height:auto;overflow:visible;font-family:var(--font);filter:drop-shadow(0 0 5px rgba(95,243,255,.45))}
svg [stroke]:not([stroke=none]):not([stroke*="var("]){stroke:var(--holo)}
svg :is(rect,circle,ellipse,polygon,path):not([fill]){fill:rgba(95,243,255,.08)}
svg text:not([fill]){fill:var(--holo-hot);letter-spacing:.04em}
.draw{stroke-dasharray:1000;stroke-dashoffset:1000;animation:draw 1.6s ease forwards .2s}
.pulse{animation:pulse 2.2s ease-in-out infinite}
body>*,.grid>*,.flow>*,.timeline>*,.list>*{animation:holoIn .55s cubic-bezier(.2,.8,.2,1) both}
${delays('body>*')}${delays('.grid>*')}${delays('.flow>*')}${delays('.timeline>*')}${delays('.list>*')}
@keyframes holoIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes barIn{from{transform:scaleX(0)}to{transform:scaleX(1)}}
@keyframes draw{to{stroke-dashoffset:0}}
@keyframes pulse{50%{opacity:.45}}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-thumb{background:rgba(95,243,255,.35)}::-webkit-scrollbar-track{background:transparent}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
`;
