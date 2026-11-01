/**
 * Cinematic "shutter" scene shown in the two door views that cover the screen while a panel
 * opens or closes. Each door draws the same full-screen scene offset by half, so together
 * they form one seamless picture that splits down the middle.
 */
import { FUTURA_CSS, FUTURA_STACK } from './fontFace';

const SCRIPT = `
var C=document.getElementById('c'),x=C.getContext('2d'),S=null,W=0,hh=0,H=0,dpr=1,raf=0;
var FONT=FUTURA,STRIP=132;
function fit(){dpr=window.devicePixelRatio||1;W=innerWidth;hh=innerHeight;H=hh*2;C.width=W*dpr;C.height=hh*dpr;}
addEventListener('resize',fit);fit();
function cl(v){return Math.max(0,Math.min(1,v));}
function eo(v){v=cl(v);return 1-Math.pow(1-v,3);}
function eio(v){v=cl(v);return v<.5?4*v*v*v:1-Math.pow(-2*v+2,3)/2;}
function draw(){
 raf=requestAnimationFrame(draw);
 var now=Date.now(),t=now-S.t0,closing=S.mode==='close';
 var p=closing?1-eio((t-60)/420):eio(t/800);
 var seam=S.openAt?eo((now-(S.openAt-180))/180):0;
 var cx=W/2,cy=H/2,h=STRIP*eio(closing?(t<60?1:cl(t/260)):cl(t/380))*(1-seam);
 x.setTransform(dpr,0,0,dpr,0,0);x.fillStyle='#000';x.fillRect(0,0,W,hh);
 x.save();x.translate(0,S.half==='top'?0:-hh);
 // white strip across the middle of the screen
 x.fillStyle='#fff';x.fillRect(0,cy-h/2,W,h);
 if(h>70){
  var a=cl((h-70)/50)*(1-seam);
  x.globalAlpha=a;x.fillStyle='#000';x.textBaseline='middle';x.textAlign='center';
  var word=closing?'CLOSING':'OPENING';
  if('letterSpacing' in x)x.letterSpacing='20px';
  x.font='700 36px '+FONT;
  x.fillText(word,cx+11,cy-10);
  if(S.label&&!closing){if('letterSpacing' in x)x.letterSpacing='8px';x.font='500 12px '+FONT;x.globalAlpha=a*.55;x.fillText(S.label,cx+4,cy+30);x.globalAlpha=a;}
  // hairline progress along the bottom of the strip
  var bw=Math.min(280,W*.4);x.globalAlpha=a*.2;x.fillRect(cx-bw/2,cy+50,bw,2);
  x.globalAlpha=a;x.fillRect(cx-bw/2,cy+50,bw*p,2);
  x.globalAlpha=1;if('letterSpacing' in x)x.letterSpacing='0px';
 }
 // hairline where the two halves part
 if(seam>0){x.fillStyle='rgba(255,255,255,'+seam+')';x.fillRect(0,cy-1,W,2);}
 x.restore();
}
function start(o){S=o;cancelAnimationFrame(raf);draw();}
function setOpenAt(t){if(S)S.openAt=t;}
function stop(){cancelAnimationFrame(raf);}
`;

export const sceneHtml = (): string =>
  `<!doctype html><meta charset="utf-8"><style>${FUTURA_CSS}html,body{margin:0;height:100%;overflow:hidden;background:#000}canvas{display:block;width:100%;height:100%}</style><canvas id="c"></canvas><script>var FUTURA=${JSON.stringify(FUTURA_STACK)};${SCRIPT}</script>`;
