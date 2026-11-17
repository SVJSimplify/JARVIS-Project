/**
 * The structured visual IR: the model DESCRIBES the content (show_visual `blocks`), this
 * module owns the presentation. Deterministic templates, every string escaped, every block
 * validated — and no payload shape can ever dead-end into a "could not be built" screen:
 * the repair pass below coerces strings, JSON, legacy schemas, object maps and mangled
 * blocks into renderable blocks, and what still cannot be trusted degrades to a note.
 *
 * Presentation (typography, spacing, colour, overflow) lives entirely in holoKit.ts.
 */

export type Tone = 'ok' | 'warn' | 'bad' | 'info';

export interface VisualIR {
  subtitle?: string;
  blocks: VisualBlock[];
}

export type VisualBlock =
  | { type: 'stats'; items: { k: string; v: string; unit?: string; hint?: string; tone?: Tone }[] }
  | { type: 'bars'; items: { label: string; value: number; display?: string; tone?: Tone }[]; max?: number }
  | { type: 'table'; columns: { label: string; align?: 'left' | 'right' | 'center' }[]; rows: string[][] }
  | { type: 'flow'; steps: { label: string; note?: string }[] }
  | { type: 'timeline'; items: { when: string; what: string }[] }
  | { type: 'list'; items: { text: string; tone?: Tone }[] }
  | { type: 'tags'; items: string[] }
  | { type: 'compare'; options: { name: string; points: { k: string; v: string }[] }[] }
  | { type: 'note'; tone?: Tone; title?: string; text: string }
  | { type: 'text'; heading?: string; body: string }
  | { type: 'kv'; items: { k: string; v: string; tone?: Tone }[] }
  | { type: 'svg'; markup: string };

const MAX_BLOCKS = 24;
const MAX_ITEMS = 200;
const MAX_TEXT = 2000;
const MAX_SVG = 30_000;
const MAX_DEPTH = 3;

const TONES: readonly Tone[] = ['ok', 'warn', 'bad', 'info'];
const tone = (x: unknown): Tone | undefined => (typeof x === 'string' && (TONES as readonly string[]).includes(x) ? (x as Tone) : undefined);

