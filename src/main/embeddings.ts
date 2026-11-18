import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { createRequire } from 'node:module';
import { localAiPackageRoot } from './localAi';
import { FILES_ROOT } from './workspace';
import { atomicWrite, loadJson, withStoreLock } from './store';
import { pinnedRequest } from './safeNet';

/**
 * EMBEDDING PROVIDER ABSTRACTION (Round 18 §7.2) — genuine vector embeddings for memory
 * retrieval, behind a configurable provider interface.
 *
 * HONEST SCOPE (the mandate is explicit about this): the local TF-IDF retriever in
 * semanticMemory.ts is LEXICAL relevance, NOT neural semantic retrieval. This module is
 * the real-embedding layer:
 *
 *  - provider 'openai': any OpenAI-compatible /embeddings endpoint (configurable base
 *    URL + model + key) — NEURAL embeddings from the configured provider. Requests ride
 *    the SAME pinned DNS transport as every other web call (safeNet.pinnedRequest).
 *  - provider 'local': NEURAL local embeddings via the OPTIONAL installer component
 *    `resources/local-ai` (`@huggingface/transformers`; feature-extraction pipeline,
 *    e.g. all-MiniLM-L6-v2, ~25 MB model, CPU inference, cached under the user's cache dir).
 *    The core application does not ship this runtime. When the installer option is omitted,
 *    local embeddings report unavailable and retrieval falls back honestly to lexical.
 *  - provider 'none' (default): no embeddings — hybrid retrieval honestly degrades to
 *    the lexical retriever and is labeled as lexical. We never CALL TF-IDF "semantic".
 *
 * Configuration lives in brain/embeddings.json (engine state, not user files):
 *   { "provider": "none" | "openai" | "local", "baseUrl": "...", "model": "...",
 *     "apiKeyEncrypted": "<base64 safeStorage ciphertext>", "keyStorage": "safeStorage" }
 * Round 21 (CHANGE 3): the API key is encrypted at rest with Electron safeStorage and is
 * only ever decrypted in the main process, never logged, never echoed into receipts.
 * A legacy plaintext key is migrated at startup (idempotently, with verify-before-remove);
 * when encryption is unavailable the limitation is stated instead of faked.
 * Vectors are cached in brain/embeddings-cache.json keyed by (model, sha1(text)) so
 * re-embedding the same memory is free; the cache is bounded and evicts oldest-first.
 */

export interface EmbeddingProvider {
  /** Provider identity for cache namespacing ("openai:text-embedding-3-small" etc.). */
  readonly id: string;
  /** Vector dimensionality. */
  readonly dims: number;
  /** Embed a batch of texts, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingsConfig {
  provider: 'none' | 'openai' | 'local';
  baseUrl?: string;
  model?: string;
  /** RUNTIME plaintext key (decrypted in the main process). Never persisted as such after
   *  Round 21 unless encryption is genuinely unavailable — and then honestly flagged. */
  apiKey?: string;
}

/**
 * Round 21 (CHANGE 3): what the CONFIG FILE holds. The plaintext `apiKey` field is a
 * LEGACY representation kept only for (a) old files awaiting migration and (b) the
 * honest 'encryption unavailable' fallback. Successful migrations store ONLY
 * `apiKeyEncrypted` (base64 safeStorage ciphertext) + a `keyStorage` marker:
 *   - 'safeStorage'      — encrypted at rest with Electron safeStorage.
 *   - 'legacy-plaintext' — a plaintext key is present and migration has not yet completed
 *                          (migration interrupted, or encryption unavailable at write time).
 *   - 'plaintext'        — no encryption available; stored as plaintext BY NECESSITY and
 *                          reported as such (never claimed encrypted).
 *   - 'invalid'          — an encrypted credential exists but cannot be decrypted.
 */
export type EmbeddingsKeyStorage = 'safeStorage' | 'legacy-plaintext' | 'plaintext' | 'invalid';
export type EmbeddingsKeyStatus = 'encrypted' | 'legacy-plaintext' | 'plaintext-unavailable' | 'missing' | 'invalid' | 'none';

