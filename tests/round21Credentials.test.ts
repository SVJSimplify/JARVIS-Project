import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ROUND 21 CHANGE 3 — CREDENTIALS ARE ENCRYPTED AT REST WITH ELECTRON SAFE STORAGE.
 *
 * Pinned contract:
 *  - new keys are stored encrypted (setEmbeddingsConfig);
 *  - the legacy plaintext key in brain/embeddings.json migrates once, idempotently,
 *    with verify-before-remove (the only valid credential is never destroyed);
 *  - an interrupted migration converges on the next startup;
 *  - encryption/decryption failures and unavailable encryption are reported HONESTLY —
 *    never faked as "encrypted";
 *  - provider configuration (provider/baseUrl/model) survives every path;
 *  - the plaintext key never reaches logs, IPC-visible status or receipts.
 */

vi.mock('electron', async () => (await import('./helpers/electronStub')).electronStub());

import {
  getEmbeddingsConfig,
  getEmbeddingsKeyStatus,
  migrateEmbeddingsKeyStorage,
  resetEmbeddingsForTests,
  setEmbeddingsCipher,
  setEmbeddingsConfig,
  type KeyCipher,
} from '../src/main/embeddings';

const CONFIG_FILE = path.join(
  process.env.JARVIS_FILES_ROOT ?? path.join(os.tmpdir(), 'jarvis-test'),
  'brain',
  'embeddings.json'
);

const LEGACY_KEY = 'sk-legacy-plaintext-ROUND21-SECRET';
const readStored = (): any => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const writeStored = (v: unknown): void => {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(v, null, 1));
};

/** A deterministic reversible cipher with failure injection — stands in for safeStorage. */
const fakeCipher = (opts: { available?: boolean; failEncrypt?: boolean; failDecrypt?: boolean; wrongDecrypt?: boolean } = {}): KeyCipher & { encryptions: number } => ({
  encryptions: 0,
  isAvailable: () => opts.available ?? true,
  encrypt: (plain: string) => {
    if (opts.failEncrypt) throw new Error('encrypt unavailable');
    return Buffer.from(`enc:${plain}`).toString('base64');
  },
  decrypt: (b64: string) => {
    if (opts.failDecrypt) throw new Error('decrypt failed');
    const s = Buffer.from(b64, 'base64').toString('utf8');
    if (!s.startsWith('enc:')) throw new Error('not a valid ciphertext');
    if (opts.wrongDecrypt) return 'wrong-key';
    return s.slice(4);
  },
});

beforeEach(() => {
  resetEmbeddingsForTests();
  fs.rmSync(CONFIG_FILE, { force: true });
});
afterEach(() => {
  resetEmbeddingsForTests();
  fs.rmSync(CONFIG_FILE, { force: true });
});

describe('CHANGE 3 — new credential storage', () => {
  it('a newly set key is stored ENCRYPTED, never as plaintext', async () => {
    setEmbeddingsCipher(fakeCipher());
    await setEmbeddingsConfig({ provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'text-embedding-3-small', apiKey: LEGACY_KEY });
    const stored = readStored();
    expect(stored.apiKey).toBeUndefined();
    expect(stored.keyStorage).toBe('safeStorage');
    expect(String(stored.apiKeyEncrypted)).not.toContain(LEGACY_KEY);
    expect(getEmbeddingsKeyStatus()).resolves.toBe('encrypted');
    const cfg = await getEmbeddingsConfig();
    expect(cfg.apiKey).toBe(LEGACY_KEY); // resolved in memory for the provider
    expect(cfg.baseUrl).toBe('https://api.example.com/v1');
  });

  it('removing the key removes both representations', async () => {
    setEmbeddingsCipher(fakeCipher());
    await setEmbeddingsConfig({ apiKey: 'temp-key' });
    await setEmbeddingsConfig({ apiKey: '' });
    const stored = readStored();
    expect(stored.apiKey).toBeUndefined();
    expect(stored.apiKeyEncrypted).toBeUndefined();
    expect(await getEmbeddingsConfig().then((c) => c.apiKey)).toBeUndefined();
  });
});

