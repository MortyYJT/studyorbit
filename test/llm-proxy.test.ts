import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createLlmProxy, type LlmProxy } from '../server/llm-proxy.ts';
import { call, closeServer, listen, open } from './local-api-helpers.ts';

// The loopback model proxy (decision #542): DeepTutor gets this address and a launch token; the real key is added here
// and never leaves StudyOrbit's process. A stub upstream stands in for the provider; no real key, no real model.
const KEY = 'sk-synthetic-key-0123456789';
const TOKEN = 'a'.repeat(64);
let upstream: Server | undefined, proxy: LlmProxy | undefined;
const seen: { method?: string; url?: string; headers: IncomingHttpHeaders; body: string }[] = [];
const lines: string[] = [];

async function start({ key = KEY as string | null, reply }: { key?: string | null; reply?: (res: import('node:http').ServerResponse) => void } = {}) {
  upstream = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (reply) { reply(res); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"usage":{"total_tokens":3}}');
  });
  const upstreamPort = await listen(upstream);
  proxy = createLlmProxy({ token: TOKEN, upstream: `http://127.0.0.1:${upstreamPort}/base`, resolveKey: async () => key, log: line => lines.push(line) });
  return proxy.listen(0);
}
const request = (port: number, path: string, options: { method?: string; headers?: Record<string, string | undefined>; body?: string } = {}) =>
  call(port, path, { method: options.method ?? 'POST', body: options.body ?? '{"model":"m","input":"hi"}', headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...options.headers } });

afterEach(async () => { await proxy?.close(); proxy = undefined; await closeServer(upstream); upstream = undefined; seen.length = 0; lines.length = 0; });

describe('model proxy', () => {
  it('forwards an allowed request unchanged with the real key instead of the launch token', async () => {
    const port = await start();
    const reply = await request(port, '/responses', { body: '{"model":"m","input":"你好"}' });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('{"usage":{"total_tokens":3}}');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/base/responses', body: '{"model":"m","input":"你好"}' });
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(seen[0]!.headers)).not.toContain(TOKEN);
    expect((await request(port, '/chat/completions')).status).toBe(200);
    expect((await request(port, '/models', { method: 'GET', body: undefined })).status).toBe(200);
  });

  it('refuses a wrong or missing token, a foreign Host, any Origin and paths or methods off the list, sending nothing upstream', async () => {
    const port = await start();
    expect((await request(port, '/responses', { headers: { authorization: `Bearer ${'b'.repeat(64)}` } })).status).toBe(403);
    expect((await request(port, '/responses', { headers: { authorization: undefined } })).status).toBe(403);
    expect((await request(port, '/responses', { headers: { authorization: TOKEN } })).status).toBe(403);
    expect((await request(port, '/responses', { headers: { host: `evil.example:${port}` } })).status).toBe(403);
    expect((await request(port, '/responses', { headers: { host: 'localhost:1' } })).status).toBe(403);
    expect((await request(port, '/responses', { headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(403);
    expect((await request(port, '/embeddings')).status).toBe(403);
    expect((await request(port, '/responses?x=1')).status).toBe(403);
    expect((await request(port, '/../responses')).status).toBe(403);
    expect((await request(port, '/models')).status).toBe(403);
    expect((await request(port, '/responses', { method: 'GET', body: undefined })).status).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('answers 503 without calling the provider when StudyOrbit has no key', async () => {
    const port = await start({ key: null });
    const reply = await request(port, '/responses');
    expect(reply.status).toBe(503);
    expect(seen).toHaveLength(0);
  });

  it('streams the reply as it arrives and passes the status through', async () => {
    let finish!: () => void;
    const port = await start({ reply: res => { res.writeHead(429, { 'Content-Type': 'text/event-stream' }); res.write('data: one\n\n'); finish = () => res.end('data: two\n\n'); } });
    const res = await open(port, '/responses', { method: 'POST', body: '{}', headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } }).response;
    expect(res.statusCode).toBe(429);
    expect(res.headers['content-type']).toBe('text/event-stream');
    res.setEncoding('utf8');
    const first = await new Promise<string>(resolve => res.once('data', resolve));
    expect(first).toBe('data: one\n\n');
    finish();
    let rest = '';
    for await (const chunk of res) rest += chunk;
    expect(rest).toBe('data: two\n\n');
  });

  it('answers 502 when the provider cannot be reached, and 413 for an oversized body', async () => {
    const port = await start();
    await closeServer(upstream);
    expect((await request(port, '/responses')).status).toBe(502);
    expect((await request(port, '/responses', { body: 'x'.repeat(21 * 1024 * 1024) })).status).toBe(413);
  });

  it('never logs the key, the token, a header or a body', async () => {
    const port = await start();
    await request(port, '/responses', { body: '{"input":"private-question"}' });
    await request(port, '/responses', { headers: { authorization: 'Bearer wrong-token-value' }, body: '{"input":"private-question"}' });
    await closeServer(upstream);
    await request(port, '/responses', { body: '{"input":"private-question"}' });
    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [KEY, TOKEN, 'wrong-token-value', 'private-question', 'Bearer']) expect(all).not.toContain(secret);
  });
});
