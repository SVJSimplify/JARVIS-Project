import { app, safeStorage } from 'electron';
import { promises as fs } from 'fs';
import * as path from 'path';
import { atomicWrite, loadJson } from './store';

/** Default used until the user saves their own OpenAI-compatible endpoint (or sets JINI_BASE_URL). */
export const BASE_URL = 'http://localhost:20128/v1';
export const DEFAULT_VOICE = 'en-GB-RyanNeural';

interface Stored {
  /** OpenAI-compatible API base, e.g. https://api.openai.com/v1 or http://localhost:11434/v1. */
  baseUrl?: string;
  apiKey?: string;
  apiKeyEncrypted?: boolean;
  groqKey?: string;
  groqKeyEncrypted?: boolean;
  tinyfishKey?: string;
  tinyfishKeyEncrypted?: boolean;
  model?: string;
  /** Tried in order when the main model is PERMANENTLY rejected (retired / closed to new users). */
  fallbackModels?: string[];
  voice?: string;
  awareness?: boolean;
  /** LEGACY field, kept only so old settings.json files still parse. The three-level
   *  autonomy selector is gone — JARVIS always runs fully autonomous; deletes, purchases,
   *  credentials, installs and config changes stay hard-denied by the permission service. */
  autonomy?: 'careful' | 'standard' | 'autonomous';
}

export interface PublicSettings {
  baseUrl: string;
  apiKeySet: boolean;
  groqKeySet: boolean;
  tinyfishKeySet: boolean;
  model: string;
  fallbackModels: string[];
  voice: string;
  awareness: boolean;
  autonomy: 'careful' | 'standard' | 'autonomous';
}

const file = () => path.join(app.getPath('userData'), 'settings.json');

async function read(): Promise<Stored> {
  return loadJson<Stored>(file(), {});
}

/** Decrypt failures must be diagnosable: the key IS set, yet every call would fail with "cannot reach provider". */
const decrypt = (v: string): string => {
  try {
    return safeStorage.decryptString(Buffer.from(v, 'base64'));
  } catch (e) {
    console.warn('[settings] a stored key could not be decrypted (keyring backend changed?):', e instanceof Error ? e.message : e);
    return '';
  }
};

export async function getApiKey(): Promise<string> {
  const s = await read();
  if (!s.apiKey) return '';
  if (!s.apiKeyEncrypted) return s.apiKey;
  return decrypt(s.apiKey);
}

/** Optional Groq key: when set, speech-to-text runs on Groq's hosted Whisper with local fallback. */
export async function getGroqKey(): Promise<string> {
  const s = await read();
  if (!s.groqKey) return '';
  if (!s.groqKeyEncrypted) return s.groqKey;
  return decrypt(s.groqKey);
}

/** Optional TinyFish key: enables tinyfish_search and tinyfish_fetch. Falls back to the TINYFISH_API_KEY environment variable. */
export async function getTinyfishKey(): Promise<string> {
  const s = await read();
  if (!s.tinyfishKey) return process.env.TINYFISH_API_KEY?.trim() ?? '';
  if (!s.tinyfishKeyEncrypted) return s.tinyfishKey;
  return decrypt(s.tinyfishKey);
}

/** Normalise a user-entered base URL: http(s) only, no trailing slash. Returns '' when invalid. */
export function normalizeBaseUrl(raw: string): string {
  const v = raw.trim().replace(/\/+$/, '');
  if (!v) return '';
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return v;
  } catch {
    return '';
  }
}

/** The active provider endpoint: saved setting, then JINI_BASE_URL, then the built-in default. */
export async function getBaseUrl(): Promise<string> {
  const stored = normalizeBaseUrl((await read()).baseUrl ?? '');
  return stored || normalizeBaseUrl(process.env.JINI_BASE_URL ?? '') || BASE_URL;
}

export async function getModel(): Promise<string> {
  return (await read()).model ?? '';
}

