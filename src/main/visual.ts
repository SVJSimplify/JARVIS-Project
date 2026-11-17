import { normalizeForStaging } from './visualIR';
import { attentionHud, isMini, sendToHud, setMini } from './hud';
import { emitActivity } from './modes';
import { sanitizeVisualHtml } from './visualSanitize';
import type { Tool } from './toolTypes';

const MAX_CHARS = 60_000;

/** What is projected: structured blocks (preferred) or legacy raw markup — the renderer owns presentation either way. */
export interface StagedVisual {
  id: number;
  title: string;
  subtitle?: string;
  blocks?: unknown;
  html?: string;
  t: number;
}

/**
 * Projects a finished visual onto the HUD the moment it is built — the old stage → "ready
 * to see it?" → yes/no gate was a confirmation prompt AND the reason visuals so often
 * never appeared: the model forgot to ask, the user's reply did not match the yes/no
 * patterns, or the staged payload simply expired after ten minutes.
 *
 * Take the whole screen first, then project, so the unfold plays at full size. Closing it
 * returns the HUD to mini if it was mini.
 */
function project(payload: Omit<StagedVisual, 'id' | 't'>): void {
  const wasMini = isMini();
  if (wasMini) setMini(false);
  attentionHud();
  const visual = { ...payload, id: Date.now(), restoreMini: wasMini };
  setTimeout(() => sendToHud('jarvis-visual', visual), wasMini ? 520 : 0);
}

const BLOCK_HELP =
  'Preferred: pass STRUCTURED blocks and the rendering engine builds the layout for you — typography, spacing and colours are handled, text never overflows. ' +
  'blocks is an array of: ' +
  '{type:"stats", items:[{k:"Label", v:"42", unit:"%", hint:"why it matters", tone:"ok|warn|bad"}]} · ' +
  '{type:"bars", items:[{label:"A", value:70, display:"70%"}], max:100} · ' +
  '{type:"table", columns:[{label:"Col", align:"left|right|center"}], rows:[["a","b"]]} · ' +
  '{type:"flow", steps:[{label:"Step", note:"detail"}]} (2–6 steps) · ' +
  '{type:"timeline", items:[{when:"2019", what:"What happened"}]} · ' +
  '{type:"list", items:[{text:"point", tone:"ok|warn|bad"}]} · ' +
  '{type:"tags", items:["tag"]} · {type:"compare", options:[{name:"A", points:[{k:"price", v:"₹1,299"}]}]} (2–4 options) · ' +
  '{type:"note", tone:"info|ok|warn|bad", title:"Heads up", text:"one insight"} · ' +
  '{type:"text", heading:"Section", body:"prose, blank line = new paragraph"} · ' +
  '{type:"svg", markup:"<svg viewBox=\\"0 0 400 200\\">…</svg>"} (inline SVG only, stroke="var(--holo)", class="draw" to animate lines). ' +
  'subtitle is an optional one-line context string under the title. ' +
  'Escape hatch: html passes raw markup instead — inline CSS only, NO scripts (stripped), same ready-made classes: .grid of .card tiles with .k/.v, ' +
  '.row/.bar/.n bars, .flow/.node/.arrow process, .timeline history, ul.list, span.tag, plain table, .ok/.warn/.bad status colours, svg text auto-coloured. ' +
  'Make it dense but clean: a short title, 3 to 6 blocks, real numbers, no walls of text.';

/**
 * Main-side gate: serialisable, size-capped, and NORMALISED content. Any payload shape the
 * model invents (legacy keys, JSON strings, single blocks, object maps) is repaired into
 * canonical blocks HERE, at tool time, so what is staged always renders — the renderer's
 * normalizeVisual then re-validates the clean shape as a no-op. A payload with nothing
 * renderable in it is rejected with guidance so the model retries; a dead visual panel is
 * never staged.
 */
