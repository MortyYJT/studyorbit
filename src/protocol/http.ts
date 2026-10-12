import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { ownerCommands } from './contracts.js';
import type { TrustedContext } from './context.js';
import { dispatch, type Registry } from './registry.js';
import { fail, type Envelope } from './envelope.js';
import { CourseworkError, type ErrorCode } from './errors.js';

const statuses: Record<ErrorCode, number> = {
  INVALID_INPUT: 400, NOT_FOUND: 404, CONFLICT: 409, AUTH_EXPIRED: 401,
  SOURCE_UNAVAILABLE: 503, LOCKED: 423, CITATION_MISMATCH: 422,
  LIMIT_EXCEEDED: 413, INTERNAL: 500, UNCERTAIN: 500,
};
export function httpStatus(envelope: Envelope): number { return envelope.ok ? 200 : statuses[envelope.error.code]; }
export interface HttpTransport {
  /** Host API only; never serialize this object into a command response. */
  readonly origin: string;
  readonly capabilityFile: string;
  close(): Promise<void>;
}
export interface HttpOptions {
  registry: Registry;
  context: TrustedContext;
  port?: number;
  /** Trusted host storage, default .local; tests use private temporary directories. */
  capabilityDirectory?: string;
  /** Host may tighten bounds, never enlarge them. */
  bodyTimeoutMs?: number;
  maxActiveRequests?: number;
}
const unavailable = () => new CourseworkError('INTERNAL', 'Local HTTP transport is unavailable.');
function bound(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw unavailable();
  return value;
}
async function privateCapability(root: string, token: string): Promise<string> {
  // Walk all components, refusing symlinks instead of following them through recursive mkdir.
  const paths: string[] = []; let path = resolve(root);
  while (dirname(path) !== path) { paths.unshift(path); path = dirname(path); }
  for (const directory of paths) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable(); }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw unavailable();
  }
  const info = await lstat(resolve(root));
  if (process.getuid && info.uid !== process.getuid()) throw unavailable();
  // Do not change permissions on ancestor directories owned by the caller.
  const directory = await mkdtemp(join(resolve(root), 'http-'));
  try {
    await chmod(directory, 0o700);
    await writeFile(join(directory, 'capability'), token + '\n', { mode: 0o600, flag: 'wx' });
    return directory;
  } catch { await rm(directory, { recursive: true, force: true }); throw unavailable(); }
}
function header(req: IncomingMessage, name: string): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() !== name) continue;
    if (value !== undefined) return undefined;
    value = req.rawHeaders[i + 1];
  }
  return value;
}
function headerCount(req: IncomingMessage, name: string): number {
  return req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === name).length;
}
/** Standalone generated transport. No UI, repository selection, confirmation issuance or retries. */
export async function startHttpTransport(options: HttpOptions): Promise<HttpTransport> {
  const bodyTimeoutMs = bound(options.bodyTimeoutMs, 5000);
  const maxActive = bound(options.maxActiveRequests, 32);
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw unavailable();
  const token = randomBytes(32).toString('hex');
  let directory: string;
  try { directory = await privateCapability(options.capabilityDirectory ?? '.local', token); }
  catch { throw unavailable(); }
  let origin = ''; let active = 0; let closing = false;
  const sockets = new Set<Socket>();
  // Sockets that already carry a Connection: close response; trailing bytes must never get a second response.
  const answered = new WeakSet<Socket>();
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 10000,
    connectionsCheckingInterval: 250 }, (req, res) => {
    let finished = false; let counted = false; let dispatching = false; let timer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (counted && !dispatching) { active--; counted = false; }
    };
    res.once('close', finish); res.once('finish', finish);
    req.on('error', () => { finish(); res.destroy(); });
    const reply = (status: number, envelope: Envelope) => {
      if (res.destroyed || res.writableEnded) return;
      if (req.socket) answered.add(req.socket);
      let text = JSON.stringify(envelope);
      // The transport's own bootstrap credential must never escape even through an injected port.
      if (text.includes(token)) { status = 500; text = JSON.stringify(fail('unknown', 'INTERNAL', 'The command could not complete safely.')); }
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close',
        ...(status === 405 ? { Allow: 'POST' } : {}) });
      res.end(text);
    };
    const reject = (status: number, code: ErrorCode = 'INVALID_INPUT') => {
      reply(status, fail('unknown', code, 'Local HTTP request rejected.'));
    };
    if (closing || active >= maxActive) { reject(503, 'LOCKED'); return; }
    counted = true; active++;
    if (req.rawHeaders.length / 2 > 64) { reject(431); return; }
    if (header(req, 'host') !== new URL(origin).host || headerCount(req, 'host') !== 1) { reject(403); return; }
    const originCount = headerCount(req, 'origin');
    if (originCount > 1 || originCount === 1 && header(req, 'origin') !== origin) { reject(403); return; }
    const fetchCount = headerCount(req, 'sec-fetch-site');
    if (fetchCount > 0 && (fetchCount !== 1 || !['same-origin', 'none'].includes(header(req, 'sec-fetch-site') ?? ''))) {
      reject(403); return;
    }
    if ((req.url?.length ?? 0) > 1024) { reject(414); return; }
    const name = req.url?.startsWith('/api/') ? req.url.slice(5) : '';
    const entry = options.registry.get(name);
    if (!entry) { reject(404, 'NOT_FOUND'); return; }
    if (req.method !== 'POST') { reject(405); return; }
    if (headerCount(req, 'content-type') !== 1 || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(header(req, 'content-type') ?? '')
      || headerCount(req, 'content-encoding') > 0) { reject(415); return; }
    const supplied = header(req, 'x-coursework-capability');
    const authorized = headerCount(req, 'x-coursework-capability') === 1 && supplied !== undefined
      && Buffer.byteLength(supplied) === 64 && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
    if ((entry.level > 0 || ownerCommands.has(name)) && !authorized) { reject(403); return; }
    const length = header(req, 'content-length');
    if (length !== undefined && Number(length) > 65536) { reject(413, 'LIMIT_EXCEEDED'); return; }
    const chunks: Buffer[] = []; let size = 0; let rejected = false;
    timer = setTimeout(() => { rejected = true; reject(408); }, bodyTimeoutMs);
    req.on('data', (chunk: Buffer) => {
      if (rejected || finished) return;
      size += chunk.length;
      if (size > 65536) { rejected = true; clearTimeout(timer); reject(413, 'LIMIT_EXCEEDED'); return; }
      chunks.push(chunk);
    });
    req.once('end', () => {
      clearTimeout(timer);
      if (rejected || finished || closing) return;
      let input: unknown;
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { reject(400); return; }
      // Reserved authority fields are refused even if an extension registry has permissive inputs.
      if (input !== null && typeof input === 'object' && ['owner', 'context', 'trustedContext', 'confirmed'].some(key => Object.hasOwn(input, key))) {
        reject(400); return;
      }
      const { owner: _untrustedOwner, ...ports } = options.context;
      const context: TrustedContext = { ...ports, ...(authorized ? { owner: { assertOwner: async () => {
        if (closing) throw unavailable();
      } } } : {}) };
      // No deadline races against a mutation: dispatcher completion determines its real outcome.
      dispatching = true;
      void dispatch(options.registry, name, input, context).then(envelope => reply(httpStatus(envelope), envelope))
        .catch(() => reply(500, fail('unknown', 'INTERNAL', 'The command could not complete safely.')))
        .finally(() => { dispatching = false; if (counted) { active--; counted = false; } });
    });
  });
  server.maxConnections = 64;
  server.setTimeout(10000, socket => socket.destroy());
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('clientError', (error, socket) => {
    if (!socket.writable) { socket.destroy(); return; }
    // Unframed bytes after a rejected request (e.g. a GET body) parse as a new request; flush and close instead.
    if (answered.has(socket as Socket)) { socket.end(); return; }
    const status = (error as NodeJS.ErrnoException).code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
    const text = JSON.stringify(fail('unknown', 'INVALID_INPUT', 'Local HTTP request rejected.'));
    socket.end(`HTTP/1.1 ${status} ${status === 431 ? 'Request Header Fields Too Large' : 'Bad Request'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
  });
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', rejectListen); resolveListen(); });
    });
    const address = server.address();
    if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') throw unavailable();
    origin = `http://127.0.0.1:${address.port}`;
  } catch {
    server.close(); for (const socket of sockets) socket.destroy();
    await rm(directory, { recursive: true, force: true }); throw unavailable();
  }
  let closed: Promise<void> | undefined;
  return { origin, capabilityFile: join(directory, 'capability'), close() {
    if (closed) return closed;
    closing = true;
    closed = (async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => error ? rejectClose(unavailable()) : resolveClose());
        for (const socket of sockets) socket.destroy();
      });
      await rm(directory, { recursive: true, force: true });
    })();
    return closed;
  } };
}
