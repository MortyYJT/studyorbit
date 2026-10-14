import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Registry } from '../../src/protocol/registry.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { createOwnerSession } from '../../src/protocol/owner-session.js';
import { startHttpTransport } from '../../src/protocol/http.js';
// Replace only the OS socket boundary; all routing, authentication and disk reads are real.
const socket = vi.hoisted(() => ({ listener: undefined as any, close: vi.fn() }));
vi.mock('node:http', () => ({ createServer: (_options: unknown, listener: unknown) => {
  socket.listener = listener;
  const server = new EventEmitter() as any;
  server.listen = (_port: number, _host: string, cb: () => void) => cb();
  server.address = () => ({ address: '127.0.0.1', port: 1234 });
  server.setTimeout = () => {};
  server.close = (cb?: () => void) => { socket.close(); cb?.(); };
  return server;
} }));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'http-owner-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const ui = join(dir, 'ui'); await mkdir(join(ui, 'assets'), { recursive: true });
  await writeFile(join(ui, 'index.html'), '<html>synthetic</html>');
  await writeFile(join(ui, 'assets', 'main.js'), 'synthetic script');
  await writeFile(join(ui, 'private.txt'), 'private fixture');
  const registry = new Registry(); let writes = 0;
  for (const name of ['policy.record', 'planning.settings.record']) registry.register({ name, input: z.strictObject({}), output: z.strictObject({}), level: 0, handler: () => { writes++; return {}; } });
  const session = createOwnerSession();
  const transport = await startHttpTransport({ registry, context: createFakeContext({ owner: true }), capabilityDirectory: dir, ownerSession: session, staticDirectory: ui });
  cleanup.push(() => transport.close());
  const secret = new URL(session.browserUrl(transport.origin)).hash.slice(3);
  return { dir, ui, transport, secret, registry, writes: () => writes };
}
async function request(path: string, headers: Record<string, string | string[] | undefined> = {}, method = 'POST') {
  const req = new EventEmitter() as any;
  req.url = path; req.method = method; req.rawHeaders = Object.entries({ Host: '127.0.0.1:1234', 'Content-Type': 'application/json', ...headers }).flatMap(([key, value]) => value === undefined ? [] : Array.isArray(value) ? value.flatMap(v => [key, v]) : [key, value]);
  req.socket = { setTimeout() {} }; req.resume = () => {};
  const res = new EventEmitter() as any; let status = 0; let resultHeaders: Record<string, string> = {};
  const finished = new Promise<{ status: number; body: string; headers: Record<string, string> }>(resolve => {
    res.writeHead = (code: number, values: Record<string, string>) => { status = code; resultHeaders = values; };
    res.end = (body: string | Buffer) => { res.writableEnded = true; res.emit('finish'); resolve({ status, body: String(body), headers: resultHeaders }); };
    res.destroy = () => { res.destroyed = true; res.emit('close'); };
  });
  socket.listener(req, res);
  req.emit('data', Buffer.from('{}')); req.emit('end');
  return finished;
}
it('owner HTTP requires a unique session header; file capability and stale sessions never grant authority', async () => {
  const { secret, transport, writes, dir } = await setup();
  const token = (await readFile(transport.capabilityFile, 'utf8')).trim();
  for (const headers of [{}, { 'X-Coursework-Capability': token }, { 'X-Coursework-Session': 'wrong' }, { 'X-Coursework-Session': [secret, secret] }, { 'X-Coursework-Session': createOwnerSession().browserUrl(transport.origin).split('#s=')[1]! }]) {
    expect((await request('/api/policy.record', headers)).status).toBe(403);
  }
  expect(writes()).toBe(0);
  for (const name of ['policy.record', 'planning.settings.record']) expect((await request(`/api/${name}`, { 'X-Coursework-Session': secret })).status).toBe(200);
  expect(writes()).toBe(2);
  for (const file of await readdir(dir, { recursive: true })) {
    try { expect(await readFile(join(dir, file), 'utf8')).not.toContain(secret); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error; }
  }
});
it('Host and Origin restrictions remain enforced with a valid owner session', async () => {
  const { secret, writes } = await setup();
  for (const headers of [{ Host: 'evil.invalid' }, { Origin: 'https://evil.invalid' }, { Origin: 'null' }, { Origin: ['http://127.0.0.1:1234', 'http://127.0.0.1:1234'] }, { 'Sec-Fetch-Site': 'cross-site' }]) expect((await request('/api/policy.record', { ...headers, 'X-Coursework-Session': secret })).status).toBe(403);
  expect(writes()).toBe(0);
});
it('static allow-list serves the index and assets while API routes take precedence', async () => {
  const { ui, secret } = await setup();
  expect(await request('/', {}, 'GET')).toMatchObject({ status: 200, body: '<html>synthetic</html>' });
  expect(await request('/assets/main.js', {}, 'GET')).toMatchObject({ status: 200, body: 'synthetic script', headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
  expect((await request('/private.txt', {}, 'GET')).status).toBe(404);
  await mkdir(join(ui, 'api')); await writeFile(join(ui, 'api', 'policy.record'), 'never serve');
  expect((await request('/api/policy.record', {}, 'GET')).status).toBe(405);
  expect((await request('/api/policy.record', { 'X-Coursework-Session': secret })).status).toBe(200);
});
it('static serving rejects traversal and symlinks even when their targets are allow-listed', async () => {
  const { dir, ui } = await setup();
  await writeFile(join(dir, 'outside.js'), 'private fixture');
  await symlink(join(dir, 'outside.js'), join(ui, 'assets', 'linked.js'));
  await symlink(join(ui, 'assets'), join(ui, 'assets', 'linked'));
  for (const path of ['/../outside.js', '/assets/../../outside.js', '/assets/%2e%2e/%2e%2e/outside.js', '/assets/%2foutside.js', '/assets/linked.js', '/assets/linked/main.js']) expect((await request(path, {}, 'GET')).status).toBe(404);
});
it('UI bootstrap checks the build, opens the system browser with a memory-only session and invalidates it on restart', async () => {
  const { ui, dir } = await setup();
  const { startOwnerUI } = await import('../../src/protocol/http-host.js');
  const registry = new Registry(); registry.register({ name: 'policy.record', level: 0, input: z.strictObject({}), output: z.strictObject({}), handler: () => ({}) });
  let opened = ''; const messages: string[] = [];
  const options = { staticDirectory: ui, capabilityDirectory: dir, opener: async (url: string) => { opened = url; }, output: (value: string) => messages.push(value) };
  const first = await startOwnerUI({ registry, context: createFakeContext() }, options);
  const oldSecret = new URL(opened).hash.slice(3);
  expect(oldSecret).toMatch(/^[a-f0-9]{64}$/);
  expect((await request('/api/policy.record', { 'X-Coursework-Session': oldSecret })).status).toBe(200);
  await first.close();
  const second = await startOwnerUI({ registry, context: createFakeContext() }, options); cleanup.push(() => second.close());
  expect((await request('/api/policy.record', { 'X-Coursework-Session': oldSecret })).status).toBe(403);
  expect(messages).toEqual([]);
  for (const file of await readdir(dir, { recursive: true })) {
    try { expect(await readFile(join(dir, file), 'utf8')).not.toContain(oldSecret); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error; }
  }
  await expect(startOwnerUI({ registry, context: createFakeContext() }, { ...options, staticDirectory: join(dir, 'missing') })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
});

it('withholds the owner session from agent read responses even without a session request header', async () => {
  const { registry, secret } = await setup();
  registry.register({ name: 'synthetic.read', level: 0, input: z.strictObject({}), output: z.string(), handler: () => `accidental credential: ${secret}` });
  const response = await request('/api/synthetic.read');
  expect(response.status).toBe(500);
  expect(response.body).not.toContain(secret);
});

it.each([false, true])('UI opener failure only exposes the fallback URL to a TTY (isTTY=%s)', async isTTY => {
  const { ui, dir, registry } = await setup();
  const { startOwnerUI } = await import('../../src/protocol/http-host.js');
  const messages: string[] = []; let attempted = '';
  const closesBefore = socket.close.mock.calls.length;
  const options = {
    staticDirectory: ui, capabilityDirectory: dir, isTTY,
    opener: async (url: string) => { attempted = url; throw new Error(`Opener failed: ${url}`); },
    output: (value: string) => messages.push(value),
  };
  const result = await startOwnerUI({ registry, context: createFakeContext() }, options)
    .then(transport => { cleanup.push(() => transport.close()); return { transport, error: undefined }; },
      (error: unknown) => ({ transport: undefined, error }));
  const secret = new URL(attempted).hash.slice(3);
  expect(secret).toMatch(/^[a-f0-9]{64}$/);
  if (isTTY) {
    expect(result.error).toBeUndefined();
    expect(messages).toEqual([attempted]);
    expect(socket.close.mock.calls.length).toBe(closesBefore);
  } else {
    expect.soft(messages.some(message => message.includes(secret))).toBe(false);
    expect.soft(socket.close.mock.calls.length).toBe(closesBefore + 1);
    expect.soft(result.error).toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('Run coursework ui from a terminal') });
    expect(String(result.error).includes(secret)).toBe(false);
  }
});
