/**
 * JINI device link protocol — shared VERBATIM by the desktop (Electron main) and the mobile
 * companion (imported through a Vite alias). Pure WebCrypto: no Node or DOM imports, so the
 * same code runs in both places and the two sides cannot drift apart.
 *
 * Pairing (QR, short-lived, single use):
 *   desktop → QR offer { id, secret, pub, hosts, port, exp }   (secret is random, 2 min, one use)
 *   phone   → POST /jini/pair { id, devicePub, proof = HMAC(secret, id.devicePub) }
 *   both    → key = HKDF-SHA256(ECDH-P256(own priv, peer pub), salt = secret, info = "jini-link-v1")
 *   desktop → { deviceId, confirm = seal(key, {ok}) }   (proves both sides derived the same key)
 *
 * Every later request/response is an AES-256-GCM envelope. The plaintext carries a timestamp and
 * a strictly increasing counter (replay protection); the AAD binds the device id and the
 * direction, so a response can never be reflected back as a request.
 */

export const LINK_VERSION = 1;
export const LINK_INFO = 'jini-link-v1';
export const OFFER_PREFIX = 'jini://pair?d=';
/** Requests whose timestamp is further than this from the receiver's clock are refused. */
export const MAX_SKEW_MS = 120_000;

export type Direction = 'c2d' | 'd2c';

export interface PairingOffer {
  v: number;
  /** Pairing session id. */
  id: string;
  /** Single-use pairing secret (base64url). Expires with the offer; never a long-lived credential. */
  secret: string;
  /** Desktop's ephemeral ECDH public key for this pairing (base64url, raw P-256). */
  pub: string;
  /** LAN addresses the phone may try, in order. */
  hosts: string[];
  port: number;
  /** Expiry (epoch ms). */
  exp: number;
  /** Desktop display name. */
  name: string;
}

export interface Envelope {
  /** 12-byte AES-GCM nonce (base64url). */
  n: string;
  /** Ciphertext + tag (base64url). */
  c: string;
}

export interface SealedPayload<T> {
  ts: number;
  ctr: number;
  body: T;
}

/** Opaque WebCrypto key handle (CryptoKey in both runtimes). */
export type LinkKey = object;

interface KeyPairLike {
  publicKey: LinkKey;
  privateKey: LinkKey;
}

/** The subset of SubtleCrypto this protocol uses, typed loosely so it compiles for Node and DOM. */
interface SubtleLike {
  generateKey(alg: object, extractable: boolean, usages: string[]): Promise<unknown>;
  importKey(format: string, data: unknown, alg: object, extractable: boolean, usages: string[]): Promise<LinkKey>;
  exportKey(format: string, key: LinkKey): Promise<unknown>;
  deriveBits(alg: object, key: LinkKey, length: number): Promise<ArrayBuffer>;
  encrypt(alg: object, key: LinkKey, data: Uint8Array): Promise<ArrayBuffer>;
  decrypt(alg: object, key: LinkKey, data: Uint8Array): Promise<ArrayBuffer>;
  sign(alg: string | object, key: LinkKey, data: Uint8Array): Promise<ArrayBuffer>;
}

interface CryptoLike {
  subtle: SubtleLike;
  getRandomValues<T extends Uint8Array>(a: T): T;
}

const cryptoApi = (): CryptoLike => {
  const c = (globalThis as unknown as { crypto?: CryptoLike }).crypto;
  if (!c?.subtle) throw new Error('WebCrypto is not available (a secure context is required).');
  return c;
};

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- base64url ----------

