import { promises as fs } from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import type { Tool } from './toolTypes';
import { atomicWrite } from './store';
import { displayPath, fsExplain, resolveRead, resolveWrite } from './workspace';

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'release', '__pycache__', '.venv', '.next']);
const MAX_WALK_FILES = 20_000;
const MAX_GLOB_RESULTS = 200;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_FILE_BYTES = 1024 * 1024;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;

/**
 * Windows text files come in three encodings in the wild: UTF-8 (with or without BOM) and
 * UTF-16 LE (PowerShell's `Out-File` default). Reading UTF-16 as utf8 yields null-byte soup
 * that used to be misreported as "binary". Decode by BOM, then by heuristic.
 */
function decodeText(buf: Buffer): string {
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').slice(1); // UTF-16 LE BOM
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      // UTF-16 BE: swap byte pairs into LE order.
      const be = Buffer.from(buf);
      be.swap16();
      return be.toString('utf16le').slice(1);
    }
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8').slice(1); // UTF-8 BOM
  }
  // Heuristic UTF-16 without BOM: lots of NUL bytes at even offsets (ASCII-heavy text).
  const probe = buf.subarray(0, Math.min(4096, buf.length));
  let zeros = 0;
  for (let i = 0; i < probe.length; i += 2) if (probe[i + 1] === 0 && probe[i] !== 0) zeros++;
  if (zeros > probe.length / 4) return buf.toString('utf16le');
  return buf.toString('utf8');
}

