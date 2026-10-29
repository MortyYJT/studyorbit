import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { manualClock } from '../scripts/lib/rate-limit.mjs';
import { createSyncLimiters, type PipelineDeps } from '../scripts/lib/sync-pipeline.mjs';
import { openSyncStore, type OpenResult } from '../scripts/lib/sync-store.mjs';
import { DEFAULT_SOURCE_CONFIG } from '../scripts/sources/config.mjs';
import { createLocalApi, type LocalApiOptions } from '../server/app.ts';
import { TOKEN_HEADER } from '../server/guard.ts';
import { call, closeServer, eventReader, fakeModel, listen, open, syntheticCourse, syntheticToken, writeSyntheticCourses } from './local-api-helpers.ts';
import { fakeCollectors, fakeConfig, fakeModel as fakeAnalysisModel, syntheticCourse as pipelineCourse } from './sync-fakes.ts';

// Every route of the standalone local API through createLocalApi (specs/local-api-server, design §2-§3), on an
// ephemeral loopback port with a temporary project directory, a temporary Desktop and synthetic files.
const webPort = 5999;
const page = `http://localhost:${webPort}`;
let root: string, projectDir: string, desktopDir: string, token: string, server: Server | undefined, port: number;
let closeApi: (() => void) | undefined;
let apiRunning: (() => boolean) | undefined;
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
  for (let waited = 0; apiRunning?.() && waited < 200; waited++) await new Promise(resolve => setTimeout(resolve, 10));
  apiRunning = undefined;
  for (const opened of openedStores.splice(0)) if (opened.ok) opened.store.close();
  await closeServer(server);
  server = undefined;
  for (const other of extra.splice(0)) await closeServer(other);
  await rm(root, { recursive: true, force: true });
});

/** Fake collectors and a fake analysis model for the sync pipeline (course 900001); the model hangs until stopped. */
function fakePipelineDeps(replies: Parameters<typeof fakeAnalysisModel>[1] = { SYNT10001: [{ hang: true }] }): Omit<Partial<PipelineDeps>, 'store' | 'projectDir' | 'desktopDir' | 'hooks'> {
  const courses = [pipelineCourse(1)];
  const clock = manualClock(Date.UTC(2026, 9, 30), { instant: true });
  return {
    runCollector: fakeCollectors(courses).runCollector, callModel: fakeAnalysisModel(courses, replies).callModel,
    resolveModel: async () => fakeConfig, childUsage: async () => null, clock, limiters: createSyncLimiters({ clock }),
  };
}
const openedStores: OpenResult[] = [];
async function openStore(): Promise<OpenResult> {
  const result = await openSyncStore({ projectDir });
  openedStores.push(result);
  return result;
}

async function start(options: Partial<LocalApiOptions> = {}) {
  // Every API gets a sync store in the temporary project unless the test passes its own result.
  const store = 'store' in options ? options.store : await openStore();
  // macOS unless a test says otherwise, so the default browser does not depend on the machine running the tests.
  const api = createLocalApi({ projectDir, desktopDir, token, webPort, env: {}, platform: 'darwin', ...options, store });
  closeApi = api.close;
  apiRunning = api.syncRunning;
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

  it('saves no message when the source settings cannot be read', async () => {
    await configure('https://model.example.invalid/v1/chat/completions');
    const id = (await write('POST', '/api/local/chats', {})).json().id;
    await mkdir(join(projectDir, '.local', 'config'), { recursive: true });
    await writeFile(join(projectDir, '.local', 'config', 'sources.json'), '{not json');
    const reply = await write('POST', `/api/local/chats/${id}/messages`, { content: 'Hi' });
    expect([reply.status, reply.json()]).toEqual([500, { error: 'SOURCE_SETTINGS_UNREADABLE' }]);
    expect((await get(`/api/local/chats/${id}`)).json().messages).toEqual([]);
  });
});

