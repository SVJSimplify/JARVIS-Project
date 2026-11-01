import { app, safeStorage } from 'electron';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { atomicWrite, loadJson } from './store';

export const BASE_URL = 'http://localhost:20128/v1';
export const DEFAULT_VOICE = 'en-GB-RyanNeural';

interface Stored {
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
}

const file = () => path.join(app?.getPath ? app.getPath('userData') : (process.env.JARVIS_SETTINGS_DIR || path.join(os.tmpdir(), 'jarvis-settings')), 'settings.json');

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

export async function getPublicSettings(): Promise<PublicSettings> {
  const s = await read();
  return { baseUrl: BASE_URL, apiKeySet: Boolean(s.apiKey), groqKeySet: Boolean(s.groqKey), tinyfishKeySet: Boolean(s.tinyfishKey), model: s.model ?? '', fallbackModels: s.fallbackModels ?? [], voice: s.voice || DEFAULT_VOICE, awareness: s.awareness !== false };
}

// Read-modify-write must be serialised: two overlapping saves (Save button vs the awareness
// checkbox, or an immediate voice save) used to both read the same base object and the last
// writer silently dropped the other's field (a just-saved API key, for example).
let writeChain: Promise<unknown> = Promise.resolve();

/** Only fields present in `patch` change. An empty apiKey removes the stored key. */
export async function setSettings(patch: { apiKey?: string; groqKey?: string; tinyfishKey?: string; model?: string; fallbackModels?: string[]; voice?: string; awareness?: boolean }): Promise<void> {
  const job = writeChain.then(async () => {
    const s = await read();

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
