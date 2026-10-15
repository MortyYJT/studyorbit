import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { ConversationService } from '../../src/agent/conversations.js';
import { SyntheticAdapter } from '../agent/synthetic.js';
import { startHttpTransport } from '../../src/protocol/http.js';
import { createOwnerSession } from '../../src/protocol/owner-session.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { Registry } from '../../src/protocol/registry.js';
// Keep routing and authentication real; substitute only the OS listen boundary.
const socket = vi.hoisted(() => ({ listener: undefined as any }));
vi.mock('node:http', () => ({ createServer: (_options: unknown, listener: unknown) => {
  socket.listener = listener;
  const server = new EventEmitter() as any;
  server.listen = (_port: number, _host: string, callback: () => void) => callback();
  server.address = () => ({ address: '127.0.0.1', port: 1234 });
  server.setTimeout = () => {};
  server.close = (callback?: () => void) => callback?.();
  return server;
} }));
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function setup(adapter = new SyntheticAdapter()) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-http-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SqliteRepository(':memory:'); cleanup.push(() => store.close());
  const chat = new ConversationService(store, adapter);
  const session = createOwnerSession(); const secret = new URL(session.browserUrl('http://127.0.0.1:1234')).hash.slice(3);
  const transport = await startHttpTransport({ registry: new Registry(), context: createFakeContext(), capabilityDirectory: dir, ownerSession: session, chat });
  cleanup.push(() => transport.close());
  const capability = readFileSync(transport.capabilityFile, 'utf8').trim();
  return { chat, secret, capability };
}
function request(path: string, headers: Record<string, string | string[] | undefined> = {}, method = 'POST', input: unknown = {}, prepare?: (res: any) => void) {
  const req = new EventEmitter() as any;
  req.method = method; req.url = path; req.socket = { setTimeout() {} }; req.resume = () => {};
  req.rawHeaders = Object.entries({ Host: '127.0.0.1:1234', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers })
    .flatMap(([k, v]) => v === undefined ? [] : Array.isArray(v) ? v.flatMap(value => [k, value]) : [k, v]);
  const res = new EventEmitter() as any; let status = 0; let body = ''; let responseHeaders: Record<string, string> = {};
  res.writeHead = (code: number, values: Record<string, string>) => { status = code; responseHeaders = values; };
  res.write = (value: string) => { body += value; return true; };
  res.end = (value = '') => { body += value; res.writableEnded = true; res.emit('finish'); };
  res.destroy = () => { res.destroyed = true; res.emit('close'); };
  prepare?.(res);
  socket.listener(req, res); req.emit('data', Buffer.from(JSON.stringify(input))); req.emit('end');
  return { status: () => status, body: () => body, headers: () => responseHeaders, disconnect: () => res.destroy() };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
it('protects every chat route with the owner session, including SSE; a file capability grants no chat access', async () => {
  const { secret, capability, chat } = await setup();
  for (const [path, method] of [['/api/agent/create', 'POST'], ['/api/agent/list', 'GET'], ['/api/agent/open?conversation=x', 'GET'], ['/api/agent/stream?conversation=x', 'GET'], ['/api/agent/send', 'POST'], ['/api/agent/stop', 'POST'], ['/api/agent/delete', 'POST']] as const) {
    for (const headers of [{}, { 'X-Coursework-Capability': capability }, { 'X-Coursework-Session': [secret, secret] }, { 'X-Coursework-Session': 'wrong' }]) {
      const response = request(path, headers, method); await tick(); expect(response.status()).toBe(403);
    }
  }
  expect(chat.list()).toEqual([]);
  const response = request('/api/agent/create', { 'X-Coursework-Session': secret }, 'POST', { title: 'Synthetic' }); await tick();
  expect(response.status()).toBe(200); expect(chat.list()).toHaveLength(1);
  for (const headers of [{ Origin: 'https://evil.invalid' }, { Host: 'evil.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = request('/api/agent/list', { 'X-Coursework-Session': secret, ...headers }, 'GET'); await tick(); expect(response.status()).toBe(403);
  }
});
it('waits for drain across large replay events and delivers live events in cursor order', async () => {
  const { chat, secret } = await setup(new SyntheticAdapter([
    { type: 'tool_step', tool: 'read', outcome: 'ok', output: 'x'.repeat(1024 * 1024) },
    { type: 'text', text: 'After large output' }, { type: 'result', turns: 1 },
  ]));
  const owner = { assertOwner: async () => {} };
  const c = await chat.create({ title: 'Backpressure' }, owner);
  await chat.send(c.id, 'Offline', owner); await chat.waitForIdle(c.id);
  let response: any;
  let writes = 0;
  const stream = request(`/api/agent/stream?conversation=${c.id}`, { 'X-Coursework-Session': secret }, 'GET', {}, res => {
    response = res;
    const write = res.write;
    res.write = (text: string) => { write(text); return ++writes > 2; };
  });
  cleanup.push(() => stream.disconnect());
  await tick();
  expect(response.destroyed).not.toBe(true);
  expect(writes).toBe(1);
  await chat.send(c.id, 'While replay is blocked', owner); await chat.waitForIdle(c.id);
  expect(writes).toBe(1);
  response.emit('drain');
  expect(writes).toBe(2);
  response.emit('drain');
  const expected = chat.events(c.id).map(stored => `id: ${stored.id}\nevent: ${stored.event.type}\ndata: ${JSON.stringify(stored)}\n\n`).join('');
  expect(stream.body()).toBe(expected);
  await chat.send(c.id, 'Live', owner); await chat.waitForIdle(c.id);
  expect([...stream.body().matchAll(/^id: (.+)$/gm)].map(match => match[1])).toEqual(chat.events(c.id).map(event => event.id));
  const write = response.write;
  response.write = (text: string) => { write(text); return false; };
  await chat.send(c.id, 'Deleted while blocked', owner); await chat.waitForIdle(c.id);
  await chat.delete(c.id, owner);
  expect(() => response.emit('drain')).not.toThrow();
  expect(response.destroyed).toBe(true);
  expect(response.listenerCount('drain')).toBe(0);
});
it('returns a reply id immediately, streams in order, stores while disconnected and replays Last-Event-ID without duplicates', async () => {
  const { chat, secret } = await setup(); const owner = { assertOwner: async () => {} };
  const conversation = await chat.create({ title: 'Synthetic' }, owner);
  const headers = { 'X-Coursework-Session': secret };
  const stream = request(`/api/agent/stream?conversation=${conversation.id}`, headers, 'GET'); await tick();
  expect(stream.headers()['Content-Type']).toContain('text/event-stream');
  const sent = request('/api/agent/send', headers, 'POST', { conversationId: conversation.id, prompt: 'Hello' }); await tick();
  expect(sent.status()).toBe(200); expect(JSON.parse(sent.body()).data.messageId).toBeTruthy();
  await chat.waitForIdle(conversation.id);
  expect(stream.body().match(/^id:/gm)).toHaveLength(4);
  stream.disconnect();
  await chat.send(conversation.id, 'Offline', owner); await chat.waitForIdle(conversation.id);
  const replay = request(`/api/agent/stream?conversation=${conversation.id}`, { ...headers, 'Last-Event-ID': '1:1' }, 'GET'); await tick();
  const ids = [...replay.body().matchAll(/^id: (.+)$/gm)].map(m => m[1]);
  expect(ids).toEqual(['1:2', '1:3', '3:0', '3:1', '3:2', '3:3']);
  expect(new Set(ids).size).toBe(ids.length); replay.disconnect();
  const invalid = request(`/api/agent/stream?conversation=${conversation.id}`, { ...headers, 'Last-Event-ID': ['1:1', '1:1'] }, 'GET'); await tick(); expect(invalid.status()).toBe(400);
  const stopped = request('/api/agent/stop', headers, 'POST', { conversationId: conversation.id }); await tick(); expect(stopped.status()).toBe(200);
  const deleted = request('/api/agent/delete', headers, 'POST', { conversationId: conversation.id }); await tick(); expect(deleted.status()).toBe(200);
});
it('production composition exposes the durable chat service and passes it into the UI host', async () => {
  const { createProductionProtocol } = await import('../../src/protocol/production.js');
  const { ProtocolFiles } = await import('../../src/protocol/files.js');
  const dir = mkdtempSync(join(tmpdir(), 'agent-production-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SqliteRepository(':memory:'); cleanup.push(() => store.close());
  const host = createProductionProtocol({ store, files: new ProtocolFiles(dir), agentAdapter: new SyntheticAdapter() });
  const c = await host.chat.create({ title: 'Production' }, { assertOwner: async () => {} });
  await host.chat.send(c.id, 'Hello', { assertOwner: async () => {} }); await host.chat.waitForIdle(c.id);
  expect(store.readMessages(c.id)).toHaveLength(2);
  const noAdapter = createProductionProtocol({ store, files: new ProtocolFiles(dir) });
  const unavailable = await noAdapter.chat.create({ title: 'Unavailable' }, { assertOwner: async () => {} });
  await noAdapter.chat.send(unavailable.id, 'Hello', { assertOwner: async () => {} }); await noAdapter.chat.waitForIdle(unavailable.id);
  expect(noAdapter.chat.events(unavailable.id).at(-1)!.event).toMatchObject({ type: 'error', code: 'AGENT_UNAVAILABLE' });
});
