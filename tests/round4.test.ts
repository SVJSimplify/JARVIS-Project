import { describe, expect, it } from 'vitest';
import { applyEdit } from '../src/main/fsTools';
import { speakable } from '../src/renderer/hooks/useSubtitles';
import { fsExplain } from '../src/main/workspace';

describe('speakable (markdown must never be spoken)', () => {
  it('strips bold markers the TTS used to read as "asterisk asterisk"', () => {
    expect(speakable('**Phase**: War of attrition')).toBe('Phase: War of attrition');
  });

  it('keeps content of links, collapses bare URLs to the domain', () => {
    expect(speakable('see [the report](https://example.com/a/b) now')).toBe('see the report now');
    expect(speakable('docs at https://www.wikipedia.org/Alan_Turing end')).toBe('docs at wikipedia.org end');
  });

  it('strips headings, bullets, table pipes and fences but keeps code and snake_case', () => {
    const out = speakable('## Military\n- **Drones** hit targets\n| a | b |\n```py\nrun_python()\n```');
    expect(out).not.toMatch(/[*#|`]/);
    expect(out).toContain('run_python()');
  });

  it('keeps single underscores (identifiers) and drops emoji', () => {
    expect(speakable('my_var is ready 🎉')).toBe('my_var is ready');
  });

  it('collapses all whitespace', () => {
    expect(speakable('a\n\n  b\tc')).toBe('a b c');
  });
});

describe('applyEdit CRLF tolerance (Windows files)', () => {
  it('edits a CRLF file when old_text uses LF, preserving CRLF', () => {
    const file = 'line one\r\nline two\r\nline three\r\n';
    const { text, count } = applyEdit(file, { old_text: 'line two\n', new_text: 'LINE TWO\n' });
    expect(count).toBe(1);
    expect(text).toBe('line one\r\nLINE TWO\r\nline three\r\n');
  });

  it('edits with old_text containing CRLF into an LF file', () => {
    const { text, count } = applyEdit('a\nb\nc\n', { old_text: 'a\r\nb\r\n', new_text: 'x\r\n' });
    expect(count).toBe(1);
    expect(text).toBe('x\nc\n'); // a and b were the matched block; LF file keeps LF
  });

  it('replace_all still works across CRLF', () => {
    const { text, count } = applyEdit('x\r\nx\r\n', { old_text: 'x\n', new_text: 'y\n', replace_all: true });
    expect(count).toBe(2);
    expect(text).toBe('y\r\ny\r\n');
  });

  it('still fails honestly when there is no match', () => {
    expect(() => applyEdit('abc\n', { old_text: 'zzz\n', new_text: 'q' })).toThrow(/not found/);
  });
});

describe('fsExplain (raw errno → recovery-grade message)', () => {
  it('explains EPERM as a Windows access problem', () => {
    const e = fsExplain(Object.assign(new Error('EPERM'), { code: 'EPERM' }), 'D:/report.docx');
    expect(e.message).toContain('D:/report.docx');
    expect(e.message).toContain('denied');
  });

  it('explains ENOENT as missing', () => {
    expect(fsExplain({ code: 'ENOENT' }, 'x').message).toContain('does not exist');
  });

  it('falls back to the raw message for unknown codes', () => {
    expect(fsExplain(new Error('weird'), 'x').message).toContain('weird');
  });
});
