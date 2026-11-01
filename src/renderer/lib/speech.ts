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
    return new Blob([bytes], { type: 'audio/mpeg' });
  } catch {
    return null;
  }
}

function setAudible(value: boolean): void {
  audible = value;
  if (!value) lastAudibleAt = performance.now();
}

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
  utterance.onboundary = (e) => {
    if (gen === generation) job.onBoundary(e.charIndex);
  };
  utterance.onend = finish;
  utterance.onerror = finish;
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
  const blob = await job.audio;
  if (gen !== generation) return; // cancelled while waiting for audio

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
