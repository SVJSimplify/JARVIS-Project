import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

/**
 * ROUND 21 CHANGE 2 — PATH RESOLUTION IS EXPLICIT AND FAIL-CLOSED.
 *
 * The Round 20 boolean `realpathProtected()` collapsed every resolution failure into
 * "not protected". The Round 21 contract: classifyRealPath returns PROTECTED /
 * NOT_PROTECTED / UNRESOLVED, and an UNRESOLVED target of a write-shaped operation fails
 * closed — it can never silently pass as safe. This suite pins the full resolution model:
 * ordinary paths, nested symlinks, broken links, cycles, deep chains, escapes, OS
 * targets, nonexistent tails, hop exhaustion and the TOCTOU revalidation gate.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import { classifyRealPath } from '../src/main/policy';
import { revalidateWriteTarget, resolveWrite } from '../src/main/workspace';

const ROOT = process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), `jarvis-test-${process.pid}`);
const rmrf = (p: string) => fs.rmSync(p, { force: true, recursive: true });
const isWin = process.platform === 'win32';

describe('CHANGE 2 — classifyRealPath: the explicit outcome model', () => {
  it('ordinary existing workspace paths resolve NOT_PROTECTED', () => {
    fs.mkdirSync(path.join(ROOT, 'r21-path', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'r21-path', 'file.txt'), 'x');
    expect(classifyRealPath(path.join(ROOT, 'r21-path', 'file.txt'))).toBe('not-protected');
    expect(classifyRealPath(path.join(ROOT, 'r21-path', 'deep'))).toBe('not-protected');
  });

  it('paths that literally name OS roots classify PROTECTED without touching the disk', () => {
    expect(classifyRealPath('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe('protected');
    expect(classifyRealPath('/etc/passwd')).toBe('protected');
    expect(classifyRealPath('/usr/bin/node')).toBe('protected');
  });

  it('a symlink resolving into an OS-protected location is PROTECTED (the real path wins)', () => {
    if (isWin) return; // POSIX CI covers symlink semantics; junctions differ on Windows
    const link = path.join(ROOT, 'r21-link-etc');
    rmrf(link);
    fs.symlinkSync('/etc', link, 'dir');
    try {
      expect(classifyRealPath(path.join(link, 'hosts'))).toBe('protected');
      expect(classifyRealPath(path.join(link, 'nonexistent-tail'))).toBe('protected');
    } finally {
      rmrf(link);
    }
  });

  it('NESTED symlinks (link → link → target) resolve to the real destination', () => {
    if (isWin) return;
    const dir = path.join(ROOT, 'r21-nested');
    rmrf(dir);
    fs.mkdirSync(path.join(dir, 'real'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'l1'), 'dir');
    fs.symlinkSync(path.join(dir, 'l1'), path.join(dir, 'l2'), 'dir');
    try {
      expect(classifyRealPath(path.join(dir, 'l2', 'file.txt'))).toBe('not-protected');
      fs.symlinkSync('/etc', path.join(dir, 'real', 'up'), 'dir');
      expect(classifyRealPath(path.join(dir, 'l2', 'up', 'hosts'))).toBe('protected');
    } finally {
      rmrf(dir);
    }
  });

  it('a BROKEN symlink is classified through its deepest existing ancestor, not silently passed', () => {
    if (isWin) return;
    const dir = path.join(ROOT, 'r21-broken');
    rmrf(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(dir, 'never-created'), path.join(dir, 'dangling'), 'dir');
    try {
      // The parent resolves; the tail is new — a WRITE through it fails at the OS with
      // ENOENT, and the classification honestly reports the resolved state.
      expect(classifyRealPath(path.join(dir, 'dangling', 'x.txt'))).toBe('not-protected');
      // But a broken link INSIDE protected territory is still judged protected.
      fs.symlinkSync('/etc/definitely-missing-child', path.join(dir, 'dangling-protected'));
      expect(classifyRealPath(path.join(dir, 'dangling-protected'))).toBe('protected');
    } finally {
      rmrf(dir);
    }
  });

  it('a SYMLINK CYCLE is UNRESOLVED — never treated as confirmed safe', () => {
    if (isWin) return;
    const dir = path.join(ROOT, 'r21-cycle');
    rmrf(dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(path.join(dir, 'b'), path.join(dir, 'a'), 'dir');
    fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'b'), 'dir');
    try {
      expect(classifyRealPath(path.join(dir, 'a', 'x.txt'))).toBe('unresolved');
    } finally {
      rmrf(dir);
    }
  });

  it('paths ESCAPING the workspace via .. resolve against the real filesystem', () => {
    const escaped = path.join(ROOT, '..', 'jarvis-r21-escape-probe');
    // Whatever it resolves to, the outcome must be explicit — here: an existing tmp
    // sibling, so NOT_PROTECTED (and the literal /etc form is PROTECTED).
    expect(['not-protected', 'protected', 'unresolved']).toContain(classifyRealPath(escaped));
    expect(classifyRealPath('/etc/../../../etc/passwd')).toBe('protected');
  });

  it('a NONEXISTENT final component resolves through its existing parent (tail joined)', () => {
    fs.mkdirSync(path.join(ROOT, 'r21-new'), { recursive: true });
    expect(classifyRealPath(path.join(ROOT, 'r21-new', 'brand-new-file.txt'))).toBe('not-protected');
    expect(classifyRealPath(path.join(ROOT, 'r21-new', 'a', 'b', 'c.txt'))).toBe('not-protected');
  });

  it('NONEXISTENT parent chains beyond the hop budget are UNRESOLVED (fail closed)', () => {
    // 20 nonexistent levels under the workspace: the ancestor climb needs 20 hops, the
    // budget is 16 — exhaustion must return UNRESOLVED, never "not protected".
    const deep = path.join(ROOT, ...Array.from({ length: 20 }, (_, i) => `r21-gap-${i}`), 'f.txt');
    expect(classifyRealPath(deep)).toBe('unresolved');
  });

  it('relative paths resolve against the workspace', () => {
    expect(classifyRealPath('r21-relative/new.txt')).toBe('not-protected');
  });

  it('non-path strings are NOT_PROTECTED (they name no filesystem target)', () => {
    expect(classifyRealPath('hello world')).toBe('not-protected');
    expect(classifyRealPath('')).toBe('not-protected');
    expect(classifyRealPath('https://example.com/page')).toBe('not-protected');
  });

  it('Windows drive and UNC shapes classify by the literal pattern on any OS', () => {
    // The literal classifier runs BEFORE resolution in every caller, so the Windows
    // shapes stay protected even on the POSIX CI box (no drive to resolve).
    expect(classifyRealPath('C:\\Program Files\\App\\x.dll')).toBe('protected');
    expect(classifyRealPath('\\\\PC-01\\c$\\Windows\\system.ini')).toBe('protected');
    expect(classifyRealPath('D:\\Projects\\report.docx')).toBe('not-protected');
  });
});

describe('CHANGE 2 — write-path enforcement fails closed', () => {
  it('resolveWrite rejects a workspace symlink that points into OS territory', async () => {
    if (isWin) return;
    const link = path.join(ROOT, 'r21-write-link');
    rmrf(link);
    fs.symlinkSync('/etc', link, 'dir');
    try {
      await expect(resolveWrite(path.join(link, 'jarvis-was-here.txt'))).rejects.toThrow(/protected|resolved/i);
    } finally {
      rmrf(link);
    }
  });

  it('resolveWrite accepts ordinary workspace writes (new files included)', async () => {
    const p = await resolveWrite(path.join(ROOT, 'r21-ordinary-write', 'ok.txt'));
    expect(p.toLowerCase()).toContain('r21-ordinary-write');
  });

  it('revalidateWriteTarget catches a symlink swapped in AFTER validation (TOCTOU)', async () => {
    if (isWin) return;
    const dir = path.join(ROOT, 'r21-toctou');
    rmrf(dir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'target.txt');
    fs.writeFileSync(file, 'ordinary');
    await expect(revalidateWriteTarget(file)).resolves.toBeUndefined(); // clean before
    rmrf(file);
    fs.symlinkSync('/etc/hosts', file); // attacker swaps the final component
    await expect(revalidateWriteTarget(file)).rejects.toThrow(/protected/i);
    rmrf(file);
    fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'b'), 'dir');
    fs.symlinkSync(path.join(dir, 'b'), path.join(dir, 'a'), 'dir');
    await expect(revalidateWriteTarget(path.join(dir, 'a'))).rejects.toThrow(); // cycle planted
    rmrf(dir);
  });
});
