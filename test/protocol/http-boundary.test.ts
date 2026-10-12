/** Socket-free boundary tests supplement, but never replace, http.test.ts's real loopback tests. */
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
const http = vi.hoisted(() => ({ listener: undefined as any, bind: undefined as any }));
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return { createServer: (_options: unknown, listener: unknown) => {
    http.listener = listener;
    return Object.assign(new EventEmitter(), {
      listen: (port: number, host: string, callback: () => void) => { http.bind = { port, host }; callback(); },
      address: () => ({ address: '127.0.0.1', port: 12345 }),
      setTimeout: () => {}, close: (callback?: () => void) => callback?.(),
    });
  } };
});
import { startHttpTransport, httpStatus, type HttpTransport } from '../../src/protocol/http.js';
import { Registry, dispatch } from '../../src/protocol/registry.js';
import { createFakeContext, createFakeRegistry, examples, FakeServices } from '../../src/protocol/fakes.js';
import { contracts, ownerCommands } from '../../src/protocol/contracts.js';
import { CourseworkError, retryable } from '../../src/protocol/errors.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(maxActiveRequests = 32) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'coursework-http-boundary-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const registry = new Registry(); const context = createFakeContext({ owner: true });
  const handler = vi.fn(async () => ({ value: 'safe' }));
  registry.register({ name: 'synthetic', input: z.strictObject({}), output: z.strictObject({ value: z.string() }), level: 0, handler });
  const server = await startHttpTransport({ registry, context, capabilityDirectory: directory, bodyTimeoutMs: 20, maxActiveRequests });
  cleanup.push(() => server.close());
  return { server, token: (await readFile(server.capabilityFile, 'utf8')).trim(), registry, context, handler };
}
function send(server: HttpTransport, body: string | Buffer = '{}', headers: string[] = [], path = '/api/synthetic', method = 'POST', complete = true) {
  return new Promise<{ status: number; body: any; text: string; headers: any }>(resolve => {
    const req = Object.assign(new EventEmitter(), { rawHeaders: ['Host', new URL(server.origin).host, 'Content-Type', 'application/json', ...headers], url: path, method });
    const res = Object.assign(new EventEmitter(), {
      destroyed: false, writableEnded: false, status: 0, headers: {},
      writeHead(status: number, values: object) { this.status = status; this.headers = values; },
      end(text: string) { this.writableEnded = true; res.emit('finish'); resolve({ status: this.status, body: JSON.parse(text), text, headers: this.headers }); },
      destroy() { this.destroyed = true; res.emit('close'); },
    });
    http.listener(req, res); req.emit('data', Buffer.isBuffer(body) ? body : Buffer.from(body));
    if (complete) req.emit('end');
  });
}
const core = (value: any) => { const { meta: _meta, ...rest } = value; return rest; };

