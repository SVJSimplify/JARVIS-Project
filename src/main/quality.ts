import type { Tool } from './toolTypes';

/**
 * The quality standard JARVIS must pass before it reports any non-trivial task as finished.
 * Single source of truth: edit the lists below to raise or lower the bar.
 */
export const STANDARDS: Record<string, string[]> = {
  research: [
    'Every angle of the original question was covered, including the user\'s own side, not only the outside world.',
    'Each key claim has a source or a number seen in a tool result this turn; nothing is guessed.',
    'Conflicts between sources were resolved or flagged; gaps are stated, not hidden.',
    'Facts are current: dates were checked for anything time-sensitive.',
    'The report is saved to a file and the visual is on screen.',
    'The conclusion gives the verdict first, the main reason, and one next move.',
  ],
  code: [
    'The change does what was asked and nothing unrelated was touched.',
    'The edited file was re-read or diagnostics ran after the change, and the result was seen.',
    'No secrets, debug leftovers or broken imports were introduced.',
    'The summary lists the files changed and anything left undone.',
  ],
  browser: [
    'The final page state was seen (snapshot or image) after the last action, not assumed.',
    'Every field, option and button the task needs was actually set, not skipped.',
    'Nothing irreversible (send, pay, delete, submit) happened without the user\'s approval.',
    'The reported outcome matches what the page shows.',
  ],
  general: [
    'The real goal behind the request is met, not just its literal wording.',
    'Every claim of success is backed by a tool result from this turn.',
    'The user can use the result as it is: file saved, visual shown, or answer given.',
    'The reply is short, result first, with the next step if one is obvious.',
  ],
};

interface Answer { item?: number; ok?: boolean; evidence?: string }

