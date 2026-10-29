import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CourseSyncState } from '../scripts/course-sync-runner.mjs';
import { createLocalApi, type LocalApiOptions } from '../server/app.ts';
import { TOKEN_HEADER } from '../server/guard.ts';
import { call, closeServer, eventReader, fakeModel, listen, open, syntheticCourse, syntheticToken, writeSyntheticCourses } from './local-api-helpers.ts';

// Every route of the standalone local API through createLocalApi (specs/local-api-server, design §2-§3), on an
// ephemeral loopback port with a temporary project directory, a temporary Desktop and synthetic files.
const webPort = 5999;
const page = `http://localhost:${webPort}`;
let root: string, projectDir: string, desktopDir: string, token: string, server: Server | undefined, port: number;
let closeApi: (() => void) | undefined;
const extra: Server[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'studyorbit-server-'));
  projectDir = join(root, 'project');
  desktopDir = join(root, 'Desktop');
  await mkdir(projectDir, { recursive: true });
  token = syntheticToken();
});
afterEach(async () => {
  closeApi?.();
  closeApi = undefined;
  await closeServer(server);
  server = undefined;
  for (const other of extra.splice(0)) await closeServer(other);
  await rm(root, { recursive: true, force: true });
});

/** A fake course sync runner: no collectors, no model. */
function fakeRunner() {
  let state: CourseSyncState = { running: false, courses: [], error: null };
  const calls: string[][] = [];
  return {
    calls,
    async start(ids: string[]) {
      if (state.running) throw new Error('SYNC_RUNNING');
      if (!ids.length) throw new Error('INVALID_SELECTION');
      calls.push(ids);
      state = { running: true, courses: ids.map(id => ({ id, code: 'SYNT10001', status: 'pending', reason: '' })), error: null };
      return state;
    },
    status: () => state,
    cancel() { state = { ...state, running: false, courses: state.courses.map(course => ({ ...course, status: 'cancelled' })) }; return state; },
  };
}

async function start(options: Partial<LocalApiOptions> = {}) {
  const api = createLocalApi({ projectDir, desktopDir, token, webPort, env: {}, courseRunner: fakeRunner(), ...options });
  closeApi = api.close;
  server = createServer(api.handle);
  port = await listen(server);
  return api;
}

