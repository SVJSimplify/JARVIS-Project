import { FUTURA_CSS, FUTURA_STACK } from './fontFace';
/** Tab strip shown at the top of the full-screen browser panel. */
const SCRIPT = `
var T=document.getElementById('t');
function send(o){console.log('__jtab__'+JSON.stringify(o));}
function setTabs(d){
  T.textContent='';
  d.tabs.forEach(function(tab,i){
    var e=document.createElement('div');e.className='tab'+(tab.id===d.active?' on':'');
    var l=document.createElement('span');l.className='l';l.textContent=tab.title||'New tab';
    var x=document.createElement('span');x.className='x';x.textContent='\\u00d7';
    x.onclick=function(ev){ev.stopPropagation();send({a:'close',i:i});};
    e.onclick=function(){send({a:'select',i:i});};
    e.appendChild(l);e.appendChild(x);T.appendChild(e);
  });
  var n=document.createElement('div');n.className='new';n.textContent='+';n.onclick=function(){send({a:'new'});};
  T.appendChild(n);
}
`;

const STYLE = `${FUTURA_CSS}
html,body{margin:0;height:100%;overflow:hidden;background:#000000;font:500 12px ${FUTURA_STACK};color:#bdbdbd;user-select:none}
#t{display:flex;align-items:flex-end;height:100%;padding:0 8px;gap:4px;border-bottom:1px solid rgba(255,255,255,.35);box-sizing:border-box}
.tab{display:flex;align-items:center;gap:8px;min-width:0;max-width:220px;flex:1 1 180px;height:30px;padding:0 10px;border:1px solid rgba(255,255,255,.25);border-bottom:none;border-radius:8px 8px 0 0;background:rgba(255,255,255,.05);cursor:pointer}
.tab.on{background:rgba(255,255,255,.18);color:#fff;border-color:rgba(255,255,255,.7)}
.l{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.x{font-size:16px;line-height:1;opacity:.7;padding:0 2px}.x:hover{opacity:1;color:#ff8a7a}
.new{width:30px;height:28px;display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;border-radius:6px}.new:hover{background:rgba(255,255,255,.15)}
`;

export const barHtml = (): string =>
  `<!doctype html><meta charset="utf-8"><style>${STYLE}</style><div id="t"></div><script>${SCRIPT}</script>`;
