import { describe, expect, it } from 'vitest';
import { applyEdit } from '../src/main/fsTools';
import { fsExplain } from '../src/main/workspace';
import { speakable as mainSpeakable } from '../src/main/tts';
import { speakable as rendererSpeakable } from '../src/renderer/hooks/useSubtitles';

describe('applyEdit whitespace-tolerant fallback (file tools bulletproofing)', () => {
  it('still edits when the file has trailing whitespace the model did not copy', () => {
    const file = 'function a() {\n  return 1;   \n}\n';
    const { text, count } = applyEdit(file, { old_text: '  return 1;\n}', new_text: '  return 2;\n}' });
    expect(count).toBe(1);
    expect(text).toBe('function a() {\n  return 2;\n}\n');
  });

  it('still edits when indentation was shifted (trim tier)', () => {
    const file = 'if (x) {\n    doWork();\n}';
    const { text, count } = applyEdit(file, { old_text: '  doWork();', new_text: '  doWork(1);' });
    expect(count).toBe(1);
    expect(text).toBe('if (x) {\n    doWork(1);\n}');
  });

  it('preserves CRLF of the original file', () => {
    const file = 'a: 1\r\nb: 2\r\n';
    const { text } = applyEdit(file, { old_text: 'b: 2', new_text: 'b: 3' });
    expect(text).toBe('a: 1\r\nb: 3\r\n');
  });

  it('refuses an ambiguous whitespace-level match without replace_all', () => {
    // Exact match misses (trailing spaces live inside the file lines); the trim tier
    // finds two places and must refuse, not guess.
    const file = 'x\na  \nb  \nmid\na  \nb  \n';
    expect(() => applyEdit(file, { old_text: 'a\nb', new_text: 'y' })).toThrow(/matches 2 places/);
    const all = applyEdit(file, { old_text: 'a\nb', new_text: 'y', replace_all: true });
    expect(all.count).toBe(2);
    expect(all.text).toBe('x\ny\nmid\ny\n');
  });

  it('still reports a clean miss', () => {
    expect(() => applyEdit('nothing here', { old_text: 'absent line', new_text: 'x' })).toThrow(/not found/);
  });
});

describe('fsExplain (drive errors must be recovery-grade)', () => {
  it('EPERM points at list_drives and the real Windows causes', () => {
    const e = fsExplain(Object.assign(new Error('epm'), { code: 'EPERM' }), 'D:\\');
    expect(e.message).toContain('list_drives');
    expect(e.message).toContain('BitLocker');
  });
});

describe('main-process speakable (TTS markdown enforcement at the choke point)', () => {
  it('strips the bold markers the voice read as "asterisk asterisk"', () => {
    expect(mainSpeakable('**Phase**: War of attrition')).toBe('Phase: War of attrition');
    expect(mainSpeakable('**€240M** planned')).toBe('€240M planned');
  });

  it('keeps identifiers and drops markup, emoji and think-blocks', () => {
    expect(mainSpeakable('<think>secret reasoning</think>run_python() is ready 🎉')).toBe('run_python() is ready');
    expect(mainSpeakable('## Head\n- item')).toBe('Head item');
  });

  it('renderer and main strippers agree', () => {
    const sample = '# T\n**b** [l](https://x.co) `c` | a | b |\n- u\nhttps://www.example.com/x';
    expect(rendererSpeakable(sample)).toBe(mainSpeakable(sample));
  });
});
