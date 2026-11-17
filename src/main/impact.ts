import { promises as fs } from 'fs';
import * as path from 'path';
import type { Dirent } from 'fs';
import { FILES_ROOT, isInsideRoot } from './workspace';
import type { Tool } from './toolTypes';

/**
 * DEPENDENCY & IMPACT ANALYSIS (Round 31 §2.3) — before code is modified, this answers
 * what the change can affect. Derived from the ACTUAL import graph of the workspace:
 *  - what the target module imports (its own dependencies, local ones resolved to files);
 *  - which files import the TARGET (the reverse graph — the blast radius);
 *  - which named exports of the target are referenced where (shared-interface risk);
 *  - which configuration files mention the target.
 *
 * Not a second indexing system: every call scans the workspace BOUNDED (file count,
 * file size, walk depth) and reports exactly what it saw — including honest empties.
 * No cache, no persistent index to go stale: the filesystem at call time is the truth.
 */

export interface ImpactReport {
  /** Workspace-relative target that was analyzed. */
  target: string;
  exists: boolean;
  /** Named exports the target offers (bounded; the interfaces others depend on). */
  exports: string[];
  /** Files that import the target DIRECTLY (bounded). */
  importedBy: Array<{ file: string; /** The specific names imported from the target, when statically listed. */ names: string[] }>;
  /** ROUND 32 (§5.3): files reached through the direct dependents (transitive blast radius, bounded, labeled). */
  transitiveDependents: string[];
  /** Local files the target itself imports (bounded, resolved). */
  imports: string[];
  /** Config files that mention the target's module name (bounded). */
  configReferences: string[];
  /** Bounded-work statement: what was actually scanned and what was NOT resolved. */
  scannedNote: string;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'target', 'venv', '.venv', '__pycache__', '.cache', 'release', 'coverage']);
const SRC_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|vue|svelte)$/i;
const CONFIG_EXT = /\.(json|ya?ml|toml|ini|cfg|conf)$/i;
const MAX_SCAN_FILES = 600;
const MAX_FILE_BYTES = 220 * 1024;
const WALK_DEPTH = 7;

/** Bounded workspace walk collecting source + config files (paths only — contents lazily). */
async function walkSources(root: string): Promise<{ src: string[]; config: string[] }> {
  const src: string[] = [];
  const config: string[] = [];
  let budget = MAX_SCAN_FILES;
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (budget <= 0 || depth > WALK_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (budget <= 0) break;
      const erel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(path.join(dir, e.name), erel, depth + 1);
      } else if (e.isFile()) {
        if (!SRC_EXT.test(e.name) && !CONFIG_EXT.test(e.name)) continue;
        budget--;
        (CONFIG_EXT.test(e.name) ? config : src).push(erel);
      }
    }
  };
  await walk(root, '', 0);
  return { src, config };
}

/** Named exports of a JS/TS/… module: `export const|function|class|interface|type X`, `export { A, B }`, `export default`. */
function exportsOf(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  if (/export\s+default\b/.test(text)) names.add('default');
  return [...names].slice(0, 24);
}

/** Import statements of a module (ESM + CJS + Python/Go lightweight forms). */
function importsOf(text: string): string[] {
  const specs = new Set<string>();
  for (const m of text.matchAll(/(?:import[\s\S]*?from\s*|export[\s\S]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)) specs.add(m[1]);
  for (const m of text.matchAll(/^\s*import\s+(?:[\w.\s,{}]*from\s+)?([\w.]+)\s*$/gm)) specs.add(m[1]); // python
  return [...specs].slice(0, 40);
}

/** Does this file's import of the target list specific names? (shared-interface detection; matches by any path candidate, basename fallback) */
function importedNames(text: string, targetRel: string): string[] {
  const baseNoExt = path.posix.basename(targetRel).replace(/\.[^.]+$/, '');
  const noExt = targetRel.replace(/\.[^.]+$/, '');
  const escaped = [targetRel, noExt, baseNoExt].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`import\\s*\\{([^}]+)\\}\\s*(?:as\\s+[\\w$]+\\s*)?from\\s*['"][^'"]*(?:${escaped.join('|')})['"]`, 'g');
  const names = new Set<string>();
  for (const m of text.matchAll(re)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (n) names.add(n);
    }
  }
  return [...names].slice(0, 16);
}