const buildPayload = (args: Record<string, unknown>): { payload: Omit<StagedVisual, 'id' | 't'>; note: string } => {
  const title = String(args.title ?? '').trim().slice(0, 80);
  if (!title) throw new Error('title is required.');
  const notes: string[] = [];

  let blocks: unknown;
  let stagedSubtitle = String(args.subtitle ?? '').trim().slice(0, 200) || undefined;
  let repairNote: string | undefined;
  const coerce = (input: unknown): boolean => {
    const { ir, warnings } = normalizeForStaging(input);
    if (!ir) return false;
    blocks = ir.blocks;
    if (!stagedSubtitle && ir.subtitle) stagedSubtitle = ir.subtitle;
    const repairs = warnings.filter((w) => /^(repaired|dropped|capped)/.test(w));
    if (repairs.length) repairNote = `content repaired: ${repairs.join('; ')}`;
    return true;
  };
  if (args.blocks != null) {
    // JSON.stringify can THROW (circular structures, BigInt) — a raw TypeError here gave the
    // model an unintelligible crash instead of retry guidance. Fold every failure into the
    // same clean refusal so the model can simply resend plain JSON.
    let json: string | undefined;
    try {
      json = JSON.stringify(args.blocks);
    } catch {
      throw new Error('blocks is not serialisable (circular or non-JSON values). Send plain JSON data only.');
    }
    if (json === undefined) throw new Error('blocks is not serialisable.');
    if (json.length > MAX_CHARS) throw new Error(`blocks is ${json.length} chars of JSON; the limit is ${MAX_CHARS}. Reduce the content.`);
    if (!coerce(args.blocks)) {
      const { warnings } = normalizeForStaging(args.blocks);
      const why = warnings.join('; ') || 'no content was found in it';
      throw new Error(
        `blocks contained nothing renderable (${why}). Send blocks as a non-empty array, e.g. ` +
        '[{"type":"stats","items":[{"k":"Label","v":"42"}]}] — types: stats, bars, table, flow, timeline, list, tags, compare, note, text, kv, svg.'
      );
    }
  } else if (!(typeof args.html === 'string' && args.html.trim())) {
    // Legacy / free-form payloads: the model put the content anywhere BUT blocks.
    // Strip the scalars the panel itself consumes, then try the full repair pass.
    const probe: Record<string, unknown> = { ...args };
    delete probe.title;
    delete probe.subtitle;
    delete probe.html;
    if (Object.keys(probe).length && !coerce(probe)) {
      throw new Error(
        'nothing renderable was passed. Send blocks as a non-empty array, e.g. ' +
        '[{"type":"stats","items":[{"k":"Label","v":"42"}]}] — types: stats, bars, table, flow, timeline, list, tags, compare, note, text, kv, svg.'
      );
    }
  }

  let html: string | undefined;
  if (typeof args.html === 'string' && args.html.trim()) {
    const raw = args.html.trim();
    if (raw.length > MAX_CHARS) throw new Error(`Visual is ${raw.length} chars; the limit is ${MAX_CHARS}. Simplify it.`);
    const clean = sanitizeVisualHtml(raw);
    html = clean.html;
    if (clean.stripped.length) notes.push(`removed ${[...new Set(clean.stripped)].join(', ')}`);
    if (!html) throw new Error('html was empty after sanitising — nothing to show.');
  }
  if (repairNote) notes.push(repairNote);

  if (!blocks && !html) throw new Error('pass blocks (preferred) or html.');
  return { payload: { title, ...(stagedSubtitle ? { subtitle: stagedSubtitle } : {}), ...(blocks ? { blocks } : {}), ...(html ? { html } : {}) }, note: notes.join('; ') };
};

export const visualTools: Record<string, Tool> = {
  show_visual: {
    description:
      'Prepare a holographic visual inside JARVIS (stats, bar chart, table, flowchart, timeline, comparison, list, diagram) whenever something is clearer seen than heard. ' +
      BLOCK_HELP +
      ' The visual appears on screen the instant you call this tool — NEVER ask permission to show it and never call it "prepared" or "staged". After calling, say one or two short sentences about what is on screen.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short heading, e.g. "How DNS works".' },
        subtitle: { type: 'string', description: 'Optional one-line context under the title.' },
        blocks: { type: 'array', description: 'Structured content blocks (preferred) — stats/bars/table/flow/timeline/list/tags/compare/note/text/svg.' },
        html: { type: 'string', description: 'Advanced escape hatch: raw HTML or inline <svg>. No scripts.' },
      },
      required: ['title'],
    },
    run: (args) => {
      const { payload, note } = buildPayload(args as Record<string, unknown>);
      project(payload);
      const size = payload.blocks ? `${JSON.stringify(payload.blocks).length} chars of blocks` : `${payload.html?.length ?? 0} chars of markup`;
      emitActivity({ kind: 'visual', label: `Visual on screen: ${payload.title}`, detail: `${size} projected${note ? ` (${note})` : ''}`, status: 'ok' });
      return `Visual "${payload.title}" is on screen now.${note ? ` (${note})` : ''} Narrate it in one or two short sentences. Do not ask whether to show it and do not call show_visual again for it.`;
    },
  },
};
