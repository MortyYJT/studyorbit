import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, readFile, stat, readdir, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { startHttpTransport, httpStatus, type HttpTransport } from '../../src/protocol/http.js';
import { Registry, dispatch } from '../../src/protocol/registry.js';
import { createFakeContext, createFakeRegistry, examples, FakeServices } from '../../src/protocol/fakes.js';
import { contracts } from '../../src/protocol/contracts.js';
import { CourseworkError, retryable } from '../../src/protocol/errors.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(options: { bodyTimeoutMs?: number; maxActiveRequests?: number; requestTimeoutMs?: number } = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'coursework-http-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const registry = new Registry();
  const handler = vi.fn(async () => ({ value: 'safe' }));
  registry.register({ name: 'synthetic', input: z.strictObject({}), output: z.strictObject({ value: z.string() }), level: 0, handler });
  const context = createFakeContext({ owner: true });
  const server = await startHttpTransport({ registry, context, capabilityDirectory: directory, port: 0, ...options });
  cleanup.push(() => server.close());
  const token = (await readFile(server.capabilityFile, 'utf8')).trim();
  return { server, token, directory, registry, context, handler };
}
async function send(server: HttpTransport, body = '{}', headers: Record<string, string | string[]> = {}, path = '/api/synthetic', method = 'POST') {
  return new Promise<{ status: number; body: any; text: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request(`${server.origin}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode!, body: JSON.parse(text), text, headers: res.headers });
      });
    });
    req.on('error', reject); req.end(body);
  });
}
/** Raw request for header shapes node's client refuses to send (e.g. duplicate Host). Returns the status code. */
async function sendRaw(server: HttpTransport, headerLines: string[], body = '{}') {
  return new Promise<number>((resolve, reject) => {
    const socket = connect(Number(new URL(server.origin).port), '127.0.0.1');
    let text = '';
    socket.on('data', c => { text += c; });
    // A reset after the response arrived is expected once the server closes; only the response matters.
    socket.on('error', () => {});
    socket.on('close', () => {
      const match = /^HTTP\/1\.1 (\d{3}) /.exec(text);
      if (match) resolve(Number(match[1])); else reject(new Error('no HTTP response'));
    });
    socket.on('connect', () => socket.write(['POST /api/synthetic HTTP/1.1', 'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`, ...headerLines, '', body].join('\r\n')));
  });
}
function withoutMeta(result: any) { const { meta: _meta, ...rest } = result; return rest; }

