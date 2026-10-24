import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { dispatch } from '../../src/protocol/registry.js';
import { SyncJobs } from '../../src/sync/jobs.js';
import { assessmentId } from '../../src/sync/course-import.js';
import { component, document, found, item, now, quoted, unknown } from '../sync/course-document.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const key = 'SYNA10001:2026:S2';
function setup(file = ':memory:') {
  const store = new SqliteRepository(file);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'course-reading-')));
  const host = createProductionProtocol({ store, files: new ProtocolFiles(join(directory, 'journal')), owner: { assertOwner: async () => {} } });
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const agent = host.registry.agentTools(host.context);
  const agentCall = (name: string, input: unknown) => dispatch(agent.registry, name, input, agent.context);
  const ownerCall = (name: string, input: unknown) => dispatch(host.registry, name, input, host.context);
  const jobs = new SyncJobs(store);
  const select = () => store.saveCourseSelections([{ key, code: 'SYNA10001', term: '2026:S2', pages: {}, offeredAt: now, selected: true, decidedAt: now }]);
  return { store, host, agentCall, ownerCall, jobs, select };
}
const data = <T = Record<string, any>>(envelope: { ok: boolean }) => (envelope as unknown as { data: T }).data;
const offer = (jobId: string) => ({ jobId, blocked: [], courses: [
  { code: 'SYNA10001', name: 'Synthetic Systems', term: '2026:S2', pages: { canvas: 'https://canvas.lms.unimelb.edu.au/courses/900001', ed: 'https://edstem.org/au/courses/800001' } },
  { code: 'synb20002_2026_sm2', term: '2026:S2', pages: { canvas: 'https://canvas.lms.unimelb.edu.au/courses/900002' } },
  { code: 'SYNC30003', name: 'Synthetic Third', term: '2026:S2', pages: {} },
] });

