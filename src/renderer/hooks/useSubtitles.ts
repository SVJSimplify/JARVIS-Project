import { useMemo, useState } from 'react';
import { cancelSpeech, enqueue } from '../lib/speech';
import { speakable, speechSummary } from '../lib/speakable';
import type { Caption } from '../components/Subtitles';

export { speakable };

const PAGE_CHARS = 84;
const MS_PER_CHAR = 62;
const HIDE_AFTER_MS = 2200;

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

/** Voice reads only a short, safe conclusion. Raw tool output, paths, code and lists stay visual. */
export function useSubtitles(): [Caption | null, SubtitleControls] {
  const [caption, setCaption] = useState<Caption | null>(null);

  const controls = useMemo<SubtitleControls>(() => {
    let pending = 0;
    let finished = false;
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
      pending = 0;
      finished = false;
    };

    const speakSummary = (raw: string) => {
      const text = speakable(raw).replace(/\s+/g, ' ').trim();
      if (!text) return;
      const pages = paginate(text);
      const starts = pages.map((_, i) => pages.slice(0, i).reduce((n, page) => n + page.length + 1, 0));
      pending++;
      enqueue({
        text,
        onStart: (durationMs) => {
          clearPageTimers();
          show(pages[0]);
          pages.forEach((page, i) => {
            if (i > 0) {
              pageTimers.push(setTimeout(
                () => show(page),
                durationMs ? (starts[i] / text.length) * durationMs : starts[i] * MS_PER_CHAR
              ));
            }
          });
        },
        onBoundary: (charIndex) => {
          clearPageTimers();
          let k = 0;
          while (k + 1 < starts.length && charIndex >= starts[k + 1]) k++;
          show(pages[k]);
        },
        onEnd: () => {
          clearPageTimers();
          pending = Math.max(0, pending - 1);
          if (finished && pending === 0) scheduleHide(HIDE_AFTER_MS);
        },
      });
    };

    return {
      begin: () => {
        reset();
        hide();
      },
      // Raw deltas and interim progress are deliberately never read aloud.
      push: () => undefined,
      progress: () => undefined,
      finish: (fullText) => {
        clearPageTimers();
        const summary = speechSummary(fullText);
        finished = true;
        if (summary) speakSummary(summary);
        if (pending === 0) scheduleHide(HIDE_AFTER_MS);
      },
      fail: (message) => {
        reset();
        show(speechSummary(message), 'error');
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