/** Escape everything that goes near innerHTML. The single gate for model-supplied text. */
export const esc = (x: unknown): string =>
  String(x ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const str = (x: unknown, cap = MAX_TEXT): string => String(x ?? '').slice(0, cap).trim();
const num = (x: unknown): number => {
  const n = typeof x === 'number' ? x : parseFloat(String(x ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};

/** Second-layer svg cleanup (the iframe CSP is the first): no scripts, handlers, external fetches or foreignObject. */
export const sanitizeSvg = (markup: string): string =>
  str(markup, MAX_SVG)
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<image\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href|src)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, (m) => (/data:image\//i.test(m) ? m : ''));

/* ================================================================== repair pass ========
 * Models send blocks in whatever shape felt natural at the time: the previous IR schema
 * (cards/charts/comparison), a JSON-encoded string, a single block without the array
 * wrapper, an object map instead of an items array, rows as objects, unknown synonyms.
 * Every one of those used to die as "This visual could not be built — no blocks." Now
 * coerceCandidates routes any payload to candidate blocks and buildBlock validates each.
 * ====================================================================================== */

/** Every name a model has used for one of the block types, mapped to the canonical type. */
const TYPE_ALIASES: Record<string, VisualBlock['type']> = {
  bars: 'bars', bar: 'bars', chart: 'bars', charts: 'bars', graph: 'bars', ranking: 'bars', distribution: 'bars',
  stats: 'stats', stat: 'stats', metric: 'stats', metrics: 'stats', kpi: 'stats', kpis: 'stats', numbers: 'stats', highlights: 'stats', cards: 'stats', card: 'stats',
  table: 'table', tables: 'table', matrix: 'table', grid: 'table',
  flow: 'flow', step: 'flow', steps: 'flow', process: 'flow', pipeline: 'flow', sequence: 'flow', workflow: 'flow',
  timeline: 'timeline', event: 'timeline', events: 'timeline', history: 'timeline', chronology: 'timeline',
  list: 'list', bullet: 'list', bullets: 'list', points: 'list', checklist: 'list', todos: 'list', findings: 'list',
  tags: 'tags', tag: 'tags', chips: 'tags', labels: 'tags', keywords: 'tags',
  compare: 'compare', comparison: 'compare', versus: 'compare', vs: 'compare', pros_cons: 'compare', tradeoffs: 'compare',
  note: 'note', notes: 'note', callout: 'note', alert: 'note', warning: 'note', info: 'note', insight: 'note', tip: 'note', caveat: 'note',
  text: 'text', heading: 'text', paragraph: 'text', paragraphs: 'text', prose: 'text', summary: 'text', overview: 'text', code: 'text', json: 'text',
  kv: 'kv', keyvalue: 'kv', key_value: 'kv', 'key-values': 'kv', properties: 'kv', props: 'kv', fields: 'kv', attributes: 'kv', details: 'kv', specs: 'kv', facts: 'kv',
  svg: 'svg', diagram: 'svg', diagrams: 'svg', drawing: 'svg',
};

const isKnownType = (t: string): boolean => Object.prototype.hasOwnProperty.call(TYPE_ALIASES, t);

/** Top-level container key that canonically holds the blocks. */
const BLOCKS_KEY = 'blocks';
/** Generic containers checked only when nothing else identified the payload. */
const LATE_CONTAINERS = ['content', 'sections', 'items', 'data', 'entries', 'visual'] as const;
/** Payload keys that are metadata, never content: skipped by typed-key routing and salvage. */
const NOISE_KEYS = new Set(['subtitle', 'sources', 'source', 'footer', 'meta', 'type']);

const firstKey = (o: Record<string, unknown>, keys: string[]): unknown => {
  for (const k of keys) if (o[k] != null) return o[k];
  return undefined;
};

/** First non-empty string among aliases. */
const sPick = (o: Record<string, unknown>, keys: string[], cap?: number): string => {
  for (const k of keys) {
    const v = o[k];
    if (v != null && typeof v !== 'object') {
      const s = str(v, cap ?? MAX_TEXT);
      if (s) return s;
    }
  }
  return '';
};

/** An object map ({Speed: 42}) becomes an items array; an array passes through. */
const itemsOf = (o: Record<string, unknown>, keys: string[]): unknown[] => {
  for (const k of keys) {
    const v = o[k];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      return Object.entries(v as Record<string, unknown>).map(([key, val]) =>
        val && typeof val === 'object' && !Array.isArray(val) ? { k: key, ...(val as Record<string, unknown>) } : { k: key, v: val }
      );
    }
  }
  return [];
};

/** Route an arbitrary payload to candidate block shapes. Never throws, never wild-guesses types it does not know. */
function coerceCandidates(input: unknown, warnings: string[], depth = 0): unknown[] {
  if (input == null) return [];
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return [];
    // A JSON-encoded payload (model double-encoded) is unwrapped, not displayed as prose.
    if (depth < MAX_DEPTH && (s.startsWith('{') || s.startsWith('['))) {
      try {
        return coerceCandidates(JSON.parse(s) as unknown, warnings, depth + 1);
      } catch {
        /* not JSON: fall through to prose */
      }
    }
    return [{ type: 'text', body: s }];
  }
  if (Array.isArray(input)) {
    const out: unknown[] = [];
    for (const item of input.slice(0, MAX_BLOCKS * 2)) {
      if (item == null) continue;
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        const b = str(item, 4000);
        if (b) out.push({ type: 'text', body: b });
      } else if (Array.isArray(item)) {
        out.push(...coerceCandidates(item, warnings, depth + 1));
      } else if (typeof item === 'object') {
        out.push(item);
      }
    }
    return out;
  }
  if (typeof input !== 'object') return [{ type: 'text', body: String(input) }];
  const o = input as Record<string, unknown>;

  // 1) canonical container — recurse (array, single block, JSON string or object map)
  if (o[BLOCKS_KEY] != null) {
    const inner = coerceCandidates(o[BLOCKS_KEY], warnings, depth + 1);
    if (inner.length) return inner;
  }

  // 2) the object IS a block (carries a known type)
  const t = str(o.type, 24).toLowerCase();
  if (t && isKnownType(t)) return [o];

  // 3) typed object map: {stats: {...}, note: {...}} or legacy containers {cards: [...], charts: [...]}
  const fromKeys: unknown[] = [];
  /** True when an array element is an ITEM (goes inside the block) rather than a BLOCK itself. */
  const looksLikeItem = (el: unknown): boolean => {
    if (!el || typeof el !== 'object' || Array.isArray(el)) return true;
    const e = el as Record<string, unknown>;
    return !('items' in e || 'steps' in e || 'columns' in e || 'rows' in e || 'options' in e || 'points' in e || 'sequence' in e || 'events' in e);
  };
  for (const [key, val] of Object.entries(o)) {
    if (val == null || NOISE_KEYS.has(key)) continue;
    const alias = TYPE_ALIASES[key.toLowerCase()];
    if (!alias) continue;
    if (Array.isArray(val)) {
      // Legacy containers hold BLOCK-shaped elements ({charts: [{title, items}]}); item arrays are one block.
      if (!val.length || val.every(looksLikeItem)) fromKeys.push(alias === 'note' ? { type: 'text', items: val } : { type: alias, items: val });
      else {
        for (const el of val) {
          if (el && typeof el === 'object' && !Array.isArray(el)) fromKeys.push({ type: alias, ...(el as Record<string, unknown>) });
          else fromKeys.push({ type: alias, items: [el] });
        }
      }
    } else if (typeof val === 'object') fromKeys.push({ type: alias, ...(val as Record<string, unknown>) });
    else {
      const s = str(val, 4000);
      if (s) fromKeys.push(alias === 'text' || alias === 'note' ? { type: alias, body: s, text: s } : { type: alias, items: [{ k: key, v: s }] });
    }
  }
  if (fromKeys.length) return fromKeys;

  // 4) generic containers, checked only when nothing above identified the payload
  for (const key of LATE_CONTAINERS) {
    const v = o[key];
    if (v == null) continue;
    const inner = typeof v === 'string' || typeof v === 'object' ? coerceCandidates(v, warnings, depth + 1) : [];
    if (inner.length) return inner;
  }

  // 5) last resort: harvest readable content straight out of the object
  const harvested = harvestStrings(o, 0);
  if (harvested.length) {
    warnings.push('repaired: payload had no recognised block shape; its raw content is shown as text');
    return [{ type: 'text', body: harvested.join('\n\n') }];
  }
  return [];
}