describe('course selection (coursework-sync "Agent discovery and owner course selection")', () => {
  it('courses.offer stores undecided candidates keyed by code and term, and keeps earlier decisions', async () => {
    const f = setup();
    const job = f.jobs.open([]);
    expect(await f.agentCall('courses.offer', offer(job.id))).toMatchObject({ ok: true, data: { stored: 3, undecided: 3, selected: 0 } });
    const candidates = data<{ items: Record<string, unknown>[] }>(await f.agentCall('courses.candidates', {})).items;
    expect(candidates.map(c => c.key)).toEqual(['SYNA10001:2026:S2', 'SYNB20002:2026:S2', 'SYNC30003:2026:S2']);
    expect(candidates.every(c => c.selected === undefined)).toBe(true);
    expect(await f.ownerCall('courses.select', { selections: [{ key, selected: true }, { key: 'SYNC30003:2026:S2', selected: false }] })).toMatchObject({ ok: true, data: { recorded: 2 } });
    await f.agentCall('courses.offer', offer(job.id));
    const after = data<{ items: { key: string; selected?: boolean }[] }>(await f.agentCall('courses.candidates', {})).items;
    expect(after.map(c => c.selected)).toEqual([true, undefined, false]);
  });

  it('refuses off-origin page URLs and malformed terms, naming the offered course', async () => {
    const f = setup();
    const job = f.jobs.open([]);
    const refused = await f.agentCall('courses.offer', { jobId: job.id, blocked: [], courses: [{ code: 'SYNA10001', term: '2026:S2', pages: { canvas: 'https://example.test/courses/1' } },
      { code: 'SYNA10001', term: 'Semester 2', pages: {} }] });
    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringMatching(/courses\[0\]\.pages\.canvas.*courses\[1\]\.term/) } });
    expect(f.store.listCourseSelections()).toEqual([]);
  });

  it('Agent cannot select: courses.select through MCP or without the owner session is refused and nothing changes', async () => {
    const f = setup();
    f.select();
    expect(await f.agentCall('courses.select', { selections: [{ key, selected: false }] })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    const { owner: _owner, ...anonymous } = f.host.context;
    expect(await dispatch(f.host.registry, 'courses.select', { selections: [{ key, selected: false }] }, anonymous)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.store.listCourseSelections()[0]).toMatchObject({ selected: true });
    expect(await f.ownerCall('courses.select', { selections: [{ key: 'NOPE10001:2026:S2', selected: true }] })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('course.import (coursework-sync "Run state is shared through the store", "Validation with two retries")', () => {
  it('Valid document: course.import returns ok with the counts of stored components and items', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    expect(await f.agentCall('course.import', { jobId: job.id, document: document() })).toMatchObject({ ok: true,
      data: { stored: true, key, submission: 1, components: 2, items: 1, unknownFields: [], warnings: [] } });
    expect(f.store.loadSyncJob(job.id)).toMatchObject({ submissions: { [key]: 1 }, results: { [key]: { components: 2, items: 1, storedAt: expect.any(String) } } });
  });

  it('Wrong field shape: INVALID_INPUT names the field path and nothing is stored', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const bad = document([component('assignments', 60, [item(1, { due: quoted('next Friday') })]), component('exam', 40, [], { kind: found('exam') })]);
    expect(await f.agentCall('course.import', { jobId: job.id, document: bad })).toMatchObject({ ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('components[0].items[0].due.value') } });
    expect(f.store.query('courses', { limit: 10 }).items).toEqual([]);
    expect(f.store.loadSyncJob(job.id)?.submissions).toEqual({ [key]: 1 });
  });

  it('Missing name triggers a retry: course.name is refused, then the second submission is stored', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    expect(await f.agentCall('course.import', { jobId: job.id, document: document(undefined, { name: unknown() }) }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('course.name') } });
    expect(await f.agentCall('course.import', { jobId: job.id, document: document() })).toMatchObject({ ok: true, data: { submission: 2 } });
    expect(f.store.query('courses', { limit: 10 }).items).toEqual([expect.objectContaining({ name: 'Synthetic Systems' })]);
  });

  it('Third submission accepted with unknowns: both due dates are stored unknown and reported', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const bad = document([component('work', 60, [item(1, { due: unknown() }), item(2, { due: quoted('2031-01-01T00:00:00Z') })], { count: found(2) }),
      component('exam', 40, [], { kind: found('exam') })]);
    for (let i = 0; i < 2; i++) expect(await f.agentCall('course.import', { jobId: job.id, document: bad })).toMatchObject({ ok: false });
    const third = await f.agentCall('course.import', { jobId: job.id, document: bad });
    expect(third).toMatchObject({ ok: true, data: { submission: 3, unknownFields: expect.arrayContaining(['components[0].items[0].due', 'components[0].items[1].due']) } });
    for (const id of [1, 2]) expect(f.store.loadAssessment(assessmentId('2026:S2', `SYNA10001:canvas:assignment:${id}`))).toMatchObject({ readState: { due: { state: 'unknown', checkedAt: expect.any(String) } } });
    expect(f.store.loadSyncJob(job.id)?.results?.[key]?.unknownFields).toEqual(expect.arrayContaining(['components[0].items[0].due', 'components[0].items[1].due']));
  });

  it('a third submission without a valid code and term is still refused and the course is not read', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    expect(await f.agentCall('course.import', { jobId: job.id, document: { course: {} } })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.store.loadSyncJob(job.id)?.results).toBeUndefined();
  });

  it('Weights do not add up: the document is stored with a weight-sum warning', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const ninety = document([component('assignments', 50, [item(1)]), component('exam', 40, [], { kind: found('exam') })]);
    expect(await f.agentCall('course.import', { jobId: job.id, document: ninety })).toMatchObject({ ok: true, data: { warnings: [{ code: 'WEIGHT_SUM', sum: 90 }] } });
    expect(f.store.loadSyncJob(job.id)?.results?.[key]).toMatchObject({ warnings: ['WEIGHT_SUM'], weightSum: 90 });
  });

  it('Import outside a run: an ended job id is refused and nothing is stored', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    f.store.saveSyncJob({ ...job, endedAt: now, outcome: 'OK' });
    expect(await f.agentCall('course.import', { jobId: job.id, document: document() })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('No active sync job') } });
    expect(await f.agentCall('courses.offer', offer(job.id))).toMatchObject({ ok: false });
    expect(await f.agentCall('course.import', { jobId: 'unknown-job', document: document() })).toMatchObject({ ok: false });
    expect(f.store.query('courses', { limit: 10 }).items).toEqual([]);
    expect(f.store.listCourseSelections()).toHaveLength(1);
  });

  it('a job older than 25 minutes counts as ended, and only selected courses are accepted', async () => {
    const f = setup(); f.select();
    const stale = f.jobs.open([key]);
    f.store.saveSyncJob({ ...stale, startedAt: new Date(Date.now() - 26 * 60_000).toISOString() });
    expect(await f.agentCall('course.import', { jobId: stale.id, document: document() })).toMatchObject({ ok: false });
    const job = f.jobs.open([key]);
    expect(await f.agentCall('course.import', { jobId: job.id, document: document(undefined, {}, 'SYNZ90009') })).toMatchObject({ ok: false,
      error: { message: expect.stringContaining('not selected') } });
  });

  it('Count shared across processes: two refusals in one process make the next submission in another the third', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'course-reading-shared-')));
    const file = join(directory, 'coursework.db');
    const runner = setup(file); const mcp = setup(file);
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    runner.select();
    const job = runner.jobs.open([key]);
    const bad = document(undefined, { name: unknown() });
    for (let i = 0; i < 2; i++) expect(await mcp.agentCall('course.import', { jobId: job.id, document: bad })).toMatchObject({ ok: false });
    expect(await runner.agentCall('course.import', { jobId: job.id, document: bad })).toMatchObject({ ok: true, data: { submission: 3, unknownFields: ['course.name'] } });
    expect(runner.store.query('courses', { limit: 10 }).items).toEqual([expect.objectContaining({ name: 'SYNA10001' })]);
  });
});
