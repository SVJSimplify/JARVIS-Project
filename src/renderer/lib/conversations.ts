import type { HistoryTurn } from './protocol';

/**
 * Pure presentation logic for the Conversations panel — no React, no DOM, fully unit-tested.
 */

/** A conversation = a run of turns with no gap longer than CONVERSATION_GAP_MS between them.
 *  The 10-minute window mirrors the app's own session semantics in session.ts. */
export const CONVERSATION_GAP_MS = 10 * 60 * 1000;

export interface ConversationGroup {
  /** First turn's start time (epoch ms). */
  start: number;
  /** Last turn's end time (epoch ms). */
  end: number;
  turns: HistoryTurn[];
}

/** Group finished turns into conversations, chronological order preserved inside each group.
 *  Turns arrive sorted oldest→newest; the sort here is defensive, not decorative. */
export function groupConversations(turns: HistoryTurn[], gapMs = CONVERSATION_GAP_MS): ConversationGroup[] {
  const sorted = [...turns].filter((t) => t && typeof t.t === 'number').sort((a, b) => a.t - b.t);
  const groups: ConversationGroup[] = [];
  for (const turn of sorted) {
    const last = groups[groups.length - 1];
    if (last && turn.t - last.end < gapMs) {
      last.turns.push(turn);
      last.end = turn.t;
    } else {
      groups.push({ start: turn.t, end: turn.t, turns: [turn] });
    }
  }
  return groups;
}

/** One renderable block of a reply: a fenced code block, or a plain-text segment. */
export interface FenceBlock {
  code: boolean;
  /** Block content without the fence markers; for code, the first line (language) is stripped off. */
  content: string;
  /** For code blocks: the language tag after the opening fence, '' when absent. */
  lang: string;
}

/** Split a reply on ``` fenced code blocks so code renders in a styled <pre> while the
 *  remaining text keeps its original line breaks, lists and indentation via pre-wrap. */
export function splitFences(text: string): FenceBlock[] {
  const out: FenceBlock[] = [];
  const re = /```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ code: false, content: text.slice(last, m.index), lang: '' });
    const body = m[2] ?? '';
    out.push({ code: true, content: body.replace(/\n$/, ''), lang: (m[1] ?? '').trim() });
    last = m.index + m[0].length;
    if (m[0].endsWith('```') === false && re.lastIndex >= text.length) break; // unclosed fence consumed
  }
  if (last < text.length) out.push({ code: false, content: text.slice(last), lang: '' });
  return out.filter((b) => b.content.length > 0 || b.code);
}

/** One-line preview for a list row: first meaningful line, compacted whitespace. */
export function preview(text: string, max = 160): string {
  const line = String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const flat = (line ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Compact timestamp for row labels: "Nov 5 · 09:14". */
export function stamp(t: number, now = new Date()): string {
  const d = new Date(t);
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (sameDay) return time;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()} · ${time}`;
}

/** Full timestamp for a detail header: "Nov 5, 2026 · 09:14:03". */
export function fullStamp(t: number): string {
  const d = new Date(t);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} · ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
