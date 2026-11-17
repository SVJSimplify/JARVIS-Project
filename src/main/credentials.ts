/**
 * INTEGRATION CREDENTIAL LAYER (Round 30, restored in Round 32 Phase 3 §3.1).
 *
 * The dedicated, single home for GitHub/Vercel credentials:
 *  - Stored OUTSIDE the workspace (Electron userData dir — never shipped, never synced,
 *    never inside Jarvis-Files where models and tools can read it).
 *  - Encrypted with the PLATFORM keychain through Electron safeStorage (the same cipher
 *    contract the settings/embeddings layers already use — never a self-made cipher).
 *  - FAIL-CLOSED on encryption: when platform encryption is unavailable, save REFUSES
 *    with a clear explanation instead of silently downgrading to plaintext. The
 *    environment-variable path remains fully supported.
 *  - Secrets never enter model context, renderer-readable state, logs, audit records or
 *    tool receipts: every observer-facing API returns PRESENCE metadata only.
 *  - save / replace / test / revoke lifecycle, plus authentication-failure detection
 *    distinct from permission/scope failures (the test path classifies HTTP 401/403).
 *
 * Electron-free by design: index.ts injects the real safeStorage cipher at boot, so the
 * module is testable and the storage contract is explicit.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { atomicWrite, withStoreLock } from './store';
import { FILES_ROOT } from './workspace';

export interface KeyCipher {
  isAvailable(): boolean;
  encrypt(plaintext: string): string; // base64 ciphertext; may throw
  decrypt(ciphertext: string): string; // may throw
}

let cipher: KeyCipher | null = null;
/** Main-process wiring (index.ts): give the credential store the real safeStorage cipher. */
export const setCredentialCipher = (c: KeyCipher | null): void => {
  cipher = c;
};

/** The credential file lives in the USER DATA dir (outside the workspace); tests may override. */
let storePathOverride: string | null = null;
export const setCredentialStorePathForTests = (p: string | null): void => {
  storePathOverride = p;
};
export const credentialStorePath = (): string => storePathOverride ?? path.join(path.dirname(FILES_ROOT), 'jarvis-credentials', 'credentials.json');

export const SERVICES = ['github', 'vercel'] as const;
export type CredentialService = (typeof SERVICES)[number];
export const isService = (v: unknown): v is CredentialService => SERVICES.includes(String(v) as CredentialService);

interface StoredCredential {
  /** base64 ciphertext (encrypted) or plaintext ONLY when encryption was unavailable AND the user stored it that way in an old version — new plaintext saves are refused. */
  secret: string;
  encrypted: boolean;
  savedAt: number;
  updatedAt: number;
  /** Set by a successful live test; cleared when a call is rejected as unauthorized. */
  lastTestedAt?: number;
  lastTestOk?: boolean;
  lastTestDetail?: string;
}

interface CredentialStore {
  version: 1;
  credentials: Partial<Record<CredentialService, StoredCredential>>;
}

const EMPTY: CredentialStore = { version: 1, credentials: {} };

const readStore = async (): Promise<CredentialStore> => {
  try {
    const raw = await fs.readFile(credentialStorePath(), 'utf8');
    const parsed = JSON.parse(raw) as CredentialStore;
    if (!parsed || typeof parsed !== 'object' || !parsed.credentials || typeof parsed.credentials !== 'object') return { ...EMPTY };
    return parsed;
  } catch {
    return { ...EMPTY };
  }
};

const writeStore = async (s: CredentialStore): Promise<void> => {
  await fs.mkdir(path.dirname(credentialStorePath()), { recursive: true });
  await atomicWrite(credentialStorePath(), JSON.stringify(s));
};

/** Sanitized, observer-facing metadata — never a secret value, never a ciphertext. */
export interface CredentialInfo {
  service: CredentialService;
  /** A credential IS stored in the dedicated store. */
  stored: boolean;
  /** The stored secret is platform-encrypted (false on a legacy plaintext record). */
  encrypted: boolean;
  savedAt?: number;
  updatedAt?: number;
  lastTestedAt?: number;
  lastTestOk?: boolean;
  lastTestDetail?: string;
  /** An environment fallback exists for this service. */
  envAvailable: boolean;
  /** Platform encryption availability (save refuses when this is false). */
  encryptionAvailable: boolean;
  /** The environment variable names that can carry this credential. */
  envKeys: string[];
}