interface StoredEmbeddingsConfig {
  provider: 'none' | 'openai' | 'local';
  baseUrl?: string;
  model?: string;
  apiKey?: string; // LEGACY plaintext (never written by setEmbeddingsConfig when encryption works)
  apiKeyEncrypted?: string; // base64 safeStorage ciphertext
  keyStorage?: EmbeddingsKeyStorage;
}

/** The cipher abstraction — Electron safeStorage in the real main process (wired in
 *  index.ts), a test double in unit tests. embeddings.ts itself stays electron-free. */
export interface KeyCipher {
  isAvailable(): boolean;
  encrypt(plaintext: string): string; // base64 ciphertext; may throw
  decrypt(ciphertext: string): string; // may throw
}

let cipher: KeyCipher | null = null;
/** Main-process wiring (index.ts): give embeddings the real Electron safeStorage cipher. */
export const setEmbeddingsCipher = (c: KeyCipher | null): void => {
  cipher = c;
  migrationDone = false;
};

const CONFIG_FILE = path.join(FILES_ROOT, 'brain', 'embeddings.json');
const CACHE_FILE = path.join(FILES_ROOT, 'brain', 'embeddings-cache.json');
const CACHE_MAX_ENTRIES = 2000;

const DEFAULT_CONFIG: EmbeddingsConfig = { provider: 'none' };

const normalizeProvider = (p: unknown): EmbeddingsConfig['provider'] =>
  ['none', 'openai', 'local'].includes(String(p)) ? (p as EmbeddingsConfig['provider']) : 'none';

/** Decrypt failures are diagnosable, never fatal, and never leak the ciphertext shape. */
const tryDecrypt = (ciphertext: string): { ok: true; key: string } | { ok: false } => {
  if (!cipher) return { ok: false };
  try {
    return { ok: true, key: cipher.decrypt(ciphertext) };
  } catch {
    return { ok: false };
  }
};

/** The honest, at-rest status of the embeddings credential (for reports and diagnostics). */
export async function getEmbeddingsKeyStatus(): Promise<EmbeddingsKeyStatus> {
  const stored = await loadJson<StoredEmbeddingsConfig | null>(CONFIG_FILE, null);
  if (!stored) return 'none';
  if (stored.apiKeyEncrypted) {
    const d = tryDecrypt(stored.apiKeyEncrypted);
    return d.ok ? 'encrypted' : 'invalid';
  }
  if (stored.apiKey) return cipher?.isAvailable() ? 'legacy-plaintext' : 'plaintext-unavailable';
  return 'missing';
}

/** Read the stored config and resolve the RUNTIME config (plaintext key in memory only). */
export async function getEmbeddingsConfig(): Promise<EmbeddingsConfig> {
  const stored = await loadJson<StoredEmbeddingsConfig | null>(CONFIG_FILE, null);
  if (!stored) return DEFAULT_CONFIG;
  let apiKey: string | undefined;
  if (stored.apiKeyEncrypted) {
    const d = tryDecrypt(stored.apiKeyEncrypted);
    apiKey = d.ok ? d.key : undefined; // invalid ciphertext → no key; the provider fails honestly
  } else if (stored.apiKey) {
    apiKey = stored.apiKey; // legacy plaintext / encryption-unavailable fallback
  }
  return {
    provider: normalizeProvider(stored.provider),
    baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : undefined,
    model: typeof stored.model === 'string' ? stored.model : undefined,
    apiKey,
  };
}