/** A page request as the proxy forwards it: loopback peer, launch token, page Host. */
const headers = (more: Record<string, string | undefined> = {}) => ({ host: `localhost:${webPort}`, [TOKEN_HEADER]: token, ...more });
const get = (path: string, more: Record<string, string | undefined> = {}) => call(port, path, { headers: headers(more) });
/** A write as the page sends it: same-origin Origin and JSON. */
const write = (method: string, path: string, body: unknown, more: Record<string, string | undefined> = {}) =>
  call(port, path, { method, headers: headers({ origin: page, 'content-type': 'application/json', ...more }), body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('access guard', () => {
  beforeEach(async () => { await start(); });

  it('answers 403 with an empty body and runs no route without the token or with a wrong one', async () => {
    for (const value of [undefined, 'b2'.repeat(32), token.slice(1)]) {
      const reply = await write('POST', '/api/local/revision-notes', { courseId: '900001', content: 'Synthetic note' }, { [TOKEN_HEADER]: value });
      expect([reply.status, reply.body]).toEqual([403, '']);
    }
    expect(existsSync(join(projectDir, '.local', 'revision'))).toBe(false);
  });

  it('refuses DNS rebinding, another local origin, another port in Host and a write without Origin', async () => {
    expect((await get('/api/local/course-sync', { host: `evil.example:${webPort}`, origin: `http://evil.example:${webPort}` })).status).toBe(403);
    expect((await get('/api/local/course-sync', { origin: 'http://localhost:3000' })).status).toBe(403);
    expect((await get('/api/local/course-sync', { host: 'localhost:5190' })).status).toBe(403);
    const save = await write('PUT', '/api/local/llm-config', { provider: 'deepseek', apiKey: 'sk-synthetic' }, { origin: undefined });
    expect([save.status, save.body]).toEqual([403, '']);
    expect(existsSync(join(projectDir, '.local', 'llm-config.json'))).toBe(false);
  });

  it('accepts 127.0.0.1 and [::1] page hosts and answers 404 for unknown paths', async () => {
    expect((await get('/api/local/course-sync', { host: `127.0.0.1:${webPort}`, origin: `http://127.0.0.1:${webPort}` })).status).toBe(200);
    expect((await get('/api/local/course-sync', { host: `[::1]:${webPort}` })).status).toBe(200);
    expect((await get('/api/local/unknown')).status).toBe(404);
    expect((await get('/api/local/course-syncx')).status).toBe(404);
    expect((await get('/index.html')).status).toBe(404);
  });
});

describe('course list and reports', () => {
  beforeEach(async () => { await start(); });

  it('course-candidates: 404 COURSES_NOT_FOUND without a list, 500 for a bad list, the candidates otherwise', async () => {
    const missing = await get('/api/local/course-candidates');
    expect([missing.status, missing.json()]).toEqual([404, { error: 'COURSES_NOT_FOUND' }]);
    await mkdir(join(projectDir, '.local', 'lms'), { recursive: true });
    await writeFile(join(projectDir, '.local', 'lms', 'courses.json'), '{"courses": 1}');
    expect((await get('/api/local/course-candidates')).json()).toEqual({ error: 'COURSES_UNAVAILABLE' });
    await writeSyntheticCourses(projectDir, desktopDir);
    const reply = await get('/api/local/course-candidates');
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.json()).toMatchObject({ fetchedAt: '2026-10-01T00:00:00.000Z', scope: 'synthetic', courses: [{ id: syntheticCourse.id, subjectCode: 'SYNT10001' }] });
    expect((await write('POST', '/api/local/course-candidates', {})).status).toBe(405);
  });

  it('course-reports: the newest Desktop document per course; 404 without a course list; 405 for writes', async () => {
    const missing = await get('/api/local/course-reports');
    expect([missing.status, missing.json()]).toEqual([404, { error: 'COURSES_UNAVAILABLE' }]);
    const document = await writeSyntheticCourses(projectDir, desktopDir);
    const reply = await get('/api/local/course-reports');
    expect(reply.status).toBe(200);
    expect(reply.json().reports).toEqual([{ id: syntheticCourse.id, report: document }]);
    expect((await write('POST', '/api/local/course-reports', {})).status).toBe(405);
  });

  it('sync-usage: empty without a log, newest first otherwise, 405 for writes', async () => {
    expect((await get('/api/local/sync-usage')).json()).toEqual({ items: [] });
    await mkdir(join(projectDir, '.local', 'lms'), { recursive: true });
    const line = (runId: string, at: string) => JSON.stringify({ type: 'course', runId, at, course: 'SYNT10001', model: 'synthetic', status: 'completed', durationMs: 10, coordinator: { input: 1, output: 2 } });
    await writeFile(join(projectDir, '.local', 'lms', 'course-sync-usage.jsonl'), `${line('r1', '2026-10-01T00:00:00.000Z')}\nnot json\n${line('r2', '2026-10-02T00:00:00.000Z')}\n`);
    const items = (await get('/api/local/sync-usage')).json().items;
    expect(items.map((item: { runId: string }) => item.runId)).toEqual(['r2', 'r1']);
    expect(items[0]).toMatchObject({ coordinator: { input: 1, output: 2, cached: null, reasoning: null }, subagents: null, recovered: false });
    expect((await write('POST', '/api/local/sync-usage', {})).status).toBe(405);
  });

  it('corrections and course-changes are mounted with their library handlers', async () => {
    expect((await get('/api/local/corrections')).json()).toEqual({ courses: {} });
    expect((await get('/api/local/corrections?courseId=..%2Fx')).json()).toEqual({ error: 'INVALID_COURSE_ID' });
    expect((await get('/api/local/course-changes')).json()).toEqual({ changes: [] });
    expect((await get('/api/local/course-changes/x')).status).toBe(404);
  });
});

describe('llm-config', () => {
  beforeEach(async () => { await start(); });

  it('reads, validates and saves settings without ever returning the key', async () => {
    expect((await get('/api/local/llm-config')).json()).toMatchObject({ provider: 'deepseek', source: 'default', hasKey: false });
    const saved = await write('PUT', '/api/local/llm-config', { provider: 'deepseek', apiKey: 'sk-synthetic-key' });
    expect(saved.status).toBe(200);
    expect(saved.body).not.toContain('sk-synthetic-key');
    expect(saved.json()).toMatchObject({ provider: 'deepseek', source: 'settings', hasKey: true });
    const invalid = await write('PUT', '/api/local/llm-config', '{');
    expect([invalid.status, invalid.json()]).toEqual([400, { error: 'INVALID_LLM_CONFIG', fieldErrors: { form: 'invalid_json' } }]);
    expect((await write('PUT', '/api/local/llm-config', { provider: 'nope' })).json().error).toBe('INVALID_LLM_CONFIG');
    expect((await write('PUT', '/api/local/llm-config', 'x'.repeat(10001))).status).toBe(413);
    expect((await write('PUT', '/api/local/llm-config', {}, { 'content-type': 'text/plain' })).status).toBe(403);
    expect((await write('DELETE', '/api/local/llm-config', {})).status).toBe(405);
    expect((await get('/api/local/llm-config/other')).status).toBe(404);
  });

  it('tests the connection against the configured (fake) endpoint', async () => {
    const model = await fakeModel(['OK']);
    extra.push(model.server);
    await write('PUT', '/api/local/llm-config', { provider: 'openai-compatible', model: 'synthetic-model', baseUrl: model.url, apiKey: 'sk-synthetic-key' });
    const reply = await write('POST', '/api/local/llm-config/test', {});
    expect(reply.json()).toMatchObject({ ok: true, model: 'synthetic-model' });
    expect(model.state.requests).toBe(1);
  });
});

describe('revision-notes', () => {
  beforeEach(async () => { await start(); });

  it('creates, lists and deletes notes with the same codes as before', async () => {
    expect((await get('/api/local/revision-notes?courseId=900001')).json()).toEqual({ notes: [] });
    const created = await write('POST', '/api/local/revision-notes', { courseId: '900001', content: 'Synthetic note' });
    expect(created.status).toBe(201);
    const id = created.json().id;
    expect((await get('/api/local/revision-notes?courseId=900001')).json().notes).toHaveLength(1);
    expect((await write('DELETE', `/api/local/revision-notes/${id}`, {})).json()).toEqual({ ok: true });
    expect((await write('DELETE', `/api/local/revision-notes/${id}`, {})).json()).toEqual({ error: 'NOTE_NOT_FOUND' });
    expect((await write('POST', '/api/local/revision-notes', '[1]')).json()).toEqual({ error: 'INVALID_JSON' });
    expect((await write('POST', '/api/local/revision-notes', { courseId: '900001', content: ' ' })).json()).toEqual({ error: 'CONTENT_EMPTY' });
    expect((await write('POST', '/api/local/revision-notes', 'x'.repeat(100001))).status).toBe(413);
    expect((await write('PUT', '/api/local/revision-notes', {})).json()).toEqual({ error: 'METHOD_NOT_ALLOWED' });
    expect((await get('/api/local/revision-notes/a/b')).json()).toEqual({ error: 'NOT_FOUND' });
    expect((await write('POST', '/api/local/revision-notes', { courseId: '900001', content: 'x' }, { origin: undefined })).status).toBe(403);
  });
});

describe('chats', () => {
  beforeEach(async () => { await start(); });
  const configure = (url: string) => write('PUT', '/api/local/llm-config', { provider: 'openai-compatible', model: 'synthetic-model', baseUrl: url, apiKey: 'sk-synthetic-key' });
  const send = (id: string, content: string) => open(port, `/api/local/chats/${id}/messages`, {
    method: 'POST', headers: headers({ origin: page, 'content-type': 'application/json' }), body: JSON.stringify({ content }),
  });

  it('creates, reads, lists and deletes chats; refuses bad IDs, paths, methods and bodies', async () => {
    const created = await write('POST', '/api/local/chats', { courseIds: [syntheticCourse.id] });
    expect(created.status).toBe(201);
    const id = created.json().id;
    expect((await get(`/api/local/chats/${id}`)).json()).toMatchObject({ id, courseIds: [syntheticCourse.id], messages: [], running: false });
    expect((await get('/api/local/chats')).json().chats).toHaveLength(1);
    expect((await get('/api/local/chats/not-an-id')).json()).toEqual({ error: 'INVALID_CHAT_ID' });
    expect((await get(`/api/local/chats/${id}/other`)).json()).toEqual({ error: 'NOT_FOUND' });
    expect((await write('PUT', `/api/local/chats/${id}`, {})).json()).toEqual({ error: 'METHOD_NOT_ALLOWED' });
    expect((await write('POST', '/api/local/chats', { courseIds: [1] })).json()).toEqual({ error: 'INVALID_COURSE_IDS' });
    expect((await write('POST', '/api/local/chats', 'x'.repeat(200001))).status).toBe(413);
    expect((await write('POST', `/api/local/chats/${id}/messages`, { content: ' ' })).json()).toEqual({ error: 'CONTENT_EMPTY' });
    // Default settings: DeepSeek without a key.
    expect((await write('POST', `/api/local/chats/${id}/messages`, { content: 'Hi' })).json()).toEqual({ error: 'ANALYSIS_KEY_MISSING' });
    expect((await write('POST', `/api/local/chats/${id}/stop`, {})).json()).toEqual({ ok: true, stopped: false });
    expect((await write('DELETE', `/api/local/chats/${id}`, {})).json()).toEqual({ ok: true });
    expect((await get(`/api/local/chats/${id}`)).json()).toEqual({ error: 'CHAT_NOT_FOUND' });
  });

  it('streams a reply from a fake model as delta events, then done, and saves both messages', async () => {
    const model = await fakeModel(['先做', ' A1。'], { hold: true });
    extra.push(model.server);
    await configure(model.url);
    const id = (await write('POST', '/api/local/chats', {})).json().id;
    const res = await send(id, 'What first?').response;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    const events = eventReader(res);
    // The first delta arrives while the model still holds the rest of the reply.
    expect(await events.next()).toEqual({ event: 'delta', data: { text: '先做' } });
    model.release();
    const rest = [];
    for (let event = await events.next(); event; event = await events.next()) rest.push(event);
    expect(rest.map(event => event.event)).toEqual(['delta', 'done']);
    expect(rest[1]!.data).toMatchObject({ message: { role: 'assistant', content: '先做 A1。' }, model: 'synthetic-model', stopped: false });
    const chat = (await get(`/api/local/chats/${id}`)).json();
    expect(chat.messages.map((message: { role: string }) => message.role)).toEqual(['user', 'assistant']);
  });

  it('aborts the model request when the client closes the stream', async () => {
    const model = await fakeModel(['Partial', ' rest'], { hold: true });
    extra.push(model.server);
    await configure(model.url);
    const id = (await write('POST', '/api/local/chats', {})).json().id;
    const { req, response } = send(id, 'Hi');
    const events = eventReader(await response);
    expect((await events.next())?.event).toBe('delta');
    req.destroy();
    await model.state.closed.promise;
    expect(model.state.closedEarly).toBe(1);
    // The partial reply is saved once the stop settles.
    await expect.poll(async () => (await get(`/api/local/chats/${id}`)).json().running).toBe(false);
    model.release();
  });
});

describe('course-sync', () => {
  it('reports status, starts, refuses a second start and cancels with the same codes as before', async () => {
    await start();
    expect((await get('/api/local/course-sync')).json()).toEqual({ running: false, courses: [], error: null });
    expect((await write('POST', '/api/local/course-sync', { ids: [] })).json()).toEqual({ error: 'INVALID_SELECTION' });
    expect((await write('POST', '/api/local/course-sync', { ids: ['900001'], extra: 1 })).json()).toEqual({ error: 'INVALID_SELECTION' });
    expect((await write('POST', '/api/local/course-sync', 'x'.repeat(10001))).json()).toEqual({ error: 'INVALID_SELECTION' });
    const started = await write('POST', '/api/local/course-sync', { ids: ['900001'] });
    expect([started.status, started.json().running]).toEqual([202, true]);
    const again = await write('POST', '/api/local/course-sync', { ids: ['900001'] });
    expect([again.status, again.json()]).toEqual([409, { error: 'SYNC_RUNNING' }]);
    expect((await write('POST', '/api/local/course-sync', { ids: ['900001'] }, { origin: undefined })).status).toBe(403);
    expect((await write('PUT', '/api/local/course-sync', {})).status).toBe(405);
    expect((await write('DELETE', '/api/local/course-sync', {})).json()).toMatchObject({ running: false, courses: [{ status: 'cancelled' }] });
  });

  it('answers 503 SYNC_STORE_UNAVAILABLE when the store could not be opened, while other routes work', async () => {
    await start({ store: { ok: false, error: 'SYNC_STORE_UNAVAILABLE', reason: 'NEWER_VERSION', message: 'synthetic' } });
    for (const reply of [await get('/api/local/course-sync'), await write('POST', '/api/local/course-sync', { ids: ['900001'] })]) {
      expect([reply.status, reply.json()]).toEqual([503, { error: 'SYNC_STORE_UNAVAILABLE' }]);
    }
    await writeSyntheticCourses(projectDir, desktopDir);
    expect((await get('/api/local/course-reports')).status).toBe(200);
  });

  it('close() cancels a running sync and refuses later requests', async () => {
    const api = await start();
    await write('POST', '/api/local/course-sync', { ids: ['900001'] });
    expect(api.syncRunning()).toBe(true);
    api.close();
    expect(api.syncRunning()).toBe(false);
    // Shutting down: no request can start another sync.
    const after = await write('POST', '/api/local/course-sync', { ids: ['900001'] });
    expect([after.status, after.body]).toEqual([503, '']);
    expect(api.syncRunning()).toBe(false);
  });
});

describe('sync-courses (course discovery)', () => {
  it('requires Origin on every method and runs the discovery script with the course file', async () => {
    const script = join(root, 'discover-stub.mjs');
    // Stub: records its arguments and warns on stderr; never opens a browser.
    await writeFile(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(root, 'args.json'))}, JSON.stringify(process.argv.slice(2)));\nconsole.error('synthetic warning');\n`);
    await start({ discoveryScript: script });
    expect((await get('/api/local/sync-courses')).status).toBe(403);
    expect((await get('/api/local/sync-courses', { origin: page })).status).toBe(405);
    const reply = await write('POST', '/api/local/sync-courses', {});
    expect([reply.status, reply.json()]).toEqual([200, { ok: true, warning: 'synthetic warning' }]);
    expect(JSON.parse(await readFile(join(root, 'args.json'), 'utf8'))).toEqual(['discover', join(projectDir, '.local', 'lms', 'courses.json')]);
    expect((await write('DELETE', '/api/local/sync-courses', {})).json()).toEqual({ ok: true });
  });

  it('reports a failed or cancelled discovery', async () => {
    const script = join(root, 'discover-stub.mjs');
    await writeFile(script, `console.error('synthetic failure'); process.exit(2);\n`);
    await start({ discoveryScript: script });
    expect((await write('POST', '/api/local/sync-courses', {})).json()).toEqual({ error: 'synthetic failure' });
    await writeFile(script, `setTimeout(() => {}, 30000);\n`);
    const running = call(port, '/api/local/sync-courses', { method: 'POST', headers: headers({ origin: page, 'content-type': 'application/json' }), body: '{}' });
    await new Promise(resolve => setTimeout(resolve, 200));
    expect((await write('POST', '/api/local/sync-courses', {})).status).toBe(409);
    await write('DELETE', '/api/local/sync-courses', {});
    const cancelled = await running;
    expect([cancelled.status, cancelled.json()]).toEqual([409, { error: 'SYNC_CANCELLED' }]);
    expect(await readdir(root)).not.toContain('args.json');
  });
});
