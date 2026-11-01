import { promises as fs } from 'fs';
import * as path from 'path';
import type { Tool } from './toolTypes';
import { displayPath, resolveWrite } from './workspace';

interface Hunk {
  old: string[];
  next: string[];
}

type Op =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; hunks: Hunk[] };

const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

/** Parse the `*** Begin Patch` format (Add / Update / Delete File, `@@` hunks). */
export function parsePatch(patch: string): Op[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '*** Begin Patch') throw new Error('Patch must start with "*** Begin Patch".');
  const ops: Op[] = [];
  let i = 1;
  for (; i < lines.length && lines[i].trim() !== '*** End Patch'; ) {
    const header = FILE_HEADER.exec(lines[i]);
    if (!header) throw new Error(`Unexpected line ${i + 1}: ${lines[i].slice(0, 60)}`);
    const [, kind, file] = header;
    i++;
    if (kind === 'Delete') {
      ops.push({ kind: 'delete', path: file.trim() });
      continue;
    }
    const body: string[] = [];
    let moveTo: string | undefined;
    const collectBody = (): void => {
      while (i < lines.length && !lines[i].startsWith('*** ')) body.push(lines[i++]);
    };
    collectBody();
    // "*** Move to:" may sit before or after the hunks; hunks may follow it either way.
    for (;;) {
      const line = lines[i] ?? '';
      const mv = /^\*\*\* Move to: (.+)$/.exec(line);
      const eof = /^\*\*\* End of File\s*$/.test(line);
      if (!mv && !eof) break;
      if (mv) moveTo = mv[1].trim();
      i++;
      collectBody();
    }
    if (kind === 'Add') {
      // A body line without the "+" prefix would be silently dropped and the file written
      // incomplete while the tool reports success: that must be a loud format error instead.
      const bad = body.find((l) => l.trim() !== '' && !l.startsWith('+'));
      if (bad !== undefined) throw new Error(`Add File body lines must start with "+". Offending line: ${bad.slice(0, 60)}`);
      ops.push({ kind: 'add', path: file.trim(), lines: body.filter((l) => l.startsWith('+')).map((l) => l.slice(1)) });
    } else {
      ops.push({ kind: 'update', path: file.trim(), moveTo, hunks: parseHunks(body) });
    }
  }
  if (i >= lines.length) throw new Error('Patch must end with "*** End Patch".');
  if (!ops.length) throw new Error('Patch contains no operations.');
  return ops;
}

function parseHunks(body: string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk = { old: [], next: [] };
  const flush = () => {
    if (cur.old.length || cur.next.length) hunks.push(cur);
    cur = { old: [], next: [] };
  };
  for (const l of body) {
    if (l.startsWith('@@')) flush();
    else if (l.startsWith('+')) cur.next.push(l.slice(1));
    else if (l.startsWith('-')) cur.old.push(l.slice(1));
    else {
      const ctx = l.startsWith(' ') ? l.slice(1) : l;
      cur.old.push(ctx);
      cur.next.push(ctx);
    }
  }
  flush();
  return hunks;
}

function indexOfBlock(hay: string[], needle: string[], from: number): number {
  for (const norm of [(s: string) => s, (s: string) => s.trimEnd(), (s: string) => s.trim()]) {
    for (let i = from; i + needle.length <= hay.length; i++) {
      if (needle.every((n, k) => norm(hay[i + k]) === norm(n))) return i;
    }
  }
  return -1;
}

function applyHunks(text: string, hunks: Hunk[], file: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let lines = text.replace(/\r\n/g, '\n').split('\n');
  let cursor = 0;
  for (const h of hunks) {
    if (!h.old.length) {
      lines = [...(lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines), ...h.next, ''];
      continue;
    }
    const at = indexOfBlock(lines, h.old, cursor);
    if (at < 0) throw new Error(`Hunk did not match in ${file}:\n${h.old.slice(0, 3).join('\n')}`);
    lines.splice(at, h.old.length, ...h.next);
    cursor = at + h.next.length;
  }
  return lines.join(eol);
}

export const patchTools: Record<string, Tool> = {
  apply_patch: {
    description:
      'Edit several files at once with a patch (paths relative to Jarvis-Files or absolute; deleting and moving are disabled). Format: "*** Begin Patch", then per file "*** Add File: p" (lines prefixed +), "*** Update File: p" (optional "*** Move to: q", then "@@" hunks whose lines start with space=context, -=remove, +=add), or "*** Delete File: p", then "*** End Patch". All or nothing.',
    parameters: {
      type: 'object',
      properties: { patch: { type: 'string' } },
      required: ['patch'],
    },
    run: async (args) => {
      const writes = new Map<string, string | null>();
      const read = async (rel: string) => {
        const full = await resolveWrite(rel);
        return writes.has(full) ? writes.get(full) ?? null : fs.readFile(full, 'utf8').catch(() => null);
      };
      for (const op of parsePatch(String(args.patch ?? ''))) {
        if (op.kind === 'delete') throw new Error('Deleting files is disabled.');
        if (op.kind === 'update' && op.moveTo) throw new Error('Moving files through a patch is disabled. Use move_file.');
        const full = await resolveWrite(op.path);
        const existing = await read(op.path);
        if (op.kind === 'add') {
          if (existing !== null) throw new Error(`${op.path} already exists.`);
          writes.set(full, op.lines.join('\n') + '\n');
        } else if (existing === null) {
          throw new Error(`${op.path} does not exist.`);
        } else {
          const updated = applyHunks(existing, op.hunks, op.path);
          if (op.moveTo) {
            writes.set(full, null);
            writes.set(await resolveWrite(op.moveTo), updated);
          } else writes.set(full, updated);
        }
      }
      // All or nothing: snapshot originals first so a failure part-way through the writes
      // (disk full, locked file) is rolled back instead of leaving half a patch applied.
      const originals = new Map<string, string | null>();
      for (const [file] of writes) {
        originals.set(file, await fs.readFile(file, 'utf8').catch(() => null));
      }
      try {
        for (const [file, content] of writes) {
          if (content === null) await fs.rm(file, { force: true });
          else {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, content, 'utf8');
          }
        }
      } catch (err) {
        for (const [file, cur] of originals) {
          await (cur === null ? fs.rm(file, { force: true }) : fs.writeFile(file, cur, 'utf8')).catch(() => undefined);
        }
        throw err;
      }
      return `Patched: ${[...writes].map(([f, c]) => `${c === null ? 'deleted ' : ''}${displayPath(f)}`).join(', ')}`;
    },
  },
};