const ENV_KEYS: Record<CredentialService, string[]> = {
  github: ['GITHUB_TOKEN', 'GH_TOKEN'],
  vercel: ['VERCEL_TOKEN'],
};

const envAvailableFor = (s: CredentialService): boolean => ENV_KEYS[s].some((k) => !!process.env[k]?.trim());

/** Presence metadata for one service (or all). Values never leave this module. */
export async function credentialInfo(service?: CredentialService): Promise<CredentialInfo[]> {
  const s = await readStore();
  const list = service ? ([service] as CredentialService[]) : [...SERVICES];
  return list.map((svc) => {
    const rec = s.credentials[svc];
    return {
      service: svc,
      stored: !!rec,
      encrypted: rec?.encrypted === true,
      savedAt: rec?.savedAt,
      updatedAt: rec?.updatedAt,
      lastTestedAt: rec?.lastTestedAt,
      lastTestOk: rec?.lastTestOk,
      lastTestDetail: rec?.lastTestDetail,
      envAvailable: envAvailableFor(svc),
      encryptionAvailable: cipher?.isAvailable() === true,
      envKeys: ENV_KEYS[svc],
    };
  });
}

/**
 * Save or REPLACE a credential. Fail-closed on encryption: when the platform keychain is
 * unavailable the save REFUSES (no plaintext downgrade); the caller is told exactly why
 * and what the safe alternative is.
 */
export async function saveCredential(service: CredentialService, secret: string): Promise<{ ok: boolean; reason: string; encrypted?: boolean }> {
  const trimmed = String(secret ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'the credential is empty — nothing was saved' };
  if (!cipher) return { ok: false, reason: 'the credential store is not initialized (main process only)' };
  if (!cipher.isAvailable()) {
    return {
      ok: false,
      reason:
        'platform credential encryption (safeStorage) is UNAVAILABLE on this system, so JARVIS refuses to store the secret: it would have to sit on disk as PLAINTEXT, and JARVIS does not silently downgrade credential storage. ' +
        `Keep the credential in the environment instead (${ENV_KEYS[service].join(' or ')}) — the environment path stays fully supported.`,
    };
  }
  let encrypted: string;
  try {
    encrypted = cipher.encrypt(trimmed);
  } catch (e) {
    return { ok: false, reason: `the platform cipher refused to encrypt the credential (${e instanceof Error ? e.message : String(e)}) — nothing was saved` };
  }
  return withStoreLock(credentialStorePath(), async () => {
    const s = await readStore();
    const prev = s.credentials[service];
    s.credentials[service] = {
      secret: encrypted,
      encrypted: true,
      savedAt: prev?.savedAt ?? Date.now(),
      updatedAt: Date.now(),
      // a replaced credential starts with a clean test slate
      lastTestedAt: undefined,
      lastTestOk: undefined,
      lastTestDetail: 'replaced — not tested yet',
    };
    await writeStore(s);
    return { ok: true, reason: `${service} credential saved (platform-encrypted)`, encrypted: true };
  });
}

/** Revoke (remove) a stored credential. The record is removed, not kept in any history. */
export async function revokeCredential(service: CredentialService): Promise<{ ok: boolean; reason: string }> {
  return withStoreLock(credentialStorePath(), async () => {
    const s = await readStore();
    if (!s.credentials[service]) return { ok: false, reason: `no ${service} credential is stored (the environment variable, if any, is unchanged)` };
    delete s.credentials[service];
    await writeStore(s);
    return { ok: true, reason: `${service} credential revoked` };
  });
}

/** Record the outcome of a live test (presence metadata only). */
async function recordTest(service: CredentialService, ok: boolean, detail: string): Promise<void> {
  await withStoreLock(credentialStorePath(), async () => {
    const s = await readStore();
    const rec = s.credentials[service];
    if (!rec) return;
    rec.lastTestedAt = Date.now();
    rec.lastTestOk = ok;
    rec.lastTestDetail = detail.slice(0, 200);
    await writeStore(s);
  });
}

/**
 * The resolved secret for a service: the dedicated store first, the environment second.
 * Returns '' when neither carries one. Never logs, never echoes.
 */