/** Depth-limited walk pulling every readable value out of an unrecognised payload. */
function harvestStrings(o: Record<string, unknown>, depth: number): string[] {
  const out: string[] = [];
  for (const [key, val] of Object.entries(o)) {
    if (NOISE_KEYS.has(key) || val == null) continue;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      const s = str(val, 600);
      if (s && s !== key) out.push(key.length <= 32 ? `${key}: ${s}` : s);
    } else if (Array.isArray(val) && depth < MAX_DEPTH) {
      for (const item of val.slice(0, 40)) {
        if (typeof item === 'string' || typeof item === 'number') {
          const s = str(item, 600);
          if (s) out.push(s);
        } else if (item && typeof item === 'object' && depth + 1 < MAX_DEPTH) {
          out.push(...harvestStrings(item as Record<string, unknown>, depth + 1));
        }
      }
    } else if (val && typeof val === 'object' && depth < MAX_DEPTH) {
      out.push(...harvestStrings(val as Record<string, unknown>, depth + 1));
    }
    if (out.length >= 40) break;
  }
  return out.slice(0, 40);
}

/* ------------------------------------------------------------------ per-type builders ---
 * Each takes a candidate block (with aliases still inside) and returns a validated
 * VisualBlock, or null when nothing usable is in it (the caller records the drop).
 */

const buildItemsKV = (raw: unknown[], kind: 'stats' | 'kv'): { k: string; v: string; unit?: string; hint?: string; tone?: Tone }[] =>
  raw
    .slice(0, MAX_ITEMS)
    .map((it) => {
      if (typeof it === 'string' || typeof it === 'number') return { k: str(it, 120), v: '' };
      const o = (it ?? {}) as Record<string, unknown>;
      const k = sPick(o, ['k', 'key', 'label', 'name', 'title', 'metric', 'stat'], 120);
      const v = sPick(o, ['v', 'value', 'val', 'text', 'result', 'amount', 'score', 'count', 'number', 'reading'], 120);
      const unit = sPick(o, ['unit', 'units', 'suffix'], 24);
      const hint = sPick(o, ['hint', 'note', 'detail', 'description', 'why'], 200);
      return { k, v, unit, hint, tone: tone(o.tone) };
    })
    .map((x) => (kind === 'stats' ? x : { k: x.k, v: x.v, tone: x.tone }))
    .filter((x) => !!x.k && !!x.v);