describe('CHANGE 3 — legacy plaintext migration', () => {
  it('migrates the legacy plaintext key: encrypted only afterwards, config preserved', async () => {
    writeStored({ provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'm-1', apiKey: LEGACY_KEY });
    setEmbeddingsCipher(fakeCipher());
    const out = await migrateEmbeddingsKeyStorage();
    expect(out.status).toBe('migrated');
    const stored = readStored();
    expect(stored.apiKey).toBeUndefined(); // plaintext removed ONLY after verification
    expect(stored.apiKeyEncrypted).toBeTruthy();
    expect(stored.keyStorage).toBe('safeStorage');
    expect(stored.baseUrl).toBe('https://api.example.com/v1'); // unrelated fields preserved
    expect(stored.model).toBe('m-1');
    expect(await getEmbeddingsConfig().then((c) => c.apiKey)).toBe(LEGACY_KEY);
  });

  it('is IDEMPOTENT: a second run reports already-encrypted and changes nothing', async () => {
    writeStored({ provider: 'openai', apiKey: LEGACY_KEY });
    setEmbeddingsCipher(fakeCipher());
    await migrateEmbeddingsKeyStorage();
    const after1 = fs.readFileSync(CONFIG_FILE, 'utf8');
    const out2 = await migrateEmbeddingsKeyStorage();
    expect(out2.status).toBe('already-encrypted');
    expect(fs.readFileSync(CONFIG_FILE, 'utf8')).toBe(after1);
  });

  it('RESTART persistence: a fresh read of the migrated file decrypts the same key', async () => {
    writeStored({ provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', apiKey: LEGACY_KEY });
    setEmbeddingsCipher(fakeCipher());
    await migrateEmbeddingsKeyStorage();
    resetEmbeddingsForTests(); // simulates a process restart
    setEmbeddingsCipher(fakeCipher());
    const cfg = await getEmbeddingsConfig();
    expect(cfg.apiKey).toBe(LEGACY_KEY);
    expect(cfg.provider).toBe('local');
  });

  it('an INTERRUPTED migration (both representations on disk) converges on the next run', async () => {
    setEmbeddingsCipher(fakeCipher());
    // Simulate a crash between "persist encrypted" and "remove plaintext".
    const encrypted = Buffer.from(`enc:${LEGACY_KEY}`).toString('base64');
    writeStored({ provider: 'openai', apiKey: LEGACY_KEY, apiKeyEncrypted: encrypted, keyStorage: 'safeStorage' });
    const out = await migrateEmbeddingsKeyStorage();
    expect(out.status).toBe('migrated');
    const stored = readStored();
    expect(stored.apiKey).toBeUndefined();
    expect(stored.apiKeyEncrypted).toBe(encrypted);
  });
});

describe('CHANGE 3 — failure paths are honest and non-destructive', () => {
  it('failed ENCRYPTION leaves the plaintext credential intact and reports failure', async () => {
    writeStored({ provider: 'openai', apiKey: LEGACY_KEY });
    setEmbeddingsCipher(fakeCipher({ failEncrypt: true }));
    const out = await migrateEmbeddingsKeyStorage();
    expect(out.status).toBe('failed');
    const stored = readStored();
    expect(stored.apiKey).toBe(LEGACY_KEY); // the only valid credential survived
    expect(await getEmbeddingsConfig().then((c) => c.apiKey)).toBe(LEGACY_KEY);
  });

  it('failed VERIFICATION decrypt restores the original file (never destroys the credential)', async () => {
    writeStored({ provider: 'openai', apiKey: LEGACY_KEY });
    setEmbeddingsCipher(fakeCipher({ wrongDecrypt: true }));
    const out = await migrateEmbeddingsKeyStorage();
    expect(out.status).toBe('failed');
    const stored = readStored();
    expect(stored.apiKey).toBe(LEGACY_KEY);
    expect(stored.apiKeyEncrypted).toBeUndefined();
  });

  it('an INVALID encrypted credential is reported honestly, never faked as encrypted', async () => {
    writeStored({ provider: 'openai', apiKeyEncrypted: 'not-a-real-ciphertext', keyStorage: 'safeStorage' });
    setEmbeddingsCipher(fakeCipher());
    expect(await getEmbeddingsKeyStatus()).toBe('invalid');
    expect(await getEmbeddingsConfig().then((c) => c.apiKey)).toBeUndefined();
  });

  it('safeStorage UNAVAILABLE: the limitation is stated, nothing is faked, the key still works', async () => {
    writeStored({ provider: 'openai', apiKey: LEGACY_KEY });
    setEmbeddingsCipher(fakeCipher({ available: false }));
    const out = await migrateEmbeddingsKeyStorage();
    expect(out.status).toBe('encryption-unavailable');
    const stored = readStored();
    expect(stored.apiKey).toBe(LEGACY_KEY); // preserved — silently destroying it would be worse
    expect(stored.keyStorage).toBe('legacy-plaintext'); // flagged, not hidden
    expect(await getEmbeddingsKeyStatus()).toBe('plaintext-unavailable');
    expect(await getEmbeddingsConfig().then((c) => c.apiKey)).toBe(LEGACY_KEY);
  });

  it('without a cipher at all, new keys store plaintext flagged as such (never claimed encrypted)', async () => {
    await setEmbeddingsConfig({ provider: 'openai', apiKey: 'some-other-key' });
    const stored = readStored();
    expect(stored.apiKey).toBe('some-other-key');
    expect(stored.keyStorage).toBe('plaintext');
    expect(await getEmbeddingsKeyStatus()).toBe('plaintext-unavailable');
  });

  it('no plaintext leaks into console output during migration', async () => {
    writeStored({ provider: 'openai', apiKey: LEGACY_KEY });
    setEmbeddingsCipher(fakeCipher());
    const seen: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...a) => seen.push(a.join(' '));
    console.warn = (...a) => seen.push(a.join(' '));
    console.error = (...a) => seen.push(a.join(' '));
    try {
      await migrateEmbeddingsKeyStorage();
      await setEmbeddingsConfig({ apiKey: 'rotated-key-2' });
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
    expect(seen.join('\n')).not.toContain(LEGACY_KEY);
    expect(seen.join('\n')).not.toContain('rotated-key-2');
  });
});
