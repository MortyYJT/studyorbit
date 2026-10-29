// Access checks for the standalone local API (design §3, decision #342). A request is served only when, in this order:
// the peer is loopback, the per-launch token matches, the Host is a loopback name with the web port (DNS rebinding),
// and an Origin, when present, equals `http://<Host>` (`foreignOrigin`). Every refusal is `403` with an empty body.
// Per-route rules (write methods need an exact Origin and JSON) stay in the routes.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { foreignOrigin } from '../scripts/lib/local-origin.mjs';

export const TOKEN_HEADER = 'x-studyorbit-token';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOST_NAMES = ['localhost', '127.0.0.1', '[::1]'];

export function isLoopback(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK.has(address);
}

/** Constant-time comparison: both sides are hashed first, so a wrong length takes the same path as a wrong value. */
export function tokenMatches(expected: string, given: unknown): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const value = typeof given === 'string' ? given : '';
  return timingSafeEqual(digest(expected), digest(value)) && typeof given === 'string' && given.length > 0;
}

export function allowedHost(host: string | undefined, webPort: number): boolean {
  return host !== undefined && HOST_NAMES.some(name => host === `${name}:${webPort}`);
}

export type Refusal = 'peer' | 'token' | 'host' | 'origin';
export type GuardOptions = { token: string; webPort: number };

/** The first failed check, or null when the request may reach a route. */
export function checkRequest(req: { socket: { remoteAddress?: string }; headers: IncomingHttpHeaders }, options: GuardOptions): Refusal | null {
  if (!isLoopback(req.socket.remoteAddress)) return 'peer';
  if (!tokenMatches(options.token, req.headers[TOKEN_HEADER])) return 'token';
  if (!allowedHost(req.headers.host, options.webPort)) return 'host';
  if (foreignOrigin({ origin: req.headers.origin, host: req.headers.host })) return 'origin';
  return null;
}