function buildBlock(candidate: unknown, warnings: string[]): VisualBlock | null {
  if (!candidate || typeof candidate !== 'object') {
    if (candidate != null) warnings.push('dropped a non-object block');
    return null;
  }
  const raw = candidate as Record<string, unknown>;
  const alias = TYPE_ALIASES[str(raw.type, 24).toLowerCase()];
  const type = alias ?? '';

  if (type === 'stats' || type === 'kv') {
    const fieldKeys = type === 'stats'
      ? ['items', 'entries', 'metrics', 'kpis', 'values', 'data', 'points', 'fields', 'stats']
      : ['items', 'entries', 'properties', 'props', 'fields', 'attributes', 'details', 'specs', 'facts', 'values', 'data', 'points'];
    const items = buildItemsKV(itemsOf(raw, fieldKeys), type);
    if (!items.length && type === 'kv') {
      // {type:"kv", Colour:"Cyan"} — the object itself is the map
      const self = Object.entries(raw)
        .filter(([k, v]) => !NOISE_KEYS.has(k) && k !== 'type' && v != null && typeof v !== 'object')
        .map(([k, v]) => ({ k: str(k, 120), v: str(v, 120) }))
        .filter((x) => x.k && x.v);
      if (self.length) return { type: 'kv', items: self };
    }
    if (!items.length) { warnings.push(`dropped empty ${type} block`); return null; }
    return type === 'stats'
      ? { type: 'stats', items: items.map(({ k, v, unit, hint, tone: t }) => ({ k, v, ...(unit ? { unit } : {}), ...(hint ? { hint } : {}), ...(t ? { tone: t } : {}) })) }
      : { type: 'kv', items: items.map(({ k, v, tone: t }) => ({ k, v, ...(t ? { tone: t } : {}) })) };
  }

  if (type === 'bars') {
    const items = itemsOf(raw, ['items', 'data', 'series', 'values', 'entries', 'points'])
      .slice(0, MAX_ITEMS)
      .map((it) => {
        if (typeof it === 'string' || typeof it === 'number') return { label: str(it, 120), value: NaN, display: undefined as string | undefined, tone: undefined as Tone | undefined };
        const o = (it ?? {}) as Record<string, unknown>;
        const label = sPick(o, ['label', 'k', 'key', 'name', 'title'], 120);
        const value = num(firstKey(o, ['value', 'v', 'val', 'count', 'score', 'amount', 'number']));
        return { label, value, display: sPick(o, ['display', 'text'], 48) || undefined, tone: tone(o.tone) };
      })
      .filter((x) => !!x.label && Number.isFinite(x.value));
    if (!items.length) {
      // bars with labels but no numbers degrade to a list instead of vanishing
      const labels = itemsOf(raw, ['items', 'data', 'series', 'values', 'entries', 'points'])
        .map((it) => (typeof it === 'string' ? str(it, 600) : sPick((it ?? {}) as Record<string, unknown>, ['label', 'k', 'key', 'name', 'title'], 600)))
        .filter((s) => !!s);
      if (labels.length) {
        warnings.push('repaired: bars had no numeric values; shown as a list');
        return { type: 'list', items: labels.map((text) => ({ text: text.slice(0, 600) })) };
      }
      warnings.push('dropped empty bars block');
      return null;
    }
    const maxRaw = num(firstKey(raw, ['max', 'maximum', 'scale']));
    const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : Math.max(...items.map((i) => i.value), 100);
    return { type: 'bars', items, max };
  }

  if (type === 'table') {
    let cols = (Array.isArray(firstKey(raw, ['columns', 'headers', 'cols', 'fields'])) ? (firstKey(raw, ['columns', 'headers', 'cols', 'fields']) as unknown[]) : [])
      .slice(0, 12)
      .map((c) => {
        if (typeof c === 'string' || typeof c === 'number') return { label: str(c, 120), align: undefined as 'left' | 'right' | 'center' | undefined };
        const o = (c ?? {}) as Record<string, unknown>;
        const label = sPick(o, ['label', 'k', 'key', 'name', 'title', 'column', 'header'], 120);
        const align = str(o.align, 8).toLowerCase();
        return { label, align: align === 'right' || align === 'center' ? (align as 'right' | 'center') : undefined };
      })
      .filter((c) => !!c.label);
    let rows: string[][] = (Array.isArray(firstKey(raw, ['rows', 'data', 'records', 'entries', 'values', 'items'])) ? (firstKey(raw, ['rows', 'data', 'records', 'entries', 'values', 'items']) as unknown[]) : [])
      .slice(0, MAX_ITEMS)
      .map((r) => (Array.isArray(r) ? r.map((c) => str(c, 400)) : [str(r, 400)]))
      .filter((r) => r.some((c) => !!c));

    // Rows given as objects: derive the columns from their keys — the most common mangled table.
    const objRows = (Array.isArray(firstKey(raw, ['rows', 'data', 'records', 'entries', 'values', 'items'])) ? (firstKey(raw, ['rows', 'data', 'records', 'entries', 'values', 'items']) as unknown[]) : [])
      .slice(0, MAX_ITEMS)
      .filter((r) => r && typeof r === 'object' && !Array.isArray(r)) as Record<string, unknown>[];
    if (objRows.length && objRows.length === rows.length) {
      const keys: string[] = [];
      for (const r of objRows.slice(0, 10)) for (const k of Object.keys(r)) if (k && !keys.includes(k) && !NOISE_KEYS.has(k)) keys.push(k);
      if (keys.length && !cols.length) cols = keys.map((k) => ({ label: str(k, 120), align: undefined as 'left' | 'right' | 'center' | undefined }));
      rows = objRows.map((r) => keys.map((k) => str(r[k], 400))).filter((r) => r.some((c) => !!c));
    }
    if (!cols.length && rows.length) {
      const width = Math.max(...rows.map((r) => (Array.isArray(r) ? r.length : 1)), 1);
      cols = Array.from({ length: width }, (_, i) => ({ label: `Col ${i + 1}`, align: undefined as 'left' | 'right' | 'center' | undefined }));
      warnings.push('repaired: table had no columns; generated from the row width');
    }
    // Keep the declared column width: extra cells are dropped, short rows pad at render.
    rows = rows.map((r) => (Array.isArray(r) ? r.slice(0, Math.max(cols.length, 1)) : [str(r, 400)]));
    // Headers with no rows still show as a list rather than vanishing.
    if (!rows.length && cols.length) {
      warnings.push('repaired: table had columns but no rows; shown as a list');
      return { type: 'list', items: cols.map((c) => ({ text: c.label })) };
    }
    if (!cols.length || !rows.length) { warnings.push('dropped incomplete table block'); return null; }
    return { type: 'table', columns: cols, rows };
  }

  if (type === 'flow') {
    const steps = itemsOf(raw, ['steps', 'sequence', 'stages', 'items', 'flow'])
      .slice(0, 12)
      .map((s): { label: string; note?: string } | null => {
        if (typeof s === 'string' || typeof s === 'number') return { label: str(s, 120), note: undefined };
        const o = (s ?? {}) as Record<string, unknown>;
        const label = sPick(o, ['label', 'k', 'key', 'name', 'title', 'step', 'text'], 120);
        if (!label) return null;
        return { label, note: sPick(o, ['note', 'detail', 'description', 'v', 'value'], 200) || undefined };
      })
      .filter((x): x is { label: string; note?: string } => !!x);
    const only = steps.length === 1 ? steps[0] : undefined;
    if (only) {
      warnings.push('repaired: single-step flow shown as a note');
      return { type: 'note', tone: 'info', title: only.label, text: only.note ?? only.label };
    }
    if (steps.length < 2) { warnings.push('dropped flow block with fewer than two steps'); return null; }
    return { type: 'flow', steps };
  }

  if (type === 'timeline') {
    const items = itemsOf(raw, ['items', 'events', 'entries', 'points', 'timeline'])
      .slice(0, MAX_ITEMS)
      .map((it) => {
        if (typeof it === 'string' || typeof it === 'number') return { when: '', what: str(it, 600) };
        const o = (it ?? {}) as Record<string, unknown>;
        return {
          when: sPick(o, ['when', 'date', 'time', 'year', 'k', 'key', 'label'], 80),
          what: sPick(o, ['what', 'text', 'event', 'description', 'v', 'value', 'title'], 600),
        };
      })
      .filter((x) => !!x.when || !!x.what);
    if (!items.length) { warnings.push('dropped empty timeline block'); return null; }
    return { type: 'timeline', items };
  }

  if (type === 'list') {
    const items = itemsOf(raw, ['items', 'entries', 'points', 'values', 'bullets', 'list'])
      .slice(0, MAX_ITEMS)
      .map((it) => {
        if (typeof it === 'string' || typeof it === 'number') return { text: str(it, 600), tone: undefined as Tone | undefined };
        const o = (it ?? {}) as Record<string, unknown>;
        const text = sPick(o, ['text', 'v', 'value', 'point', 'item', 'body', 'title', 'label'], 600);
        return { text, tone: tone(o.tone) };
      })
      .filter((x) => !!x.text);
    if (!items.length) { warnings.push('dropped empty list block'); return null; }
    return { type: 'list', items };
  }

  if (type === 'tags') {
    const items = itemsOf(raw, ['items', 'tags', 'labels', 'keywords', 'values', 'chips'])
      .slice(0, 40)
      .map((t) => (typeof t === 'string' || typeof t === 'number' ? str(t, 60) : sPick((t ?? {}) as Record<string, unknown>, ['text', 'label', 'name', 'k', 'tag'], 60)))
      .filter((t) => !!t);
    if (!items.length) { warnings.push('dropped empty tags block'); return null; }
    return { type: 'tags', items };
  }

  if (type === 'compare') {
    let optionsRaw = itemsOf(raw, ['options', 'alternatives', 'choices', 'columns', 'items', 'versus', 'candidates']);
    // compare as an object map {A: {...}, B: {...}} — including a legacy {comparison: {...}} spread
    const container = firstKey(raw, ['options', 'alternatives', 'choices', 'versus', 'candidates']);
    if (!Array.isArray(container) && (!container || typeof container !== 'object')) {
      const selfMap = Object.fromEntries(
        Object.entries(raw).filter(([, v]) => v != null && typeof v === 'object' && !Array.isArray(v))
      );
      if (Object.keys(selfMap).length >= 1) optionsRaw = Object.entries(selfMap).map(([name, val]) => ({ name, ...((val && typeof val === 'object' ? val : { points: { value: val } }) as Record<string, unknown>) }));
    } else if (!Array.isArray(container) && container && typeof container === 'object') {
      optionsRaw = Object.entries(container as Record<string, unknown>).map(([name, val]) => ({ name, ...(val && typeof val === 'object' ? (val as Record<string, unknown>) : { points: { value: val } }) }));
    }
    const options = optionsRaw
      .slice(0, 4)
      .map((o) => {
        if (typeof o === 'string' || typeof o === 'number') return { name: str(o, 120), points: [] as { k: string; v: string }[] };
        const c = (o ?? {}) as Record<string, unknown>;
        const name = sPick(c, ['name', 'label', 'title', 'option', 'k'], 120);
        const pointsRaw = itemsOf(c, ['points', 'props', 'attrs', 'details', 'items', 'values', 'features', 'specs']);
        const points = pointsRaw
          .slice(0, 20)
          .map((p) => {
            if (typeof p === 'string' || typeof p === 'number') return { k: '', v: str(p, 200) };
            const q = (p ?? {}) as Record<string, unknown>;
            return { k: sPick(q, ['k', 'key', 'label', 'name', 'feature', 'aspect'], 120), v: sPick(q, ['v', 'value', 'text', 'detail'], 200) };
          })
          .filter((x) => !!x.k || !!x.v);
        return { name, points };
      })
      .filter((x) => !!x.name && x.points.length > 0);
    if (options.length === 1) {
      warnings.push('repaired: single-option compare shown as key values');
      return { type: 'kv', items: options[0].points.slice(0, MAX_ITEMS) };
    }
    if (options.length < 2) { warnings.push('dropped compare block with fewer than two options'); return null; }
    return { type: 'compare', options };
  }

  if (type === 'note') {
    const text = sPick(raw, ['text', 'body', 'message', 'content', 'description', 'summary', 'insight', 'detail'], 1200);
    if (!text) { warnings.push('dropped empty note block'); return null; }
    const title = sPick(raw, ['title', 'heading', 'label'], 120) || undefined;
    return { type: 'note', tone: tone(raw.tone) ?? 'info', ...(title ? { title } : {}), text };
  }

  if (type === 'text') {
    let body = sPick(raw, ['body', 'text', 'content', 'prose', 'message', 'description', 'summary', 'value'], 4000);
    if (!body && Array.isArray(firstKey(raw, ['items', 'paragraphs', 'points', 'lines']))) {
      body = (firstKey(raw, ['items', 'paragraphs', 'points', 'lines']) as unknown[])
        .map((p) => (typeof p === 'string' || typeof p === 'number' ? str(p, 2000) : sPick((p ?? {}) as Record<string, unknown>, ['text', 'body', 'v'], 2000)))
        .filter((p) => !!p)
        .slice(0, 50)
        .join('\n\n');
      if (body) warnings.push('repaired: text block assembled from its items');
    }
    if (!body) { warnings.push('dropped empty text block'); return null; }
    const heading = sPick(raw, ['heading', 'title', 'name', 'label'], 120) || undefined;
    return heading ? { type: 'text', heading, body } : { type: 'text', body };
  }

  if (type === 'svg') {
    const markup = sanitizeSvg(sPick(raw, ['markup', 'svg', 'content', 'source', 'diagram'], MAX_SVG) || '');
    if (!/^<svg[\s>]/i.test(markup)) { warnings.push('dropped svg block without an <svg> root'); return null; }
    return { type: 'svg', markup };
  }

  // A typeless k/v pair ({k:"Speed", v:"42"} without a type) is still real data: show it.
  const pairK = sPick(raw, ['k', 'key', 'label', 'name'], 120);
  const pairV = sPick(raw, ['v', 'value', 'text'], 120);
  if (pairK && pairV) {
    warnings.push('repaired: typeless k/v block shown as key values');
    return { type: 'kv', items: [{ k: pairK, v: pairV }] };
  }

  warnings.push(`dropped unknown block type "${str(raw.type, 24) || '(missing)'}"`);
  return null;
}

