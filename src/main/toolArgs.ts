import type { Tool } from './toolTypes';

type PropSchema = {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  description?: string;
  minItems?: number;
  maxItems?: number;
  items?: PropSchema;
};
type Schema = { type?: string; properties?: Record<string, PropSchema>; required?: string[]; additionalProperties?: boolean };

const ALIASES: Record<string, string> = {
  open_browser: 'browser_open', browser_navigate: 'browser_open', browser_goto: 'browser_open', navigate: 'browser_open',
  open_website: 'browser_open', open_page: 'browser_open', search_web: 'web_search', websearch: 'web_search', google: 'web_search',
  read_file: 'read', cat: 'read', ls: 'list_files', shell: 'run_command', bash: 'run_command', powershell: 'run_command',
  exec: 'run_command', run: 'run_command', screenshot: 'see_screen', open_application: 'launch_app', start_app: 'launch_app',
  open_app_by_name: 'launch_app',
};

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)] as number[]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Map a hallucinated or malformed tool name to a real one; null when nothing is close enough or the guess would act. */
export function resolveTool(name: string, tools: Record<string, Tool>, safeToGuess: (n: string) => boolean = () => true): string | null {
  if (tools[name]) return name;
  const n = norm(name.replace(/^(functions?|tools?)[.:/]/i, ''));
  if (tools[n]) return n;
  if (ALIASES[n] && tools[ALIASES[n]]) return ALIASES[n];
  const best = Object.keys(tools)
    .map((k) => ({ k, d: distance(n, k) }))
    .sort((x, y) => x.d - y.d)[0];
  // A guessed (fuzzy) match may only run read-only tools; anything that acts must be named exactly.
  return best && best.d <= Math.max(2, Math.floor(n.length / 4)) && safeToGuess(best.k) ? best.k : null;
}

