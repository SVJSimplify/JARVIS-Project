/**
 * Sequential sentence speech queue. Audio comes from Edge neural voices via the
 * main process (fetched ahead of time so sentences play back to back), with the
 * built-in speech engine as an offline / "system voice" fallback.
 */
import { speakable } from './speakable';

export interface SpeechJob {
  text: string;
  /** `durationMs` is known for neural audio; undefined for the system voice. */
  onStart: (durationMs?: number) => void;
  onBoundary: (charIndex: number) => void;
  onEnd: () => void;
}

interface QueuedJob extends SpeechJob {
  audio: Promise<Blob | null>;
}

const MS_PER_CHAR_FALLBACK = 62;
const SPEAKING_GRACE_MS = 400;
/** Sentences shorter than this never hit the truncation probe — the risk (and the cost) is too low. */
const TRUNCATION_CHECK_MIN_CHARS = 100;
/** ≈22 chars/s is faster than any neural voice can speak: audio shorter than this for a long line was truncated. */
const MIN_S_PER_CHAR = 0.045;

const queue: QueuedJob[] = [];
let playing = false;
let audible = false;
let lastAudibleAt = 0;
let generation = 0;
let currentAudio: HTMLAudioElement | undefined;

/** True while JARVIS is audibly talking (with a short grace between sentences). */
export const isSpeaking = (): boolean =>
  audible || queue.length > 0 || performance.now() - lastAudibleAt < SPEAKING_GRACE_MS;

async function fetchAudio(text: string): Promise<Blob | null> {
  try {
    const bytes = await window.electronAPI.tts.synthesize(text);
    // .slice() copies into a fresh, exactly-sized ArrayBuffer (TS 5.7 no longer accepts an
    // ArrayBufferLike view directly as a BlobPart).
    return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'audio/mpeg' });
  } catch {
    return null;
  }
}

function setAudible(value: boolean): void {
  audible = value;
  if (!value) lastAudibleAt = performance.now();
}

/** Metadata-only duration probe for a synthesized blob. NaN when it cannot be decoded at all. */
function audioDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const probe = new Audio();
    const done = (s: number): void => {
      clearTimeout(timer);
      probe.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(s);
    };
    const timer = setTimeout(() => done(Number.NaN), 2000);
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => done(Number.isFinite(probe.duration) ? probe.duration : Number.NaN);
    probe.onerror = () => done(Number.NaN);
    probe.src = url;
  });
}

const looksTruncated = (duration: number, text: string): boolean =>
  Number.isFinite(duration) && duration > 0 && duration < text.length * MIN_S_PER_CHAR;

function pickVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => /david|mark|guy|ryan|george/i.test(v.name)) ?? voices.find((v) => v.lang === 'en-US') ?? voices[0];
}

function playNeural(blob: Blob, job: QueuedJob, finish: () => void): void {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  let started = false;

  const end = () => {
    URL.revokeObjectURL(url);
    if (currentAudio === audio) currentAudio = undefined;
    finish();
  };
  audio.onplaying = () => {
    if (started) return;
    started = true;
    setAudible(true);
    job.onStart(Number.isFinite(audio.duration) ? audio.duration * 1000 : undefined);
  };
  audio.onended = end;
  audio.onerror = end;
  audio.play().catch(end);
}

function playSystem(job: QueuedJob, gen: number, finish: () => void): void {
  setAudible(true);
  job.onStart();
  if (!('speechSynthesis' in window)) {
    setTimeout(finish, job.text.length * MS_PER_CHAR_FALLBACK);
    return;
  }
  const utterance = new SpeechSynthesisUtterance(job.text);
  const voice = pickVoice();
  if (voice) utterance.voice = voice;
  utterance.rate = 0.95;
  // Chromium drops utterances that run long while the process is busy or the window is
  // backgrounded — the classic speechSynthesis cutoff. The pause/resume ping every 5 s is
  // the canonical keepalive, so a long sentence ends with its last word, not in silence.
  const kick = setInterval(() => {
    if (!speechSynthesis.speaking) return;
    speechSynthesis.pause();
    speechSynthesis.resume();
  }, 5000);
  const done = () => {
    clearInterval(kick);
    finish();
  };
  utterance.onboundary = (e) => {
    if (gen === generation) job.onBoundary(e.charIndex);
  };
  utterance.onend = done;
  utterance.onerror = done;
  speechSynthesis.speak(utterance);
}

async function next(): Promise<void> {
  const job = queue.shift();
  if (!job) {
    playing = false;
    return;
  }
  playing = true;
  const gen = generation;
  let blob = await job.audio;
  if (gen !== generation) return; // cancelled while waiting for audio

  // Cut-off guard: Edge-TTS resolves on whatever the socket delivered, so a connection
  // that died mid-sentence used to play as the first half of a long answer, then silence.
  // Audio that is impossibly short for its text (or undecodable) is re-fetched once, and
  // if that also fails the system voice reads the whole line — a half-spoken sentence
  // must never reach the user.
  if (blob && job.text.length >= TRUNCATION_CHECK_MIN_CHARS) {
    const dur = await audioDuration(blob);
    if (gen !== generation) return;
    if (Number.isNaN(dur) || looksTruncated(dur, job.text)) {
      const retry = await fetchAudio(job.text);
      if (gen !== generation) return;
      if (!retry) blob = null;
      else {
        const dur2 = await audioDuration(retry);
        if (gen !== generation) return;
        blob = Number.isNaN(dur2) || looksTruncated(dur2, job.text) ? null : retry;
      }
    }
  }

  const finish = () => {
    if (gen !== generation) return;
    setAudible(false);
    job.onEnd();
    void next();
  };
  if (blob) playNeural(blob, job, finish);
  else playSystem(job, gen, finish);
}

export function enqueue(job: SpeechJob): void {
  // The choke point: whatever a caller passes, the synthesized audio, the system-voice
  // fallback and the captions all use the same cleaned text. Markdown, raw URLs and emoji
  // must never reach a voice ("**" used to be read aloud as "asterisk asterisk").
  const text = speakable(job.text);
  if (!text) {
    job.onEnd(); // nothing speakable: honour the contract so callers never hang on a pending job
    return;
  }
  queue.push({ ...job, text, audio: fetchAudio(text) }); // start fetching immediately
  if (!playing) void next();
}

export function cancelSpeech(): void {
  generation++;
  queue.length = 0;
  playing = false;
  setAudible(false);
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.removeAttribute('src');
    currentAudio = undefined;
  }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
