import { createServer, type Server } from 'node:http';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendCourseChanges, changeLogHasRun, createCourseChangesHandler, readCourseChanges, recordCourseChanges } from '../scripts/lib/course-changes-log.mjs';
import type { CourseDocumentV1, CourseDocumentV2 } from '../shared/course-data.js';

// Scenarios from openspec/specs/course-change-log/spec.md (PR 3). Synthetic data only.
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'course-changes-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

type V1Item = CourseDocumentV1['assessments'][number];
const item = (id: string, patch: Partial<V1Item> = {}): V1Item => ({
  id, name: `Synthetic ${id}`, kind: 'assignment', nature: 'regular', parentId: null, weight: 20, score: null, maxScore: 10,
  due: '2026-11-03T12:59:00Z', status: 'not_started', scoring: 'none', rule: null, sources: [], ...patch,
});
const course = { id: '100', code: 'SYNT10001', name: 'Synthetic Course', term: null };
const v1 = (assessments: V1Item[]): CourseDocumentV1 => ({ version: 1, course, assessments, materials: [] });
const v2 = (assessments: V1Item[], legacyIds: Record<string, string> = {}): CourseDocumentV2 => ({
  version: 2, course, materials: [], legacyIds, assessments: assessments.map(entry => ({ ...entry, refs: [], weightQuote: null, ruleQuote: null, unsourced: [] })),
});
const logFile = () => join(dir, '.local', 'lms', 'changes.jsonl');
const lines = async () => (await readFile(logFile(), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
const at = '2026-10-30T01:00:00.000Z';

describe('changeLogHasRun', () => {
  it('finds a line for the course with any of the given run IDs, skipping malformed lines', async () => {
    expect(await changeLogHasRun(dir, '100', ['run-1'])).toBe(false);
    await mkdir(join(dir, '.local', 'lms'), { recursive: true });
    await appendFile(logFile(), `${JSON.stringify({ at, runId: 'run-1', courseId: '100' })}\nnot json\n${JSON.stringify({ at, runId: 'run-2', courseId: '200' })}\n`);
    expect(await changeLogHasRun(dir, '100', ['run-0', 'run-1'])).toBe(true);
    expect(await changeLogHasRun(dir, '100', ['run-2'])).toBe(false);
    expect(await changeLogHasRun(dir, '200', ['run-2'])).toBe(true);
    expect(await changeLogHasRun(dir, '100', [])).toBe(false);
  });
});

describe('appendCourseChanges', () => {
  it('appends one line per change with the run ID, in an owner-only file and directory', async () => {
    const previous = v1([item('a1'), item('a2')]);
    const current = v2([item('canvas:5551', { due: '2026-11-10T12:59:00Z', score: 9 }), item('a2', { weight: 25, score: 8, status: 'graded' })], { a1: 'canvas:5551' });
    expect(await appendCourseChanges(dir, { at, runId: 'run-1', courseId: '100', previous, current })).toBe(2);
    expect(await lines()).toEqual([
      { at, runId: 'run-1', courseId: '100', assessmentId: 'canvas:5551', name: 'Synthetic canvas:5551', field: 'due', before: '2026-11-03T12:59:00Z', after: '2026-11-10T12:59:00Z' },
      { at, runId: 'run-1', courseId: '100', assessmentId: 'a2', name: 'Synthetic a2', field: 'weight', before: 20, after: 25 },
    ]);
    expect(await readFile(logFile(), 'utf8')).not.toMatch(/score|maxScore|status/i);
    expect((await stat(logFile())).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, '.local', 'lms'))).mode & 0o777).toBe(0o700);
    // A later sync appends; earlier lines stay.
    await appendCourseChanges(dir, { at: '2026-10-31T01:00:00.000Z', runId: 'run-2', courseId: '100', previous: current, current: v2([item('canvas:5551'), item('a2', { weight: 25 })]) });
    expect((await lines()).map(line => line.runId)).toEqual(['run-1', 'run-1', 'run-2']);
  });

  it('writes nothing for a first sync or when nothing changed', async () => {
    expect(await appendCourseChanges(dir, { at, runId: 'run-1', courseId: '100', previous: null, current: v1([item('a1')]) })).toBe(0);
    expect(await appendCourseChanges(dir, { at, runId: 'run-1', courseId: '100', previous: v1([item('a1')]), current: v1([item('a1', { score: 5 })]) })).toBe(0);
    await expect(stat(logFile())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('starts on a new line after a line an earlier write cut short', async () => {
    await mkdir(join(dir, '.local', 'lms'), { recursive: true });
    await appendFile(logFile(), '{"at":"2026-10-29T01:00:00.000Z","runId":"run-0"');
    await appendCourseChanges(dir, { at, runId: 'run-1', courseId: '100', previous: v1([item('a1')]), current: v1([item('a1', { weight: 30 })]) });
    expect((await readCourseChanges(dir)).map(change => change.runId)).toEqual(['run-1']);
  });

  it('keeps a long assessment name readable', async () => {
    const name = 'N'.repeat(3000);
    await appendCourseChanges(dir, { at, runId: 'run-1', courseId: '100', previous: v1([item('a1', { name })]), current: v1([item('a1', { name, weight: 30 })]) });
    expect((await readCourseChanges(dir))[0]?.name).toBe(name);
  });
});

describe('recordCourseChanges', () => {
  it('keeps the course status and ends the reason with the failure note when the append fails', async () => {
    await mkdir(logFile(), { recursive: true }); // A directory where the log file should be: appending fails.
    const row = { status: 'completed', reason: '已同步。' };
    await recordCourseChanges(dir, { at, runId: 'run-1', courseId: '100', previous: v1([item('a1')]), current: v1([item('a1', { weight: 30 })]) }, row);
    expect(row).toEqual({ status: 'completed', reason: '已同步。 变更记录写入失败。' });
    const empty = { status: 'partial', reason: '' };
    await recordCourseChanges(dir, { at, runId: 'run-1', courseId: '100', previous: v1([item('a1')]), current: v1([item('a1', { weight: 30 })]) }, empty);
    expect(empty).toEqual({ status: 'partial', reason: '变更记录写入失败。' });
  });

  it('leaves the reason alone on success and on a first sync', async () => {
    const row = { status: 'completed', reason: '已同步。' };
    await recordCourseChanges(dir, { at, runId: 'run-1', courseId: '100', previous: null, current: v1([item('a1')]) }, row);
    await recordCourseChanges(dir, { at, runId: 'run-1', courseId: '100', previous: v1([item('a1')]), current: v1([item('a1', { weight: 30 })]) }, row);
    expect(row.reason).toBe('已同步。');
    expect(await lines()).toHaveLength(1);
  });
});

const line = (index: number, patch: Record<string, unknown> = {}) => JSON.stringify({
  at: new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString(), runId: `run-${index}`, courseId: '100', assessmentId: `a${index}`, name: `Synthetic ${index}`, field: 'weight', before: 20, after: 25, ...patch,
});

describe('readCourseChanges', () => {
  it('returns an empty list when the log does not exist', async () => {
    expect(await readCourseChanges(dir)).toEqual([]);
  });

  it('skips malformed and schema-failing lines and returns the newest first', async () => {
    await mkdir(join(dir, '.local', 'lms'), { recursive: true });
    await appendFile(logFile(), [line(1), '{not json', line(2, { field: 'score' }), line(3, { courseId: '../x' }), '', line(4)].join('\n') + '\n');
    expect((await readCourseChanges(dir)).map(change => change.assessmentId)).toEqual(['a4', 'a1']);
  });

  it('returns at most the newest 200 valid lines', async () => {
    await mkdir(join(dir, '.local', 'lms'), { recursive: true });
    await appendFile(logFile(), `${Array.from({ length: 205 }, (_, index) => line(index)).join('\n')}\nbroken\n`);
    const changes = await readCourseChanges(dir);
    expect(changes).toHaveLength(200);
    expect([changes[0]?.assessmentId, changes[199]?.assessmentId]).toEqual(['a204', 'a5']);
  });
});

describe('course-changes HTTP handler', () => {
  let server: Server;
  let origin: string;
  beforeEach(async () => {
    const handle = createCourseChangesHandler(dir);
    server = createServer((req, res) => {
      // Mounted like Vite's connect middleware: the prefix is stripped from req.url.
      if (!req.url?.startsWith('/api/local/course-changes')) { res.writeHead(404).end(); return; }
      req.url = req.url.slice('/api/local/course-changes'.length) || '/';
      void handle(req, res);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

  it('serves the valid changes, newest first, and an empty list without a log', async () => {
    const none = await fetch(`${origin}/api/local/course-changes`, { headers: { Origin: origin } });
    expect([none.status, none.headers.get('cache-control'), await none.json()]).toEqual([200, 'no-store', { changes: [] }]);
    await mkdir(join(dir, '.local', 'lms'), { recursive: true });
    await appendFile(logFile(), `${line(1)}\nnot json\n${line(2)}\n`);
    const response = await fetch(`${origin}/api/local/course-changes`);
    expect((await response.json()).changes.map((change: { assessmentId: string }) => change.assessmentId)).toEqual(['a2', 'a1']);
  });

  it('refuses other methods, paths and origins', async () => {
    expect((await fetch(`${origin}/api/local/course-changes`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(405);
    expect((await fetch(`${origin}/api/local/course-changes/x`)).status).toBe(404);
    expect((await fetch(`${origin}/api/local/course-changes`, { headers: { Origin: 'http://127.0.0.1:1' } })).status).toBe(403);
  });
});