/** Repairs are cumulative: each one fixes another thing models get wrong, on top of the previous repair. */
const REPAIRS: Array<(s: string) => string> = [
  (s) => s.replace(/^```(?:json)?\s*/gim, '').replace(/```\s*$/gim, '').trim(),
  (s) => s.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1').replace(/'([^']*)'\s*:/g, '"$1":'),
  (s) => (s.match(/\{[\s\S]*\}/) ?? [''])[0],
];

/** Tolerant JSON: strips code fences, trailing commas, smart quotes and single-quoted keys, cumulatively. */
export function parseArgs(raw: string): Record<string, unknown> {
  const t = (raw ?? '').trim();
  if (!t) return {};
  let cur = t;
  for (let step = 0; ; step++) {
    try {
      const v = JSON.parse(cur) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
      if (typeof v === 'string') return parseArgs(v);
    } catch {
      /* try the next repair */
    }
    if (step >= REPAIRS.length) break;
    cur = REPAIRS[step](cur);
    if (!cur) break;
  }
  throw new Error(`Arguments were not valid JSON: ${t.slice(0, 120)}`);
}

/** Coerce stringly-typed values to the schema and reject calls missing required fields with an actionable message.
 *  F-11: declared enums, numeric ranges and string length bounds are ENFORCED, not just
 *  documentation — a schema violation fails with an actionable message instead of
 *  reaching the tool and failing somewhere less explainable. */
export function checkArgs(name: string, args: Record<string, unknown>, params: unknown): Record<string, unknown> {
  const sch = (params ?? {}) as Schema;
  const props = sch.properties ?? {};
  const out: Record<string, unknown> = { ...args };
  for (const [k, def] of Object.entries(props)) {
    const v = out[k];
    if (v === undefined || v === null) continue;
    if ((def.type === 'number' || def.type === 'integer') && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) out[k] = Number(v);
    else if (def.type === 'boolean' && typeof v === 'string') {
      if (/^(true|yes|1)$/i.test(v)) out[k] = true;
      else if (/^(false|no|0)$/i.test(v)) out[k] = false;
      else throw new Error(`${name}.${k} must be true or false (got ${JSON.stringify(v)}).`);
    }
    else if (def.type === 'string' && (typeof v === 'number' || typeof v === 'boolean')) out[k] = String(v);
    else if (def.type === 'array' && typeof v === 'string') {
      try {
        const p = JSON.parse(v) as unknown;
        out[k] = Array.isArray(p) ? p : [v];
      } catch {
        out[k] = [v];
      }
    } else if (def.type === 'object' && typeof v === 'string') {
      try {
        const parsed = JSON.parse(v) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
        out[k] = parsed;
      } catch {
        throw new Error(`${name}.${k} must be a valid JSON object.`);
      }
    }
  }
  for (const [k, def] of Object.entries(props)) {
    const v = out[k];
    if (v === undefined || v === null) continue;
    if (def.type === 'string' && typeof v !== 'string')
      throw new Error(`${name}.${k} must be a string.`);
    if (def.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v)))
      throw new Error(`${name}.${k} must be a finite number.`);
    if (def.type === 'integer' && (typeof v !== 'number' || !Number.isInteger(v)))
      throw new Error(`${name}.${k} must be an integer.`);
    if (def.type === 'boolean' && typeof v !== 'boolean')
      throw new Error(`${name}.${k} must be a boolean.`);
    if (def.type === 'array' && !Array.isArray(v))
      throw new Error(`${name}.${k} must be an array.`);
    if (def.type === 'object' && (!v || typeof v !== 'object' || Array.isArray(v)))
      throw new Error(`${name}.${k} must be an object.`);
  }
  if (sch.additionalProperties === false) {
    const unknown = Object.keys(out).filter((key) => !(key in props));
    if (unknown.length) throw new Error(`${name} received unsupported argument(s): ${unknown.join(', ')}.`);
  }
  const missing = (sch.required ?? []).filter((k) => out[k] === undefined || out[k] === null || out[k] === '');
  if (missing.length) {
    const sig = Object.entries(props).map(([k, d]) => `${k}${sch.required?.includes(k) ? '*' : ''}:${d.type ?? 'any'}`).join(', ');
    throw new Error(`${name} is missing required argument(s): ${missing.join(', ')}. Signature: ${sig}. Call it again with them.`);
  }
  // Constraint enforcement (F-11). Runs after coercion so "3" for an enum ["3"] works.
  for (const [k, def] of Object.entries(props)) {
    const v = out[k];
    if (v === undefined || v === null) continue;
    if (def.enum && !def.enum.some((e) => e === v || JSON.stringify(e) === JSON.stringify(v)))
      throw new Error(`${name}.${k} must be one of: ${def.enum.map((e) => String(e)).join(' | ')} (got ${JSON.stringify(v)}). Call it again with a valid value.`);
    if (Array.isArray(v)) {
      if (def.minItems !== undefined && v.length < def.minItems)
        throw new Error(`${name}.${k} requires at least ${def.minItems} item(s).`);
      if (def.maxItems !== undefined && v.length > def.maxItems)
        throw new Error(`${name}.${k} accepts at most ${def.maxItems} item(s).`);
      if (def.items?.type) {
        const badIndex = v.findIndex((item) => def.items?.type === 'string' ? typeof item !== 'string'
          : def.items?.type === 'number' ? typeof item !== 'number' || !Number.isFinite(item)
          : def.items?.type === 'integer' ? typeof item !== 'number' || !Number.isInteger(item)
          : def.items?.type === 'boolean' ? typeof item !== 'boolean'
          : false);
        if (badIndex >= 0) throw new Error(`${name}.${k}[${badIndex}] must be ${def.items.type}.`);
      }
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      if (def.minimum !== undefined && v < def.minimum)
        throw new Error(`${name}.${k} must be ≥ ${def.minimum} (got ${v}). Call it again.`);
      if (def.maximum !== undefined && v > def.maximum)
        throw new Error(`${name}.${k} must be ≤ ${def.maximum} (got ${v}). Call it again.`);
    }
    if (typeof v === 'string') {
      if (def.maxLength !== undefined && v.length > def.maxLength)
        throw new Error(`${name}.${k} exceeds its maximum length of ${def.maxLength} characters (got ${v.length}). Trim it and call again.`);
      if (def.minLength !== undefined && v.length < def.minLength)
        throw new Error(`${name}.${k} must be at least ${def.minLength} characters (got ${v.length}). Call it again.`);
    }
  }
  return out;
}