describe('course-sync', () => {
  it('reports status, starts, refuses a second start and cancels with the same codes as before', async () => {
    await writeSyntheticCourses(projectDir, desktopDir);
    await start({ store: await openStore(), pipelineDeps: fakePipelineDeps() });
    expect((await get('/api/local/course-sync')).json()).toEqual({ running: false, courses: [], error: null, jobId: null, resumable: false });
    expect((await write('POST', '/api/local/course-sync', { ids: [] })).json()).toEqual({ error: 'INVALID_SELECTION' });
    expect((await write('POST', '/api/local/course-sync', { ids: ['900001'], extra: 1 })).json()).toEqual({ error: 'INVALID_SELECTION' });
    expect((await write('POST', '/api/local/course-sync', 'x'.repeat(10001))).json()).toEqual({ error: 'INVALID_SELECTION' });
    const started = await write('POST', '/api/local/course-sync', { ids: ['900001'] });
    expect([started.status, started.json().running, started.json().courses]).toEqual([202, true, [expect.objectContaining({ id: '900001', code: 'SYNT10001', reason: '', reused: false })]]);
    const again = await write('POST', '/api/local/course-sync', { ids: ['900001'] });
    expect([again.status, again.json()]).toEqual([409, { error: 'SYNC_RUNNING' }]);
    expect((await write('POST', '/api/local/course-sync', { ids: ['900001'] }, { origin: undefined })).status).toBe(403);
    expect((await write('PUT', '/api/local/course-sync', {})).status).toBe(405);
    expect((await write('DELETE', '/api/local/course-sync', {})).json()).toMatchObject({ courses: [{ status: 'cancelled' }] });
    await expect.poll(async () => (await get('/api/local/course-sync')).json().running, { interval: 10 }).toBe(false);
    expect((await get('/api/local/course-sync')).json()).toMatchObject({ jobId: expect.any(String), resumable: true, courses: [{ status: 'cancelled', reused: false }] });
  });

  it('keeps the status of the newest job across a restart of the server', async () => {
    await writeSyntheticCourses(projectDir, desktopDir);
    const api = await start({ store: await openStore(), pipelineDeps: fakePipelineDeps({}) });
    await write('POST', '/api/local/course-sync', { ids: ['900001'] });
    await expect.poll(() => api.syncRunning(), { interval: 10 }).toBe(false);
    closeApi?.(); await closeServer(server); server = undefined;
    for (const opened of openedStores.splice(0)) if (opened.ok) opened.store.close();
    await start({ store: await openStore(), pipelineDeps: fakePipelineDeps({}) });
    expect((await get('/api/local/course-sync')).json()).toMatchObject({ running: false, resumable: false, courses: [{ id: '900001', status: 'completed', stage: 'merge' }] });
  });

  it('lists jobs and resumes a stopped one with the write checks of the other routes', async () => {
    await writeSyntheticCourses(projectDir, desktopDir);
    const deps = fakePipelineDeps({ SYNT10001: [{ status: 503 }, { status: 503 }, { status: 503 }] });
    const api = await start({ store: await openStore(), pipelineDeps: deps });
    const started = (await write('POST', '/api/local/course-sync', { ids: ['900001'] })).json();
    await expect.poll(() => api.syncRunning(), { interval: 10 }).toBe(false);
    const listed = (await get('/api/local/sync-jobs')).json();
    expect(listed).toEqual({ jobs: [expect.objectContaining({ id: started.jobId, status: 'failed', resumable: true, resumedFrom: null, courses: [{ id: '900001', code: 'SYNT10001', status: 'failed' }] })] });
    const path = `/api/local/sync-jobs/${started.jobId}/resume`;
    expect((await get(path)).status).toBe(405);
    expect((await write('POST', path, {}, { origin: undefined })).status).toBe(403);
    expect((await write('POST', path, {}, { 'content-type': 'text/plain' })).status).toBe(403);
    expect((await write('POST', path, { force: true })).json()).toEqual({ error: 'INVALID_REQUEST' });
    expect((await write('POST', path, 'not json')).status).toBe(400);
    const missing = await write('POST', '/api/local/sync-jobs/no-such-job/resume', {});
    expect([missing.status, missing.json()]).toEqual([404, { error: 'JOB_NOT_FOUND' }]);
    expect((await write('POST', '/api/local/sync-jobs/x/y', {})).status).toBe(404);
    const resumed = await write('POST', path, {});
    expect(resumed.status).toBe(202);
    expect(resumed.json()).toMatchObject({ running: true, resumedFrom: started.jobId });
    await expect.poll(() => api.syncRunning(), { interval: 10 }).toBe(false);
    const again = await write('POST', path, {});
    expect([again.status, again.json()]).toEqual([409, { error: 'ALREADY_RESUMED' }]);
    expect((await get('/api/local/course-sync')).json()).toMatchObject({ resumedFrom: started.jobId, courses: [{ status: 'completed' }] });
  });

  it('answers 503 SYNC_STORE_UNAVAILABLE when the store could not be opened, while other routes work', async () => {
    await start({ store: { ok: false, error: 'SYNC_STORE_UNAVAILABLE', reason: 'NEWER_VERSION', message: 'synthetic' } });
    for (const reply of [await get('/api/local/course-sync'), await write('POST', '/api/local/course-sync', { ids: ['900001'] }), await get('/api/local/sync-jobs')]) {
      expect([reply.status, reply.json()]).toEqual([503, { error: 'SYNC_STORE_UNAVAILABLE' }]);
    }
    await writeSyntheticCourses(projectDir, desktopDir);
    expect((await get('/api/local/course-reports')).status).toBe(200);
  });

  it('close() interrupts a running sync and refuses later requests', async () => {
    await writeSyntheticCourses(projectDir, desktopDir);
    const store = await openStore();
    const api = await start({ store, pipelineDeps: fakePipelineDeps() });
    const started = (await write('POST', '/api/local/course-sync', { ids: ['900001'] })).json();
    expect(api.syncRunning()).toBe(true);
    api.close();
    await expect.poll(() => api.syncRunning(), { interval: 10 }).toBe(false);
    if (store.ok) expect(store.store.getJob(started.jobId)).toMatchObject({ status: 'interrupted' });
    // Shutting down: no request can start another sync.
    const after = await write('POST', '/api/local/course-sync', { ids: ['900001'] });
    expect([after.status, after.body]).toEqual([503, '']);
    expect(api.syncRunning()).toBe(false);
  });
});

