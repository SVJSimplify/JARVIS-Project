import { describe, expect, it } from 'vitest';
import { applyEdit, globToRegExp } from '../src/main/fsTools';
import { parsePatch } from '../src/main/patch';

describe('globToRegExp', () => {
  it('matches a bare name anywhere in the tree', () => {
    const re = globToRegExp('*.ts');
    expect(re.test('src/main/index.ts')).toBe(true);
    expect(re.test('index.ts')).toBe(true);
    expect(re.test('src/main/index.tsx')).toBe(false);
  });

  it('supports ** crossing directories and {a,b} alternation', () => {
    const re = globToRegExp('src/**/*.{js,jsx}');
    expect(re.test('src/a/b.js')).toBe(true);
    expect(re.test('src/a.jsx')).toBe(true);
    expect(re.test('lib/a.js')).toBe(false);
  });

  it('treats ? as a single character and escapes regex metacharacters', () => {
    expect(globToRegExp('file?.txt').test('file1.txt')).toBe(true);
    expect(globToRegExp('file?.txt').test('file12.txt')).toBe(false);
    expect(globToRegExp('a(b).ts').test('a(b).ts')).toBe(true);
  });
});

describe('applyEdit', () => {
  const text = 'alpha\nbeta\ngamma\nbeta';

  it('replaces a unique occurrence', () => {
    expect(applyEdit(text, { old_text: 'gamma', new_text: 'delta' })).toEqual({ text: 'alpha\nbeta\ndelta\nbeta', count: 1 });
  });

  it('replaces all occurrences with replace_all', () => {
    const out = applyEdit(text, { old_text: 'beta', new_text: 'B', replace_all: true });
    expect(out).toEqual({ text: 'alpha\nB\ngamma\nB', count: 2 });
  });

  it('rejects empty old_text', () => {
    expect(() => applyEdit(text, { old_text: '', new_text: 'x' })).toThrow(/old_text must not be empty/);
  });

  it('reports a missing match clearly', () => {
    expect(() => applyEdit(text, { old_text: 'missing', new_text: 'x' })).toThrow(/old_text was not found/);
  });

  it('refuses ambiguous matches unless replace_all', () => {
    expect(() => applyEdit(text, { old_text: 'beta', new_text: 'B' })).toThrow(/appears 2 times/);
  });

  it('does not treat $-patterns in new_text as replacement syntax', () => {
    const out = applyEdit('x', { old_text: 'x', new_text: '$&$1$$' });
    expect(out.text).toBe('$&$1$$');
  });
});

describe('parsePatch', () => {
  it('parses Add and Update operations with hunks', () => {
    const ops = parsePatch(
      [
        '*** Begin Patch',
        '*** Add File: new.txt',
        '+hello',
        '*** Update File: old.txt',
        '@@',
        ' context',
        '-gone',
        '+here',
        '*** End Patch',
      ].join('\n')
    );
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ kind: 'add', path: 'new.txt', lines: ['hello'] });
    const upd = ops[1] as Extract<(typeof ops)[number], { kind: 'update' }>;
    expect(upd.hunks).toEqual([{ old: ['context', 'gone'], next: ['context', 'here'] }]);
  });

  it('requires the Begin/End markers', () => {
    expect(() => parsePatch('*** Update File: a\n@@\n*** End Patch')).toThrow(/Begin Patch/);
    expect(() => parsePatch('*** Begin Patch\n*** Add File: a\n+x')).toThrow(/End Patch/);
  });

  it('parses Move to as a rename on update ops', () => {
    const ops = parsePatch(['*** Begin Patch', '*** Update File: a.txt', '*** Move to: b.txt', '@@', '-x', '+y', '*** End Patch'].join('\n'));
    expect(ops[0]).toMatchObject({ kind: 'update', path: 'a.txt', moveTo: 'b.txt' });
  });
});