/** Comma-separated fallback models from the environment, e.g. JARVIS_FALLBACK_MODELS="a,b". */
const envFallbacks = (): string[] =>
  (process.env.JARVIS_FALLBACK_MODELS ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

/**
 * The fallback chain for the main model: stored setting first, the environment as the
 * default when nothing is saved. May be empty — then a dead model fails honestly fast.
 */
export async function getFallbackModels(): Promise<string[]> {
  const stored = (await read()).fallbackModels;
  return stored && stored.length ? stored.filter(Boolean) : envFallbacks();
}

export async function getVoice(): Promise<string> {
  return (await read()).voice || DEFAULT_VOICE;
}

/** Persistent screen awareness; on unless the user turned it off. */
export async function getAwarenessEnabled(): Promise<boolean> {
  return (await read()).awareness !== false;
}

/**
 * The autonomy level governing the permission service. SINGLE MODE: always 'autonomous',
 * whatever an old settings.json says. Kept async and keyed by nothing so the permission
 * service wiring does not change.
 */
export async function getAutonomy(): Promise<'autonomous'> {
  await read().catch(() => undefined); // keep the same I/O profile; the value is irrelevant
  return 'autonomous';
}

export async function getPublicSettings(): Promise<PublicSettings> {
  const s = await read();
  return { baseUrl: await getBaseUrl(), apiKeySet: Boolean(s.apiKey), groqKeySet: Boolean(s.groqKey), tinyfishKeySet: Boolean(s.tinyfishKey), model: s.model ?? '', fallbackModels: s.fallbackModels ?? [], voice: s.voice || DEFAULT_VOICE, awareness: s.awareness !== false, autonomy: 'autonomous' as const };
}

// Read-modify-write must be serialised: two overlapping saves (Save button vs the awareness
// checkbox, or an immediate voice save) used to both read the same base object and the last
// writer silently dropped the other's field (a just-saved API key, for example).
let writeChain: Promise<unknown> = Promise.resolve();

/** Only fields present in `patch` change. An empty apiKey removes the stored key. */
export async function setSettings(patch: { baseUrl?: string; apiKey?: string; groqKey?: string; tinyfishKey?: string; model?: string; fallbackModels?: string[]; voice?: string; awareness?: boolean }): Promise<void> {
  const job = writeChain.then(async () => {
    const s = await read();

  if (patch.baseUrl !== undefined) {
    const raw = patch.baseUrl.trim();
    const url = normalizeBaseUrl(raw);
    if (raw && !url) throw new Error('The API base URL must be a valid http:// or https:// address.');
    if (url) s.baseUrl = url;
    else delete s.baseUrl;
  }
  if (patch.apiKey !== undefined) {
    const key = patch.apiKey.trim();
    if (!key) {
      delete s.apiKey;
      delete s.apiKeyEncrypted;
    } else if (safeStorage.isEncryptionAvailable()) {
      s.apiKey = safeStorage.encryptString(key).toString('base64');
      s.apiKeyEncrypted = true;
    } else {
      s.apiKey = key;
      s.apiKeyEncrypted = false;
    }
  }
  if (patch.groqKey !== undefined) {
    const key = patch.groqKey.trim();
    if (!key) {
      delete s.groqKey;
      delete s.groqKeyEncrypted;
    } else if (safeStorage.isEncryptionAvailable()) {
      s.groqKey = safeStorage.encryptString(key).toString('base64');
      s.groqKeyEncrypted = true;
    } else {
      s.groqKey = key;
      s.groqKeyEncrypted = false;
    }
  }
  if (patch.tinyfishKey !== undefined) {
    const key = patch.tinyfishKey.trim();
    if (!key) {
      delete s.tinyfishKey;
      delete s.tinyfishKeyEncrypted;
    } else if (safeStorage.isEncryptionAvailable()) {
      s.tinyfishKey = safeStorage.encryptString(key).toString('base64');
      s.tinyfishKeyEncrypted = true;
    } else {
      s.tinyfishKey = key;
      s.tinyfishKeyEncrypted = false;
    }
  }
  if (patch.model !== undefined) s.model = patch.model.trim();
  if (patch.fallbackModels !== undefined) s.fallbackModels = patch.fallbackModels.map((t) => t.trim()).filter(Boolean);
  if (patch.voice !== undefined) s.voice = patch.voice.trim();
  if (patch.awareness !== undefined) s.awareness = patch.awareness === true;

    await fs.mkdir(path.dirname(file()), { recursive: true });
    await atomicWrite(file(), JSON.stringify(s));
  });
  writeChain = job.catch(() => undefined);
  return job;
}
