import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import { URL } from 'url';

/**
 * SSRF-SAFE TRANSPORT (F-33) — the DNS-rebinding fix.
 *
 * THE GAP: `assertPublicUrl()` resolved the hostname, validated every returned address as
 * public, and then handed the URL to `electronNet.fetch` — which resolves the hostname
 * AGAIN through its own resolver. An attacker controlling DNS answers twice: a public
 * address to the validator, a private one (127.0.0.1, 169.254.169.254, 10.x…) to the
 * transport. The validated destination and the actual connection were two different
 * resolutions, so the check did not cover the connection.
 *
 * THE FIX: the transport itself connects ONLY through a pinned lookup. `createPublicLookup`
 * produces a `lookup` function in Node's net.connect shape; http/https.request receive it
 * in their options, so the socket's peer address IS the address this module validated —
 * there is no second resolution. Every redirect hop builds a new request with the same
 * pinned lookup for the NEW host, TLS SNI and certificate validation stay bound to the
 * hostname (the URL is never rewritten to an IP), and a resolution that yields ANY private
 * address fails closed before a socket exists.
 *
 * IPv6 and IPv4 (including IPv4-mapped IPv6 forms) are judged by isPrivateAddress, shared
 * with webTools so both layers classify identically.
 */

/** Test hook: replace the resolver so private/blocked answers are testable without a network. */
type LookupImpl = (host: string, opts: dns.LookupAllOptions) => Promise<dns.LookupAddress[]>;
let dnsLookupImpl: LookupImpl = (host, opts) => dns.promises.lookup(host, { ...opts, all: true, verbatim: true } as dns.LookupAllOptions);
export const setDnsLookupForTests = (impl: LookupImpl | null): void => {
  dnsLookupImpl = impl ?? ((host, opts) => dns.promises.lookup(host, { ...opts, all: true, verbatim: true } as dns.LookupAllOptions));
};

/** Shared private-address classifier: webTools imports THIS one (one implementation). */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged by the embedded IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return isPrivateAddress(mapped[1]);
  return (
    v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') ||
    v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.') ||
    v.startsWith('::ffff:169.254.') || v.startsWith('::ffff:172.') || v.startsWith('::ffff:100.64.') ||
    v.startsWith('0:')
  );
}

export class BlockedAddressError extends Error {
  constructor(host: string, addresses: string[]) {
    super(`Local and private addresses are blocked (${host} → ${addresses.join(', ')}).`);
    this.name = 'BlockedAddressError';
  }
}

/**
 * Build a pinned `lookup` for net.connect-style callers: resolves the host, validates EVERY
 * answer as public, and reports ONLY public addresses back to the transport — the socket
 * cannot connect to anything this module did not validate.
 */
export function createPublicLookup(): NonNullable<https.RequestOptions['lookup']> {
  return (hostname, options, callback) => {
    dnsLookupImpl(String(hostname), { all: true, verbatim: true })
      .then((list) => {
        const bad = list.filter((a) => isPrivateAddress(a.address));
        if (bad.length) {
          // Fail closed: the transport never learns a connectable address.
          callback(new BlockedAddressError(String(hostname), bad.map((a) => a.address)), '' as unknown as string, 4);
          return;
        }
        if (!list.length) {
          callback(new Error(`DNS resolution returned no addresses for ${hostname}.`), '' as unknown as string, 4);
          return;
        }
        // Node's lookup contract: with options.all the callback receives the address
        // ARRAY; without it, exactly one (address, family). Honor both shapes so the
        // socket always gets what the platform promises — but ONLY validated addresses.
        const publicAddresses = list.map((a) => ({ address: a.address, family: (a.family ?? 4) as 4 | 6 }));
        if (options?.all) {
          callback(null, publicAddresses as dns.LookupAddress[]);
          return;
        }
        // Prefer the family the caller asked for, then IPv4 (the common path).
        const wanted = publicAddresses.find((a) => options?.family && a.family === options.family) ?? publicAddresses.find((a) => a.family === 4) ?? publicAddresses[0];
        callback(null, wanted.address, wanted.family);
      })
      .catch((e: Error) => callback(e, '' as unknown as string, 4));
  };
}

/** True when the URL names a scheme and host this transport is willing to connect to. */
export function assertFetchableUrl(raw: string | URL): URL {
  const url = raw instanceof URL ? raw : new URL(String(raw));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs are allowed.');
  return url;
}

export interface PinnedResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Body readers: capped text read (the caller never buffers unbounded). */
  text: (maxBytes: number) => Promise<string>;
}

/**
 * One pinned HTTP(S) request, redirects NOT followed (the caller revalidates per hop with
 * the same helper — every hop's host goes through the pinned lookup again).
 */
export function pinnedRequest(
  raw: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number; signal?: AbortSignal; maxRedirects?: number }
): Promise<PinnedResponse & { location?: string }> {
  // Async wrapper: a bad scheme rejects the promise instead of throwing synchronously,
  // so callers can always .catch / await the rejection.
  try {
    return pinnedRequestInner(raw, opts);
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

function pinnedRequestInner(
  raw: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs: number; signal?: AbortSignal; maxRedirects?: number }
): Promise<PinnedResponse & { location?: string }> {
  const url = assertFetchableUrl(raw);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: opts.method ?? 'GET',
        headers: opts.headers,
        lookup: createPublicLookup(), // THE transport pin: connection = validated address
        timeout: opts.timeoutMs,
        // A private/blocked DNS answer must not hang until the timeout: the lookup error
        // surfaces immediately, but keep the overall cap as the second belt.
        rejectUnauthorized: true,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on('data', (c: Buffer) => {
          bytes += c.byteLength;
          chunks.push(c);
          if (bytes > 8_000_000) req.destroy(new Error('Response too large.')); // 8 MB hard cap
        });
        res.on('end', () => {
          settle();
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            location: res.headers.location,
            text: async (maxBytes: number) => {
              const buf = Buffer.concat(chunks);
              return buf.subarray(0, maxBytes).toString('utf8');
            },
          });
        });
        res.on('error', (e) => {
          settle();
          reject(e);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Request timed out after ${opts.timeoutMs}ms.`)));
    req.on('error', reject);
    // Round 18 §11 (S2): the abort listener is REMOVED when the request settles (no
    // accumulation on long-lived turn signals), and timeouts are distinguishable from
    // user cancellations: AbortSignal.timeout() carries a TimeoutError reason, which
    // surfaces as 'timed out' (transient, retriable) — a real cancellation stays
    // 'cancelled' (final).
    let onAbort: (() => void) | null = null;
    const abortReason = (sig: AbortSignal): Error =>
      sig.reason instanceof Error && sig.reason.name === 'TimeoutError' ? new Error('timed out') : new Error('cancelled');
    if (opts.signal) {
      if (opts.signal.aborted) req.destroy(abortReason(opts.signal));
      else {
        onAbort = () => req.destroy(abortReason(opts.signal!));
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    const settle = (): void => {
      if (onAbort && opts.signal) opts.signal.removeEventListener('abort', onAbort);
      onAbort = null;
    };
    req.on('error', settle);
    req.on('close', settle); // fires on every terminal path: end, error, destroy
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