describe('generated loopback HTTP transport', () => {
  it('binds only IPv4 loopback, creates a private random capability and removes it on idempotent close', async () => {
    const { server, token } = await setup();
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(server.capabilityFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(server.capabilityFile, '..'))).mode & 0o777).toBe(0o700);
    const second = await setup(); expect(second.token).not.toBe(token);
    await server.close(); await server.close();
    await expect(stat(server.capabilityFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(send(server)).rejects.toBeDefined();
  });
  it('derives all routes from the registry and supplies owner authority only after local capability verification', async () => {
    const { server, registry, token, context } = await setup();
    for (const entry of createFakeRegistry().list()) registry.register(entry);
    for (const name of Object.keys(contracts) as (keyof typeof contracts)[]) {
      const response = await send(server, JSON.stringify(examples[name].input), { 'X-Coursework-Capability': token }, `/api/${name}`);
      expect(response.status, name).toBe(200);
      expect(response.body.ok, name).toBe(true);
      expect(response.text).not.toContain(token);
    }
    expect((context.services as FakeServices).writes.length).toBeGreaterThan(0);
  });
  it.each([
    ['{', '/api/synthetic', 'POST', 400], ['', '/api/synthetic', 'POST', 400],
    ['{}', '/api/missing', 'POST', 404], ['{}', '/api/synthetic?owner=true', 'POST', 404],
    ['{}', '/api/%73ynthetic', 'POST', 404], ['{}', '/', 'POST', 404],
    ['{}', '/api/synthetic', 'GET', 405], ['{}', '/api/synthetic', 'OPTIONS', 405],
  ])('rejects framing %s %s %s', async (body, path, method, status) => {
    const { server, handler } = await setup();
    const response = await send(server, body, {}, path, method);
    expect(response.status).toBe(status); expect(response.body.ok).toBe(false);
    expect(response.headers['access-control-allow-origin']).toBeUndefined(); expect(handler).not.toHaveBeenCalled();
  });
  it('requires JSON, rejects encodings and bounds received bytes and headers', async () => {
    const { server, handler } = await setup();
    expect((await send(server, '{}', { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await send(server, '{}', { 'Content-Encoding': 'gzip' })).status).toBe(415);
    expect((await send(server, ' '.repeat(65537), { 'Transfer-Encoding': 'chunked' })).status).toBe(413);
    expect((await send(server, ' '.repeat(65537), { 'Content-Length': '65537' })).status).toBe(413);
    expect((await send(server, '{}', { 'X-Large': 'x'.repeat(9000) })).status).toBe(431);
    expect((await send(server, '{}', {}, `/api/${'x'.repeat(1100)}`)).status).toBe(414);
    expect(handler).not.toHaveBeenCalled();
  });
  it('times out incomplete bodies without execution and closes idle sockets on shutdown', async () => {
    const { server, handler } = await setup({ bodyTimeoutMs: 40 });
    const response = await new Promise<string>(resolve => {
      const socket = connect(Number(new URL(server.origin).port), '127.0.0.1');
      // The server may reset after its 408 because the declared body never arrived; the response text is asserted below.
      let text = ''; socket.on('error', () => {}); socket.on('data', c => { text += c; }); socket.on('close', () => resolve(text));
      socket.on('connect', () => socket.write(`POST /api/synthetic HTTP/1.1\r\nHost: ${new URL(server.origin).host}\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{`));
    });
    expect(response).toContain('408'); expect(handler).not.toHaveBeenCalled();
    const socket = connect(Number(new URL(server.origin).port), '127.0.0.1');
    socket.on('error', () => {}); // shutdown destroys idle sockets, which the client sees as ECONNRESET
    await new Promise<void>(resolve => socket.once('connect', resolve));
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    await server.close(); await closed;
  });
  it('bounds concurrent requests before dispatch', async () => {
    const { server, handler } = await setup({ maxActiveRequests: 1 });
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    handler.mockImplementationOnce(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return { value: 'safe' }; });
    const first = send(server); await started;
    try { expect((await send(server)).status).toBe(503); expect(handler).toHaveBeenCalledTimes(1); }
    finally { release(); await first; }
  });
  it('never dispatches a second request pipelined on the same connection', async () => {
    const { server, handler } = await setup();
    const one = ['POST /api/synthetic HTTP/1.1', `Host: ${new URL(server.origin).host}`, 'Content-Type: application/json',
      'Content-Length: 2', '', '{}'].join('\r\n');
    const text = await new Promise<string>(resolve => {
      const socket = connect(Number(new URL(server.origin).port), '127.0.0.1');
      let text = ''; socket.on('error', () => {}); socket.on('data', c => { text += c; }); socket.on('close', () => resolve(text));
      socket.on('connect', () => socket.write(one + one));
    });
    expect(text.match(/HTTP\/1\.1 \d{3}/g)).toEqual(['HTTP/1.1 200']);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('delivers a slow command response past the receive timeout, while incomplete bodies still time out unexecuted', async () => {
    const { server, handler } = await setup({ requestTimeoutMs: 300, bodyTimeoutMs: 100 });
    handler.mockImplementationOnce(async () => { await new Promise(resolve => setTimeout(resolve, 1200)); return { value: 'slow' }; });
    const response = await send(server);
    expect(response.status).toBe(200); expect(response.body.data).toEqual({ value: 'slow' }); expect(handler).toHaveBeenCalledTimes(1);
    handler.mockClear();
    const partial = await new Promise<string>(resolve => {
      const socket = connect(Number(new URL(server.origin).port), '127.0.0.1');
      let text = ''; socket.on('error', () => {}); socket.on('data', c => { text += c; }); socket.on('close', () => resolve(text));
      socket.on('connect', () => socket.write(`POST /api/synthetic HTTP/1.1\r\nHost: ${new URL(server.origin).host}\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{`));
    });
    expect(partial).toContain('408'); expect(handler).not.toHaveBeenCalled();
  });
  it('accepts a private capability directory under a symlinked parent but never a symlinked final directory', async () => {
    const { directory, registry, context } = await setup();
    const parent = join(directory, 'parent-link'); await symlink(directory, parent);
    const transport = await startHttpTransport({ registry, context, capabilityDirectory: join(parent, 'store') });
    cleanup.push(() => transport.close());
    expect((await stat(transport.capabilityFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'store'))).mode & 0o777).toBe(0o700);
    expect((await send(transport)).status).toBe(200);
    await symlink(join(directory, 'store'), join(directory, 'store-link'));
    await expect(startHttpTransport({ registry, context, capabilityDirectory: join(parent, 'store-link') })).rejects.toMatchObject({ code: 'INTERNAL' });
  });
  it('rejects unsafe capability storage and cleans failed startup', async () => {
    const { directory, registry, context, server } = await setup();
    const link = join(directory, 'link'); await symlink(directory, link);
    await expect(startHttpTransport({ registry, context, capabilityDirectory: link })).rejects.toMatchObject({ code: 'INTERNAL' });
    const before = await readdir(directory);
    await expect(startHttpTransport({ registry, context, capabilityDirectory: directory, port: Number(new URL(server.origin).port) })).rejects.toMatchObject({ code: 'INTERNAL' });
    expect(await readdir(directory)).toEqual(before);
  });
});

describe('HTTP security and dispatcher parity', () => {
  it('rejects forged Host, cross-origin/opaque/duplicate Origin and browser fetch metadata even with the capability', async () => {
    const { server, token, handler } = await setup();
    const forged: Record<string, string | string[]>[] = [{ Host: 'localhost:1234' }, { Host: 'evil.invalid' },
      { Origin: 'https://evil.invalid' }, { Origin: 'null' }, { Origin: [server.origin, server.origin] }, { 'Sec-Fetch-Site': 'cross-site' }];
    for (const headers of forged) {
      expect((await send(server, '{}', { ...headers, 'X-Coursework-Capability': token })).status).toBe(403);
    }
    // Node's client refuses duplicate Host, so send the duplicate-header cases as raw bytes.
    const host = new URL(server.origin).host;
    const capability = `X-Coursework-Capability: ${token}`;
    expect(await sendRaw(server, [`Host: ${host}`, capability])).toBe(200); // control: raw framing itself is accepted
    handler.mockClear();
    for (const lines of [[`Host: ${host}`, `Host: ${host}`], [`Host: ${host}`, `Origin: ${server.origin}`, `Origin: ${server.origin}`],
      [`Host: ${host}`, 'Sec-Fetch-Site: same-origin', 'Sec-Fetch-Site: same-origin']]) {
      expect(await sendRaw(server, [...lines, capability])).toBe(403);
    }
    expect(handler).not.toHaveBeenCalled();
    expect((await send(server, '{}', { Origin: server.origin })).status).toBe(200);
  });
  it('denies unauthenticated mutations and owner actions, even with a preexisting host owner or forged body flag', async () => {
    const { server, registry, token, context } = await setup();
    for (const entry of createFakeRegistry().list()) registry.register(entry);
    for (const name of ['revision.write', 'policy.record', 'quiz.review', 'quiz.prerequisites', 'quiz.fill', 'quiz.submit'] as const) {
      const input = JSON.stringify(examples[name].input);
      expect((await send(server, input, {}, `/api/${name}`)).status).toBe(403);
      expect((await send(server, input, { 'X-Coursework-Capability': 'wrong' }, `/api/${name}`)).status).toBe(403);
      expect((await send(server, JSON.stringify({ ...examples[name].input, owner: true }), { 'X-Coursework-Capability': token }, `/api/${name}`)).status).toBe(400);
    }
    expect((context.services as FakeServices).writes).toEqual([]); expect(context.actionCalls).toEqual([]);
  });
  it('withholds the local capability even if trusted output accidentally contains it; errors never reflect requests', async () => {
    const { server, token, handler } = await setup();
    handler.mockResolvedValueOnce({ value: token });
    const response = await send(server);
    expect(response.status).toBe(500); expect(response.text).not.toContain(token);
    handler.mockRejectedValueOnce(new Error(`private-path password=${token}`));
    expect((await send(server)).text).not.toContain(token);
    expect((await send(server, '{}', {}, `/api/${token}`)).text).not.toContain(token);
  });
  it('matches dispatcher successes, schema errors, authorization denial, invalid and oversized output; executes once per valid request', async () => {
    const { server, registry, context, handler } = await setup();
    for (const input of [{}, { unexpected: true }]) {
      const expected = await dispatch(registry, 'synthetic', input, context);
      handler.mockClear();
      const response = await send(server, JSON.stringify(input));
      expect(withoutMeta(response.body)).toEqual(withoutMeta(expected));
      expect(response.status).toBe(httpStatus(expected)); expect(handler).toHaveBeenCalledTimes(expected.ok ? 1 : 0);
    }
    context.authorization.check = async () => { throw new CourseworkError('INVALID_INPUT', 'private authorization'); };
    const denied = await dispatch(registry, 'synthetic', {}, context); handler.mockClear();
    expect(withoutMeta((await send(server)).body)).toEqual(withoutMeta(denied)); expect(handler).not.toHaveBeenCalled();
    context.authorization.check = async () => {};
    for (const output of [{ value: '字 '.repeat(30000) }, { value: 1 }]) {
      handler.mockResolvedValue(output as never);
      const expected = await dispatch(registry, 'synthetic', {}, context); handler.mockClear();
      const response = await send(server);
      expect(withoutMeta(response.body)).toEqual(withoutMeta(expected));
      expect(response.status).toBe(httpStatus(expected)); expect(handler).toHaveBeenCalledTimes(1);
      expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(65536);
    }
  });
  it('maps every dispatcher error consistently without exposing exception text', async () => {
    const { server, handler, registry, context } = await setup();
    for (const code of Object.keys(retryable) as (keyof typeof retryable)[]) {
      handler.mockRejectedValue(new CourseworkError(code, 'private-secret'));
      const expected = await dispatch(registry, 'synthetic', {}, context); handler.mockClear();
      const response = await send(server);
      expect(withoutMeta(response.body)).toEqual(withoutMeta(expected)); expect(response.status).toBe(httpStatus(expected));
      expect(response.text).not.toContain('private-secret'); expect(handler).toHaveBeenCalledTimes(1);
    }
  });
});
