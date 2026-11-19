import { useSyncExternalStore } from 'react';

export interface VoicePrefs {
  interrupt: boolean;
  greeting: boolean;
  voiceLock: boolean;
  lockStrictness: number;
}

export type ToggleKey = 'interrupt' | 'greeting' | 'voiceLock';

const KEY = 'jarvis.voice2';
const DEFAULTS: VoicePrefs = { interrupt: true, greeting: true, voiceLock: false, lockStrictness: 2.0 };

function load(): VoicePrefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return DEFAULTS;
  }
}

let prefs = load();
const subs = new Set<() => void>();

export function setVoicePrefs(patch: Partial<VoicePrefs>): void {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Non-persistent session: keep in memory.
  }
  subs.forEach((f) => f());
}

export const useVoicePrefs = (): VoicePrefs =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => void subs.delete(f)),
    () => prefs
  );
