/**
 * Phone side of the JINI device link. Speaks the SAME protocol module as the desktop (@link).
 *
 * Battery rules: no polling. While the app is in the foreground it holds one live WebSocket that
 * only carries "new data at seq N" hints; data is pulled incrementally from the cursor. When the
 * app goes to the background the socket closes and nothing runs until the user returns.
 */
import {
  decodeOffer,
  deriveLinkSecret,
  exportPublicKey,
  generateLinkKeyPair,
  hmacB64u,
  importLinkSecret,
  makeCounter,
  open,
  pairingProofInput,
  seal,
  type Envelope,
  type LinkEvent,
  type LinkKey,
  type RpcResponse,
} from '@link';
import { getState, setState, toast, uid, type ApprovalView, type ChatMessage, type LinkState, type MemoryView, type TaskView } from './store';

const counter = makeCounter();
let key: LinkKey | null = null;
let keyFor = '';
let socket: WebSocket | null = null;
let foreground = true;
let reconnectTries = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let syncing: Promise<void> | null = null;

export class OfflineError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new OfflineError('The desktop did not answer in time.')), ms))]);
}

async function linkKey(l: LinkState): Promise<LinkKey> {
  if (!key || keyFor !== l.secret) {
    key = await importLinkSecret(l.secret);
    keyFor = l.secret;
  }
  return key;
}

const base = (host: string, port: number) => `http://${host}:${port}`;

/** Find a reachable desktop address (the last good one first). */
async function reachableHost(l: LinkState): Promise<string> {
  const candidates = [l.host, ...l.hosts.filter((h) => h !== l.host)].filter(Boolean);
  for (const h of candidates) {
    try {
      const res = await withTimeout(fetch(`${base(h, l.port)}/jini/hello`), 2500);
      if (res.ok) {
        if (h !== l.host) setState({ link: { ...l, host: h } });
        return h;
      }
    } catch {
      /* try the next address */
    }
  }
  throw new OfflineError('Desktop JINI is not reachable on this network.');
}

// ---------------- pairing ----------------

export async function pairWithOffer(offerText: string, deviceName: string, platform: string): Promise<void> {
  const o = decodeOffer(offerText);
  if (o.exp < Date.now()) throw new Error('This pairing code has expired. Show a new one on the desktop.');
  const kp = await generateLinkKeyPair();
  const devicePub = await exportPublicKey(kp);
  const proof = await hmacB64u(o.secret, pairingProofInput(o.id, devicePub));
  let lastErr = 'Could not reach the desktop. Make sure the phone is on the same Wi-Fi network.';
  for (const host of o.hosts) {
    let res: Response;
    try {
      res = await withTimeout(
        fetch(`${base(host, o.port)}/jini/pair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: o.id, devicePub, proof, name: deviceName, platform }),
        }),
        6000
      );
    } catch {
      continue;
    }
    const json = (await res.json()) as { deviceId?: string; confirm?: Envelope; error?: string };
    if (!res.ok || !json.deviceId || !json.confirm) {
      lastErr = json.error ?? `Pairing failed (HTTP ${res.status}).`;
      break; // the desktop answered: another address will not change its answer
    }
    const secret = await deriveLinkSecret(kp.privateKey, o.pub, o.secret);
    const k = await importLinkSecret(secret);
    await open(k, json.deviceId, 'd2c', json.confirm); // proves both sides hold the same key
    key = k;
    keyFor = secret;
    setState({
      link: { deviceId: json.deviceId, secret, desktopName: o.name, hosts: o.hosts, port: o.port, host, pairedAt: Date.now() },
      cursor: 0,
      connection: 'online',
      messages: [],
      tasks: [],
      approvals: [],
      outbox: [],
    });
    void connect();
    return;
  }
  throw new Error(lastErr);
}

export function unpair(): void {
  socket?.close();
  socket = null;
  key = null;
  setState({ link: null, connection: 'unpaired', cursor: 0, tasks: [], approvals: [], outbox: [] });
}

// ---------------- RPC ----------------

export async function rpc<T = unknown>(op: string, args: Record<string, unknown> = {}, cmdId?: string): Promise<T> {
  const l = getState().link;
  if (!l || l.revoked) throw new Error('This phone is not paired with a desktop.');
  const host = getState().connection === 'online' ? l.host : await reachableHost(l);
  const k = await linkKey(l);
  const env = await seal(k, l.deviceId, 'c2d', { ts: Date.now(), ctr: counter(), body: { op, args, cmdId } });
  let res: Response;
  try {
    res = await withTimeout(
      fetch(`${base(host, l.port)}/jini/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ d: l.deviceId, ...env }) }),
      15000
    );
  } catch (e) {
    setState({ connection: 'offline' });
    throw e instanceof OfflineError ? e : new OfflineError('Desktop JINI is not reachable.');
  }
  const json = (await res.json()) as Envelope & { error?: string };
  if (res.status === 401 && /revoked|unknown device/.test(json.error ?? '')) {
    setState({ link: { ...l, revoked: json.error }, connection: 'unpaired' });
    throw new Error('This phone was revoked on the desktop. Pair again.');
  }
  if (!res.ok) throw new Error(json.error ?? `Request failed (HTTP ${res.status}).`);
  const out = await open<RpcResponse>(k, l.deviceId, 'd2c', json);
  if (!out.body.ok) throw new Error(out.body.error ?? 'The desktop refused the request.');
  return out.body.result as T;
}

