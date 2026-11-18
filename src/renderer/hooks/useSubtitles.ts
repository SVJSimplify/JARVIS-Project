import { useMemo, useState } from 'react';
import { cancelSpeech, enqueue, isSpeaking } from '../lib/speech';
import { speakable, speechSummary } from '../lib/speakable';
import type { Caption } from '../components/Subtitles';

// Re-exported so every consumer (and the tests) find the stripper where it has always lived.
export { speakable };

const PAGE_CHARS = 84;
const MS_PER_CHAR = 62;
const HIDE_AFTER_MS = 2200;
const MIN_PROGRESS_AGE_MS = 1500; // fast jobs get only the conclusion
const PROGRESS_GAP_MS = 9000; // at most one progress line per 9 s, and never queued behind other speech
const SENTENCE_END = /[.!?…]+["'”)\]]*\s+|\n+/;

/**
 * Markdown and URLs are for reading, not hearing: TTS used to speak "**" literally as
 * "asterisk asterisk" and read raw links character by character. Everything spoken goes
 * through this, so audio, the system-voice fallback and captions stay consistent.
 * Implementation lives in lib/speakable.ts — the single renderer choke point
 * (speech.enqueue strips there too, and the main process enforces it a third time).
 */

export interface SubtitleControls {
  begin: () => void;
  push: (delta: string) => void;
  progress: (text: string) => void;
  finish: (fullText: string) => void;
  fail: (message: string) => void;
  stop: () => void;
}

/** Greedy word wrap into subtitle-sized pages. */
export function paginate(text: string): string[] {
  const pages: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > PAGE_CHARS && line) {
      pages.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) pages.push(line);
  return pages;
}

/**
 * Turns a token stream into spoken sentences with synced captions:
 * each sentence is queued for TTS and shown when its speech starts.
 */
export function useSubtitles(): [Caption | null, SubtitleControls] {
  const [caption, setCaption] = useState<Caption | null>(null);

  const controls = useMemo<SubtitleControls>(() => {
    let buffer = '';
    let pending = 0;
    let spoken = 0;
    let finished = false;
    let progressPending = 0;
    let turnStart = 0;
    let lastProgress = 0;
    let shown = '';
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let pageTimers: ReturnType<typeof setTimeout>[] = [];

    const clearPageTimers = () => {
      pageTimers.forEach(clearTimeout);
      pageTimers = [];
    };
    const clearHide = () => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = undefined;
    };
    const hide = () => {
      shown = '';
      setCaption(null);
    };
    const scheduleHide = (ms: number) => {
      clearHide();
      hideTimer = setTimeout(hide, ms);
    };
    const show = (text: string, tone: Caption['tone'] = 'speech') => {
      clearHide();
      if (text === shown) return;
      shown = text;
      setCaption({ text, tone });
    };
    const reset = () => {
      cancelSpeech();
      clearPageTimers();
      clearHide();
      buffer = '';
      pending = 0;
      spoken = 0;
      progressPending = 0;
      finished = false;
    };

    const speakSentence = (rawIn: string, kind: 'final' | 'progress' = 'final') => {
      const raw = kind === 'progress' ? rawIn : speakable(rawIn); // progress lines come from JARVIS itself, already clean
      const text = raw.replace(/\s+/g, ' ').trim();
      if (!text) return;
      const pages = paginate(text);
      const starts = pages.map((_, i) => pages.slice(0, i).reduce((n, p) => n + p.length + 1, 0));
      pending++;
      if (kind === 'progress') progressPending++;
      else spoken++;
      enqueue({
        text,
        onStart: (durationMs) => {
          clearPageTimers();
          show(pages[0]);
          pages.forEach((page, i) => {
            if (i > 0) pageTimers.push(setTimeout(() => show(page), (durationMs ? (starts[i] / text.length) * durationMs : starts[i] * MS_PER_CHAR)));
          });
        },
        onBoundary: (charIndex) => {
          clearPageTimers(); // real word timing beats the estimate
          let k = 0;
          while (k + 1 < starts.length && charIndex >= starts[k + 1]) k++;
          show(pages[k]);
        },
        onEnd: () => {
          clearPageTimers();
          pending--;
          if (kind === 'progress') progressPending--;
          if (finished && pending === 0) scheduleHide(HIDE_AFTER_MS);
        },
      });
    };

    const drain = (flush: boolean) => {
      for (;;) {
        const m = SENTENCE_END.exec(buffer);
        if (m) {
          const end = m.index + m[0].length;
          speakSentence(buffer.slice(0, end));
          buffer = buffer.slice(end);
          continue;
        }
        if (buffer.length > 160) {
          const cut = buffer.lastIndexOf(' ', 140);
          if (cut > 40) {
            speakSentence(buffer.slice(0, cut));
            buffer = buffer.slice(cut + 1);
            continue;
          }
        }
        break;
      }
      if (flush && buffer.trim()) {
        speakSentence(buffer);
        buffer = '';
      }
    };

    /** The answer is arriving: a stale progress line is cut so it never plays after the work is done. */
    const dropProgress = () => {
      cancelSpeech();
      clearPageTimers();
      pending -= progressPending;
      progressPending = 0;
    };

    return {
      begin: () => {
        reset();
        hide();
        turnStart = Date.now();
        lastProgress = 0;
      },
      progress: (text) => {
        const t = Date.now();
        if (finished || t - turnStart < MIN_PROGRESS_AGE_MS || t - lastProgress < PROGRESS_GAP_MS || isSpeaking()) return;
        lastProgress = t;
        speakSentence(text, 'progress');
      },
      push: (delta) => {
        if (progressPending) dropProgress();
        buffer += delta;
        drain(false);
      },
      finish: (fullText) => {
        // Only speak a short natural-language conclusion after the complete answer is known.
        // Streaming output can contain file dumps, tool data or credential-shaped material.
        buffer = '';
        const summary = speechSummary(fullText);
        if (summary) speakSentence(summary);
        finished = true;
        if (pending === 0) scheduleHide(HIDE_AFTER_MS);
      },
      fail: (message) => {
        reset();
        show(message, 'error');
        scheduleHide(6000);
      },
      stop: () => {
        reset();
        hide();
      },
    };
  }, []);

  return [caption, controls];
}