export function toB64u(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const randomB64u = (n: number): string => toB64u(cryptoApi().getRandomValues(new Uint8Array(n)));

/** Constant-time string comparison (both inputs are short base64url tags). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- offers ----------

export function encodeOffer(o: PairingOffer): string {
  return OFFER_PREFIX + toB64u(enc.encode(JSON.stringify(o)));
}

export function decodeOffer(text: string): PairingOffer {
  const t = text.trim();
  if (!t.startsWith(OFFER_PREFIX)) throw new Error('This is not a JINI pairing code.');
  const o = JSON.parse(dec.decode(fromB64u(t.slice(OFFER_PREFIX.length)))) as PairingOffer;
  const ok =
    o &&
    o.v === LINK_VERSION &&
    typeof o.id === 'string' &&
    typeof o.secret === 'string' &&
    typeof o.pub === 'string' &&
    Array.isArray(o.hosts) &&
    o.hosts.every((h) => typeof h === 'string') &&
    Number.isInteger(o.port) &&
    o.port > 0 &&
    o.port < 65536 &&
    typeof o.exp === 'number';
  if (!ok) throw new Error('The pairing code is malformed or from an incompatible JINI version.');
  return o;
}

// ---------- keys ----------

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

export async function generateLinkKeyPair(): Promise<KeyPairLike> {
  return (await cryptoApi().subtle.generateKey(ECDH, true, ['deriveBits'])) as KeyPairLike;
}

export async function exportPublicKey(kp: KeyPairLike): Promise<string> {
  return toB64u((await cryptoApi().subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
}

/** Private key as JWK (for storage on the device that owns it). */
export async function exportPrivateJwk(kp: KeyPairLike): Promise<string> {
  return JSON.stringify(await cryptoApi().subtle.exportKey('jwk', kp.privateKey));
}

export async function importPrivateJwk(jwk: string): Promise<LinkKey> {
  return cryptoApi().subtle.importKey('jwk', JSON.parse(jwk), ECDH, true, ['deriveBits']);
}

/**
 * Derive the 32-byte link secret from our private key and the peer's public key.
 * Returned as base64url so it can be stored (encrypted at rest by the caller).
 */
export async function deriveLinkSecret(privateKey: LinkKey, peerPubB64u: string, saltB64u: string): Promise<string> {
  const s = cryptoApi().subtle;
  const peer = await s.importKey('raw', fromB64u(peerPubB64u), ECDH, false, []);
  const shared = await s.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const hk = await s.importKey('raw', new Uint8Array(shared), { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await s.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: fromB64u(saltB64u), info: enc.encode(LINK_INFO) }, hk, 256);
  return toB64u(bits);
}

export async function importLinkSecret(secretB64u: string): Promise<LinkKey> {
  return cryptoApi().subtle.importKey('raw', fromB64u(secretB64u), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function hmacB64u(keyB64u: string, data: string): Promise<string> {
  const s = cryptoApi().subtle;
  const k = await s.importKey('raw', fromB64u(keyB64u), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toB64u(await s.sign('HMAC', k, enc.encode(data)));
}

export const pairingProofInput = (pairingId: string, devicePub: string): string => `${LINK_INFO}|pair|${pairingId}|${devicePub}`;

// ---------- envelopes ----------

const aad = (deviceId: string, dir: Direction): Uint8Array => enc.encode(`${LINK_INFO}|${deviceId}|${dir}`);

export async function seal<T>(key: LinkKey, deviceId: string, dir: Direction, payload: SealedPayload<T>): Promise<Envelope> {
  const c = cryptoApi();
  const iv = c.getRandomValues(new Uint8Array(12));
  const ct = await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(deviceId, dir) }, key, enc.encode(JSON.stringify(payload)));
  return { n: toB64u(iv), c: toB64u(ct) };
}

/** Decrypt and authenticate; throws on any tampering, wrong key, wrong device or wrong direction. */
export async function open<T>(key: LinkKey, deviceId: string, dir: Direction, env: Envelope): Promise<SealedPayload<T>> {
  if (!env || typeof env.n !== 'string' || typeof env.c !== 'string') throw new Error('malformed envelope');
  const pt = await cryptoApi().subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64u(env.n), additionalData: aad(deviceId, dir) },
    key,
    fromB64u(env.c)
  );
  const p = JSON.parse(dec.decode(pt)) as SealedPayload<T>;
  if (typeof p?.ts !== 'number' || typeof p?.ctr !== 'number') throw new Error('malformed payload');
  return p;
}

/**
 * Freshness + replay check for one sender. A request must be inside the clock window, carry a
 * counter above the persisted high-water mark (survives restarts) and never repeat a counter
 * seen inside the window. Parallel requests may arrive out of order and are still accepted.
 */
export class ReplayGuard {
  private seen = new Map<number, number>();
  constructor(private floor = 0) {}

  check(p: { ts: number; ctr: number }, now = Date.now()): string | null {
    if (!Number.isFinite(p.ts) || Math.abs(now - p.ts) > MAX_SKEW_MS) return 'request timestamp is outside the allowed window (check the phone and desktop clocks)';
    if (!Number.isSafeInteger(p.ctr) || p.ctr <= this.floor) return 'replayed request';
    for (const [ctr, at] of this.seen) if (at < now - 2 * MAX_SKEW_MS) this.seen.delete(ctr);
    if (this.seen.has(p.ctr)) return 'replayed request';
    if (this.seen.size >= 4096) return 'too many requests in the replay window';
    this.seen.set(p.ctr, now);
    return null;
  }

  /** Highest counter accepted so far (persist it; pass it back as the floor after a restart). */
  highWater(): number {
    let m = this.floor;
    for (const c of this.seen.keys()) if (c > m) m = c;
    return m;
  }
}

/** Monotonic counter source for a sender: time-based so it stays increasing across reinstalls. */
export function makeCounter(start = 0): () => number {
  let last = start;
  return () => {
    last = Math.max(Date.now() * 1000, last + 1);
    return last;
  };
}

// ---------- RPC surface (shared types) ----------

export interface RpcRequest {
  op: string;
  args?: Record<string, unknown>;
  /** Client-generated id for mutating ops; the desktop returns the stored result for a repeat. */
  cmdId?: string;
}

export interface RpcResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface LinkEvent {
  seq: number;
  at: number;
  type: 'chat' | 'task' | 'tasks' | 'approval' | 'approval-resolved' | 'memory' | 'notice';
  data: Record<string, unknown>;
}