export async function setEmbeddingsConfig(patch: Partial<EmbeddingsConfig>): Promise<EmbeddingsConfig> {
  return withStoreLock(CONFIG_FILE, async () => {
    const cur = await getEmbeddingsConfig();
    const next: EmbeddingsConfig = {
      provider: patch.provider !== undefined ? normalizeProvider(patch.provider) : cur.provider,
      baseUrl: patch.baseUrl !== undefined ? patch.baseUrl.trim() : cur.baseUrl,
      model: patch.model !== undefined ? patch.model.trim() : cur.model,
      apiKey: patch.apiKey !== undefined ? patch.apiKey.trim() : cur.apiKey,
    };
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    // Round 21 (CHANGE 3): the key is encrypted at rest whenever a cipher is available;
    // plaintext is stored ONLY when encryption is genuinely unavailable — and flagged as
    // such so no code path can later claim the credential was encrypted.
    const stored: StoredEmbeddingsConfig = {
      provider: next.provider,
      baseUrl: next.baseUrl,
      model: next.model,
    };
    if (next.apiKey && cipher?.isAvailable()) {
      try {
        stored.apiKeyEncrypted = cipher.encrypt(next.apiKey);
        stored.keyStorage = 'safeStorage';
      } catch {
        stored.apiKey = next.apiKey;
        stored.keyStorage = 'plaintext';
      }
    } else if (next.apiKey) {
      stored.apiKey = next.apiKey;
      stored.keyStorage = 'plaintext'; // honest flag: encryption unavailable, stored in the clear
    }
    await atomicWrite(CONFIG_FILE, JSON.stringify(stored, null, 1));
    return next;
  });
}

let migrationDone = false;
export type MigrationOutcome =
  | { status: 'migrated' }
  | { status: 'already-encrypted' }
  | { status: 'no-credential' }
  | { status: 'encryption-unavailable' }
  | { status: 'failed'; reason: string };

/**
 * Round 21 (CHANGE 3): ONE-TIME, IDEMPOTENT startup migration of a legacy plaintext
 * embeddings API key to Electron safeStorage encryption. Sequence per the security
 * contract: encrypt → persist the encrypted representation → VERIFY it decrypts → only
 * then remove the plaintext. A verification or write failure leaves the original file
 * intact (the only valid credential is never destroyed); the next startup retries.
 * Never logs, returns or transmits the key material itself.
 */
export async function migrateEmbeddingsKeyStorage(): Promise<MigrationOutcome> {
  if (migrationDone) return { status: 'already-encrypted' };
  return withStoreLock(CONFIG_FILE, async (): Promise<MigrationOutcome> => {
    const stored = await loadJson<StoredEmbeddingsConfig | null>(CONFIG_FILE, null);
    if (!stored) {
      migrationDone = true;
      return { status: 'no-credential' };
    }
    if (stored.apiKeyEncrypted && !stored.apiKey) {
      migrationDone = true;
      return { status: 'already-encrypted' };
    }
    if (!stored.apiKey) {
      migrationDone = true;
      return { status: 'no-credential' };
    }
    if (!cipher || !cipher.isAvailable()) {
      // Honest fallback: keep the legacy plaintext, flag the limitation, never fake encryption.
      const patched: StoredEmbeddingsConfig = { ...stored, keyStorage: 'legacy-plaintext' };
      await atomicWrite(CONFIG_FILE, JSON.stringify(patched, null, 1));
      migrationDone = true;
      return { status: 'encryption-unavailable' };
    }
    let encrypted: string;
    try {
      encrypted = cipher.encrypt(stored.apiKey);
    } catch (e) {
      return { status: 'failed', reason: `encryption failed (${e instanceof Error ? e.message : 'unknown'}); the plaintext key was left untouched` };
    }
    // Persist encrypted WITH the plaintext still present (crash here = next startup re-migrates),
    // then verify, then remove the plaintext. Both writes ride the same per-file lock.
    const withBoth: StoredEmbeddingsConfig = { ...stored, apiKeyEncrypted: encrypted, keyStorage: 'safeStorage' };
    try {
      await atomicWrite(CONFIG_FILE, JSON.stringify(withBoth, null, 1));
      const verify = tryDecrypt(encrypted);
      if (!verify.ok || verify.key !== stored.apiKey) throw new Error('verification decrypt did not return the original key');
      const encryptedOnly: StoredEmbeddingsConfig = {
        provider: stored.provider,
        baseUrl: stored.baseUrl,
        model: stored.model,
        apiKeyEncrypted: encrypted,
        keyStorage: 'safeStorage',
      };
      await atomicWrite(CONFIG_FILE, JSON.stringify(encryptedOnly, null, 1));
      migrationDone = true;
      return { status: 'migrated' };
    } catch (e) {
      // Restore the original file so the only valid credential is never lost.
      try {
        await atomicWrite(CONFIG_FILE, JSON.stringify(stored, null, 1));
      } catch {
        /* the plaintext file may still be on disk anyway — recovery is re-running migration */
      }
      return { status: 'failed', reason: e instanceof Error ? e.message : 'unknown migration failure' };
    }
  });
}

