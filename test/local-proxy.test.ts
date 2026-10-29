import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createViteServer, preview, type ViteDevServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLocalApi } from '../server/app.ts';
import { TOKEN_HEADER } from '../server/guard.ts';
import { localApiProxy, previewWithoutApi } from '../server/proxy.ts';
import { call, closeServer, eventReader, listen, open, portOf, syntheticCourse, syntheticToken, writeSyntheticCourses } from './local-api-helpers.ts';

// The Vite proxy for `/api/local` (design §4, specs/local-api-server "Vite proxies the local API"): a Vite dev server
// created with `localApiProxy` (no config file) in front of a test API server on loopback.
let root: string, token: string, vite: ViteDevServer | undefined, api: Server | undefined, apiPort: number, webPort: number;
let upstream: (req: IncomingMessage, res: ServerResponse) => void;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'studyorbit-proxy-'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>synthetic</title>');
  token = syntheticToken();
  upstream = (_req, res) => { res.writeHead(500).end(); };
  api = createHttpServer((req, res) => upstream(req, res));
  apiPort = await listen(api);
  vite = await createViteServer({
    configFile: false, root, logLevel: 'silent', appType: 'spa', optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, strictPort: true, ws: false, proxy: { '/api/local': localApiProxy({ apiPort, token }) } },
  });
  await vite.listen();
  webPort = portOf(vite.httpServer as Server);
});
afterEach(async () => {
  await vite?.close();
  vite = undefined;
  await closeServer(api);
  await rm(root, { recursive: true, force: true });
});

const page = () => `127.0.0.1:${webPort}`;

describe('localApiProxy', () => {
  it('forwards with the launch token, replacing one sent by the browser, and keeps Host and Origin', async () => {
    const seen: IncomingHttpHeaders[] = [];
    upstream = (req, res) => { seen.push(req.headers); res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ url: req.url })); };
    const plain = await call(webPort, '/api/local/course-sync?x=1', { headers: { host: page() } });
    expect([plain.status, plain.json()]).toEqual([200, { url: '/api/local/course-sync?x=1' }]);
    await call(webPort, '/api/local/course-sync', { headers: { host: page(), origin: `http://${page()}`, [TOKEN_HEADER]: 'f'.repeat(64) } });
    expect(seen.map(headers => headers[TOKEN_HEADER])).toEqual([token, token]);
    expect(seen.map(headers => headers.host)).toEqual([page(), page()]);
    expect(seen[1]!.origin).toBe(`http://${page()}`);
  });

  it('passes Server-Sent Events through unbuffered and closes the upstream request when the browser aborts', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const closed = Promise.withResolvers<boolean>();
    upstream = async (_req, res) => {
      res.on('close', () => closed.resolve(res.writableFinished));
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' });
      res.write(`event: delta\ndata: ${JSON.stringify({ text: 'one' })}\n\n`);
      await held;
      if (!res.destroyed) res.end(`event: done\ndata: {}\n\n`);
    };
    const { req, response } = open(webPort, '/api/local/chats/x/messages', { method: 'POST', headers: { host: page(), 'content-type': 'application/json' }, body: '{}' });
    const events = eventReader(await response);
    // Arrives while the upstream response is still open.
    expect(await events.next()).toEqual({ event: 'delta', data: { text: 'one' } });
    req.destroy();
    expect(await closed.promise).toBe(false);
    release();
  });

  it('refuses a non-loopback browser address with 403 and forwards nothing', async () => {
    const entry = localApiProxy({ apiPort, token });
    let status = 0, ended = false;
    const res = { writeHead(code: number) { status = code; return this; }, end() { ended = true; return this; }, get writableEnded() { return ended; } };
    const req = { url: '/api/local/course-reports', headers: { host: 'localhost:5173' }, socket: { remoteAddress: '192.168.1.20' } };
    const result = await entry.bypass!(req as never, res as never, entry);
    expect([status, ended]).toEqual([403, true]);
    // A string result with the response ended stops Vite's proxy middleware before it forwards anything.
    expect(typeof result).toBe('string');
    for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(await entry.bypass!({ ...req, socket: { remoteAddress } } as never, res as never, entry)).toBeUndefined();
    }
  });

  it('serves real routes end to end through createLocalApi', async () => {
    const projectDir = join(root, 'project'), desktopDir = join(root, 'Desktop');
    await mkdir(projectDir, { recursive: true });
    await writeSyntheticCourses(projectDir, desktopDir);
    const local = createLocalApi({ projectDir, desktopDir, token, webPort, env: {}, courseRunner: { start: async () => { throw new Error('INVALID_SELECTION'); }, status: () => ({ running: false, courses: [], error: null }), cancel: () => ({ running: false, courses: [], error: null }) } });
    upstream = local.handle;
    const reports = await call(webPort, '/api/local/course-reports', { headers: { host: page() } });
    expect(reports.json().reports.map((item: { id: string }) => item.id)).toEqual([syntheticCourse.id]);
    expect((await call(webPort, '/api/local/course-sync', { headers: { host: page(), origin: 'http://localhost:3000' } })).status).toBe(403);
    const save = await call(webPort, '/api/local/llm-config', { method: 'PUT', headers: { host: page(), origin: `http://${page()}`, 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'deepseek', apiKey: 'sk-synthetic-key' }) });
    expect(save.json()).toMatchObject({ hasKey: true });
    // A direct request to the API port without the proxy has no token.
    expect((await call(apiPort, '/api/local/course-reports', { headers: { host: page() } })).status).toBe(403);
  });
});

describe('previewWithoutApi', () => {
  it('answers 404 for /api/local in vite preview instead of the page fallback, and forwards nothing', async () => {
    const dist = join(root, 'dist');
    await mkdir(dist, { recursive: true });
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>synthetic build</title>');
    let forwarded = 0;
    upstream = (_req, res) => { forwarded += 1; res.writeHead(200).end(); };
    const server = await preview({ configFile: false, root, logLevel: 'silent', plugins: [previewWithoutApi()], build: { outDir: dist }, preview: { host: '127.0.0.1', port: 0, strictPort: true, proxy: {} } });
    try {
      const port = portOf(server.httpServer as Server);
      for (const method of ['GET', 'POST']) {
        const reply = await call(port, '/api/local/course-sync', { method, headers: { host: `127.0.0.1:${port}`, accept: '*/*' } });
        expect([reply.status, reply.json()]).toEqual([404, { error: 'NOT_FOUND' }]);
      }
      expect((await call(port, '/', { headers: { host: `127.0.0.1:${port}` } })).body).toContain('synthetic build');
      expect(forwarded).toBe(0);
    } finally { await server.close(); }
  });
});
