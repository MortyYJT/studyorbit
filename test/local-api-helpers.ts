// Shared helpers for the local API server and proxy tests: a raw HTTP client (fetch cannot set `Host`), a fake
// OpenAI-compatible streaming model on loopback, and synthetic project data. Never the owner's files or a real model.
import { randomBytes } from 'node:crypto';
import { request as httpRequest, createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const syntheticToken = () => randomBytes(32).toString('hex');
export const portOf = (server: Server) => (server.address() as AddressInfo).port;

export function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(portOf(server)));
  });
}

export function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  server.closeAllConnections();
  return new Promise(resolve => server.close(() => resolve()));
}

export type Reply = { status: number; headers: IncomingHttpHeaders; body: string; json(): any };

/** Opens a request and resolves with the response as soon as its headers arrive. */
export function open(port: number, path: string, options: { method?: string; headers?: Record<string, string | undefined>; body?: string } = {}) {
  const headers = Object.fromEntries(Object.entries(options.headers ?? {}).filter(([, value]) => value !== undefined)) as Record<string, string>;
  // Node sends a DELETE body without framing unless Content-Length is set.
  if (options.body !== undefined) headers['content-length'] = String(Buffer.byteLength(options.body));
  const req = httpRequest({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, agent: false });
  const response = new Promise<IncomingMessage>((resolve, reject) => { req.on('response', resolve); req.on('error', reject); });
  req.end(options.body);
  return { req, response };
}

export async function call(port: number, path: string, options: Parameters<typeof open>[2] = {}): Promise<Reply> {
  const res = await open(port, path, options).response;
  let body = '';
  res.setEncoding('utf8');
  for await (const chunk of res) body += chunk;
  return { status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) };
}

/** Reads Server-Sent Events from a response, resolving each `next()` with the next complete event. */
export function eventReader(res: IncomingMessage) {
  res.setEncoding('utf8');
  let buffer = '';
  const queue: { event: string; data: any }[] = [];
  const waiting: ((value: { event: string; data: any } | null) => void)[] = [];
  let ended = false;
  res.on('data', (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null');
      const waiter = waiting.shift();
      if (waiter) waiter({ event, data }); else queue.push({ event, data });
    }
  });
  res.on('end', () => { ended = true; for (const waiter of waiting.splice(0)) waiter(null); });
  return {
    next: () => new Promise<{ event: string; data: any } | null>(resolve => {
      const item = queue.shift();
      if (item) resolve(item); else if (ended) resolve(null); else waiting.push(resolve);
    }),
  };
}

/**
 * A fake OpenAI-compatible chat endpoint streaming `parts` as content deltas. With `hold`, it sends the first part,
 * then waits for `release()` before the rest. `closed` counts upstream requests closed before the reply finished.
 */
export async function fakeModel(parts: string[], { hold = false } = {}) {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const state = { requests: 0, closedEarly: 0, closed: Promise.withResolvers<void>() };
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain the request */ }
    state.requests += 1;
    res.on('close', () => { if (!res.writableFinished) { state.closedEarly += 1; state.closed.resolve(); } });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const send = (value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);
    for (const [index, text] of parts.entries()) {
      if (index === 1 && hold) await released;
      if (res.destroyed) return;
      send({ choices: [{ delta: { content: text } }] });
    }
    send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } });
    res.end('data: [DONE]\n\n');
  });
  const port = await listen(server);
  return { server, state, release, url: `http://127.0.0.1:${port}/v1/chat/completions` };
}

/** Synthetic course list and one v1 course document on a temporary Desktop. */
export const syntheticCourse = { id: '900001', code: 'SYNT10001', name: 'Synthetic Course', term: '2026 Semester 2' };
export async function writeSyntheticCourses(projectDir: string, desktopDir: string) {
  await mkdir(join(projectDir, '.local', 'lms'), { recursive: true });
  await writeFile(join(projectDir, '.local', 'lms', 'courses.json'), JSON.stringify({
    fetchedAt: '2026-10-01T00:00:00.000Z', scope: 'synthetic',
    courses: [{ id: syntheticCourse.id, name: syntheticCourse.name, code: 'SYNT10001_2026_SM2', term: syntheticCourse.term }],
  }));
  const folder = join(desktopDir, '墨尔本大学 2026 S2', 'SYNT10001');
  await mkdir(folder, { recursive: true });
  const document = { version: 1, course: syntheticCourse, materials: [], assessments: [{ id: 'a1', name: 'Assignment 1', kind: 'assignment', nature: 'regular', parentId: null,
    weight: 20, score: null, maxScore: 20, due: null, status: 'not_started', scoring: 'none', rule: null, sources: [] }] };
  await writeFile(join(folder, '分数结构.json'), JSON.stringify(document));
  return document;
}