export async function resolveCredential(service: CredentialService): Promise<string> {
  const s = await readStore();
  const rec = s.credentials[service];
  if (rec && cipher?.isAvailable() && rec.encrypted) {
    try {
      const plain = cipher.decrypt(rec.secret);
      if (plain) return plain;
    } catch {
      // decryption failed (keyring backend changed) — fall through honestly to env
      console.warn(`[credentials] the stored ${service} credential could not be decrypted (keyring backend changed?); falling back to the environment if one is set`);
    }
  }
  for (const k of ENV_KEYS[service]) {
    const v = process.env[k]?.trim();
    if (v) return v;
  }
  return '';
}

/** A record marked encrypted but unreadable is a DETECTABLE failure, not silence. */
export async function credentialStoreProblem(): Promise<string> {
  const s = await readStore();
  const problems: string[] = [];
  for (const svc of SERVICES) {
    const rec = s.credentials[svc];
    if (rec && rec.encrypted && cipher?.isAvailable() !== true) problems.push(`${svc}: stored credential is encrypted but platform encryption is now unavailable`);
  }
  return problems.join('; ');
}

/** Mark a service's credential as rejected-by-service (auth evidence for the Ops Center). */
export async function noteCredentialRejected(service: CredentialService, detail: string): Promise<void> {
  await recordTest(service, false, `rejected by the service: ${detail}`);
}

export async function noteCredentialVerified(service: CredentialService, detail: string): Promise<void> {
  await recordTest(service, true, detail);
}

// --------------------------------------------------------------------------- IPC faces

const cleanService = (v: unknown): CredentialService | null => (isService(v) ? v : null);

export const credentialInfoIpc = (): Promise<CredentialInfo[]> => credentialInfo();

export async function credentialSetIpc(service: string, secret: string): Promise<{ ok: boolean; reason: string }> {
  const svc = cleanService(service);
  if (!svc) return { ok: false, reason: `unknown credential service "${service}" (known: ${SERVICES.join(', ')})` };
  return saveCredential(svc, secret);
}

export async function credentialTestIpc(service: string): Promise<{ ok: boolean; reason: string }> {
  const svc = cleanService(service);
  if (!svc) return { ok: false, reason: `unknown credential service "${service}"` };
  const secret = await resolveCredential(svc);
  if (!secret) return { ok: false, reason: `no ${svc} credential is stored and none is in the environment (${ENV_KEYS[svc].join(', ')})` };
  try {
    if (svc === 'github') {
      const res = await fetch('https://api.github.com/user', {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${secret}`, 'User-Agent': 'JARVIS-desktop-agent' },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 401) {
        await noteCredentialRejected('github', 'HTTP 401 unauthorized');
        return { ok: false, reason: 'GitHub REJECTED the credential (HTTP 401 — unauthorized): it is expired or invalid.' };
      }
      if (res.status === 403) {
        await noteCredentialRejected('github', 'HTTP 403 forbidden/rate limit');
        return { ok: false, reason: 'GitHub refused the credential (HTTP 403 — forbidden or rate limited): the token may lack the required scope.' };
      }
      if (!res.ok) {
        return { ok: false, reason: `GitHub API returned HTTP ${res.status} — the credential was not confirmed.` };
      }
      const login = (await res.json().catch(() => ({})) as { login?: string }).login;
      await noteCredentialVerified('github', `accepted by GitHub as "${login ?? '?'}"`);
      return { ok: true, reason: `GitHub ACCEPTED the credential (authenticated as "${login ?? '?'}").` };
    }
    // vercel
    const res = await fetch('https://api.vercel.com/v2/user', {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      await noteCredentialRejected('vercel', `HTTP ${res.status}`);
      return { ok: false, reason: `Vercel REJECTED the credential (HTTP ${res.status}): it is expired, invalid, or lacks access.` };
    }
    if (!res.ok) return { ok: false, reason: `Vercel API returned HTTP ${res.status} — the credential was not confirmed.` };
    const user = (await res.json().catch(() => ({})) as { user?: { username?: string } }).user;
    await noteCredentialVerified('vercel', `accepted by Vercel as "${user?.username ?? '?'}"`);
    return { ok: true, reason: `Vercel ACCEPTED the credential (authenticated as "${user?.username ?? '?'}").` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: `the ${svc} credential could not be tested (network failure: ${msg.slice(0, 120)}) — not an auth rejection.` };
  }
}

export async function credentialRevokeIpc(service: string): Promise<{ ok: boolean; reason: string }> {
  const svc = cleanService(service);
  if (!svc) return { ok: false, reason: `unknown credential service "${service}"` };
  return revokeCredential(svc);
}
