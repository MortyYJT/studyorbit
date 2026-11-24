// Loopback model proxy for the assistant (decision #542). DeepTutor 1.7.4 can only be given a key by writing it into
// its settings file, so it is given this proxy's address and a token created for this launch instead; the real key is
// added here, from StudyOrbit's own model settings, and exists only in this process. A request is forwarded only when
// it comes from a loopback peer, names this proxy in `Host`, carries no `Origin` (a browser page would), presents the
// launch token, and is one of three method/path pairs. It goes to the configured provider address and nowhere else.
// Nothing about a request is logged except why it was refused: no headers, no bodies, no query strings.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isLoopback, tokenMatches } from './guard.ts';

const ALLOWED = new Set(['POST /responses', 'POST /chat/completions', 'GET /models']);
const BODY_LIMIT = 20 * 1024 * 1024;

export type LlmProxyOptions = {
  /** This launch's token; DeepTutor sends it as its "API key". */
  token: string;
  /** Provider base address, for example `https://api.deepseek.com`. Requests go to `<upstream><path>` only. */
  upstream: string;
  /** The real key, read when a request arrives; null when StudyOrbit has none. */
  resolveKey(): Promise<string | null>;
  log?(line: string): void;
};
export type LlmProxy = { listen(port: number): Promise<number>; close(): Promise<void> };

export function createLlmProxy({ token, upstream, resolveKey, log = line => console.error(line) }: LlmProxyOptions): LlmProxy {
  const base = upstream.replace(/\/+$/, '');
  let port = 0;
  const refuse = (res: ServerResponse, reason: string) => { log(`[model proxy] refused: ${reason}`); res.writeHead(403).end(); };

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!isLoopback(req.socket.remoteAddress)) return refuse(res, 'peer');
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return refuse(res, 'host');
    if (req.headers.origin !== undefined) return refuse(res, 'origin');
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ') || !tokenMatches(token, authorization.slice(7))) return refuse(res, 'token');
    if (!ALLOWED.has(`${req.method} ${req.url}`)) return refuse(res, 'path');

    const chunks: Buffer[] = [];
    let size = 0;
    // An oversized body is read to its end and thrown away, so the sender gets the 413 instead of a broken pipe.
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size <= BODY_LIMIT) chunks.push(chunk as Buffer); else chunks.length = 0;
    }
    if (size > BODY_LIMIT) { res.writeHead(413).end(); return; }
    const key = await resolveKey();
    if (!key) { res.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'StudyOrbit has no model key. Add one in StudyOrbit settings.' } })); return; }

    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    let reply: Response;
    try {
      reply = await fetch(`${base}${req.url}`, {
        method: req.method, signal: abort.signal,
        headers: { ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}), accept: req.headers.accept ?? '*/*', authorization: `Bearer ${key}` },
        ...(req.method === 'GET' ? {} : { body: Buffer.concat(chunks) }),
      });
    } catch {
      if (!abort.signal.aborted) log('[model proxy] the provider could not be reached');
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'The model provider could not be reached.' } }));
      return;
    }
    res.writeHead(reply.status, { 'Content-Type': reply.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' });
    res.flushHeaders();
    try { if (reply.body) for await (const chunk of reply.body) res.write(chunk); }
    catch { /* The provider or the client went away mid-stream; ending the response is all that is left to do. */ }
    res.end();
  }

  const server: Server = createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
  return {
    listen: requested => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(requested, '127.0.0.1', () => { port = (server.address() as AddressInfo).port; resolve(port); });
    }),
    close: () => new Promise(resolve => { if (!server.listening) { resolve(); return; } server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