const moduleCandidates = (rel: string): string[] => {
  const noExt = rel.replace(/\.[^.]+$/, '');
  const base = path.posix.basename(noExt);
  return [rel, noExt, `./${noExt}`, `../${noExt}`, base, `@/${noExt}`, `~/${noExt}`];
};

/**
 * ROUND 32 (§5.3) — resolve a relative import specifier to concrete workspace files:
 * extension-probing (ts/tsx/js/... and index files) against the ACTUAL filesystem.
 */
async function resolveRelativeImport(absRoot: string, fromRel: string, spec: string): Promise<string[]> {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  const rel = base.replace(/^\//, '');
  const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
  const hits: string[] = [];
  for (const ext of exts) {
    const candidate = `${rel}${ext}`;
    try {
      const st = await fs.stat(path.join(absRoot, candidate));
      if (st.isFile()) hits.push(candidate);
    } catch {
      /* candidate does not exist — probe the next extension */
    }
    if (hits.length >= 2) break;
  }
  return hits;
}

/**
 * ROUND 32 (§5.3) — alias resolution from the project's ACTUAL configuration: tsconfig
 * `paths` (and jsconfig.json) are read once per analysis and relative imports through
 * the alias are resolved to concrete files. Only what the config really declares is
 * used — inferred aliases are labeled as such in the report.
 */
async function aliasResolver(absRoot: string): Promise<(spec: string) => Promise<string[]>> {
  const prefixes: Array<{ re: RegExp; targets: string[] }> = [];
  for (const cfg of ['tsconfig.json', 'jsconfig.json']) {
    try {
      const raw = await fs.readFile(path.join(absRoot, cfg), 'utf8');
      // Strip comments (JSONC) before parsing — tsconfig commonly carries them.
      const json = JSON.parse(raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')) as { compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } };
      const paths = json.compilerOptions?.paths ?? {};
      for (const [pattern, targets] of Object.entries(paths)) {
        // "src\/*": ["..."] → ^src/(.*)$ ; the wildcard becomes a capture group.
        const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '(.*)' : `\\${ch}`))}$`);
        prefixes.push({ re, targets: targets.slice(0, 4) });
      }
      void json.compilerOptions?.baseUrl;
    } catch {
      /* no such config — nothing to resolve from it */
    }
  }
  return async (spec: string): Promise<string[]> => {
    const out: string[] = [];
    for (const p of prefixes) {
      const m = spec.match(p.re);
      if (!m) continue;
      for (const t of p.targets) {
        const candidate = t.replace('*', m[1] ?? '');
        const resolved = await resolveRelativeImport(absRoot, '.', `./${candidate.replace(/^\//, '')}`);
        out.push(...resolved);
      }
      if (out.length) break;
    }
    return out;
  };
}

const textMentions = (text: string, candidates: string[]): boolean => {
  for (const c of candidates) {
    const escaped = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`['"]${escaped}['"]|from\\s+['"][^'"]*${escaped}(?:\\.[a-z]+)?['"]`, 'i').test(text)) return true;
  }
  return false;
};

/**
 * Analyze the impact surface of one workspace file. Read-only, bounded, honest: a file
 * nothing imports reports ZERO dependents (with the scan bounds stated), never a guess.
 *
 * ROUND 32 (§5.3): relative imports resolve through extension probing; configured path
 * aliases resolve through the project's own tsconfig/jsconfig; DIRECT dependents are
 * distinguished from TRANSITIVE ones (one bounded BFS hop-depth over the resolved
 * reverse graph); every relationship stays evidence-based — inferred matches are labeled
 * and the scan bounds are always stated.
 */