/** Final salvage: pull readable strings out of the ORIGINAL payload when no block survived. */
function finalSalvage(input: unknown, warnings: string[]): VisualBlock | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const strings = harvestStrings(input as Record<string, unknown>, 0);
  if (!strings.length) return null;
  warnings.push('repaired: no block survived validation; the payload\'s raw content is shown as text');
  return { type: 'text', body: strings.join('\n\n') };
}

export interface NormalizeResult {
  ir: VisualIR;
  warnings: string[];
}

/** GUARANTEE of this function: the returned IR always has at least one renderable block.
 *  Any input — null, a string, an old-schema payload, mangled blocks — comes out renderable. */
export function normalizeVisual(input: unknown): NormalizeResult {
  const warnings: string[] = [];
  const subtitle = input && typeof input === 'object' && !Array.isArray(input) ? str((input as Record<string, unknown>).subtitle, 200) || undefined : undefined;
  const candidates = coerceCandidates(input, warnings);
  const blocks: VisualBlock[] = [];
  for (const c of candidates) {
    if (blocks.length >= MAX_BLOCKS) { warnings.push(`blocks capped at ${MAX_BLOCKS}`); break; }
    const b = buildBlock(c, warnings);
    if (b) blocks.push(b);
  }
  if (!blocks.length) {
    const salvaged = finalSalvage(input, warnings);
    if (salvaged) return { ir: { blocks: [salvaged] }, warnings };
    // Truly nothing: render an honest, calm panel instead of a dead-end error.
    warnings.push('payload had no renderable content');
    return { ir: { blocks: [{ type: 'note', tone: 'info', title: 'Nothing to show', text: 'This visual arrived without content. Ask JARVIS to build it again.' }] }, warnings };
  }
  return { ir: { ...(subtitle ? { subtitle } : {}), blocks }, warnings };
}

