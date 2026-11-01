import { useSyncExternalStore } from 'react';

/**
 * Lightweight speaker check: MFCC mean/std per utterance, compared with the enrolled
 * profile by normalised distance. It deters other voices; it is not strong biometrics.
 */
export const ENROL_CLIPS = 5;

const KEY = 'jarvis.voiceprint';
const SR = 16000;
const N = 512;
const HOP = 256;
const MELS = 26;
const COEFS = 12;
const MIN_FRAMES = 10;

interface Print {
  mu: number[];
  sd: number[];
}

const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const unmel = (m: number) => 700 * (10 ** (m / 2595) - 1);

const BANK: number[][] = (() => {
  const pts = Array.from({ length: MELS + 2 }, (_, i) => unmel(mel(80) + ((mel(7600) - mel(80)) * i) / (MELS + 1)));
  const bins = pts.map((f) => Math.floor(((N + 1) * f) / SR));
  return Array.from({ length: MELS }, (_, k) => {
    const m = k + 1;
    const row = new Array<number>(N / 2 + 1).fill(0);
    for (let b = bins[m - 1]; b < bins[m]; b++) row[b] = (b - bins[m - 1]) / (bins[m] - bins[m - 1] || 1);
    for (let b = bins[m]; b < bins[m + 1]; b++) row[b] = (bins[m + 1] - b) / (bins[m + 1] - bins[m] || 1);
    return row;
  });
})();

const WINDOW = Float32Array.from({ length: N }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1)));
const DCT = Array.from({ length: COEFS }, (_, j) =>
  Array.from({ length: MELS }, (_, m) => Math.cos((Math.PI * (j + 1) * (m + 0.5)) / MELS))
);

function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

function features(a: Float32Array): number[] | null {
  const frames: Array<{ e: number; c: number[] }> = [];
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let s = 1; s + N <= a.length; s += HOP) {
    let e = 0;
    for (let i = 0; i < N; i++) {
      const x = a[s + i] - 0.97 * a[s + i - 1];
      re[i] = x * WINDOW[i];
      im[i] = 0;
      e += x * x;
    }
    fft(re, im);
    const logMel = BANK.map((row) => {
      let sum = 0;
      for (let k = 0; k <= N / 2; k++) if (row[k]) sum += row[k] * (re[k] * re[k] + im[k] * im[k]);
      return Math.log(Math.max(sum, 1e-10));
    });
    frames.push({ e, c: DCT.map((row) => row.reduce((acc, w, m) => acc + w * logMel[m], 0)) });
  }
  if (frames.length < MIN_FRAMES) return null;
  const thr = (0.3 * frames.reduce((s, f) => s + f.e, 0)) / frames.length;
  const voiced = frames.filter((f) => f.e > thr);
  if (voiced.length < MIN_FRAMES) return null;

  const mean = Array.from({ length: COEFS }, (_, j) => voiced.reduce((s, f) => s + f.c[j], 0) / voiced.length);
  const std = mean.map((m, j) => Math.sqrt(voiced.reduce((s, f) => s + (f.c[j] - m) ** 2, 0) / voiced.length));
  return [...mean, ...std];
}

function load(): Print | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? 'null') as Print | null;
  } catch {
    return null;
  }
}

let print = load();
let clips: number[][] | null = null;
let snap = { enrolled: print !== null, clips: null as number | null };
const subs = new Set<() => void>();

function emit(): void {
  snap = { enrolled: print !== null, clips: clips ? clips.length : null };
  subs.forEach((f) => f());
}

export const useVoiceprint = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => snap
  );

export const isEnrolling = (): boolean => clips !== null;
export const hasPrint = (): boolean => print !== null;

export function startEnrol(): void {
  clips = [];
  emit();
}

export function cancelEnrol(): void {
  clips = null;
  emit();
}

export function clearPrint(): void {
  print = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  emit();
}

/** Adds one enrolment sample. Returns 'short' if unusable, 'done' when the profile is saved. */
export function addClip(audio: Float32Array): 'ok' | 'short' | 'done' {
  const f = clips && features(audio);
  if (!clips || !f) return 'short';
  clips.push(f);
  if (clips.length < ENROL_CLIPS) {
    emit();
    return 'ok';
  }
  const n = clips.length;
  const mu = f.map((_, i) => clips!.reduce((s, c) => s + c[i], 0) / n);
  const sd = mu.map((m, i) => Math.max(Math.sqrt(clips!.reduce((s, c) => s + (c[i] - m) ** 2, 0) / n), 0.15 * Math.abs(m), 0.05));
  print = { mu, sd };
  clips = null;
  try {
    localStorage.setItem(KEY, JSON.stringify(print));
  } catch {
    // ignore
  }
  emit();
  return 'done';
}

/** True when the voice is close enough to the enrolled profile (lower strictness = looser). */
export function verify(audio: Float32Array, threshold: number): boolean {
  const f = features(audio);
  if (!print || !f) return false;
  const d = Math.sqrt(f.reduce((s, x, i) => s + ((x - print!.mu[i]) / print!.sd[i]) ** 2, 0) / f.length);
  return d <= threshold;
}