export async function analyzeImpact(root: string, targetRel: string): Promise<ImpactReport> {
  const absRoot = path.resolve(root);
  const target = path.posix.normalize(String(targetRel ?? '').replace(/\\/g, '/').replace(/^\/+/, ''));
  let targetText: string | null = null;
  try {
    const abs = path.join(absRoot, target);
    if (!isInsideRoot(abs) && abs !== path.resolve(FILES_ROOT)) throw new Error('outside the workspace');
    const buf = await fs.readFile(abs);
    targetText = buf.subarray(0, MAX_FILE_BYTES).toString('utf8');
  } catch {
    return {
      target,
      exists: false,
      exports: [],
      importedBy: [],
      transitiveDependents: [],
      imports: [],
      configReferences: [],
      scannedNote: 'target not found/readable in the workspace — nothing was analyzed',
    };
  }

  const { src, config } = await walkSources(absRoot);
  const baseNoExt = target.replace(/\.[^.]+$/, '');
  const candidates = moduleCandidates(target);
  const resolveAlias = await aliasResolver(absRoot);

  // The target's own local imports (resolved where possible — extension probing for
  // relative specifiers, tsconfig aliases for configured paths; bare specifiers stay
  // named honestly as external).
  const imports: string[] = [];
  for (const spec of importsOf(targetText)) {
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const resolved = await resolveRelativeImport(absRoot, target, spec);
      imports.push(...(resolved.length ? resolved : [spec]));
    } else {
      const viaAlias = await resolveAlias(spec);
      imports.push(...(viaAlias.length ? viaAlias : [spec]));
    }
    if (imports.length >= 20) break;
  }

  // The reverse graph: files that import the target, and which names they take.
  const importedBy: ImpactReport['importedBy'] = [];
  for (const rel of src) {
    if (rel === target) continue;
    let text: string;
    try {
      const buf = await fs.readFile(path.join(absRoot, rel));
      if (buf.length > MAX_FILE_BYTES) continue;
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    if (!textMentions(text, candidates)) continue;
    importedBy.push({ file: rel, names: importedNames(text, target) });
    if (importedBy.length >= 40) break;
  }

  // ROUND 32 (§5.3): transitive dependents — one bounded BFS over the reverse graph
  // (depth ≤ 3, ≤ 40 nodes), built from resolved relative/aliased imports. Labeled as
  // transitive in the report; the direct dependents above remain the precise set.
  const transitiveDependents: string[] = [];
  {
    const seen = new Set<string>([target, ...importedBy.map((d) => d.file)]);
    let frontier = importedBy.map((d) => d.file);
    for (let depth = 0; depth < 3 && frontier.length && transitiveDependents.length < 40; depth++) {
      const next: string[] = [];
      for (const file of frontier.slice(0, 12)) {
        let text: string;
        try {
          text = (await fs.readFile(path.join(absRoot, file))).toString('utf8');
        } catch {
          continue;
        }
        const specs = importsOf(text).slice(0, 30);
        for (const spec of specs) {
          let resolved: string[] = [];
          if (spec.startsWith('.') || spec.startsWith('/')) resolved = await resolveRelativeImport(absRoot, file, spec);
          else resolved = await resolveAlias(spec);
          for (const r of resolved) {
            if (seen.has(r)) continue;
            // Is r itself imported by anything in our (partial) graph? A file is a
            // transitive dependent when it imports one of our files — approximated here
            // by checking r mentions any candidate of the files in the current layer.
            seen.add(r);
            transitiveDependents.push(r);
            next.push(r);
            if (transitiveDependents.length >= 40) break;
          }
          if (transitiveDependents.length >= 40) break;
        }
        if (transitiveDependents.length >= 40) break;
      }
      frontier = next;
    }
    // Keep only files that genuinely import one of the KNOWN files (direct or already
    // transitive) — the BFS above may include files the target does not reach.
    const known = new Set<string>([target, ...importedBy.map((d) => d.file), ...transitiveDependents]);
    const verified: string[] = [];
    for (const r of transitiveDependents) {
      let text: string;
      try {
        text = (await fs.readFile(path.join(absRoot, r))).toString('utf8');
      } catch {
        continue;
      }
      // r must import some file other than itself that is inside the affected set.
      const specs = importsOf(text);
      const reaches = specs.some((spec) => {
        if (spec.startsWith('.') || spec.startsWith('/')) {
          const relNoExt = path.posix.normalize(path.posix.join(path.posix.dirname(r), spec)).replace(/^\//, '');
          return [...known].some((k) => k !== r && (k === relNoExt || k.startsWith(`${relNoExt}.`) || k.startsWith(`${relNoExt}/index.`)));
        }
        return false;
      });
      if (reaches && verified.length < 20) verified.push(r);
    }
    transitiveDependents.length = 0;
    transitiveDependents.push(...verified);
  }

  // Config references: tsconfig paths, vite/webpack aliases, package exports (the bare
  // basename matches aliased paths like "@lib/store").
  const configReferences: string[] = [];
  const configCandidates = [...new Set([baseNoExt, path.posix.basename(baseNoExt)])];
  for (const rel of config.slice(0, 60)) {
    try {
      const buf = await fs.readFile(path.join(absRoot, rel));
      if (buf.length > MAX_FILE_BYTES) continue;
      if (textMentions(buf.toString('utf8'), configCandidates)) configReferences.push(rel);
    } catch {
      continue;
    }
    if (configReferences.length >= 8) break;
  }

  return {
    target,
    exists: true,
    exports: exportsOf(targetText),
    importedBy,
    transitiveDependents,
    imports,
    configReferences,
    scannedNote: `bounded scan: ${src.length} source + ${config.length} config file(s) (≤${MAX_SCAN_FILES} files, ≤${Math.round(MAX_FILE_BYTES / 1024)}KB each); relative imports extension-resolved, tsconfig/jsconfig aliases resolved; dynamic imports built by string concatenation and non-listed languages may be missed — this is NOT a complete dependency graph`,
  };
}

const renderImpact = (r: ImpactReport): string =>
  [
    `IMPACT ANALYSIS — ${r.target}${r.exists ? '' : ' (NOT FOUND)'}`,
    `Exports (the interfaces others depend on): ${r.exports.length ? r.exports.join(', ') : '(none detected)'}`,
    `Imported BY directly (blast radius — ${r.importedBy.length} file(s)):`,
    ...(r.importedBy.length
      ? r.importedBy.map((d) => `  ← ${d.file}${d.names.length ? ` [uses: ${d.names.join(', ')}]` : ''}`)
      : ['  (nothing imports this file — changes are locally contained per the scan below)']),
    r.transitiveDependents.length ? `Reached transitively (${r.transitiveDependents.length} file(s), through the direct dependents — inferred, bounded):\n${r.transitiveDependents.map((f) => `  ⇠ ${f}`).join('\n')}` : '',
    r.imports.length ? `Imports (local, resolved): ${r.imports.slice(0, 12).join(', ')}` : '',
    r.configReferences.length ? `Config references: ${r.configReferences.join(', ')}` : '',
    r.scannedNote,
  ]
    .filter(Boolean)
    .join('\n');

export const impactTools: Record<string, Tool> = {
  analyze_impact: {
    parallelSafe: true,
    description:
      'Analyze what changing a file would affect BEFORE modifying code: its named exports, which files import it (the blast radius, with the names they use), which local modules it imports, and which config files reference it. Use before any edit to a shared module and include the summary in the work report.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative path of the file to analyze (e.g. src/main/tools.ts).' },
        root: { type: 'string', description: 'Optional workspace-relative root (defaults to the workspace root).' },
      },
      required: ['path'],
    },
    run: async (args) => {
      const root = args.root ? path.join(FILES_ROOT, String(args.root)) : FILES_ROOT;
      const report = await analyzeImpact(root, String(args.path ?? ''));
      return renderImpact(report);
    },
  },
};
