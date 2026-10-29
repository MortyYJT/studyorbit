import { describe, expect, it, vi } from 'vitest';

// Spy on the constant-time comparison while keeping its behaviour (design §3, check 2).
const timing = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => { timing.calls += 1; return actual.timingSafeEqual(a, b); } };
});

const { TOKEN_HEADER, allowedHost, checkRequest, isLoopback, tokenMatches } = await import('../server/guard.ts');

// Synthetic token: 32 random-looking bytes in hex, never a real launch token.
const token = 'a1'.repeat(32);
const webPort = 5999;
// The peer defaults to 127.0.0.1; pass `undefined` explicitly for a socket without an address.
const request = (headers: Record<string, string | undefined>, ...peer: [string?]) =>
  ({ socket: { remoteAddress: peer.length ? peer[0] : '127.0.0.1' }, headers: { host: `localhost:${webPort}`, [TOKEN_HEADER]: token, ...headers } });

describe('isLoopback', () => {
  it('accepts the three loopback forms only', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) expect(isLoopback(address)).toBe(true);
    for (const address of [undefined, '', '192.168.1.20', '10.0.0.2', '::ffff:192.168.1.20', 'fe80::1', '0.0.0.0']) expect(isLoopback(address)).toBe(false);
  });
});

describe('tokenMatches', () => {
  it('accepts only the launch token', () => {
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, undefined)).toBe(false);
    expect(tokenMatches(token, '')).toBe(false);
    expect(tokenMatches(token, 'b2'.repeat(32))).toBe(false);
    expect(tokenMatches(token, token.slice(0, -1))).toBe(false);
    expect(tokenMatches(token, `${token}0`)).toBe(false);
    expect(tokenMatches(token, [token, token])).toBe(false);
  });

  it('compares in constant time for right-length and wrong-length tokens', () => {
    timing.calls = 0;
    tokenMatches(token, 'b2'.repeat(32));
    tokenMatches(token, 'short');
    tokenMatches(token, token);
    expect(timing.calls).toBe(3);
  });
});

describe('allowedHost', () => {
  it('accepts localhost, 127.0.0.1 and [::1] with the web port', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) expect(allowedHost(`${host}:${webPort}`, webPort)).toBe(true);
  });

  it('refuses other names, other ports and missing ports', () => {
    for (const host of [undefined, '', 'localhost', `localhost:5190`, `evil.example:${webPort}`, `localhost.evil.example:${webPort}`,
      `127.0.0.2:${webPort}`, `::1:${webPort}`, `0.0.0.0:${webPort}`, `localhost:${webPort}0`, ` localhost:${webPort}`]) {
      expect(allowedHost(host, webPort)).toBe(false);
    }
  });
});

describe('checkRequest', () => {
  const options = { token, webPort };

  it('passes a proxied page request with and without Origin', () => {
    expect(checkRequest(request({}), options)).toBeNull();
    expect(checkRequest(request({ origin: `http://localhost:${webPort}` }), options)).toBeNull();
    expect(checkRequest(request({ host: `127.0.0.1:${webPort}`, origin: `http://127.0.0.1:${webPort}` }), options)).toBeNull();
  });

  it('refuses a non-loopback peer, a missing or wrong token, a foreign Host and a foreign Origin', () => {
    expect(checkRequest(request({}, '192.168.1.20'), options)).toBe('peer');
    expect(checkRequest(request({}, undefined), options)).toBe('peer');
    expect(checkRequest(request({ [TOKEN_HEADER]: undefined }), options)).toBe('token');
    expect(checkRequest(request({ [TOKEN_HEADER]: 'b2'.repeat(32) }), options)).toBe('token');
    expect(checkRequest(request({ host: `evil.example:${webPort}`, origin: `http://evil.example:${webPort}` }), options)).toBe('host');
    expect(checkRequest(request({ host: 'localhost:5190' }), options)).toBe('host');
    expect(checkRequest(request({ origin: 'http://localhost:3000' }), options)).toBe('origin');
    expect(checkRequest(request({ origin: `https://localhost:${webPort}` }), options)).toBe('origin');
  });

  it('checks peer, then token, then Host, then Origin', () => {
    const bad = { [TOKEN_HEADER]: undefined, host: 'evil.example:1', origin: 'http://elsewhere' };
    expect(checkRequest(request(bad, '10.0.0.2'), options)).toBe('peer');
    expect(checkRequest(request(bad), options)).toBe('token');
    expect(checkRequest(request({ ...bad, [TOKEN_HEADER]: token }), options)).toBe('host');
    expect(checkRequest(request({ ...bad, [TOKEN_HEADER]: token, host: `localhost:${webPort}` }), options)).toBe('origin');
  });
});
