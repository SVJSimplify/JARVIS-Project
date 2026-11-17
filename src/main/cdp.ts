import * as http from 'http';
import WebSocket from 'ws';

/**
 * MINIMAL CHROME DEVTOOLS PROTOCOL (CDP) CLIENT (Round 28, Phase 2).
 *
 * The transport layer for native-browser control: JARVIS speaks the SAME protocol the
 * browser itself exposes, so it can operate the user's real installed Chrome/Edge/
 * Chromium instead of a bundled imitation. Two layers:
 *
 *   - HTTP discovery endpoints (/json/version, /json/list) — used to verify and enumerate
 *     an existing browser before any WebSocket is opened.
 *   - One browser-level WebSocket with FLATTENED sessions (Target.attachToTarget), the
 *     protocol Chrome itself documents for automation clients.
 *
 * SECURITY RULES THIS MODULE ENFORCES (Phase 2 §2.7):
 *   - The DevTools endpoint is reached on 127.0.0.1 ONLY — the debugging interface is a
 *     local control surface, never a network one. A non-loopback host is refused outright.
 *   - Every request and command is bounded by a timeout; a hung browser cannot wedge the
 *     engine.
 *   - A closed socket rejects every pending command and fires onDisconnect exactly once,
 *     so the session layer can reconcile honestly instead of half-acting.
 *
 * This module is pure protocol: no Electron, no profile management, no policy — those
 * live in nativeBrowser.ts.
 */

const HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;

/** The ONLY hosts JARVIS will ever talk CDP to. */
const isLoopbackHost = (host: string): boolean => host === '127.0.0.1' || host === 'localhost' || host === '[::1]';

export interface CdpVersionInfo {
  browser: string;
  protocolVersion: string;
  /** WebSocket URL of the browser-level endpoint. */
  webSocketDebuggerUrl: string;
}

export interface CdpTargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  attached: boolean;
}

/** GET http://127.0.0.1:<port>/<path> → parsed JSON (bounded, loopback-only). */
export function cdpHttpGet<T>(port: number, path: string, timeoutMs = HTTP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      reject(new Error(`invalid DevTools port ${port}`));
      return;
    }
    const req = http.request(
      { host: '127.0.0.1', port, path: `/${path.replace(/^\/+/, '')}`, method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            reject(new Error(`DevTools endpoint /${path} returned HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (e) {
            reject(new Error(`DevTools endpoint /${path} returned non-JSON body: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error(`DevTools endpoint /${path} timed out after ${timeoutMs}ms`));
    });
    req.on('error', (e) => reject(new Error(`DevTools endpoint /${path} unreachable: ${e.message}`)));
    req.end();
  });
}

/** Verify a debugging endpoint is alive and Chromium-shaped. Loopback ONLY. */
export async function cdpVersion(port: number): Promise<CdpVersionInfo> {
  const raw = await cdpHttpGet<Record<string, string>>(port, 'json/version');
  if (!raw?.Browser || !raw?.webSocketDebuggerUrl) throw new Error(`the endpoint on port ${port} did not answer as a Chromium DevTools endpoint`);
  // never connect to a non-loopback debugger URL even if the endpoint advertised one
  const wsUrl = new URL(raw.webSocketDebuggerUrl);
  if (!isLoopbackHost(wsUrl.hostname)) throw new Error(`refusing non-loopback DevTools endpoint (${wsUrl.hostname}) — the debugging interface must never be a network surface`);
  return { browser: String(raw.Browser), protocolVersion: String(raw['Protocol-Version'] ?? ''), webSocketDebuggerUrl: raw.webSocketDebuggerUrl };
}

/** Enumerate the page targets of a running browser. */
export async function cdpListTargets(port: number): Promise<CdpTargetInfo[]> {
  const raw = await cdpHttpGet<Array<Record<string, unknown>>>(port, 'json/list');
  return (Array.isArray(raw) ? raw : [])
    .filter((t) => typeof t.id === 'string')
    .map((t) => ({
      targetId: String(t.id),
      type: String(t.type ?? ''),
      url: String(t.url ?? ''),
      title: String(t.title ?? ''),
      attached: t.attached === true,
    }));
}

