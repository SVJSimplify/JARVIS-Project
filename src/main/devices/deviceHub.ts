/**
 * JINI Device Communication Layer (desktop side): pairing, the device registry, the encrypted
 * request channel, incremental event sync and live hints. Feature operations are injected
 * (see deviceOps.ts) so this module owns transport + security only and is testable without
 * Electron.
 *
 * Security model:
 *  - The LAN server is OFF until the user enables it. Pairing is possible only while a QR offer
 *    is showing (2 minutes, single use, 5 wrong proofs kill it).
 *  - Each device has its own 32-byte link secret (ECDH + HKDF), stored encrypted at rest when
 *    the OS keyring is available. Every request is AES-GCM sealed and replay-checked.
 *  - Devices can be revoked; a device unused for 30 days expires and must pair again; the link
 *    secret can be rotated (the previous secret keeps working until the new one is first used).
 */
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  LINK_VERSION,
  ReplayGuard,
  decodeOffer,
  deriveLinkSecret,
  encodeOffer,
  exportPublicKey,
  generateLinkKeyPair,
  hmacB64u,
  importLinkSecret,
  makeCounter,
  open,
  pairingProofInput,
  randomB64u,
  safeEqual,
  seal,
  type Envelope,
  type LinkEvent,
  type LinkKey,
  type RpcRequest,
  type RpcResponse,
} from './link';

export const DEFAULT_PORT = 47621;
const PAIRING_TTL_MS = 120_000;
const DEVICE_IDLE_EXPIRY_MS = 30 * 24 * 3600_000;
const MAX_BODY = 256 * 1024;
const MAX_EVENTS = 1000;
const SYNC_PAGE = 200;

export interface Cipher {
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

export interface OpContext {
  deviceId: string;
  deviceName: string;
}

export type OpHandler = (args: Record<string, unknown>, ctx: OpContext) => Promise<unknown> | unknown;

export interface HubDeps {
  dataDir: string;
  desktopName: string;
  cipher: Cipher | null;
  ops: Record<string, OpHandler>;
  /** Optional hook: a device paired / revoked / expired (for desktop notifications). */
  onSecurityEvent?: (message: string) => void;
}

interface DeviceRecord {
  id: string;
  name: string;
  platform: string;
  secret: string;
  secretEnc: boolean;
  prevSecret?: string;
  createdAt: number;
  lastSeen: number;
  rotatedAt?: number;
  revokedAt?: number;
  revokeReason?: string;
  hwm: number;
}

export interface DeviceView {
  id: string;
  name: string;
  platform: string;
  createdAt: number;
  lastSeen: number;
  rotatedAt?: number;
  revokedAt?: number;
  revokeReason?: string;
  online: boolean;
}

export interface HubStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  hosts: string[];
  pairing: { exp: number } | null;
  lastError: string;
  seq: number;
}

interface Pairing {
  id: string;
  secret: string;
  keyPair: Awaited<ReturnType<typeof generateLinkKeyPair>>;
  pub: string;
  exp: number;
  used: boolean;
  failures: number;
}