// ---------------- sync ----------------

function applyEvent(e: LinkEvent): void {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case 'chat': {
      const threadId = String(d.threadId ?? '');
      if (!threadId) return;
      setState((s) => {
        const msgs = s.messages.slice();
        const user = msgs.find((m) => m.id === threadId);
        if (user && (user.state === 'queued' || user.state === 'sending')) user.state = 'done';
        const replyId = `r_${threadId}`;
        const reply: ChatMessage = msgs.find((m) => m.id === replyId) ?? {
          id: replyId,
          role: 'jini',
          text: '',
          at: e.at,
          kind: d.kind === 'task' ? 'task' : 'chat',
          state: 'running',
          via: 'desktop',
          replyTo: threadId,
        };
        if (d.state === 'done') {
          reply.state = 'done';
          reply.text = String(d.reply ?? '');
        } else if (d.state === 'failed') {
          reply.state = 'failed';
          reply.text = String(d.error ?? 'The desktop could not complete this.');
        } else reply.state = 'running';
        reply.at = e.at;
        if (!msgs.includes(reply)) msgs.push(reply);
        return { messages: msgs.map((m) => ({ ...m })) };
      });
      return;
    }
    case 'tasks':
      setState({ tasks: (d.tasks as TaskView[]) ?? [] });
      return;
    case 'approval':
      setState((s) => ({ approvals: [...s.approvals.filter((a) => a.id !== d.id), d as unknown as ApprovalView] }));
      if (!foreground) return;
      toast(`Approval needed: ${String(d.action ?? '')} on ${String(d.origin ?? '')}`);
      return;
    case 'approval-resolved':
      setState((s) => ({ approvals: s.approvals.filter((a) => a.id !== d.id) }));
      return;
    case 'memory':
      void refreshMemories();
      return;
    case 'notice':
      if (d.text) toast(String(d.text));
      return;
  }
}

