/**
 * A REAL Chrome DevTools Protocol server for tests: an HTTP endpoint (/json/version,
 * /json/list) plus a `ws` WebSocketServer speaking the actual CDP wire format (flattened
 * sessions, Runtime.evaluate, Target.*). It exercises the REAL client code path end to
 * end — only the browser behind the protocol is a test double.
 */
import * as http from 'http';
import { WebSocketServer, type WebSocket } from 'ws';

export interface FakeCdpState {
  httpPort: number;
  createdTargets: Array<{ url: string; background: boolean }>;
  activated: string[];
  closed: string[];
  evaluates: string[];
  server: http.Server;
  wss: WebSocketServer;
  sockets: Set<WebSocket>;
}

export const newFakeCdpState = (): FakeCdpState => ({
  httpPort: 0,
  createdTargets: [],
  activated: [],
  closed: [],
  evaluates: [],
  server: undefined as unknown as http.Server,
  wss: undefined as unknown as WebSocketServer,
  sockets: new Set(),
});

const fakeTarget = { targetId: 'T-main', type: 'page', url: 'https://app.local/start', title: 'Start' };

export function startFake(state: FakeCdpState): Promise<number> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (url.startsWith('/json/version')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ Browser: 'FakeChrome/120', 'Protocol-Version': '1.3', webSocketDebuggerUrl: `ws://127.0.0.1:${state.httpPort}/devtools/browser/fake` }));
      } else if (url.startsWith('/json/list')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([fakeTarget]));
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });
    state.server = server;
    const wss = new WebSocketServer({ server });
    state.wss = wss;
    const targets = new Map<string, { type: string; url: string; title: string }>([[fakeTarget.targetId, { ...fakeTarget }]]);
    let nextSession = 1;
    const sessions = new Map<string, string>();
    wss.on('connection', (ws) => {
      state.sockets.add(ws);
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
        const reply = (result: Record<string, unknown>): void => ws.send(JSON.stringify({ id: msg.id, result }));
        if (msg.method === 'Browser.getVersion') return reply({ product: 'FakeChrome/120', protocolVersion: '1.3' });
        if (msg.method === 'Browser.setDownloadBehavior') return reply({});
        if (msg.method === 'Target.getTargets')
          return reply({ targetInfos: [...targets.entries()].map(([targetId, t]) => ({ targetId, ...t, attached: [...sessions.values()].includes(targetId) })) });
        if (msg.method === 'Target.createTarget') {
          const id = `T-${targets.size + 1}`;
          targets.set(id, { type: 'page', url: String(msg.params?.url ?? ''), title: 'New tab' });
          state.createdTargets.push({ url: String(msg.params?.url ?? ''), background: msg.params?.background === true });
          return reply({ targetId: id });
        }
        if (msg.method === 'Target.closeTarget') {
          state.closed.push(String(msg.params?.targetId));
          targets.delete(String(msg.params?.targetId));
          return reply({});
        }
        if (msg.method === 'Target.activateTarget') {
          state.activated.push(String(msg.params?.targetId));
          return reply({});
        }
        if (msg.method === 'Target.attachToTarget') {
          const sid = `S${nextSession++}`;
          sessions.set(sid, String(msg.params?.targetId));
          return reply({ sessionId: sid });
        }
        if (msg.method === 'Target.detachFromTarget') {
          sessions.delete(String(msg.sessionId));
          return reply({});
        }
        if (msg.method === 'Page.enable' || msg.method === 'Runtime.enable') return reply({});
        if (msg.method === 'Page.navigate') return reply({ frameId: 'F1' });
        if (msg.method === 'Input.insertText') return reply({});
        if (msg.method === 'Page.captureScreenshot') return reply({ data: Buffer.from('fake-png-bytes').toString('base64') });
        if (msg.method === 'Runtime.evaluate') {
          const expr = String(msg.params?.expression ?? '');
          state.evaluates.push(expr.slice(0, 120));
          const send = (value: string): void => reply({ result: { type: 'string', value } });
          if (expr.includes('__nbEls') && expr.includes('tagName')) {
            const m = /__nbEls \|\| \[\]\)\[(\d+)\]/.exec(expr);
            const ref = m ? Number(m[1]) : 0;
            // Mirrors ELEMENT_IDENTITY_JS (nativeBrowser.ts): the exact-identity JSON record.
            const ident = (tag: string, acc: string, link: string): string =>
            JSON.stringify({ tag, id: '', name: '', type: tag === 'button' ? 'button' : '', role: '', accessibleName: acc, resolvedHref: link, formPresent: false, formAction: '', formMethod: '', position: ref, duplicates: 1, hidden: false });
            if (ref === 5) return send(ident('button', 'Delete account', 'https://app.local/account/delete'));
            if (ref === 6) return send(ident('button', 'Buy now', 'https://shop.local/checkout/9'));
            return send(ident('a', 'Settings link', 'https://app.local/settings'));
          }
          if (expr.includes('__nbEls') && expr.includes('gone')) return send('ok');
          if (expr.includes('document.title') && expr.includes('content')) return send(JSON.stringify({ title: 'Settings', url: 'https://app.local/settings', content: 'account preferences live here' }));
          if (expr.startsWith('JSON.stringify({ title')) return send(JSON.stringify({ title: 'Settings', url: 'https://app.local/settings' }));
          if (expr.includes('body.innerText')) return send('account preferences page text');
          if (expr.includes('__nbEls') && expr.includes('focus')) return send('ok');
          if (expr.includes('activeElement')) return send('typed-value');
          return send('null');
        }
        return reply({});
      });
      ws.on('close', () => state.sockets.delete(ws));
    });
    server.listen(0, '127.0.0.1', () => {
      state.httpPort = (server.address() as { port: number }).port;
      resolve(state.httpPort);
    });
  });
}

export function stopFake(state: FakeCdpState): Promise<void> {
  return new Promise((resolve) => {
    for (const s of state.sockets) {
      try {
        s.terminate();
      } catch {
        /* gone */
      }
    }
    state.wss.close(() => state.server.close(() => resolve()));
  });
}
