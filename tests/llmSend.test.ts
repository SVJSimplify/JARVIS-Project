import * as http from 'http';
import os from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelGoneError, providerRejection, send, withModelFallback } from '../src/main/llm';

// settings.ts reads its store under Electron's userData; the unit-test env has no Electron,
// so stand in a temp dir (the same isolation rule tests/setup.ts applies to FILES_ROOT).
vi.mock('electron', () => ({ app: { getPath: () => os.tmpdir() } }));

const RELAY_DEAD_MODEL =
  '{"error":{"message":"[gemini/gemini-2.5-flash-lite] [404]: {\\n  \\"error\\": {\\n    \\"code\\": 404,\\n    \\"message\\": \\"This model models/gemini-2.5-flash-lite is no longer available to new users. Please update your code."}}';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('providerRejection — pure classification', () => {
  it('names the exact relay shape from the field: dead model wrapped as 503', () => {
    const msg = providerRejection(503, RELAY_DEAD_MODEL);
    expect(msg).toMatch(/HTTP 503/);
    expect(msg).toMatch(/no longer available to new users/);
    expect(msg).toMatch(/Pick another model in Settings\.$/);
  });

  it('recognises a plain upstream 404 with no relay wrapper', () => {
    const msg = providerRejection(404, '{"error":{"code":404,"message":"Model models/foo-bar does not exist"}}');
    expect(msg).toMatch(/HTTP 404/);
    expect(msg).toMatch(/Pick another model in Settings\.$/);
  });

  it('stays null for transient failures so the retry path keeps working', () => {
    expect(providerRejection(503, '{"error":{"message":"upstream overloaded, try again"}}')).toBeNull();
    expect(providerRejection(429, '{"error":{"message":"rate limit exceeded"}}')).toBeNull();
    expect(providerRejection(500, '')).toBeNull();
  });
});

/**
 * send() itself is exercised over a REAL local HTTP server — no fetch mocks, so the retry
 * behaviour is proven end to end against actual sockets. BASE_URL is the fixed local
 * http://localhost:20128/v1, which nothing else binds in the test environment.
 */
describe('llm.send — retry discipline over a real socket', () => {
  interface Server { close: () => void; hits: () => number }
  let last: Server | null = null;

  const start = (status: number, body: string): Promise<Server> =>
    new Promise((resolve, reject) => {
      let hits = 0;
      const srv = http.createServer((_req, r) => {
        hits++;
        r.writeHead(status, { 'Content-Type': 'application/json' });
        r.end(body);
      });
      srv.on('error', reject);
      // Bind every interface: `localhost` may resolve to ::1 or 127.0.0.1 depending on the OS.
      srv.listen(20128, () => resolve({ close: () => srv.close(), hits: () => hits }));
    });

  afterEach(() => {
    last?.close();
    last = null;
  });

  it('fails in ONE attempt when the relay wraps a dead-model 404 as 503', async () => {
    last = await start(503, RELAY_DEAD_MODEL);
    await expect(send('/chat/completions', 'POST', { model: 'gemini/gemini-2.5-flash-lite' })).rejects.toThrow(
      /Pick another model in Settings\./
    );
    expect(last.hits()).toBe(1); // permanent rejection: no retry burns the user's time
  });

  it('still retries genuine hiccups twice before reporting the raw status', async () => {
    last = await start(503, '{"error":{"message":"upstream overloaded, try again"}}');
    await expect(send('/chat/completions', 'POST', {})).rejects.toThrow(/Provider returned 503/);
    expect(last.hits()).toBe(3); // original attempt + 2 retries
  }, 15_000);

  it('returns 200 responses untouched', async () => {
    last = await start(200, '{"data":[{"id":"gemini/gemini-3.5-flash-lite"}]}');
    const res = await send('/models', 'GET');
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { data: Array<{ id: string }> };
    expect(data.data[0].id).toBe('gemini/gemini-3.5-flash-lite');
    expect(last.hits()).toBe(1);
  });
});

/**
 * withModelFallback — the retirement of a model (Gemini 2.5 closed to new users) must not
 * dead-end a turn. Proven over the same real socket: the relay rejects one model permanently
 * and (when asked) serves the next. No fetch mocks, actual HTTP, actual status codes.
 */
describe('withModelFallback — permanent rejections walk the chain', () => {
  interface Server {
    close: () => void;
    hits: () => number;
  }
  let last: Server | null = null;

  /** Server whose answer depends on which model the request carried. */
  const startRouting = (handler: (model: string) => { status: number; body: string }): Promise<Server> =>
    new Promise((resolve, reject) => {
      let hits = 0;
      const srv = http.createServer((req, r) => {
        hits++;
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          let model = '';
          try {
            model = String((JSON.parse(raw) as { model?: string }).model ?? '');
          } catch {
            model = '';
          }
          const { status, body } = handler(model);
          r.writeHead(status, { 'Content-Type': 'application/json' });
          r.end(body);
        });
      });
      srv.on('error', reject);
      srv.listen(20128, () => resolve({ close: () => srv.close(), hits: () => hits }));
    });

  afterEach(() => {
    last?.close();
    last = null;
  });

  it('a retired primary does not kill the turn: work continues on the fallback', async () => {
    last = await startRouting((model) =>
      model.includes('flash-lite')
        ? { status: 503, body: RELAY_DEAD_MODEL }
        : { status: 200, body: '{"choices":[{"message":{"content":"ok"}}]}' }
    );
    const res = await withModelFallback(
      ['gemini/gemini-2.5-flash-lite', 'gateway/good-model'],
      (m) => send('/chat/completions', 'POST', { model: m })
    );
    expect(res.ok).toBe(true);
    expect(last.hits()).toBe(2); // one permanent rejection + one success
  });

  it('every model gone: the honest error surfaces after ONE attempt per model', async () => {
    last = await startRouting(() => ({ status: 503, body: RELAY_DEAD_MODEL }));
    await expect(
      withModelFallback(['a/gone-1', 'b/gone-2'], (m) => send('/chat/completions', 'POST', { model: m }))
    ).rejects.toThrow(/Pick another model in Settings\./);
    expect(last.hits()).toBe(2); // no retry storm on permanent rejections
  });

  it('transient failures are NOT swallowed: they fail the turn as they always did', async () => {
    last = await startRouting(() => ({ status: 500, body: '{"error":{"message":"boom"}}' }));
    await expect(
      withModelFallback(['m/one', 'm/two'], (m) => send('/chat/completions', 'POST', { model: m }))
    ).rejects.toThrow(/Provider returned 500/);
    expect(last.hits()).toBe(3); // only the FIRST model tried: 500 retries twice, then stops
  });

  it('dedupes and trims the chain, keeps order, stops after the first success', async () => {
    const calls: string[] = [];
    const out = await withModelFallback(
      [' alpha ', 'alpha', 'beta', ''],
      async (m) => {
        calls.push(m);
        if (m === 'alpha') throw new ModelGoneError('no longer available');
        return `ok:${m}`;
      }
    );
    expect(calls).toEqual(['alpha', 'beta']);
    expect(out).toBe('ok:beta');
  });
});