describe('source-settings', () => {
  const generic = { institution: 'generic', canvasOrigin: 'https://canvas.example.edu', browser: 'chrome-applescript', edRegion: 'us', timeZone: 'America/New_York', codePattern: '^([A-Z]+\\d+)_' };
  const file = () => join(projectDir, '.local', 'config', 'sources.json');

  it('answers the defaults, saves valid settings owner-only and refuses invalid ones naming the field', async () => {
    await start();
    const first = await get('/api/local/source-settings');
    expect(first.status).toBe(200);
    expect(first.json()).toMatchObject({
      saved: false, platform: 'darwin',
      settings: { version: 1, institution: 'unimelb', canvasOrigin: 'https://canvas.lms.unimelb.edu.au', browser: 'edge-applescript', browserPath: null, edRegion: 'auto', timeZone: 'Australia/Melbourne', codePattern: null },
      available: { edRegions: ['auto', 'au', 'us', 'eu'] },
    });
    expect(first.json().available.browsers.filter((browser: { experimental: boolean }) => browser.experimental).map((browser: { id: string }) => browser.id)).toEqual(['cdp-chrome', 'cdp-edge']);
    const saved = await write('PUT', '/api/local/source-settings', generic);
    expect(saved.status, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ saved: true, settings: { ...generic, browserPath: null } });
    expect((await stat(file())).mode & 0o777).toBe(0o600);
    const bad = await write('PUT', '/api/local/source-settings', { ...generic, codePattern: '[A-Z]+\\d+' });
    expect([bad.status, bad.json().error, bad.json().field]).toEqual([400, 'INVALID_SOURCE_SETTINGS', 'codePattern']);
    const http = await write('PUT', '/api/local/source-settings', { ...generic, canvasOrigin: 'http://canvas.example.edu' });
    expect([http.status, http.json().field]).toEqual([400, 'canvasOrigin']);
    expect((await write('PUT', '/api/local/source-settings', 'not json')).json()).toMatchObject({ error: 'INVALID_SOURCE_SETTINGS' });
    expect(JSON.parse(await readFile(file(), 'utf8'))).toMatchObject({ codePattern: generic.codePattern, canvasOrigin: generic.canvasOrigin });
  });

  it('uses the same access checks as the other write routes', async () => {
    await start();
    expect((await write('PUT', '/api/local/source-settings', generic, { origin: undefined })).status).toBe(403);
    expect((await write('PUT', '/api/local/source-settings', generic, { 'content-type': 'text/plain' })).status).toBe(403);
    expect((await write('PUT', '/api/local/source-settings', generic, { origin: 'http://localhost:5998' })).status).toBe(403);
    expect((await write('PUT', '/api/local/source-settings', generic, { [TOKEN_HEADER]: 'wrong' })).status).toBe(403);
    expect((await write('POST', '/api/local/source-settings', generic)).status).toBe(405);
    expect((await get('/api/local/source-settings/x')).status).toBe(404);
    expect(existsSync(file())).toBe(false);
  });

  it('offers only the CDP browsers off macOS', async () => {
    await start({ platform: 'linux' });
    const reply = (await get('/api/local/source-settings')).json();
    expect(reply.settings.browser).toBe('cdp-chrome');
    expect((await write('PUT', '/api/local/source-settings', generic)).json()).toMatchObject({ field: 'browser' });
    const path = await write('PUT', '/api/local/source-settings', { ...generic, browser: 'cdp-chrome', browserPath: join(root, 'no-such-browser') });
    expect(path.json()).toMatchObject({ field: 'browserPath' });
  });

  it('refuses changes with 409 SYNC_RUNNING while a sync runs, keeping the file', async () => {
    await writeSyntheticCourses(projectDir, desktopDir);
    const api = await start({ store: await openStore(), pipelineDeps: fakePipelineDeps() });
    expect((await write('POST', '/api/local/course-sync', { ids: ['900001'] })).status).toBe(202);
    expect(api.syncRunning()).toBe(true);
    const refused = await write('PUT', '/api/local/source-settings', generic);
    expect([refused.status, refused.json()]).toEqual([409, { error: 'SYNC_RUNNING' }]);
    expect(existsSync(file())).toBe(false);
    await write('DELETE', '/api/local/course-sync', {});
    await expect.poll(() => api.syncRunning(), { interval: 10 }).toBe(false);
    expect((await write('PUT', '/api/local/source-settings', generic)).status).toBe(200);
  });

  it('refuses changes while course discovery runs, and discovery uses the saved settings', async () => {
    const script = join(root, 'discover-stub.mjs');
    await writeFile(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(root, 'env.json'))}, process.env.STUDYORBIT_SOURCE_CONFIG);\nsetTimeout(() => {}, 30000);\n`);
    await start({ discoveryScript: script });
    expect((await write('PUT', '/api/local/source-settings', generic)).status).toBe(200);
    const running = call(port, '/api/local/sync-courses', { method: 'POST', headers: headers({ origin: page, 'content-type': 'application/json' }), body: '{}' });
    await expect.poll(() => existsSync(join(root, 'env.json')), { interval: 10 }).toBe(true);
    expect(JSON.parse(await readFile(join(root, 'env.json'), 'utf8'))).toEqual({
      version: 1, institution: 'generic', canvasOrigin: generic.canvasOrigin, browser: 'chrome-applescript', browserPath: null, edRegion: 'us', profileDir: null,
    });
    expect((await write('PUT', '/api/local/source-settings', { ...generic, edRegion: 'eu' })).json()).toEqual({ error: 'SYNC_RUNNING' });
    await write('DELETE', '/api/local/sync-courses', {});
    expect((await running).status).toBe(409);
  });

  it('answers 409 COURSE_LIST_STALE for a course list from another Canvas; an old list counts as the default Canvas', async () => {
    await writeSyntheticCourses(projectDir, desktopDir);
    await start({ store: await openStore(), pipelineDeps: fakePipelineDeps() });
    expect((await get('/api/local/course-candidates')).status).toBe(200);
    expect((await get('/api/local/course-reports')).status).toBe(200);
    expect((await write('PUT', '/api/local/source-settings', generic)).status).toBe(200);
    for (const path of ['/api/local/course-candidates', '/api/local/course-reports']) {
      const stale = await get(path);
      expect([stale.status, stale.json()], path).toEqual([409, { error: 'COURSE_LIST_STALE' }]);
    }
    const sync = await write('POST', '/api/local/course-sync', { ids: ['900001'] });
    expect([sync.status, sync.json()]).toEqual([409, { error: 'COURSE_LIST_STALE' }]);
    // A list discovered on the configured Canvas is read with the generic institution's course filter.
    const list = JSON.parse(await readFile(join(projectDir, '.local', 'lms', 'courses.json'), 'utf8'));
    await writeFile(join(projectDir, '.local', 'lms', 'courses.json'), JSON.stringify({ ...list, canvasOrigin: generic.canvasOrigin, institution: 'generic' }));
    expect((await get('/api/local/course-candidates')).json().courses).toEqual([expect.objectContaining({ id: '900001', subjectCode: 'SYNT10001' })]);
  });

  it('answers 500 SOURCE_SETTINGS_UNREADABLE for a settings file it cannot use', async () => {
    await mkdir(join(projectDir, '.local', 'config'), { recursive: true });
    await writeFile(file(), '{not json');
    await writeSyntheticCourses(projectDir, desktopDir);
    await start();
    expect((await get('/api/local/source-settings')).json()).toEqual({ error: 'SOURCE_SETTINGS_UNREADABLE' });
    expect((await get('/api/local/course-reports')).json()).toEqual({ error: 'SOURCE_SETTINGS_UNREADABLE' });
    // Saving valid settings replaces it.
    expect((await write('PUT', '/api/local/source-settings', generic)).status).toBe(200);
  });
});

describe('sync-courses (course discovery)', () => {
  it('requires Origin on every method and runs the discovery script with the course file', async () => {
    const script = join(root, 'discover-stub.mjs');
    // Stub: records its arguments and warns on stderr; never opens a browser.
    await writeFile(script, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(root, 'args.json'))}, JSON.stringify([...process.argv.slice(2), process.env.STUDYORBIT_SOURCE_CONFIG]));\nconsole.error('synthetic warning');\n`);
    await start({ discoveryScript: script });
    expect((await get('/api/local/sync-courses')).status).toBe(403);
    expect((await get('/api/local/sync-courses', { origin: page })).status).toBe(405);
    const reply = await write('POST', '/api/local/sync-courses', {});
    expect([reply.status, reply.json()]).toEqual([200, { ok: true, warning: 'synthetic warning' }]);
    expect(JSON.parse(await readFile(join(root, 'args.json'), 'utf8'))).toEqual(['discover', join(projectDir, '.local', 'lms', 'courses.json'), JSON.stringify(DEFAULT_SOURCE_CONFIG)]);
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