export interface StagingResult {
  ir: VisualIR | null;
  warnings: string[];
}

/** Tool-time twin of normalizeVisual: identical repair, but a payload with NOTHING
 *  renderable in it returns null so show_visual can reject with guidance and the model
 *  retries — an empty panel never reaches the user's screen. */
export function normalizeForStaging(input: unknown): StagingResult {
  const warnings: string[] = [];
  const subtitle = input && typeof input === 'object' && !Array.isArray(input) ? str((input as Record<string, unknown>).subtitle, 200) || undefined : undefined;
  const candidates = coerceCandidates(input, warnings);
  const blocks: VisualBlock[] = [];
  for (const c of candidates) {
    if (blocks.length >= MAX_BLOCKS) { warnings.push(`blocks capped at ${MAX_BLOCKS}`); break; }
    const b = buildBlock(c, warnings);
    if (b) blocks.push(b);
  }
  if (!blocks.length) {
    const salvaged = finalSalvage(input, warnings);
    if (salvaged) return { ir: { blocks: [salvaged] }, warnings };
    return { ir: null, warnings: warnings.length ? warnings : ['no renderable blocks'] };
  }
  return { ir: { ...(subtitle ? { subtitle } : {}), blocks }, warnings };
}

/* ---------- rendering (deterministic templates; presentation lives in holoKit) ---------- */

