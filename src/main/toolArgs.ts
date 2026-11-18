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
  properties?: Record<string, PropSchema>;
  required?: string[];
  additionalProperties?: boolean;
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

/**
 * Validate one argument recursively against its declared tool schema. Stringly-typed
 * primitives are repaired only when the conversion is unambiguous; malformed values
 * fail at the dispatch boundary with a precise argument path.
 */
function checkValue(name: string, key: string, input: unknown, def: PropSchema, depth = 0): unknown {
  if (depth > 16) throw new Error(`${name}.${key} exceeds the maximum schema nesting depth.`);
  if (input === undefined || input === null) return input;

  let value = input;
  if ((def.type === 'number' || def.type === 'integer') && typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) value = n;
  } else if (def.type === 'boolean' && typeof value === 'string') {
    if (/^(true|yes|1)$/i.test(value.trim())) value = true;
    else if (/^(false|no|0)$/i.test(value.trim())) value = false;
    else throw new Error(`${name}.${key} must be true or false (got ${JSON.stringify(value)}).`);
  } else if (def.type === 'string' && (typeof value === 'number' || typeof value === 'boolean')) {
    value = String(value);
  } else if (def.type === 'array' && typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      value = Array.isArray(parsed) ? parsed : [value];
    } catch {
      value = [value];
    }
  } else if (def.type === 'object' && typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
      value = parsed;
    } catch {
      throw new Error(`${name}.${key} must be a valid JSON object.`);
    }
  }

  if (def.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${name}.${key} must be a string.`);
    if (def.minLength !== undefined && value.length < def.minLength) throw new Error(`${name}.${key} must be at least ${def.minLength} characters.`);
    if (def.maxLength !== undefined && value.length > def.maxLength) throw new Error(`${name}.${key} exceeds its maximum length of ${def.maxLength} characters.`);
  } else if (def.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name}.${key} must be a finite number.`);
    if (def.minimum !== undefined && value < def.minimum) throw new Error(`${name}.${key} must be ≥ ${def.minimum} (got ${value}).`);
    if (def.maximum !== undefined && value > def.maximum) throw new Error(`${name}.${key} must be ≤ ${def.maximum} (got ${value}).`);
  } else if (def.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${name}.${key} must be an integer.`);
    if (def.minimum !== undefined && value < def.minimum) throw new Error(`${name}.${key} must be ≥ ${def.minimum} (got ${value}).`);
    if (def.maximum !== undefined && value > def.maximum) throw new Error(`${name}.${key} must be ≤ ${def.maximum} (got ${value}).`);
  } else if (def.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${name}.${key} must be a boolean.`);
  } else if (def.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${name}.${key} must be an array.`);
    if (def.minItems !== undefined && value.length < def.minItems) throw new Error(`${name}.${key} requires at least ${def.minItems} item(s).`);
    if (def.maxItems !== undefined && value.length > def.maxItems) throw new Error(`${name}.${key} accepts at most ${def.maxItems} item(s).`);
    if (def.items) value = value.map((item, index) => checkValue(name, `${key}[${index}]`, item, def.items!, depth + 1));
  } else if (def.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name}.${key} must be an object.`);
    const object = { ...(value as Record<string, unknown>) };
    const properties = def.properties ?? {};
    if (def.additionalProperties === false) {
      const unknown = Object.keys(object).filter((property) => !(property in properties));
      if (unknown.length) throw new Error(`${name}.${key} received unsupported argument(s): ${unknown.join(', ')}.`);
    }
    for (const [property, schema] of Object.entries(properties)) {
      if (object[property] !== undefined && object[property] !== null) {
        object[property] = checkValue(name, `${key}.${property}`, object[property], schema, depth + 1);
      }
    }
    const missing = (def.required ?? []).filter((property) => object[property] === undefined || object[property] === null || object[property] === '');
    if (missing.length) throw new Error(`${name}.${key} is missing required field(s): ${missing.join(', ')}.`);
    value = object;
  }

  if (def.enum && !def.enum.some((item) => item === value || JSON.stringify(item) === JSON.stringify(value))) {
    throw new Error(`${name}.${key} must be one of: ${def.enum.map(String).join(' | ')} (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/**
 * Enforce the declared tool argument schema at the dispatch boundary. Coercion is limited
 * to unambiguous JSON-model mistakes; types, nested objects, array items, bounds, enums
 * and closed-object contracts are then checked before authorization or execution.
 */
export function checkArgs(name: string, args: Record<string, unknown>, params: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${name} arguments must be a JSON object.`);
  const schema = (params ?? {}) as Schema;
  const properties = schema.properties ?? {};
  const out: Record<string, unknown> = { ...args };

  if (schema.additionalProperties === false) {
    const unknown = Object.keys(out).filter((key) => !(key in properties));
    if (unknown.length) throw new Error(`${name} received unsupported argument(s): ${unknown.join(', ')}.`);
  }

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (out[key] !== undefined && out[key] !== null) {
      out[key] = checkValue(name, key, out[key], propertySchema);
    }
  }

  const missing = (schema.required ?? []).filter((key) => out[key] === undefined || out[key] === null || out[key] === '');
  if (missing.length) {
    const signature = Object.entries(properties)
      .map(([key, property]) => `${key}${schema.required?.includes(key) ? '*' : ''}:${property.type ?? 'any'}`)
      .join(', ');
    throw new Error(`${name} is missing required argument(s): ${missing.join(', ')}. Signature: ${signature}. Call it again with them.`);
  }
  return out;
}
