import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { startHttpTransport } from '../../src/protocol/http.js';
import { createOwnerSession } from '../../src/protocol/owner-session.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { Registry } from '../../src/protocol/registry.js';
const socket = vi.hoisted(() => ({ listener: undefined as any }));
vi.mock('node:http', () => ({ createServer: (_options: unknown, listener: unknown) => {
  socket.listener = listener; const server = new EventEmitter() as any;
  server.listen = (_p: number, _h: string, cb: () => void) => cb(); server.address = () => ({ address: '127.0.0.1', port: 1234 });
  server.setTimeout = () => {}; server.close = (cb: () => void) => cb(); return server;
} }));
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });
function request(url: string, secret?: string) {
  const req = new EventEmitter() as any; req.url = url; req.method = 'GET'; req.resume = () => {}; req.socket = { setTimeout() {} };
  req.rawHeaders = ['Host', '127.0.0.1:1234', ...(secret ? ['X-Coursework-Session', secret] : [])];
  const res = new EventEmitter() as any;
  return new Promise<{ status: number; body: Buffer; headers: Record<string, string> }>(resolve => {
    let status = 0; let headers: Record<string, string> = {};
    res.writeHead = (s: number, h: Record<string, string>) => { status = s; headers = h; };
    res.end = (body: string | Buffer) => { res.writableEnded = true; res.emit('finish'); resolve({ status, body: Buffer.from(body), headers }); };
    socket.listener(req, res); req.emit('end');
  });
}
it('11.5 focus and screenshot retrieval require the owner session and reject malformed references', async () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-http-')); cleanup.push(() => rmSync(root, { recursive: true, force: true })); vi.stubEnv('COURSEWORK_HOME', root);
  const registry = new Registry(); const focus = vi.fn(async () => ({}));
  registry.register({ name: 'browser.view', level: 0, authority: 'owner-session', input: z.object({ tabId: z.uuid() }), output: z.object({}), handler: focus });
  const session = createOwnerSession(); const secret = session.browserUrl('http://127.0.0.1:1234').split('#s=')[1]!;
  const transport = await startHttpTransport({ registry, context: createFakeContext(), ownerSession: session, capabilityDirectory: root }); cleanup.push(() => transport.close());
  const id = randomUUID(); mkdirSync(join(root, 'screenshots')); writeFileSync(join(root, 'screenshots', `${id}.png`), 'synthetic PNG');
  expect((await request(`/api/browser.view?tabId=${id}`)).status).toBe(403);
  expect((await request(`/api/browser.image?screenshotRef=${id}`)).status).toBe(403);
  expect((await request(`/api/browser.view?tabId=${id}`, secret)).status).toBe(200); expect(focus).toHaveBeenCalledOnce();
  const image = await request(`/api/browser.image?screenshotRef=${id}`, secret); expect(image.status).toBe(200); expect(image.headers['Content-Type']).toBe('image/png'); expect(image.body.toString()).toBe('synthetic PNG');
  expect((await request('/api/browser.image?screenshotRef=../../private', secret)).status).toBe(400);
  expect((await request(`/api/browser.view?tabId=${id}&tabId=${id}`, secret)).status).toBe(400); expect(focus).toHaveBeenCalledOnce();
});