// ------------------------------------------------------------------ the 'openai' provider

const openAICompatibleProvider = (cfg: EmbeddingsConfig): EmbeddingProvider | null => {
  const base = (cfg.baseUrl ?? '').replace(/\/+$/, '');
  const model = cfg.model ?? 'text-embedding-3-small';
  if (!base) return null;
  return {
    id: `openai:${model}`,
    dims: 0, // learned from the first response
    async embed(texts: string[]): Promise<number[][]> {
      const res = await pinnedRequest(`${base}/embeddings`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
        timeoutMs: 30_000,
      });
      const body = await res.text(2_000_000);
      if (res.status !== 200) throw new Error(`Embedding provider returned ${res.status}: ${body.slice(0, 200)}`);
      const parsed = JSON.parse(body) as { data?: Array<{ embedding?: unknown; index?: number }>; error?: { message?: string } };
      if (!parsed.data?.length) throw new Error(`Embedding provider returned no vectors: ${parsed.error?.message ?? body.slice(0, 120)}`);
      const out: number[][] = new Array(texts.length);
      parsed.data.forEach((d, i) => {
        const v = (d.embedding as number[] | undefined) ?? [];
        out[d.index ?? i] = v.map(Number);
      });
      // Round 20 (CHANGE 7): DIMENSION VALIDATION before pinning. A bogus first response
      // (empty/misaligned vectors) used to poison the memoized provider's dims forever,
      // forcing silent lexical fallback until the config changed. Now: every vector must
      // be a finite array of the SAME positive length, or the call throws (lexical
      // fallback for this turn; a healthy response later still pins dims). A LATER
      // response with a different length throws too — vectors from two different models
      // must never be mixed (model-compatibility validation).
      const dims = out[0]?.length ?? 0;
      const sane = dims > 0 && out.every((v) => Array.isArray(v) && v.length === dims && v.every((x) => Number.isFinite(x)));
      if (!sane) throw new Error(`Embedding provider returned malformed vectors (expected ${dims || 'a positive'}-length finite vectors)`);
      const known = (this as { dims?: number }).dims ?? 0;
      if (known > 0 && known !== dims) throw new Error(`Embedding dimension mismatch: provider previously returned ${known}-dim vectors, now ${dims}-dim — the model changed; re-embed the corpus before use`);
      (this as { dims?: number }).dims = dims;
      return out;
    },
  };
};

// ------------------------------------------------------------------- the 'local' provider

type FeatureExtractor = (texts: string[], opts: { pooling: string; normalize: boolean }) => Promise<unknown>;

let localPipeline: FeatureExtractor | null = null;
let localPipelineTried = false;

/**
 * The local NEURAL backend is an opt-in installer component. Packaged builds load it
 * from resources/local-ai; development builds resolve the locked devDependency. A missing
 * optional component is a normal state: retrieval falls back to lexical, never faked.
 */
export const isLocalEmbedderAvailable = async (): Promise<boolean> => {
  if (localPipeline) return true;
  if (localPipelineTried) return false;
  localPipelineTried = true;
  try {
    const packageRoot = localAiPackageRoot();
    if (!packageRoot) return false;
    const runtimeRequire = createRequire(packageRoot);
    const mod = runtimeRequire('@huggingface/transformers') as {
      pipeline: (task: string, model?: string) => Promise<FeatureExtractor>;
    };
    localPipeline = await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    return true;
  } catch {
    return false;
  }
};

