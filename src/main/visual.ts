import { attentionHud, isMini, sendToHud, setMini } from './hud';
import { emitActivity } from './modes';
import type { Tool } from './toolTypes';

const MAX_CHARS = 60_000;
const TTL_MS = 10 * 60_000;
const YES = /^\W*(?:yes|yeah|yep|yup|sure|ready|i'?m ready|go ahead|go on|show( it| me)?|do it|please|ok(?:ay)?|alright|haan|han?)\b/i;
const NO = /^\W*(?:no|nope|not now|not yet|don'?t|do not|cancel|skip|later|never ?mind|nahi|nhi)\b/i;
/** Courtesy tail allowed after a bare yes/no. Anything more ("yes, but first check my email", "show me the weather") is a real request that must reach the model. */
const TAIL_OK = /^\W*(?:sir|doctor|doc|please|plz|thanks|thank you|then|now|ji|go|ahead|it|on|screen|to|me|lets|let's|see|haan|han|)*[\s.!?,;:'"…-]*$/i;
/** True when the utterance is a yes/no plus at most a courtesy tail — not merely a sentence that starts with one. */
const isAnswer = (re: RegExp, text: string): boolean => {
  const m = re.exec(text);
  return !!m && TAIL_OK.test(text.slice(m[0].length));
};

/** A drawn visual waits here, off screen, until the user says they are ready to see it. */
let staged: { title: string; html: string; t: number } | null = null;
const fresh = (): boolean => !!staged && Date.now() - staged.t < TTL_MS;

/** Handles the user's yes or no to "ready to see it?" without a model round trip. Returns the spoken reply, or null if the text is not an answer. */
export function answerPendingVisual(text: string): string | null {
  if (!staged || !fresh()) {
    staged = null;
    return null;
  }
  const yes = isAnswer(YES, text);
  const no = !yes && isAnswer(NO, text);
  if (!yes && !no) return null;
  const v = staged;
  staged = null;
  if (no) return 'Very well, sir. I will keep it off the screen.';
  // Take the whole screen first, then project, so the unfold plays at full size. Closing it returns the HUD to mini if it was mini.
  const wasMini = isMini();
  if (wasMini) setMini(false);
  attentionHud();
  setTimeout(() => sendToHud('jarvis-visual', { title: v.title, html: v.html, restoreMini: wasMini }), wasMini ? 520 : 0);
  return 'Here it is, sir.';
}

export const pendingVisualNote = (): string =>
  staged && fresh()
    ? `A visual titled "${staged.title}" is prepared but NOT on screen. The user has been asked whether they are ready; their yes or no is handled automatically. Do not call show_visual for it again.`
    : '';

export const visualTools: Record<string, Tool> = {
  show_visual: {
    description:
      'Prepare a holographic visual inside JARVIS (diagram, flowchart, chart, timeline, comparison, stats, illustration) whenever something is clearer seen than heard. Pass one self-contained HTML or inline <svg> snippet; no external URLs or images, inline CSS/JS only. The holographic cyan theme is applied for you: do NOT set colours, fonts, backgrounds or shadows. Use the ready-made classes: ' +
      '<h1> big title, <h2> section heading, <p>, .muted; .grid of .card tiles (each with .k small label and .v big value, optional <small> unit); ' +
      'bars: <div class="row"><span>Label</span><div class="bar"><i style="width:70%"></i></div><span class="n">70%</span></div>; ' +
      'process: <div class="flow"><span class="node">Step</span><span class="arrow"></span><span class="node">Step</span></div>; ' +
      'history: <div class="timeline"><div><b>2019</b><p>What happened</p></div></div>; <ul class="list">; <span class="tag">; plain <table> with <th>; status colours only via .ok .warn .bad. ' +
      'SVG: stroke="var(--holo)", fill="none" for lines, class="draw" on lines to animate them, class="pulse" for live elements, text gets the right colour automatically, use a viewBox. ' +
      'Make it dense but clean: a short title, 3 to 6 elements, real numbers, no walls of text. The visual is NOT shown immediately: after calling this, ask the user in one short sentence if they are ready to see it (for example "I have it ready, sir. Shall I put it on screen?") and stop; their yes or no is handled for you.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short heading, e.g. "How DNS works".' },
        html: { type: 'string', description: 'Self-contained HTML or <svg> markup.' },
      },
      required: ['title', 'html'],
    },
    run: (args) => {
      const html = String(args.html ?? '').trim();
      if (!html) throw new Error('html is empty.');
      if (html.length > MAX_CHARS) throw new Error(`Visual is ${html.length} chars; the limit is ${MAX_CHARS}. Simplify it.`);
      const title = String(args.title ?? '').slice(0, 80);
      staged = { title, html, t: Date.now() };
      emitActivity({ kind: 'visual', label: `Visual ready: ${title}`, detail: `${html.length} chars staged — shown when you say so`, status: 'ok' });
      return 'Visual is prepared but NOT on screen yet. Ask the user in one short sentence whether they are ready to see it, then stop. Do not describe it. Their yes or no is handled automatically.';
    },
  },
};