const cell = (x: string, align?: 'left' | 'right' | 'center'): string =>
  align ? `<td class="al-${align}">${esc(x)}</td>` : `<td>${esc(x)}</td>`;

const toneCls = (t?: Tone): string => (t ? ` ${t}` : '');

function renderBlock(b: VisualBlock): string {
  switch (b.type) {
    case 'stats':
      return `<div class="grid">${b.items.map((i) => `<div class="card"><div class="k">${esc(i.k)}</div><div class="v${toneCls(i.tone)}">${esc(i.v)}${i.unit ? `<small>${esc(i.unit)}</small>` : ''}</div>${i.hint ? `<p class="hint">${esc(i.hint)}</p>` : ''}</div>`).join('')}</div>`;
    case 'bars': {
      const max = b.max != null && b.max > 0 ? b.max : 100;
      return b.items.map((i) => {
        const pct = Math.max(2, Math.min(100, Math.round((i.value / max) * 100)));
        return `<div class="row"><span>${esc(i.label)}</span><div class="bar"><i class="${i.tone ?? ''}" style="width:${pct}%"></i></div><span class="n">${esc(i.display ?? String(i.value))}</span></div>`;
      }).join('');
    }
    case 'table':
      return `<div class="tablewrap"><table><thead><tr>${b.columns.map((c) => (c.align ? `<th class="al-${c.align}">${esc(c.label)}</th>` : `<th>${esc(c.label)}</th>`)).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${b.columns.map((c, idx) => cell(r[idx] ?? '', c.align)).join('')}</tr>`).join('')}</tbody></table></div>`;
    case 'flow':
      return `<div class="flow">${b.steps.map((s, i) => `${i ? '<span class="arrow"></span>' : ''}<span class="node">${esc(s.label)}${s.note ? `<small>${esc(s.note)}</small>` : ''}</span>`).join('')}</div>`;
    case 'timeline':
      return `<div class="timeline">${b.items.map((i) => `<div>${i.when ? `<b>${esc(i.when)}</b>` : ''}<p>${esc(i.what)}</p></div>`).join('')}</div>`;
    case 'list':
      return `<ul class="list">${b.items.map((i) => `<li class="${i.tone ?? ''}">${esc(i.text)}</li>`).join('')}</ul>`;
    case 'tags':
      return `<div class="tagrow">${b.items.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`;
    case 'compare':
      return `<div class="compare" style="--cols:${b.options.length}">${b.options.map((o) => `<div class="card option"><div class="k">${esc(o.name)}</div><div class="pts">${o.points.map((p) => `<div class="pt"><span class="pk">${esc(p.k)}</span><span class="pv">${esc(p.v)}</span></div>`).join('')}</div></div>`).join('')}</div>`;
    case 'note': {
      const t = b.tone && b.tone !== 'info' ? ` ${b.tone}` : '';
      return `<div class="callout${t}">${b.title ? `<b>${esc(b.title)}</b>` : ''}<p>${esc(b.text)}</p></div>`;
    }
    case 'text': {
      const paras = b.body.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br/>')}</p>`).join('');
      return `${b.heading ? `<h2>${esc(b.heading)}</h2>` : ''}${paras}`;
    }
    case 'kv':
      return `<div class="kv">${b.items.map((i) => `<div class="kvrow"><span class="k">${esc(i.k)}</span><span class="v2${toneCls(i.tone)}">${esc(i.v)}</span></div>`).join('')}</div>`;
    case 'svg':
      return `<div class="viz-svg">${b.markup}</div>`;
  }
}

/** IR → the exact HTML the sandboxed iframe renders. Blocks are stacked; holoKit styles them. */
export function renderVisual(ir: VisualIR): string {
  return ir.blocks.map(renderBlock).join('\n');
}