it('requests IPv4 loopback only and creates/cleans a private capability without returning it', async () => {
  const { server, token } = await setup();
  expect(http.bind).toEqual({ port: 0, host: '127.0.0.1' }); expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect((await send(server)).text).not.toContain(token);
  await server.close(); await server.close(); await expect(readFile(server.capabilityFile)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('generates every registered route, and capability gates all mutations/owner commands before dispatch', async () => {
  const { server, registry, context, token } = await setup();
  for (const entry of createFakeRegistry().list()) registry.register(entry);
  for (const name of Object.keys(contracts) as (keyof typeof contracts)[]) {
    const body = JSON.stringify(examples[name].input);
    if (contracts[name].level > 0 || ownerCommands.has(name)) expect((await send(server, body, [], `/api/${name}`)).status, name).toBe(403);
    const response = await send(server, body, ['X-Coursework-Capability', token], `/api/${name}`);
    expect(response.status, name).toBe(200); expect(response.body.ok, name).toBe(true);
  }
  expect((context.services as FakeServices).writes.length).toBeGreaterThan(0);
});
it('rejects duplicate/forged Host and Origin and unsafe fetch metadata regardless of credential', async () => {
  const { server, token, handler } = await setup();
  for (const headers of [['Host', 'evil.invalid'], ['Origin', 'null'], ['Origin', 'https://evil.invalid'],
    ['Origin', server.origin, 'Origin', server.origin], ['Sec-Fetch-Site', 'cross-site'], ['Sec-Fetch-Site', 'same-site']]) {
    expect((await send(server, '{}', [...headers, 'X-Coursework-Capability', token])).status).toBe(403);
  }
  expect(handler).not.toHaveBeenCalled();
  expect((await send(server, '{}', ['Origin', server.origin])).status).toBe(200);
});
it('rejects malformed/invalid UTF-8, owner flags, unknown paths/methods and bounded request bodies', async () => {
  const { server, token, handler } = await setup();
  for (const body of ['{', '', '{"owner":true}', '{"confirmed":true}', Buffer.from([0xff])]) {
    expect((await send(server, body, ['X-Coursework-Capability', token])).status).toBe(400);
  }
  expect((await send(server, '{}', [], '/api/missing')).status).toBe(404);
  expect((await send(server, '{}', [], '/api/synthetic?x=1')).status).toBe(404);
  expect((await send(server, '{}', [], '/api/synthetic', 'OPTIONS')).status).toBe(405);
  expect((await send(server, '{}', [], `/api/${'x'.repeat(1100)}`)).status).toBe(414);
  expect((await send(server, 'x'.repeat(65537))).status).toBe(413);
  expect((await send(server, '{}', ['Content-Length', '65537'])).status).toBe(413);
  expect((await send(server, '{}', ['Content-Encoding', 'gzip'])).status).toBe(415);
  expect((await send(server, '{}', Array.from({ length: 65 }, (_, i) => [`X-${i}`, 'value']).flat())).status).toBe(431);
  expect(handler).not.toHaveBeenCalled();
});
it('times out incomplete bodies before handler execution', async () => {
  const { server, handler } = await setup();
  expect((await send(server, '{', [], '/api/synthetic', 'POST', false)).status).toBe(408);
  expect(handler).not.toHaveBeenCalled();
});
it('matches dispatcher data/error semantics and executes exactly once, or zero times on validation/authorization failure', async () => {
  const { server, registry, context, handler } = await setup();
  for (const input of [{}, { invalid: true }]) {
    const expected = await dispatch(registry, 'synthetic', input, context); handler.mockClear();
    const response = await send(server, JSON.stringify(input));
    expect(core(response.body)).toEqual(core(expected)); expect(response.status).toBe(httpStatus(expected));
    expect(handler).toHaveBeenCalledTimes(expected.ok ? 1 : 0);
  }
  context.authorization.check = async () => { throw new CourseworkError('INVALID_INPUT', 'private'); };
  handler.mockClear(); expect((await send(server)).status).toBe(400); expect(handler).not.toHaveBeenCalled();
  context.authorization.check = async () => {};
  for (const code of Object.keys(retryable) as (keyof typeof retryable)[]) {
    handler.mockRejectedValue(new CourseworkError(code, 'private-secret'));
    const expected = await dispatch(registry, 'synthetic', {}, context); handler.mockClear();
    const response = await send(server);
    expect(core(response.body)).toEqual(core(expected)); expect(response.status).toBe(httpStatus(expected));
    expect(response.text).not.toContain('private-secret'); expect(handler).toHaveBeenCalledTimes(1);
  }
});
it('withholds invalid/oversized output and the bootstrap secret itself, with no CORS headers', async () => {
  const { server, handler, token } = await setup();
  for (const output of [{ value: 1 }, { value: '字 '.repeat(30000) }, { value: token }]) {
    handler.mockResolvedValue(output as never); handler.mockClear();
    const response = await send(server);
    expect(response.body.ok).toBe(false); expect(response.text).not.toContain(token);
    expect(Buffer.byteLength(response.text)).toBeLessThanOrEqual(65536);
    expect(response.headers['Access-Control-Allow-Origin']).toBeUndefined(); expect(handler).toHaveBeenCalledTimes(1);
  }
});
it('holds concurrency capacity until handler completion', async () => {
  const { server, handler } = await setup(1); let release!: () => void;
  handler.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return { value: 'safe' }; });
  const first = send(server); await vi.waitFor(() => expect(release).toBeDefined());
  expect((await send(server)).status).toBe(503); expect(handler).toHaveBeenCalledTimes(1);
  release(); expect((await first).status).toBe(200);
});
