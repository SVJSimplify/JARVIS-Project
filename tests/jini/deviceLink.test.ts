import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { DeviceHub } from '../../src/main/devices/deviceHub';
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
  type LinkKey,
  type RpcResponse,
} from '../../src/main/devices/link';

/** A minimal phone client written only against the shared protocol (what the mobile app does). */
async function pairPhone(hub: DeviceHub, port: number, tamperProof = false) {
  const { offer } = await hub.startPairing();
  const o = decodeOffer(offer);
  const kp = await generateLinkKeyPair();
  const devicePub = await exportPublicKey(kp);
  let proof = await hmacB64u(o.secret, pairingProofInput(o.id, devicePub));
  if (tamperProof) proof = proof.slice(0, -2) + (proof.endsWith('AA') ? 'BB' : 'AA');
  const res = await fetch(`http://127.0.0.1:${port}/jini/pair`, {
    method: 'POST',
    body: JSON.stringify({ id: o.id, devicePub, proof, name: 'Test Phone', platform: 'android' }),
  });
  const json = (await res.json()) as { deviceId?: string; confirm?: Envelope; error?: string };
  if (!res.ok) return { status: res.status, error: json.error, offer: o };
  const secret = await deriveLinkSecret(kp.privateKey, o.pub, o.secret);
  const key = await importLinkSecret(secret);
  const confirm = await open<{ ok: boolean }>(key, json.deviceId!, 'd2c', json.confirm!);
  return { status: res.status, deviceId: json.deviceId!, key, confirm: confirm.body, offer: o };
}

async function rpc(port: number, deviceId: string, key: LinkKey, ctr: () => number, op: string, args: Record<string, unknown> = {}, cmdId?: string) {
  const env = await seal(key, deviceId, 'c2d', { ts: Date.now(), ctr: ctr(), body: { op, args, cmdId } });
  const res = await fetch(`http://127.0.0.1:${port}/jini/rpc`, { method: 'POST', body: JSON.stringify({ d: deviceId, ...env }) });
  const json = (await res.json()) as Envelope & { error?: string };
  if (!res.ok) return { status: res.status, error: json.error, env };
  const opened = await open<RpcResponse>(key, deviceId, 'd2c', json);
  return { status: res.status, resp: opened.body, env };
}