// ------------------------------------------------------------------ WebSocket protocol

type CdpEvent = { method: string; params?: Record<string, unknown>; sessionId?: string };

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export class CdpError extends Error {
  constructor(message: string, readonly method: string, readonly code?: number) {
    super(message);
    this.name = 'CdpError';
  }
}

/**
 * One browser-level CDP connection. A connection is created per attach/launch and owns
 * exactly one WebSocket; sessions are flattened multiplexed channels over it. All I/O is
 * bounded; connection loss is surfaced once through onDisconnect.
 */
export class CdpConnection {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private eventHandlers = new Set<(e: CdpEvent) => void>();
  private closed = false;
  readonly browserInfo: CdpVersionInfo;

  /** Fired EXACTLY ONCE when the socket dies (browser exit, crash, port gone). */
  readonly onDisconnect: Promise<string>;
  /** Resolves when the WebSocket reaches OPEN (or rejects if it dies while connecting). */
  readonly whenOpen: Promise<void>;

  constructor(wsUrl: string, browserInfo: CdpVersionInfo, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
    this.browserInfo = browserInfo;
    let settledDisconnect = false;
    this.onDisconnect = new Promise<string>((resolve) => {
      // resolution deferred to the close/error handlers below
      (this as { resolveDisconnect?: (why: string) => void }).resolveDisconnect = (why: string) => {
        if (!settledDisconnect) {
          settledDisconnect = true;
          resolve(why);
        }
      };
    });
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    const connectTimer = setTimeout(() => {
      try {
        this.ws.terminate();
      } catch {
        /* already gone */
      }
      this.failAll(new CdpError(`connecting to the browser's debugging socket timed out after ${connectTimeoutMs}ms`, 'connect'));
    }, connectTimeoutMs);

    this.whenOpen = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => {
        clearTimeout(connectTimer);
        resolve();
      });
      this.ws.once('error', (e) => reject(new CdpError(`the debugging socket could not be opened: ${e.message}`, 'connect')));
    });
    this.ws.on('open', () => clearTimeout(connectTimer));
    this.ws.on('message', (data: WebSocket.RawData) => {
      let msg: { id?: number; result?: Record<string, unknown>; error?: { message?: string; code?: number }; method?: string; params?: Record<string, unknown>; sessionId?: string };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return; // a malformed frame is dropped, not fatal
      }
      if (typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new CdpError(msg.error.message ?? 'CDP error', p.method, msg.error.code));
        else p.resolve(msg.result ?? {});
      } else if (typeof msg.method === 'string') {
        const e: CdpEvent = { method: msg.method, params: msg.params, sessionId: msg.sessionId };
        for (const h of this.eventHandlers) {
          try {
            h(e);
          } catch {
            /* a listener must never break the pump */
          }
        }
      }
    });
    const gone = (why: string) => {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(connectTimer);
      this.failAll(new CdpError(`the browser connection was lost (${why})`, 'connection'));
      (this as { resolveDisconnect?: (why: string) => void }).resolveDisconnect?.(why);
    };
    this.ws.on('close', () => gone('socket closed'));
    this.ws.on('error', (e) => gone(e.message || 'socket error'));
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  get isConnected(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  /** Subscribe to CDP events (browser-level and session-level, unfiltered). */
  onEvent(h: (e: CdpEvent) => void): () => void {
    this.eventHandlers.add(h);
    return () => this.eventHandlers.delete(h);
  }

  /** Send one command (browser-level, or session-level when sessionId given). Bounded. */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (!this.isConnected) return Promise.reject(new CdpError(`no live browser connection (the browser was closed or detached)`, method));
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`${method} timed out after ${timeoutMs}ms`, method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify(payload), (err) => {
          if (err) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(new CdpError(`${method} could not be sent: ${err.message}`, method));
          }
        });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new CdpError(`${method} could not be sent: ${e instanceof Error ? e.message : String(e)}`, method));
      }
    });
  }

  /** Enumerate targets through the live connection (fresher than the HTTP list). */
  async getTargets(): Promise<CdpTargetInfo[]> {
    const res = await this.send('Target.getTargets');
    const infos = (res.targetInfos ?? []) as Array<Record<string, unknown>>;
    return infos.map((t) => ({
      targetId: String(t.targetId ?? ''),
      type: String(t.type ?? ''),
      url: String(t.url ?? ''),
      title: String(t.title ?? ''),
      attached: t.attached === true,
    }));
  }

  /** Create a tab. `background: true` NEVER activates it — the core of no-focus-stealing. */
  async createTarget(url: string, opts: { background?: boolean } = {}): Promise<string> {
    const res = await this.send('Target.createTarget', { url, newWindow: false, background: opts.background !== false });
    return String(res.targetId);
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.send('Target.closeTarget', { targetId });
  }

  /** Bring a tab to the FRONT — only ever called for an explicit user-requested activation. */
  async activateTarget(targetId: string): Promise<void> {
    await this.send('Target.activateTarget', { targetId });
  }

  /** Attach a flattened session to a target. */
  async attach(targetId: string): Promise<CdpSession> {
    const res = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return new CdpSession(this, String(res.sessionId), targetId);
  }

  async detach(session: CdpSession): Promise<void> {
    if (!this.isConnected) return;
    await this.send('Target.detachFromTarget', { sessionId: session.sessionId }).catch(() => undefined);
  }

  /** Ask the browser to close itself (Mode B shutdown); resolves even if already gone. */
  async closeBrowser(): Promise<void> {
    try {
      await this.send('Browser.close', {}, undefined, 4000);
    } catch {
      /* the browser may already be gone — closing is idempotent */
    }
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }

  /** Close the JARVIS-side socket without touching the browser process (Mode A disconnect). */
  disconnect(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    this.closed = true;
    this.failAll(new CdpError('the connection was closed by JARVIS', 'connection'));
  }
}