export const qualityTools: Record<string, Tool> = {
  quality_gate: {
    description:
      'MANDATORY before concluding any project, research, analysis, code change or multi-step browser job. Call once with kind to get the checklist; do any missing work; call again with answers (one {item, ok, evidence} per item, evidence = what you saw). Returns PASS or the items that must be fixed. Do not conclude until PASS.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: Object.keys(STANDARDS) },
        answers: {
          type: 'array',
          items: { type: 'object', properties: { item: { type: 'number' }, ok: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['item', 'ok', 'evidence'] },
        },
      },
      required: ['kind'],
    },
    run: (args) => {
      const kind = String(args.kind ?? 'general');
      const list = STANDARDS[kind] ?? STANDARDS.general;
      const answers = (Array.isArray(args.answers) ? args.answers : []) as Answer[];
      if (!answers.length) {
        return `QUALITY CHECKLIST (${kind}). Verify each, fix what fails, then call quality_gate again with answers.\n${list.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
      }
      const bad = list
        .map((t, i) => ({ n: i + 1, t, a: answers.find((x) => Number(x.item) === i + 1) }))
        .filter((r) => !r.a || r.a.ok !== true || String(r.a.evidence ?? '').trim().length < 8);
      return bad.length
        ? `NOT DONE: fix before concluding.\n${bad.map((r) => `${r.n}. ${r.t} ${r.a ? (r.a.ok === true ? '(evidence missing)' : '(failed)') : '(not answered)'}`).join('\n')}\nDo the work, then call quality_gate again.`
        : 'PASS. Conclude now.';
    },
  },
};

/**
 * CODE-ENFORCED RESEARCH GATE.
 *
 * The checklist above depends on the model grading itself honestly; a live run proved that
 * is not enough (a report shipped with a wrong year, zero sources and a self-contradicting
 * spec card, and the gate saw nothing). These checks run in code on the final reply and on
 * whatever was written with write_file, so the model cannot skip them. They are deliberately
 * narrow and deterministic: every rule below fired on a real failing report or guards a
 * trap from the E2E test kit. Anything fuzzy (is this source reputable?) is left to the
 * checklist — false positives here would teach the model to route around the gate.
 */
export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface Today {
  day: number;
  month: string;
  year: number;
  iso: string;
  weekday: string;
}

/** The real current date, computed in code — never taken from the model's sense of time. */
export function todayParts(now: Date = new Date()): Today {
  const day = now.getDate();
  const month = MONTHS[now.getMonth()];
  const year = now.getFullYear();
  const iso = `${year}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { day, month, year, iso, weekday: WEEKDAYS[now.getDay()] };
}

/** The date block injected into every turn's context so the model never guesses "today". */
export function dateContext(t: Today, tz?: string): string {
  return (
    `TODAY: ${t.weekday}, ${t.day} ${t.month} ${t.year} (${t.iso}). Timezone: ${tz || 'local'}. ` +
    'This is the real current date from the system clock, cross-checkable with get_current_time. ' +
    'Every date you state — report headers, "as of" stamps, deadlines, "this Saturday" — resolves against it. ' +
    'Never trust your internal sense of the date: research results without their own dates are stale until proven current.'
  );
}

/** "Date: 1 November 2025", "as of Nov 1st, 2025", "updated on 2025-11-01" — the lines that CLAIM currency. */
const DATED_RE =
  /\b(?:dated|date|as of|updated(?: on)?)\s*[:\-–—]?\s*(\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}|\d{4}-\d{2}-\d{2})/gi;

const MONTH_IDX = new Map(MONTHS.map((m, i) => [m.slice(0, 3).toLowerCase(), i]));

/** Parse one dated-line capture to ISO, or null when it is not a real calendar date. */
export function parseDated(s: string): string | null {
  let m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s.trim());
  if (m) {
    const mon = MONTH_IDX.get(m[2].slice(0, 3).toLowerCase());
    return mon === undefined ? null : `${m[3]}-${String(mon + 1).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`;
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s.trim());
  if (m) {
    const mon = MONTH_IDX.get(m[1].slice(0, 3).toLowerCase());
    return mon === undefined ? null : `${m[3]}-${String(mon + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  return m ? s.trim() : null;
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]}»]+/g;
const UNVERIFIED_RE = /\bUNVERIFIED\b|not confirmed|unconfirmed|could not (?:be )?verif|couldn'?t verif|no longer listed/i;
const PRICE_RE = /(?:₹|Rs\.?|\$|USD|EUR|€)\s?\d[\d,.]*/i;
/** Tools whose SUCCESS means the turn actually looked at the live web. */
const WEB_ACTION_RE = /^(tinyfish_|search_and_read|web_search|fetch_url)/;

/** A "weight/battery" claim in text: 167 g, 213 grams, 6000 mAh, 6,000mAh. */
const SPEC_RE = /(\d[\d,]*(?:\.\d+)?)\s*(mAh|grams?|g)\b/gi;
/** The model-ish name a line leads with, when one is detectable at all. */
const NAME_RE =
  /^[\s|>*\-#]*(?:\d+[.)]\s*)?([A-Za-z][A-Za-z0-9'+&.-]*(?:\s+[A-Za-z0-9][A-Za-z0-9'+&.-]*){0,3})(?=\s*(?:[₹$€@]|\d|\||$))/;

export interface GateInput {
  /** The final spoken/written reply. */
  reply: string;
  /** Every write_file content delivered this turn (report bodies). */
  reports: string[];
  /** describe()-style action strings for the turn, FAILED-suffixed on failure. */
  actions: string[];
  today: Today;
  /** The request demanded currency ("right now", "currently", ...). */
  fresh: boolean;
  /** Tool result bodies seen this turn (search hits, page text, calculate outputs) — the evidence pool for the provenance check. */
  evidence?: string[];
  /** The user's own request text: figures the user themselves stated are always legitimate. */
  request?: string;
}

/**
 * Every deterministic violation of the research standard in this turn's output.
 * Empty array = the gate passes. Order: sources, dates, freshness, self-consistency,
 * provenance, arithmetic.
 */
export function researchViolations(input: GateInput): string[] {
  const { reply, reports, actions, today, fresh } = input;
  const rawBody = [...reports, reply].join('\n\n');
  // Markdown emphasis is noise for the date/URL/price scans; URLs and spec numbers survive
  // stripping. The spec scan (check 6) reads rawBody instead: bold spans ARE the model names.
  const body = rawBody.replace(/\*\*|__|`/g, '');
  const out: string[] = [];
  const reportish = reports.length > 0 || reply.trim().length >= 400;
  const urls = new Set(body.match(URL_RE) ?? []);

  // 1. A report with no sources is the "research" red flag: findings nobody can check.
  if (reportish && urls.size < 2) {
    out.push(`no source URLs (report cites ${urls.size}, need 2+ real links)`);
  }

  // 2. Any line claiming currency must carry TODAY's date. A confidently wrong year that is
  //    internally self-consistent is the dangerous case — it must never ship unflagged.
  for (const m of body.matchAll(DATED_RE)) {
    const iso = parseDated(m[1]);
    if (iso && iso !== today.iso) {
      out.push(`date anchoring wrong: "${m[0].trim()}" (parsed ${iso}) but today is ${today.iso}`);
    }
  }

  if (fresh) {
    // 3. Currency demanded means the live web was actually consulted this turn.
    const looked = actions.some((a) => WEB_ACTION_RE.test(a) && !/ FAILED$/.test(a));
    if (!looked) out.push('freshness requested ("right now"/"currently") but no successful web search or fetch ran');

    // 4. The freshness claim must be stamped with today's date, not implied.
    const variants = [`${today.day} ${today.month} ${today.year}`, `${today.month} ${today.day},? ${today.year}`, today.iso, 'today']
      .join('|')
      .replace(/,/g, ',?');
    if (!new RegExp(`\\bas of\\b[^.\\n]{0,40}(?:${variants})`, 'i').test(body)) {
      out.push(`freshness not stamped "as of ${today.day} ${today.month} ${today.year}"`);
    }

    // 5. Volatile prices with neither sources nor UNVERIFIED marks = the fabricated-market-data signature.
    if (PRICE_RE.test(body) && urls.size < 2 && !UNVERIFIED_RE.test(body)) {
      out.push('prices stated with neither sources nor UNVERIFIED marks on volatile data');
    }
  }

  // 6. Same product, same spec, two numbers (the 206 g card vs 213 g table case).
  //    Attribution is line-local: a spec belongs to the nearest model-looking name to its
  //    LEFT — bold spans first (tables, breakdowns), else the line-leading name (digest
  //    cards). Line-locality keeps one model's specs from bleeding onto another's.
  const BOLD_RE = /\*\*([^*\n]{2,48})\*\*/g;
  const looksLikeName = (s: string): boolean => {
    const t = s.trim();
    if (!t || !/^[A-Za-z]/.test(t) || t.endsWith(':') || t.split(/\s+/).length > 5) return false;
    return true;
  };
  interface Cand {
    at: number;
    name: string;
  }
  const claims = new Map<string, Set<number>>();
  for (const raw of rawBody.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const cands: Cand[] = [];
    for (const b of line.matchAll(BOLD_RE)) {
      if (looksLikeName(b[1])) cands.push({ at: b.index ?? 0, name: b[1].trim().toLowerCase() });
    }
    if (!cands.length) {
      const lead = NAME_RE.exec(line)?.[1];
      if (lead) cands.push({ at: 0, name: lead.trim().toLowerCase() });
    }
    if (!cands.length) continue;
    for (const s of line.matchAll(SPEC_RE)) {
      const value = Number(s[1].replace(/,/g, ''));
      const unit = /mah/i.test(s[2]) ? 'mAh' : 'g';
      // 4G/5G network generations parse as "4 g"; real device weights are 80 g+.
      if (unit === 'g' && value < 80) continue;
      if (unit === 'mAh' && value < 300) continue;
      const at = s.index ?? 0;
      const owner = [...cands].reverse().find((c) => c.at < at);
      if (!owner) continue;
      const key = `${owner.name}|${unit}`;
      (claims.get(key) ?? claims.set(key, new Set()).get(key)!).add(value);
    }
  }
  for (const [key, vals] of claims) {
    if (vals.size > 1) {
      const [name, unit] = key.split('|');
      out.push(`self-contradicting spec: ${name} ${unit} = ${[...vals].join(' vs ')}`);
    }
  }

  // 7. PROVENANCE — the fabricated-market-data killer. Every accountable figure in the
  //    output (currency amounts, unit-attached specs) must be traceable to this turn: seen
  //    in a tool result or the user's request, produced by calculate/run_python (their
  //    outputs are in the evidence pool), derived as ×/÷ of two seen values within 1%, or
  //    sitting on a line explicitly marked UNVERIFIED. A figure from nowhere is a violation,
  //    exactly like the "₹43,000–47,000" 2025 prices that shipped with no source at all.
  const pool = [...(input.evidence ?? []), input.request ?? ''].filter(Boolean);
  if (reportish && pool.length) {
    const seen = seenValues(pool);
    if (seen.length) {
      const unseen = new Set<string>();
      for (const raw of rawBody.split('\n')) {
        const line = raw.trim();
        if (!line || UNVERIFIED_RE.test(line)) continue; // an explicitly flagged line is honest by definition
        for (const f of accountableNumbers(line.replace(URL_RE, ''))) {
          // 0.5% tolerance = the same figure rounded differently (6,428.57 seen → "₹6,429" passes;
          // a fabricated ₹43,000 next to a seen ₹46,999 is 7.4% off and still caught).
          if (!seen.some((s) => close(s, f.value, 0.005)) && !isDerived(f.value, seen)) unseen.add(f.label);
        }
      }
      if (unseen.size) {
        out.push(`figures stated with no source this turn: ${[...unseen].slice(0, 6).join(', ')} — quote the exact source figure or mark the line UNVERIFIED`);
      }
    }
  }

  // 8. ARITHMETIC AUDIT — the gate recomputes the maths. "A / B = C" and "₹T … Y years …
  //    ₹P per year" are verified in code; the per-year figure passes if ANY currency total
  //    on the same line divides to it (rows legitimately carry price, EMI and per-year side
  //    by side). Wrong arithmetic on sourced numbers is still a failed report.
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || UNVERIFIED_RE.test(line)) continue;
    const clean = line.replace(URL_RE, '');
    const dm = DIV_RE.exec(clean);
    if (dm) {
      const a = num(dm[1]);
      const b = num(dm[2]);
      const q = b === 0 ? NaN : a / b;
      if (Number.isFinite(q) && !close(q, num(dm[3]), 0.005) && Math.abs(q - num(dm[3])) > 0.01) {
        out.push(`arithmetic wrong: "${dm[0].trim()}" computes to ${Number(q.toFixed(2))}`);
      }
    }
    const pm = PER_YEAR_RE.exec(clean);
    if (pm) {
      const ym = YEARS_RE.exec(clean);
      if (ym && num(ym[1]) > 0) {
        const y = num(ym[1]);
        const p = num(pm[1]);
        const totals = Array.from(clean.matchAll(CURRENCY_VALUE_RE))
          .map((c) => num(c[1]))
          .filter((v) => Math.abs(v - p) > 1e-9);
        const explained = totals.some((t) => close(t / y, p, 0.005) || Math.abs(t / y - p) <= 0.01);
        if (totals.length && !explained) {
          out.push(`per-year figure unexplained: "${pm[0].trim()}" is not any total on the line ÷ ${ym[1]} years`);
        }
      }
    }
  }

  return out;
}