/** Convert a glob (`**`, `*`, `?`, `{a,b}`) to a RegExp over posix-style relative paths. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.includes('/') ? glob : `**/${glob}`;
  let re = '';
  let depth = 0;
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      depth++;
      re += '(?:';
    } else if (c === '}' && depth) {
      depth--;
      re += ')';
    } else if (c === ',' && depth) re += '|';
    else re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

async function* walk(root: string, rel = ''): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) yield* walk(root, next);
    } else if (e.isFile()) yield next;
  }
}

async function findFiles(root: string, glob?: string): Promise<string[]> {
  const match = glob ? globToRegExp(glob) : null;
  const out: string[] = [];
  for await (const rel of walk(root)) {
    if (!match || match.test(rel)) out.push(rel);
    if (out.length >= MAX_WALK_FILES) break;
  }
  return out;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const MAX_LIST_FILES = 400;
const humanSize = (n: number): string => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
/** UTF-16-without-BOM heuristic used before the null-byte binary check rejects a file. */
const looksLikeUtf16 = (buf: Buffer): boolean => {
  const probe = buf.subarray(0, Math.min(4096, buf.length));
  let zeros = 0;
  for (let i = 0; i < probe.length; i += 2) if (probe[i + 1] === 0 && probe[i] !== 0) zeros++;
  return zeros > probe.length / 4;
};

/**
 * Grep matching runs in a throwaway worker thread: an LLM-supplied pathological pattern
 * (e.g. "(a+)+$") would otherwise freeze the whole main process mid-`re.test` with no way to
 * interrupt it. The worker is killed when the overall budget runs out.
 */
const GREP_TIMEOUT_MS = 15_000;
const GREP_CHUNK = 25;
const GREP_WORKER_SRC = `
const { parentPort, workerData } = require('worker_threads');
const re = new RegExp(workerData.pattern, workerData.flags);
parentPort.on('message', (files) => {
  const hits = [];
  for (const { rel, text } of files) {
    const lines = text.split('\\n');
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        hits.push([rel, i + 1, lines[i]]);
        if (hits.length >= workerData.maxMatches) { parentPort.postMessage(hits); return; }
      }
    }
  }
  parentPort.postMessage(hits);
});
`;

function matchChunk(w: Worker, files: Array<{ rel: string; text: string }>): Promise<Array<[string, number, string]>> {
  return new Promise((resolve, reject) => {
    const onMsg = (hits: Array<[string, number, string]>): void => {
      cleanup();
      resolve(hits);
    };
    const onErr = (e: Error): void => {
      cleanup();
      reject(e);
    };
    const cleanup = (): void => {
      w.off('message', onMsg);
      w.off('error', onErr);
    };
    w.once('message', onMsg);
    w.once('error', onErr);
    w.postMessage(files);
  });
}

export interface EditSpec {
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}

/**
 * Exact-match replace; throws unless old_text matches exactly once (or replace_all).
 * Matching is CRLF-tolerant (Windows files store \r\n while the model sends \n) and, as a
 * fallback, whitespace-tolerant: when the exact text is nowhere, whole LINES are matched
 * ignoring trailing whitespace and then indentation, so a file edited in an editor with
 * different trailing spaces or shifted blocks still edits. The EOL style is preserved.
 */
export function applyEdit(text: string, { old_text, new_text, replace_all }: EditSpec): { text: string; count: number } {
  if (!old_text) throw new Error('old_text must not be empty.');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const flat = text.replace(/\r\n/g, '\n');
  const find = old_text.replace(/\r\n/g, '\n');
  const swap = new_text.replace(/\r\n/g, '\n');
  const count = flat.split(find).length - 1;
  if (count === 1 || (count > 1 && replace_all)) {
    const flatOut = replace_all ? flat.split(find).join(swap) : flat.replace(find, () => swap);
    return { text: flatOut.replace(/\n/g, eol), count: replace_all ? count : 1 };
  }
  if (count > 1) {
    throw new Error(`old_text appears ${count} times. Include more surrounding text, or set replace_all.`);
  }

  // Tolerant fallback: match whole lines ignoring trailing whitespace, then full trimming.
  for (const norm of [(s: string) => s.replace(/\s+$/, ''), (s: string) => s.trim()] as const) {
    const lines = flat.split('\n');
    const want = find.split('\n');
    const hits: number[] = [];
    for (let i = 0; i + want.length <= lines.length; i++) {
      if (want.every((w, k) => norm(lines[i + k]) === norm(w))) hits.push(i);
    }
    if (!hits.length) continue;
    if (hits.length > 1 && !replace_all) {
      throw new Error(`old_text matches ${hits.length} places when whitespace is ignored (lines ${hits.map((h) => h + 1).join(', ')}). Include more surrounding text, or set replace_all.`);
    }
    const swapLines = swap.split('\n');
    const targets = replace_all ? hits.reverse() : [hits[0]];
    let out = lines;
    for (const at of targets) out = [...out.slice(0, at), ...swapLines, ...out.slice(at + want.length)];
    return { text: out.join(eol), count: targets.length };
  }
  throw new Error('old_text was not found. Read the file and copy the text exactly (line endings, trailing spaces and indentation are handled automatically).');
}

const dirParam = { type: 'string', description: 'Folder to search. Relative paths start at the Jarvis-Files workspace; absolute paths are allowed.' };

export const fsTools: Record<string, Tool> = {
  read: {
    description:
      'Read a file (numbered lines) or list a directory. Any path is readable; relative paths start at the Jarvis-Files workspace. Use offset/limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number', description: 'First line to read (1-based). Default 1.' },
        limit: { type: 'number', description: `Max lines. Default ${DEFAULT_READ_LINES}.` },
      },
      required: ['path'],
    },
    run: async (args) => {
      const target = resolveRead(args.path);
      const stat = await fs.stat(target).catch((e) => {
        throw fsExplain(e, displayPath(target) || target);
      });
      if (stat.isDirectory()) {
        const entries = await fs.readdir(target, { withFileTypes: true }).catch((e) => {
          throw fsExplain(e, displayPath(target) || target);
        });
        if (!entries.length) return '(empty folder)';
        const dirs = entries.filter((e) => e.isDirectory()).map((e) => `${e.name}/`);
        const files = entries.filter((e) => !e.isDirectory());
        const sized = await Promise.all(
          files.slice(0, MAX_LIST_FILES).map(async (e) => {
            const st = await fs.stat(path.join(target, e.name)).catch(() => null);
            return st ? `${e.name}  (${humanSize(st.size)})` : e.name;
          })
        );
        const head = [...dirs, ...sized].join('\n');
        const rest = files.length > MAX_LIST_FILES ? `\n…and ${files.length - MAX_LIST_FILES} more files` : '';
        return `${head}${rest}\n[${dirs.length} folder(s), ${files.length} file(s)]`;
      }
      if (stat.size > MAX_READ_BYTES) throw new Error('File is too large to read. Use grep to find the part you need.');
      const buf = await fs.readFile(target).catch((e) => {
        throw fsExplain(e, displayPath(target) || target);
      });
      if (buf.slice(0, 4096).includes('\0') && !looksLikeUtf16(buf)) {
        throw new Error('That is a binary file (images, PDFs, executables...) and cannot be read as text.');
      }
      const raw = decodeText(buf);
      if (!raw.trim()) return `(${displayPath(target)} is empty, 0 bytes)`;
      const lines = raw.split('\n');
      const start = Math.max(1, Math.floor(Number(args.offset) || 1));
      const limit = Math.max(1, Math.floor(Number(args.limit) || DEFAULT_READ_LINES));
      const body = lines
        .slice(start - 1, start - 1 + limit)
        .map((l, i) => `${start + i}\t${clip(l, MAX_LINE_CHARS)}`)
        .join('\n');
      const end = Math.min(lines.length, start - 1 + limit);
      const meta = `(${displayPath(target)}, ${humanSize(stat.size)}, modified ${stat.mtime.toISOString().slice(0, 16).replace('T', ' ')})`;
      const more = end < lines.length ? `\n[lines ${start}-${end} of ${lines.length}; use offset ${end + 1} to continue]` : '';
      return `${meta}\n${body}${more}`;
    },
  },
  glob: {
    description: 'Find files by glob pattern (e.g. **/*.ts, src/**/*.{js,jsx}). Newest first. Skips node_modules and .git.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: dirParam },
      required: ['pattern'],
    },
    run: async (args) => {
      const root = resolveRead(args.path ?? '.');
      const files = await findFiles(root, String(args.pattern ?? ''));
      const dated = await Promise.all(
        files.map(async (f) => ({ f, t: (await fs.stat(path.join(root, f)).catch(() => null))?.mtimeMs ?? 0 }))
      );
      dated.sort((a, b) => b.t - a.t);
      if (!dated.length) return 'No files matched.';
      const shown = dated.slice(0, MAX_GLOB_RESULTS).map((d) => d.f).join('\n');
      return dated.length > MAX_GLOB_RESULTS ? `${shown}\n…and ${dated.length - MAX_GLOB_RESULTS} more` : shown;
    },
  },
  grep: {
    description: 'Search file contents with a regular expression. Returns file:line: text. Skips node_modules, .git and binaries.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression.' },
        path: dirParam,
        include: { type: 'string', description: 'Only search files matching this glob, e.g. *.ts' },
        ignore_case: { type: 'boolean' },
      },
      required: ['pattern'],
    },
    run: async (args) => {
      const pattern = String(args.pattern ?? '');
      const flags = args.ignore_case ? 'i' : '';
      try {
        new RegExp(pattern, flags); // validate here for a fast, clear error before any file I/O
      } catch (e) {
        throw new Error(`Invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
      }
      const root = resolveRead(args.path ?? '.');
      const rels = await findFiles(root, args.include ? String(args.include) : undefined);
      const w = new Worker(GREP_WORKER_SRC, { eval: true, workerData: { pattern, flags, maxMatches: MAX_GREP_MATCHES } });
      const kill = (): void => void w.terminate().catch(() => undefined);
      const deadline = Date.now() + GREP_TIMEOUT_MS;
      const hits: string[] = [];
      try {
        for (let i = 0; i < rels.length && hits.length < MAX_GREP_MATCHES; i += GREP_CHUNK) {
          const chunk: Array<{ rel: string; text: string }> = [];
          for (const rel of rels.slice(i, i + GREP_CHUNK)) {
            const file = path.join(root, rel);
            const stat = await fs.stat(file).catch(() => null);
            if (!stat || stat.size > MAX_GREP_FILE_BYTES) continue;
            const text = await fs.readFile(file, 'utf8').catch(() => '');
            if (text.slice(0, 4096).includes('\0')) continue;
            chunk.push({ rel, text });
          }
          if (!chunk.length) continue;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error('too slow');
          const found = await Promise.race([
            matchChunk(w, chunk),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('too slow')), remaining)),
          ]);
          for (const [rel, lineNo, line] of found) hits.push(`${rel}:${lineNo}: ${clip(line.trim(), 200)}`);
        }
      } catch {
        return 'Search stopped: the pattern was too slow to run. Simplify it (nested quantifiers like (a+)+ are the usual cause).';
      } finally {
        kill();
      }
      if (!hits.length) return 'No matches.';
      return hits.length >= MAX_GREP_MATCHES ? `${hits.join('\n')}\n[stopped at ${MAX_GREP_MATCHES} matches]` : hits.join('\n');
    },
  },
  multi_edit: {
    description:
      'Apply several exact-text edits to ONE workspace file in order, all or nothing. Each edit sees the result of the previous one. Prefer this over repeated edit_file calls.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace.' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_text: { type: 'string' },
              new_text: { type: 'string' },
              replace_all: { type: 'boolean' },
            },
            required: ['old_text', 'new_text'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    run: async (args) => {
      const edits = args.edits as EditSpec[] | undefined;
      if (!Array.isArray(edits) || !edits.length) throw new Error('edits must be a non-empty array.');
      const file = await resolveWrite(args.path);
      let text = await fs.readFile(file, 'utf8');
      edits.forEach((e, i) => {
        try {
          text = applyEdit(text, e).text;
        } catch (err) {
          throw new Error(`Edit ${i + 1}: ${err instanceof Error ? err.message : String(err)} Nothing was changed.`);
        }
      });
      await atomicWrite(file, text);
      return `Applied ${edits.length} edit(s) to ${displayPath(file)}.`;
    },
  },
};