/** Pull every event after the cursor (incremental), then flush queued commands. */
export function sync(): Promise<void> {
  syncing ??= (async () => {
    try {
      for (let guard = 0; guard < 20; guard++) {
        const r = await rpc<{ events: LinkEvent[]; seq: number; more: boolean; gap: boolean }>('sync', { since: getState().cursor });
        if (r.gap) await fullRefresh();
        for (const e of r.events) applyEvent(e);
        setState({ cursor: r.seq, lastSync: Date.now(), connection: 'online' });
        if (!r.more) break;
      }
      await flushOutbox();
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

export async function fullRefresh(): Promise<void> {
  const [tasks, approvals] = await Promise.all([rpc<TaskView[]>('tasks.list'), rpc<Array<{ id: string; requestExpiresAt: number; intent: Record<string, string> }>>('approvals.list')]);
  setState({
    tasks,
    approvals: approvals.map((a) => ({
      id: a.id,
      tool: a.intent.tool,
      action: a.intent.action,
      origin: a.intent.origin,
      target: a.intent.targetLabel,
      effect: a.intent.effect,
      expiresAt: a.requestExpiresAt,
    })),
  });
  await refreshMemories();
}

export async function refreshMemories(): Promise<void> {
  try {
    const list = await rpc<MemoryView[]>('memory.list');
    setState({ memories: list.sort((a, b) => b.updated - a.updated) });
  } catch {
    /* keep the cached copy */
  }
}

// ---------------- outbox (offline queue, idempotent) ----------------

export function enqueue(op: string, args: Record<string, unknown>, cmdId = uid('cmd')): string {
  setState((s) => ({ outbox: [...s.outbox, { cmdId, op, args, createdAt: Date.now() }] }));
  void flushOutbox().catch(() => undefined);
  return cmdId;
}

let flushing = false;
export async function flushOutbox(): Promise<void> {
  if (flushing || !getState().link) return;
  flushing = true;
  try {
    for (const item of getState().outbox) {
      try {
        if (item.op === 'chat' || item.op === 'task.send') markMessage(String(item.args.threadId ?? ''), 'sending');
        await rpc(item.op, item.args, item.cmdId);
        setState((s) => ({ outbox: s.outbox.filter((o) => o.cmdId !== item.cmdId) }));
        if (item.op === 'chat' || item.op === 'task.send') markMessage(String(item.args.threadId ?? ''), 'done');
      } catch (e) {
        if (e instanceof OfflineError) {
          if (item.op === 'chat' || item.op === 'task.send') markMessage(String(item.args.threadId ?? ''), 'queued');
          break; // keep it (and everything after it) queued; retried on reconnect
        }
        // The desktop answered with a refusal: drop it from the queue and surface the reason.
        setState((s) => ({ outbox: s.outbox.filter((o) => o.cmdId !== item.cmdId) }));
        if (item.op === 'chat' || item.op === 'task.send') markMessage(String(item.args.threadId ?? ''), 'failed');
        toast(e instanceof Error ? e.message : String(e));
      }
    }
  } finally {
    flushing = false;
  }
}

function markMessage(id: string, st: ChatMessage['state']): void {
  if (!id) return;
  setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, state: st } : m)) }));
}

// ---------------- live channel (foreground only) ----------------

export async function connect(): Promise<void> {
  const l = getState().link;
  if (!l || l.revoked || !foreground) return;
  if (socket && socket.readyState <= 1) return;
  setState({ connection: 'connecting' });
  let host: string;
  try {
    host = await reachableHost(l);
  } catch {
    setState({ connection: 'offline' });
    scheduleReconnect();
    return;
  }
  const k = await linkKey(l);
  const ws = new WebSocket(`ws://${host}:${l.port}/jini/live`);
  socket = ws;
  ws.onopen = async () => {
    const env = await seal(k, l.deviceId, 'c2d', { ts: Date.now(), ctr: counter(), body: { op: 'live' } });
    ws.send(JSON.stringify({ d: l.deviceId, ...env }));
    reconnectTries = 0;
    setState({ connection: 'online' });
    void sync()
      .then(() => (getState().lastSync && getState().tasks.length === 0 ? fullRefresh() : undefined))
      .catch(() => undefined);
  };
  ws.onmessage = async (ev) => {
    try {
      const p = await open<{ seq: number }>(k, l.deviceId, 'd2c', JSON.parse(String(ev.data)) as Envelope);
      if (p.body.seq > getState().cursor) void sync().catch(() => undefined);
    } catch {
      /* ignore anything that does not authenticate */
    }
  };
  ws.onclose = (ev) => {
    if (socket === ws) socket = null;
    if (ev.code === 4401) {
      setState({ connection: 'unpaired', link: { ...l, revoked: 'revoked on the desktop' } });
      return;
    }
    setState({ connection: 'offline' });
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (!foreground || reconnectTimer || reconnectTries >= 6) return;
  const delay = Math.min(30_000, 2000 * 2 ** reconnectTries++);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, delay);
}

/** App lifecycle: connect while visible, release everything in the background. */
export function setForeground(on: boolean): void {
  foreground = on;
  if (on) {
    reconnectTries = 0;
    void connect();
  } else {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    socket?.close(1000, 'background');
    socket = null;
    if (getState().link) setState({ connection: 'offline' });
  }
}

/** Manual "try again" from the UI. */
export function retryNow(): void {
  reconnectTries = 0;
  void connect();
}

/** Credential rotation: agree a fresh link secret under the current one. */
export async function rotateKey(): Promise<void> {
  const l = getState().link;
  if (!l) throw new Error('Not paired.');
  const kp = await generateLinkKeyPair();
  const r = await rpc<{ pub: string; salt: string }>('device.rotate', { pub: await exportPublicKey(kp) });
  const secret = await deriveLinkSecret(kp.privateKey, r.pub, r.salt);
  setState({ link: { ...l, secret } });
  // First use of the new key retires the old one on the desktop.
  await rpc('ping');
}