const localProvider = (model: string): EmbeddingProvider => ({
  id: `local:${model}`,
  dims: 384, // all-MiniLM-L6-v2
  async embed(texts: string[]): Promise<number[][]> {
    if (!(await isLocalEmbedderAvailable()) || !localPipeline) {
      throw new Error('Local AI support was not selected during JINI setup. Enable the Local AI installer component for local embeddings, or configure an OpenAI-compatible embeddings provider.');
    }
    // Batched through the pipeline; normalize:true yields unit vectors, so cosine is a
    // plain dot product — but we still normalize defensively.
    // Round 20 (CHANGE 7): the local pipeline previously had NO timeout — a hung model
    // load stalled turn-context assembly. 30 s bounds one embed call; on timeout the
    // lexical fallback takes over (honestly labeled).
    const raw = (await Promise.race([
      localPipeline(texts, { pooling: 'mean', normalize: true }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Local embedding timed out after 30s')), 30_000)),
    ])) as unknown;
    const arr = Array.isArray(raw) ? raw : [raw];
    const out: number[][] = arr.map((entry) => {
      const data = (entry as { data: Float32Array | number[] }).data;
      const v = data instanceof Float32Array ? Array.from(data) : (data as number[]);
      const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
    return out;
  },
});

// ---------------------------------------------------------------------------- the facade

let activeProvider: EmbeddingProvider | null = null;
let activeProviderKey = '';

/** Resolve the configured provider, or null when 'none' (honest lexical-only mode). */
export async function getEmbeddingProvider(): Promise<EmbeddingProvider | null> {
  const cfg = await getEmbeddingsConfig();
  if (cfg.provider === 'none') return null;
  const key = `${cfg.provider}:${cfg.baseUrl ?? ''}:${cfg.model ?? ''}:${cfg.apiKey ? 'key' : 'nokey'}`;
  if (activeProvider && activeProviderKey === key) return activeProvider;
  activeProvider =
    cfg.provider === 'openai' ? openAICompatibleProvider(cfg) : localProvider(cfg.model ?? 'Xenova/all-MiniLM-L6-v2');
  activeProviderKey = key;
  return activeProvider;
}

// ------------------------------------------------------------------------ vector caching

interface CacheEntry {
  v: number[];
  at: number;
}
type VectorCache = Record<string, Record<string, CacheEntry>>; // providerId → hash → entry

let cacheDirty = false;
let cacheWrite: Promise<void> = Promise.resolve();

async function loadCache(): Promise<VectorCache> {
  const parsed = await loadJson<VectorCache | null>(CACHE_FILE, null);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function persistCache(cache: VectorCache): Promise<void> {
  cacheWrite = cacheWrite
    .then(async () => {
      if (!cacheDirty) return;
      cacheDirty = false;
      await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
      await atomicWrite(CACHE_FILE, JSON.stringify(cache));
    })
    .catch(() => undefined); // the cache is an optimization; losing it must never break retrieval
  return cacheWrite;
}

const textHash = (text: string): string => createHash('sha1').update(text).digest('hex');

/** Embed texts with the given provider, using and filling the on-disk vector cache. */
export async function embedWithCache(provider: EmbeddingProvider, texts: string[]): Promise<number[][]> {
  const cache = await loadCache();
  const bucket = (cache[provider.id] ??= {});
  const now = Date.now();
  const hashes = texts.map(textHash);
  const missing: number[] = [];
  hashes.forEach((h, i) => {
    if (!bucket[h]) missing.push(i);
    else bucket[h].at = now; // LRU touch
  });
  if (missing.length) {
    const vectors = await provider.embed(missing.map((i) => texts[i]));
    missing.forEach((idx, k) => {
      bucket[hashes[idx]] = { v: vectors[k], at: now };
    });
    // Bound the cache: evict the oldest entries beyond the cap.
    const all = Object.entries(bucket).sort((a, b) => a[1].at - b[1].at);
    for (const [h] of all.slice(0, Math.max(0, all.length - CACHE_MAX_ENTRIES))) delete bucket[h];
    cacheDirty = true;
    await persistCache(cache);
  }
  return hashes.map((h) => bucket[h].v);
}

/** Cosine similarity for equal-length vectors (0 for degenerate inputs). */
export function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** TEST-ONLY: reset memoized provider/pipeline state between tests. */
export const resetEmbeddingsForTests = (): void => {
  activeProvider = null;
  activeProviderKey = '';
  localPipeline = null;
  localPipelineTried = false;
  cipher = null;
  migrationDone = false;
};