/** One attached page/session: command channel + bounded event waiting. */
export class CdpSession {
  constructor(private conn: CdpConnection, readonly sessionId: string, readonly targetId: string) {}

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
    return this.conn.send(method, params, this.sessionId, timeoutMs);
  }

  /** Wait for one occurrence of an event on THIS session (bounded; '' events resolve null). */
  waitEvent(method: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      let done = false;
      const off = this.conn.onEvent((e) => {
        if (done || e.method !== method || e.sessionId !== this.sessionId) return;
        done = true;
        clearTimeout(timer);
        off();
        resolve(e.params ?? {});
      });
      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          off();
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  /** Evaluate an expression in the page; returns the JSON value (returnByValue) or throws. */
  async evaluate<T>(expression: string, timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<T> {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    const r = res.result as { type?: string; value?: unknown; subtype?: string; description?: string } | undefined;
    if (!r || r.subtype === 'error') throw new CdpError(`page evaluation failed: ${String(r?.description ?? 'no result')}`, 'Runtime.evaluate');
    return (r.value ?? null) as T;
  }

  async navigate(url: string, timeoutMs = 30_000): Promise<{ waitForLoadMs: number }> {
    const started = Date.now();
    const loadPromise = this.waitEvent('Page.loadEventFired', timeoutMs);
    await this.send('Page.navigate', { url }, timeoutMs);
    await loadPromise; // null on timeout — the caller decides what an unsettled load means
    return { waitForLoadMs: Date.now() - started };
  }

  async captureScreenshot(format: 'png' | 'jpeg' = 'png', quality = 80, timeoutMs = 12_000): Promise<Buffer> {
    const res = await this.send('Page.captureScreenshot', format === 'jpeg' ? { format, quality } : { format }, timeoutMs);
    return Buffer.from(String(res.data ?? ''), 'base64');
  }
}