describe('JINI device link (desktop hub + shared protocol, real HTTP)', () => {
  let dir: string;
  let hub: DeviceHub;
  let port: number;
  let calls: string[];

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'jini-link-'));
    calls = [];
    hub = new DeviceHub({
      dataDir: dir,
      desktopName: 'JINI test desktop',
      cipher: null,
      ops: {
        echo: (args) => ({ echoed: args.v }),
        count: () => {
          calls.push('count');
          return calls.length;
        },
      },
    });
    await hub.load();
    hub.setPortForTests(0);
    await hub.start('127.0.0.1');
    port = hub.boundPort();
  });

  afterEach(async () => {
    await hub.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('pairs with a single-use QR offer and confirms both sides derived the same key', async () => {
    const p = await pairPhone(hub, port);
    expect(p.status).toBe(200);
    expect(p.confirm).toEqual({ ok: true, desktop: 'JINI test desktop' });
    expect(hub.listDevices()).toHaveLength(1);
    // The same offer cannot be used twice.
    const again = await fetch(`http://127.0.0.1:${port}/jini/pair`, { method: 'POST', body: JSON.stringify({ id: p.offer.id, devicePub: 'x', proof: 'y' }) });
    expect(again.status).toBe(410);
  });

  it('rejects a wrong pairing proof and kills the offer after 5 failures', async () => {
    const bad = await pairPhone(hub, port, true);
    expect(bad.status).toBe(403);
    expect(hub.listDevices()).toHaveLength(0);
    for (let i = 0; i < 4; i++) {
      await fetch(`http://127.0.0.1:${port}/jini/pair`, { method: 'POST', body: JSON.stringify({ id: bad.offer.id, devicePub: 'AAAA', proof: 'nope' }) });
    }
    expect(hub.status().pairing).toBeNull();
  });

  it('runs encrypted RPCs and refuses replays, tampering and reflection', async () => {
    const p = await pairPhone(hub, port);
    const ctr = makeCounter();
    const ok = await rpc(port, p.deviceId!, p.key!, ctr, 'echo', { v: 42 });
    expect(ok.resp).toEqual({ ok: true, result: { echoed: 42 } });

    // Replay the exact same envelope.
    const replay = await fetch(`http://127.0.0.1:${port}/jini/rpc`, { method: 'POST', body: JSON.stringify({ d: p.deviceId, ...ok.env }) });
    expect(replay.status).toBe(409);

    // Tamper one ciphertext character.
    const env = await seal(p.key!, p.deviceId!, 'c2d', { ts: Date.now(), ctr: ctr(), body: { op: 'echo', args: { v: 1 } } });
    const flipped = { ...env, c: (env.c[0] === 'A' ? 'B' : 'A') + env.c.slice(1) };
    const tampered = await fetch(`http://127.0.0.1:${port}/jini/rpc`, { method: 'POST', body: JSON.stringify({ d: p.deviceId, ...flipped }) });
    expect(tampered.status).toBe(401);

    // A desktop→phone envelope cannot be reflected back as a request (direction is authenticated).
    const reflected = await seal(p.key!, p.deviceId!, 'd2c', { ts: Date.now(), ctr: ctr(), body: { op: 'echo', args: {} } });
    const refl = await fetch(`http://127.0.0.1:${port}/jini/rpc`, { method: 'POST', body: JSON.stringify({ d: p.deviceId, ...reflected }) });
    expect(refl.status).toBe(401);

    // A stale timestamp is refused.
    const stale = await seal(p.key!, p.deviceId!, 'c2d', { ts: Date.now() - 10 * 60_000, ctr: ctr(), body: { op: 'echo', args: {} } });
    const st = await fetch(`http://127.0.0.1:${port}/jini/rpc`, { method: 'POST', body: JSON.stringify({ d: p.deviceId, ...stale }) });
    expect(st.status).toBe(409);
  });

  it('dedupes a retried command by cmdId (idempotent outbox replay)', async () => {
    const p = await pairPhone(hub, port);
    const ctr = makeCounter();
    const a = await rpc(port, p.deviceId!, p.key!, ctr, 'count', {}, 'cmd-1');
    const b = await rpc(port, p.deviceId!, p.key!, ctr, 'count', {}, 'cmd-1');
    expect(a.resp).toEqual(b.resp);
    expect(calls).toHaveLength(1);
  });

  it('serves incremental sync pages from a cursor', async () => {
    const p = await pairPhone(hub, port);
    const ctr = makeCounter();
    const base = hub.status().seq;
    hub.append('notice', { text: 'one' });
    hub.append('notice', { text: 'two' });
    const s1 = await rpc(port, p.deviceId!, p.key!, ctr, 'sync', { since: base });
    const r1 = s1.resp!.result as { events: Array<{ data: { text: string } }>; seq: number; more: boolean };
    expect(r1.events.map((e) => e.data.text)).toEqual(['one', 'two']);
    const s2 = await rpc(port, p.deviceId!, p.key!, ctr, 'sync', { since: r1.seq });
    expect((s2.resp!.result as { events: unknown[] }).events).toHaveLength(0);
  });

  it('revocation locks the device out immediately', async () => {
    const p = await pairPhone(hub, port);
    const ctr = makeCounter();
    expect(await hub.revokeDevice(p.deviceId!)).toBe(true);
    const r = await rpc(port, p.deviceId!, p.key!, ctr, 'echo', { v: 1 });
    expect(r.status).toBe(401);
  });

  it('rotates the link secret; the old secret works only until the new one is used', async () => {
    const p = await pairPhone(hub, port);
    const ctr = makeCounter();
    const kp = await generateLinkKeyPair();
    const rot = await rpc(port, p.deviceId!, p.key!, ctr, 'device.rotate', { pub: await exportPublicKey(kp) });
    const { pub, salt } = rot.resp!.result as { pub: string; salt: string };
    const newKey = await importLinkSecret(await deriveLinkSecret(kp.privateKey, pub, salt));
    // Old key still accepted (rotation reply may have been lost)…
    expect((await rpc(port, p.deviceId!, p.key!, ctr, 'echo', { v: 'old' })).status).toBe(200);
    // …new key works, and once used the old key is retired.
    expect((await rpc(port, p.deviceId!, newKey, ctr, 'echo', { v: 'new' })).resp).toEqual({ ok: true, result: { echoed: 'new' } });
    expect((await rpc(port, p.deviceId!, p.key!, ctr, 'echo', { v: 'old' })).status).toBe(401);
  });

  it('persists devices and the replay floor across a restart', async () => {
    const p = await pairPhone(hub, port);
    const ctr = makeCounter();
    const first = await rpc(port, p.deviceId!, p.key!, ctr, 'echo', { v: 1 });
    await hub.stop();
    await hub.saveNow();
    const hub2 = new DeviceHub({ dataDir: dir, desktopName: 'x', cipher: null, ops: { echo: (a) => a.v } });
    await hub2.load();
    hub2.setPortForTests(0);
    await hub2.start('127.0.0.1');
    const port2 = hub2.boundPort();
    // Captured pre-restart envelope cannot be replayed after the restart.
    const replay = await fetch(`http://127.0.0.1:${port2}/jini/rpc`, { method: 'POST', body: JSON.stringify({ d: p.deviceId, ...first.env }) });
    expect(replay.status).toBe(409);
    expect((await rpc(port2, p.deviceId!, p.key!, ctr, 'echo', { v: 7 })).resp).toEqual({ ok: true, result: 7 });
    await hub2.stop();
  });

  it('pairing is impossible while the link server is off', async () => {
    await hub.stop();
    await expect(hub.startPairing()).rejects.toThrow(/Allow phone connections/);
  });
});
