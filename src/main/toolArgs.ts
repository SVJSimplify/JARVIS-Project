import type { Tool } from './toolTypes';

type Schema = { type?: string; properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] };

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

/** Coerce stringly-typed values to the schema and reject calls missing required fields with an actionable message. */
export function checkArgs(name: string, args: Record<string, unknown>, params: unknown): Record<string, unknown> {
  const sch = (params ?? {}) as Schema;
  const props = sch.properties ?? {};
  const out: Record<string, unknown> = { ...args };
  for (const [k, def] of Object.entries(props)) {
    const v = out[k];
    if (v === undefined || v === null) continue;
    if (def.type === 'number' && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) out[k] = Number(v);
    else if (def.type === 'boolean' && typeof v === 'string') out[k] = /^(true|yes|1)$/i.test(v);
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
        out[k] = JSON.parse(v) as unknown;
      } catch {
        /* leave as is */
      }
    }
  }
  const missing = (sch.required ?? []).filter((k) => out[k] === undefined || out[k] === null || out[k] === '');
  if (missing.length) {
    const sig = Object.entries(props).map(([k, d]) => `${k}${sch.required?.includes(k) ? '*' : ''}:${d.type ?? 'any'}`).join(', ');
    throw new Error(`${name} is missing required argument(s): ${missing.join(', ')}. Signature: ${sig}. Call it again with them.`);
  }
  return out;
}
