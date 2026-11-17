import { describe, expect, it, afterEach } from 'vitest';
import * as net from 'net';
import * as http from 'http';

/**
 * SSRF-SAFE TRANSPORT (F-33) — the DNS-rebinding fix, pinned where it matters: the socket.
 *
 * The historical gap: assertPublicUrl validated ONE DNS resolution and then the HTTP
 * transport resolved the hostname AGAIN — a rebinding server answered publicly to the
 * validator and privately (127.0.0.1) to the transport. These tests pin the corrected
 * design: the transport's lookup hands the socket ONLY validator-approved public
 * addresses, and a resolution that contains ANY private address fails closed before a
 * connection exists.
 */

import { createPublicLookup, isPrivateAddress, pinnedRequest, setDnsLookupForTests, BlockedAddressError } from '../src/main/safeNet';

afterEach(() => setDnsLookupForTests(null));

describe('isPrivateAddress (one classifier for pre-checks and transport)', () => {
  it('blocks loopback, LAN, link-local, CGNAT, metadata and mapped forms', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.4', '169.254.169.254', '100.64.0.1', '0.1.2.3', '::1', '::', 'fe80::1', 'fd00::5', '::ffff:127.0.0.1', '::ffff:10.0.0.2']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['93.184.216.34', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:2800:220:1:248:1893:25c8:1946']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe('the pinned lookup feeds the socket only validated public addresses', () => {
  it('a resolution containing ANY private address fails closed with no address reported', async () => {
    // THE rebinding scenario: the first answer is public, a later/second answer is private.
    setDnsLookupForTests(async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const lookup = createPublicLookup();
    await new Promise<void>((resolve) => {
      lookup('evil.example', {}, (err: Error | null) => {
        expect(err).toBeInstanceOf(BlockedAddressError);
        expect((err as Error).message).toContain('127.0.0.1');
        resolve();
      });
    });
  });

  it('a fully public resolution reaches the transport unchanged (single-address contract)', async () => {
    setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
    const lookup = createPublicLookup();
    await new Promise<void>((resolve) => {
      lookup('good.example', { all: false }, (err: Error | null, address: string, family: number) => {
        try {
          expect(err).toBeNull();
          expect(address).toBe('93.184.216.34');
          expect(family).toBe(4);
          resolve();
        } catch (e) {
          resolve(); // surface via the outer expect below, not an unhandled rejection
          throw e;
        }
      });
    }).then(() => {
      // The all:true shape (array) is what aggregate callers receive.
      lookup('good.example', { all: true }, (err: Error | null, addresses: unknown) => {
        expect(err).toBeNull();
        expect(Array.isArray(addresses)).toBe(true);
        expect((addresses as Array<{ address: string }>)[0].address).toBe('93.184.216.34');
      });
    });
  });

  it('a resolver error is surfaced, never swallowed into a connectable address', async () => {
    setDnsLookupForTests(async () => {
      throw new Error('servfail');
    });
    const lookup = createPublicLookup();
    await new Promise<void>((resolve) => {
      lookup('dead.example', {}, (err: Error | null) => {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain('servfail');
        resolve();
      });
    });
  });
});

describe('pinnedRequest end-to-end against a REAL loopback server', () => {
  // NOTE: a positive end-to-end fetch over loopback is impossible BY DESIGN — the pinned
  // lookup refuses private addresses, and loopback is private. That refusal is exactly
  // the policy working; the positive path (socket receives only validated addresses) is
  // pinned at the lookup contract level above, and the refusal path is pinned here with
  // a REAL server whose handler must never be reached.
  it('a hostname whose DNS answers private is refused BEFORE connecting (the socket never exists)', async () => {
    // A real HTTP server listens on loopback — exactly what the private-target policy protects.
    const server = http.createServer(() => {
      throw new Error('MUST NOT BE REACHED: the pinned lookup had to refuse the private target first');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as net.AddressInfo).port;
      // DNS says the host resolves to loopback — the classic rebinding answer. The pinned
      // lookup must refuse it before any socket exists; the request rejects.
      setDnsLookupForTests(async () => [{ address: '127.0.0.1', family: 4 }]);
      await expect(pinnedRequest(`http://rebind.example:${port}/`, { timeoutMs: 3000 })).rejects.toThrow(BlockedAddressError);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('non-http schemes are refused before any DNS work', async () => {
    await expect(pinnedRequest('file:///etc/hosts', { timeoutMs: 1000 })).rejects.toThrow(/http and https/);
    await expect(pinnedRequest('ftp://example.com/x', { timeoutMs: 1000 })).rejects.toThrow(/http and https/);
  });
});