// ---- Provenance and arithmetic helpers (Round 9) ----

/** Currency values, including "₹1.5 lakh", "₹2 crore" and "₹45k" shorthand. */
const CURRENCY_VALUE_RE = /(?:₹|Rs\.?|\$|€)\s?(\d[\d,]*(?:\.\d+)?)\s*(lakh|crore|k)?\b/gi;
/** Unit-attached spec values in output text: 6000 mAh, 213 g, 1.2 kg, 16 GB, 14 inches. */
const UNIT_VALUE_RE = /(\d[\d,]*(?:\.\d+)?)\s*(mAh|Wh|kgs?|kilograms?|grams?|g|GB|TB|inches|inch|")\b/gi;
/** Any number, for the evidence pool — a superset on purpose: under-flagging beats false accusation. */
const ANY_NUM_RE = /\d[\d,]*(?:\.\d+)?/g;
/** "A / B = C" and "₹A ÷ B = C" divisions stated in text. */
const DIV_RE = /(\d[\d,]*(?:\.\d+)?)\s*(?:\/|÷)\s*(\d[\d,]*(?:\.\d+)?)\s*=\s*(?:₹|Rs\.?\s?|\$|€)?\s*(\d[\d,]*(?:\.\d+)?)/;
/** "₹6,428 per year", "₹6,428 / year", "₹45,000 per update year". */
const PER_YEAR_RE = /(?:₹|Rs\.?|\$|€)\s?(\d[\d,]*(?:\.\d+)?)\s*(?:\/|per\b(?:\s+\w+){0,3}?)\s*(?:years?|yrs?|annum)\b/i;
const YEARS_RE = /(\d[\d,]*)\s*(?:years?|yrs?)\b/i;

const num = (v: string): number => Number(String(v).replace(/[,\s]/g, ''));
const close = (a: number, b: number, tol = 0.01): boolean => Math.abs(a - b) <= tol * Math.max(Math.abs(b), 1e-9);

/** Accountable figures on one line, with sane floors so 4G is not "4 grams". */
export function accountableNumbers(line: string): Array<{ label: string; value: number }> {
  const out: Array<{ label: string; value: number }> = [];
  for (const m of line.matchAll(CURRENCY_VALUE_RE)) {
    const base = num(m[1]);
    if (!Number.isFinite(base)) continue;
    const scale = (m[2] ?? '').toLowerCase() === 'k' ? 1e3 : (m[2] ?? '').toLowerCase() === 'lakh' ? 1e5 : (m[2] ?? '').toLowerCase() === 'crore' ? 1e7 : 1;
    out.push({ label: `${(m[0] ?? '').trim()}`, value: base * scale });
  }
  for (const m of line.matchAll(UNIT_VALUE_RE)) {
    const v = num(m[1]);
    const u = m[2].toLowerCase();
    if (!Number.isFinite(v)) continue;
    if ((u === 'g' || u.startsWith('gram')) && v < 80) continue; // 4G/5G networks and trivial "g" hits
    if ((u === 'kg' || u.startsWith('kilogram')) && (v < 0.3 || v > 50)) continue;
    if (u === 'mah' && v < 300) continue;
    if (u === 'wh' && v < 10) continue;
    if (u === 'gb' && v < 4) continue;
    if (u === 'tb' && v < 0.2) continue;
    if ((u === 'inch' || u === 'inches' || u === '"') && (v < 4 || v > 40)) continue;
    out.push({ label: `${m[1]} ${m[2]}`, value: v });
  }
  return out;
}

/** Every number in the evidence pool, numerically (cap keeps the derived scan bounded). */
export function seenValues(pool: string[]): number[] {
  const vals: number[] = [];
  for (const s of pool) {
    for (const m of s.matchAll(ANY_NUM_RE)) {
      const v = num(m[0]);
      if (Number.isFinite(v)) vals.push(v);
      if (vals.length >= 2000) return vals;
    }
  }
  return vals;
}

/** True when v is within 1% of a×b or a÷b for two values seen this turn (the derived-figure escape: 6,428.57 = 45,000 ÷ 7). */
export function isDerived(v: number, seen: number[]): boolean {
  const list = seen.slice(0, 300);
  for (const a of list) {
    if (!Number.isFinite(a) || a === 0) continue;
    for (const b of list) {
      if (!Number.isFinite(b) || b === 0) continue;
      if (close(a / b, v, 0.01) || close(a * b, v, 0.01)) return true;
    }
  }
  return false;
}

/**
 * Pull report bodies out of the turn's tool arguments. Only write_file-shaped args
 * ({ path, content }) count — a clipboard_write({ content }) is not a report; anything
 * unparsable or content-less is ignored.
 */
export function extractReportContents(argsList: string[]): string[] {
  const out: string[] = [];
  for (const a of argsList) {
    try {
      const o = JSON.parse(a) as { path?: unknown; content?: unknown };
      if (o && typeof o.path === 'string' && typeof o.content === 'string' && o.content.trim()) out.push(o.content);
    } catch {
      /* not JSON or not a write tool — nothing to gate */
    }
  }
  return out;
}
