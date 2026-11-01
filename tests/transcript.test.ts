import { describe, expect, it } from 'vitest';
import { cleanTranscript, greeting, isStop, parseWake } from '../src/renderer/lib/transcript';
import { paginate } from '../src/renderer/hooks/useSubtitles';

describe('cleanTranscript', () => {
  it('strips Whisper noise tags and silence hallucinations', () => {
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('');
    expect(cleanTranscript('(music playing)')).toBe('');
    expect(cleanTranscript('thank you for watching')).toBe('');
    expect(cleanTranscript('♪ nice tune ♪')).toBe('');
  });

  it('keeps real speech', () => {
    expect(cleanTranscript('  Open   the browser  ')).toBe('Open the browser');
  });

  it('rejects sub-threshold filler', () => {
    expect(cleanTranscript('um')).toBe('');
    expect(cleanTranscript('the')).toBe('');
  });
});

describe('parseWake', () => {
  it('recognises the wake word at the start and strips it', () => {
    expect(parseWake('hey Jarvis open Spotify')).toEqual({ woke: true, command: 'open Spotify' });
  });

  it('recognises a trailing name (speech often ends with the name)', () => {
    expect(parseWake('what time is it Jarvis')).toEqual({ woke: true, command: 'what time is it' });
  });

  it('passes plain commands through as un-woken', () => {
    expect(parseWake('open Spotify')).toEqual({ woke: false, command: 'open Spotify' });
  });

  it('treats a bare wake word as an empty command', () => {
    expect(parseWake('Jarvis?')).toEqual({ woke: true, command: '' });
  });

  it('tolerates common mis-transcriptions of the name', () => {
    expect(parseWake('hey jarvis, play lofi').woke).toBe(true);
    expect(parseWake('open jar vis').woke).toBe(true);
    expect(parseWake('travis open the door').woke).toBe(true);
  });
});

describe('isStop', () => {
  it('matches the ways users silence JARVIS', () => {
    for (const t of ['stop', 'quiet', 'shut up', "that's enough", 'never mind', 'cancel']) expect(isStop(t)).toBe(true);
  });

  it('does not match ordinary requests', () => {
    expect(isStop('stopwatch app open karo')).toBe(false);
    expect(isStop('open Spotify')).toBe(false);
  });
});

describe('greeting', () => {
  it('is a short spoken line addressed to sir', () => {
    const g = greeting();
    expect(g).toMatch(/, sir\./);
    expect(g.split(' ').length).toBeLessThan(12);
  });
});

describe('paginate (subtitle paging)', () => {
  it('splits long text into subtitle-sized pages on word boundaries', () => {
    const pages = paginate('word '.repeat(40).trim());
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(90);
    expect(pages.join(' ')).toBe('word '.repeat(40).trim());
  });

  it('keeps short text on one page', () => {
    expect(paginate('short sentence')).toEqual(['short sentence']);
  });
});