/** LAN IPv4 addresses the phone can try (private ranges first). */
export function lanHosts(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  const priv = (h: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  return [...out.filter(priv), ...out.filter((h) => !priv(h))];
}

export class DeviceHub {
  private devices = new Map<string, DeviceRecord>();
  private guards = new Map<string, ReplayGuard>();
  private keys = new Map<string, { cur: LinkKey; prev?: LinkKey }>();
  private counters = new Map<string, () => number>();
  private sockets = new Map<string, Set<WebSocket>>();
  private idem = new Map<string, Map<string, RpcResponse>>();
  private events: LinkEvent[] = [];
  private seq = 0;
  private pairing: Pairing | null = null;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private enabled = false;
  private port = DEFAULT_PORT;
  private lastError = '';
  private loaded = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private failuresByIp = new Map<string, { n: number; since: number }>();

  constructor(private deps: HubDeps) {}

  // ---------- persistence ----------

  private file = (name: string) => path.join(this.deps.dataDir, name);

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await fs.mkdir(this.deps.dataDir, { recursive: true });
    const read = async <T>(name: string, fallback: T): Promise<T> => {
      try {
        return JSON.parse(await fs.readFile(this.file(name), 'utf8')) as T;
      } catch {
        return fallback;
      }
    };
    const cfg = await read<{ enabled?: boolean; port?: number }>('hub.json', {});
    this.enabled = cfg.enabled === true;
    this.port = Number.isInteger(cfg.port) && cfg.port! > 1024 && cfg.port! < 65536 ? cfg.port! : DEFAULT_PORT;
    for (const d of await read<DeviceRecord[]>('devices.json', [])) {
      if (d && typeof d.id === 'string' && typeof d.secret === 'string') this.devices.set(d.id, d);
    }
    const ev = await read<{ seq: number; events: LinkEvent[] }>('events.json', { seq: 0, events: [] });
    this.seq = Number.isInteger(ev.seq) ? ev.seq : 0;
    this.events = Array.isArray(ev.events) ? ev.events.slice(-MAX_EVENTS) : [];
    this.expireIdleDevices();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, 300);
  }

  async saveNow(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    for (const [id, g] of this.guards) {
      const d = this.devices.get(id);
      if (d) d.hwm = Math.max(d.hwm ?? 0, g.highWater());
    }
    const write = async (name: string, data: unknown) => {
      const f = this.file(name);
      const tmp = `${f}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await fs.rename(tmp, f);
    };
    await fs.mkdir(this.deps.dataDir, { recursive: true });
    await write('hub.json', { enabled: this.enabled, port: this.port });
    await write('devices.json', [...this.devices.values()]);
    await write('events.json', { seq: this.seq, events: this.events });
  }

  // ---------- secrets ----------

  private storeSecret(plain: string): { secret: string; secretEnc: boolean } {
    const c = this.deps.cipher;
    if (c?.available()) return { secret: c.encrypt(plain), secretEnc: true };
    return { secret: plain, secretEnc: false };
  }

  private readSecret(stored: string, encFlag: boolean): string {
    return encFlag ? (this.deps.cipher?.decrypt(stored) ?? '') : stored;
  }

  private async keysFor(d: DeviceRecord): Promise<{ cur: LinkKey; prev?: LinkKey }> {
    const cached = this.keys.get(d.id);
    if (cached) return cached;
    const cur = await importLinkSecret(this.readSecret(d.secret, d.secretEnc));
    const prev = d.prevSecret ? await importLinkSecret(this.readSecret(d.prevSecret, d.secretEnc)) : undefined;
    const k = { cur, prev };
    this.keys.set(d.id, k);
    return k;
  }

  private guardFor(d: DeviceRecord): ReplayGuard {
    let g = this.guards.get(d.id);
    if (!g) {
      g = new ReplayGuard(d.hwm ?? 0);
      this.guards.set(d.id, g);
    }
    return g;
  }

  private counterFor(id: string): () => number {
    let c = this.counters.get(id);
    if (!c) {
      c = makeCounter();
      this.counters.set(id, c);
    }
    return c;
  }

  // ---------- registry ----------

  private viewOf(d: DeviceRecord): DeviceView {
    return {
      id: d.id,
      name: d.name,
      platform: d.platform,
      createdAt: d.createdAt,
      lastSeen: d.lastSeen,
      rotatedAt: d.rotatedAt,
      revokedAt: d.revokedAt,
      revokeReason: d.revokeReason,
      online: (this.sockets.get(d.id)?.size ?? 0) > 0,
    };
  }

  listDevices(): DeviceView[] {
    return [...this.devices.values()].sort((a, b) => b.lastSeen - a.lastSeen).map((d) => this.viewOf(d));
  }

  private expireIdleDevices(now = Date.now()): void {
    for (const d of this.devices.values()) {
      if (!d.revokedAt && now - d.lastSeen > DEVICE_IDLE_EXPIRY_MS) {
        d.revokedAt = now;
        d.revokeReason = 'expired after 30 days without use — pair again';
        this.deps.onSecurityEvent?.(`Device "${d.name}" expired after 30 days of inactivity.`);
      }
    }
  }

  async revokeDevice(id: string, reason = 'revoked by the user'): Promise<boolean> {
    const d = this.devices.get(id);
    if (!d || d.revokedAt) return false;
    d.revokedAt = Date.now();
    d.revokeReason = reason;
    this.keys.delete(id);
    for (const s of this.sockets.get(id) ?? []) s.close(4401, 'revoked');
    this.sockets.delete(id);
    await this.saveNow();
    this.deps.onSecurityEvent?.(`Device "${d.name}" was revoked.`);
    return true;
  }

  /** Remove a revoked device from the list entirely. */
  async forgetDevice(id: string): Promise<boolean> {
    const d = this.devices.get(id);
    if (!d || !d.revokedAt) return false;
    this.devices.delete(id);
    this.guards.delete(id);
    this.idem.delete(id);
    await this.saveNow();
    return true;
  }

  // ---------- server lifecycle ----------

  status(): HubStatus {
    return {
      enabled: this.enabled,
      listening: Boolean(this.server?.listening),
      port: this.port,
      hosts: lanHosts(),
      pairing: this.pairing && !this.pairing.used && this.pairing.exp > Date.now() ? { exp: this.pairing.exp } : null,
      lastError: this.lastError,
      seq: this.seq,
    };
  }

  async setEnabled(on: boolean): Promise<HubStatus> {
    await this.load();
    this.enabled = on;
    if (on) await this.start();
    else await this.stop();
    await this.saveNow();
    return this.status();
  }

  /** Start listening if the user enabled the link (called once at app start). */
  async startIfEnabled(): Promise<void> {
    await this.load();
    if (this.enabled) await this.start();
  }

  async start(host = '0.0.0.0'): Promise<void> {
    if (this.server?.listening) return;
    this.lastError = '';
    const server = http.createServer((req, res) => void this.handleHttp(req, res));
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      if (!req.url?.startsWith('/jini/live')) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.handleLive(ws));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, host, () => {
        server.off('error', reject);
        resolve();
      });
    }).catch((e: unknown) => {
      this.lastError = `Could not listen on port ${this.port}: ${e instanceof Error ? e.message : String(e)}`;
      throw new Error(this.lastError);
    });
    this.server = server;
    this.wss = wss;
  }

  async stop(): Promise<void> {
    this.pairing = null;
    for (const set of this.sockets.values()) for (const s of set) s.close(1001, 'link disabled');
    this.sockets.clear();
    this.wss?.close();
    this.wss = null;
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  /** Bound port (useful when started on port 0 in tests). */
  boundPort(): number {
    const a = this.server?.address();
    return a && typeof a === 'object' ? a.port : this.port;
  }

  setPortForTests(port: number): void {
    this.port = port;
  }

  // ---------- pairing ----------

  async startPairing(): Promise<{ offer: string; exp: number }> {
    await this.load();
    if (!this.server?.listening) throw new Error('Turn on "Allow phone connections" first.');
    const keyPair = await generateLinkKeyPair();
    const p: Pairing = {
      id: randomB64u(9),
      secret: randomB64u(32),
      keyPair,
      pub: await exportPublicKey(keyPair),
      exp: Date.now() + PAIRING_TTL_MS,
      used: false,
      failures: 0,
    };
    this.pairing = p;
    const offer = encodeOffer({
      v: LINK_VERSION,
      id: p.id,
      secret: p.secret,
      pub: p.pub,
      hosts: lanHosts(),
      port: this.boundPort(),
      exp: p.exp,
      name: this.deps.desktopName,
    });
    // Sanity: the offer must round-trip through the same decoder the phone uses.
    decodeOffer(offer);
    return { offer, exp: p.exp };
  }

  cancelPairing(): void {
    this.pairing = null;
  }

  async handlePair(body: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    const p = this.pairing;
    const id = String(body.id ?? '');
    const devicePub = String(body.devicePub ?? '');
    const proof = String(body.proof ?? '');
    if (!p || p.used || p.exp <= Date.now() || !safeEqual(id, p.id)) return { status: 410, json: { error: 'This pairing code has expired. Show a new one on the desktop.' } };
    const expected = await hmacB64u(p.secret, pairingProofInput(p.id, devicePub));
    if (!devicePub || !safeEqual(proof, expected)) {
      p.failures += 1;
      if (p.failures >= 5) this.pairing = null;
      return { status: 403, json: { error: 'Pairing proof rejected.' } };
    }
    p.used = true;
    this.pairing = null;
    let linkSecret: string;
    try {
      linkSecret = await deriveLinkSecret(p.keyPair.privateKey, devicePub, p.secret);
    } catch {
      return { status: 400, json: { error: 'Invalid device key.' } };
    }
    const deviceId = `dev_${randomB64u(12)}`;
    const now = Date.now();
    const rec: DeviceRecord = {
      id: deviceId,
      name: String(body.name ?? 'Phone').replace(/[^\p{L}\p{N} '._-]/gu, '').slice(0, 40) || 'Phone',
      platform: String(body.platform ?? 'unknown').slice(0, 16),
      ...this.storeSecret(linkSecret),
      createdAt: now,
      lastSeen: now,
      hwm: 0,
    };
    this.devices.set(deviceId, rec);
    await this.saveNow();
    const key = await importLinkSecret(linkSecret);
    this.keys.set(deviceId, { cur: key });
    const confirm = await seal(key, deviceId, 'd2c', { ts: now, ctr: this.counterFor(deviceId)(), body: { ok: true, desktop: this.deps.desktopName } });
    this.deps.onSecurityEvent?.(`New device paired: "${rec.name}" (${rec.platform}).`);
    this.append('notice', { text: `Paired ${rec.name}` });
    return { status: 200, json: { deviceId, confirm } };
  }

  // ---------- requests ----------

  /** Open + authenticate one sealed request from a device. */
  private async authenticate(deviceId: string, env: Envelope): Promise<{ d: DeviceRecord; body: unknown; usedPrev: boolean } | { error: string; status: number }> {
    const d = this.devices.get(deviceId);
    if (!d) return { error: 'unknown device', status: 401 };
    this.expireIdleDevices();
    if (d.revokedAt) return { error: `device revoked: ${d.revokeReason ?? ''}`, status: 401 };
    const k = await this.keysFor(d);
    let opened: { ts: number; ctr: number; body: unknown } | null = null;
    let usedPrev = false;
    try {
      opened = await open(k.cur, d.id, 'c2d', env);
    } catch {
      if (k.prev) {
        try {
          opened = await open(k.prev, d.id, 'c2d', env);
          usedPrev = true;
        } catch {
          opened = null;
        }
      }
    }
    if (!opened) return { error: 'authentication failed', status: 401 };
    const why = this.guardFor(d).check(opened);
    if (why) return { error: why, status: 409 };
    if (!usedPrev && d.prevSecret) {
      // The phone is using the rotated secret: retire the old one.
      delete d.prevSecret;
      this.keys.delete(d.id);
    }
    d.lastSeen = Date.now();
    this.scheduleSave();
    return { d, body: opened.body, usedPrev };
  }

  async handleRpc(raw: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    const deviceId = String(raw.d ?? '');
    const auth = await this.authenticate(deviceId, { n: String(raw.n ?? ''), c: String(raw.c ?? '') });
    if ('error' in auth) return { status: auth.status, json: { error: auth.error } };
    const { d, usedPrev } = auth;
    const req = auth.body as RpcRequest;
    // Reply with the key the request came in on — captured BEFORE dispatch, because
    // device.rotate replaces the current key and the phone cannot read the new one yet.
    const keys = await this.keysFor(d);
    const replyKey = usedPrev && keys.prev ? keys.prev : keys.cur;
    const resp = await this.dispatch(d, req);
    const env = await seal(replyKey, d.id, 'd2c', { ts: Date.now(), ctr: this.counterFor(d.id)(), body: resp });
    return { status: 200, json: env };
  }

  private async dispatch(d: DeviceRecord, req: RpcRequest): Promise<RpcResponse> {
    if (!req || typeof req.op !== 'string') return { ok: false, error: 'malformed request' };
    const cmdId = typeof req.cmdId === 'string' && req.cmdId.length <= 64 ? req.cmdId : '';
    const cache = this.idem.get(d.id) ?? new Map<string, RpcResponse>();
    this.idem.set(d.id, cache);
    if (cmdId && cache.has(cmdId)) return cache.get(cmdId)!;
    const args = req.args && typeof req.args === 'object' ? req.args : {};
    let resp: RpcResponse;
    try {
      resp = { ok: true, result: await this.runOp(d, req.op, args) };
    } catch (e) {
      resp = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (cmdId) {
      cache.set(cmdId, resp);
      if (cache.size > 300) cache.delete(cache.keys().next().value as string);
    }
    return resp;
  }

  private async runOp(d: DeviceRecord, op: string, args: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'hello':
        return { desktop: this.deps.desktopName, deviceId: d.id, seq: this.seq, ops: Object.keys(this.deps.ops) };
      case 'sync': {
        const since = Math.max(0, Number(args.since) || 0);
        // A cursor older than the retained window cannot be served incrementally.
        const oldest = this.events[0]?.seq ?? this.seq + 1;
        const gap = since > 0 && since < oldest - 1;
        const page = this.events.filter((e) => e.seq > since).slice(0, SYNC_PAGE);
        const last = page.length ? page[page.length - 1].seq : Math.max(since, this.seq);
        return { events: page, seq: last, latest: this.seq, more: last < this.seq, gap };
      }
      case 'devices.list':
        return this.listDevices();
      case 'device.rotate': {
        const pub = String(args.pub ?? '');
        const salt = randomB64u(32);
        const kp = await generateLinkKeyPair();
        const next = await deriveLinkSecret(kp.privateKey, pub, salt);
        d.prevSecret = d.secret; // stays valid until the phone first uses the new secret
        Object.assign(d, this.storeSecret(next));
        d.rotatedAt = Date.now();
        this.keys.delete(d.id);
        await this.saveNow();
        return { pub: await exportPublicKey(kp), salt };
      }
      default: {
        const h = this.deps.ops[op];
        if (!h) throw new Error(`unsupported operation "${op}"`);
        return h(args, { deviceId: d.id, deviceName: d.name });
      }
    }
  }

  // ---------- events ----------

  /** Append a sync event and hint every connected device that new data is available. */
  append(type: LinkEvent['type'], data: Record<string, unknown>): LinkEvent {
    const e: LinkEvent = { seq: ++this.seq, at: Date.now(), type, data };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.scheduleSave();
    void this.hintAll(e.seq);
    return e;
  }

  private async hintAll(seq: number): Promise<void> {
    for (const [id, set] of this.sockets) {
      const d = this.devices.get(id);
      if (!d || d.revokedAt || !set.size) continue;
      try {
        const k = await this.keysFor(d);
        const env = await seal(k.cur, id, 'd2c', { ts: Date.now(), ctr: this.counterFor(id)(), body: { seq } });
        const msg = JSON.stringify(env);
        for (const s of set) if (s.readyState === s.OPEN) s.send(msg);
      } catch {
        /* a broken socket is cleaned up by its close handler */
      }
    }
  }

  /** Live channel: the first message must be a sealed {op:'live'} from a known device within 5 s. */
  private handleLive(ws: WebSocket): void {
    const timer = setTimeout(() => ws.close(4408, 'auth timeout'), 5000);
    ws.once('message', async (raw) => {
      clearTimeout(timer);
      try {
        const msg = JSON.parse(String(raw)) as { d?: string; n?: string; c?: string };
        const auth = await this.authenticate(String(msg.d ?? ''), { n: String(msg.n ?? ''), c: String(msg.c ?? '') });
        if ('error' in auth || (auth.body as RpcRequest)?.op !== 'live') {
          ws.close(4401, 'unauthorized');
          return;
        }
        const id = auth.d.id;
        const set = this.sockets.get(id) ?? new Set<WebSocket>();
        set.add(ws);
        this.sockets.set(id, set);
        ws.on('close', () => set.delete(ws));
        ws.on('message', () => undefined); // the live channel is one-way (desktop → phone hints)
        void this.hintAll(this.seq);
      } catch {
        ws.close(4400, 'bad request');
      }
    });
  }

  // ---------- HTTP ----------

  private tooManyFailures(ip: string): boolean {
    const f = this.failuresByIp.get(ip);
    if (!f) return false;
    if (Date.now() - f.since > 60_000) {
      this.failuresByIp.delete(ip);
      return false;
    }
    return f.n >= 30;
  }

  private noteFailure(ip: string): void {
    const f = this.failuresByIp.get(ip);
    if (!f || Date.now() - f.since > 60_000) this.failuresByIp.set(ip, { n: 1, since: Date.now() });
    else f.n += 1;
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? '?';
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(json));
    };
    try {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/jini/hello') return send(200, { app: 'jini', v: LINK_VERSION });
      if (req.method !== 'POST' || (url !== '/jini/pair' && url !== '/jini/rpc')) return send(404, { error: 'not found' });
      if (this.tooManyFailures(ip)) return send(429, { error: 'too many failed requests; wait a minute' });
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY) return send(413, { error: 'request too large' });
        chunks.push(chunk as Buffer);
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        return send(400, { error: 'invalid JSON' });
      }
      const out = url === '/jini/pair' ? await this.handlePair(body) : await this.handleRpc(body);
      if (out.status >= 400) this.noteFailure(ip);
      return send(out.status, out.json);
    } catch (e) {
      console.error('[jini-link] request failed:', e);
      return send(500, { error: 'internal error' });
    }
  }
}
