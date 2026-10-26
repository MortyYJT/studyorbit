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
import { api, component, document, found, handbook, item, kinds, now, quoted, unknown } from '../sync/course-document.js';

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
  // The store-side import (`storeBuilt` uses the same path); agents no longer get a course.import tool.
  const importCall = (jobId: string, document: unknown) => {
    try { return { ok: true as const, data: jobs.import({ jobId, document }) }; }
    catch (error) { const failure = error as { code?: string; message?: string };
      return { ok: false as const, error: { code: failure.code ?? 'INTERNAL', message: failure.message ?? '' } }; }
  };
  const select = () => store.saveCourseSelections([{ key, code: 'SYNA10001', term: '2026:S2', pages: {}, offeredAt: now, selected: true, decidedAt: now }]);
  return { store, host, agentCall, ownerCall, jobs, select, importCall };
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

describe('store-side course import (coursework-sync "Validation with two retries")', () => {
  it('Valid document: the store-side import returns the counts of stored components and items', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    expect(await f.importCall(job.id, document())).toMatchObject({ ok: true,
      data: { stored: true, key, submission: 1, components: 2, items: 1, unknownFields: [], warnings: [] } });
    expect(f.store.loadSyncJob(job.id)).toMatchObject({ submissions: { [key]: 1 }, results: { [key]: { components: 2, items: 1, storedAt: expect.any(String) } } });
    // protocol-reads: courses report the time of their last stored document.
    const storedAt = f.store.loadSyncJob(job.id)!.results![key]!.storedAt;
    expect(await f.agentCall('courses.list', {})).toMatchObject({ ok: true, data: { items: [expect.objectContaining({ code: 'SYNA10001', storedAt })] } });
  });

  it('Valid built document: API and Handbook values, the six kinds and an item aiPolicy import with receipt counts', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const apiItem = item(1, {
      kind: found('presentation'), due: api('2026-10-30T12:59:00Z'), unlockAt: api('2026-10-01T00:00:00Z'),
      weight: api(25), score: api(80), outOf: api(100), aiPolicy: quoted('prohibited', 'No generative AI for this report.'),
    });
    const weights = [40, 15, 25, 10, 10, 0];
    const components = kinds.map((kind, index) => component(kind, weights[index]!, kind === 'assignment' ? [apiItem] : [],
      { kind: found(kind), ...(kind === 'exam' ? { weight: handbook(weights[index]!, 'Final exam 40 per cent') } : {}) }));
    expect(await f.importCall(job.id, document(components))).toMatchObject({ ok: true,
      data: { stored: true, submission: 1, components: 6, items: 1, unknownFields: [], warnings: [] } });
    expect(f.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:canvas:assignment:1'))).toMatchObject({ kind: 'presentation',
      unlockAt: '2026-10-01T00:00:00Z', aiPolicy: 'prohibited', readState: { aiPolicy: { state: 'found', quote: 'No generative AI for this report.' },
        unlockAt: { state: 'found', via: 'api' } } });
  });

  it('Agent read without a quote: an item aiPolicy found with ax but no quote is refused, then stored unknown on the final submission', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const bad = document([component('work', 100, [item(1, { aiPolicy: found('prohibited',
      { source: 'https://canvas.lms.unimelb.edu.au/courses/900001/assignments/1' }) })], { count: found(1) })]);
    for (let i = 0; i < 2; i++) expect(await f.importCall(job.id, bad)).toMatchObject({ ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('components[0].items[0].aiPolicy.quote') } });
    const third = await f.importCall(job.id, bad);
    expect(third).toMatchObject({ ok: true, data: { submission: 3, unknownFields: expect.arrayContaining(['components[0].items[0].aiPolicy']) } });
    const stored = f.store.loadAssessment(assessmentId('2026:S2', 'SYNA10001:canvas:assignment:1'));
    expect(stored).toMatchObject({ name: 'Synthetic item 1', readState: { aiPolicy: { state: 'unknown', checkedAt: expect.any(String) } } });
    expect(stored?.aiPolicy).toBeUndefined();
  });

  it('Wrong field shape: INVALID_INPUT names the field path and nothing is stored', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const bad = document([component('assignments', 60, [item(1, { due: quoted('next Friday') })]), component('exam', 40, [], { kind: found('exam') })]);
    expect(await f.importCall(job.id, bad)).toMatchObject({ ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringContaining('components[0].items[0].due.value') } });
    expect(f.store.query('courses', { limit: 10 }).items).toEqual([]);
    expect(f.store.loadSyncJob(job.id)?.submissions).toEqual({ [key]: 1 });
  });

  it('Missing name triggers a retry: course.name is refused, then the second submission is stored', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    expect(await f.importCall(job.id, document(undefined, { name: unknown() })))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('course.name') } });
    expect(await f.importCall(job.id, document())).toMatchObject({ ok: true, data: { submission: 2 } });
    expect(f.store.query('courses', { limit: 10 }).items).toEqual([expect.objectContaining({ name: 'Synthetic Systems' })]);
  });

  it('Third submission accepted with unknowns: both due dates are stored unknown and reported', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const bad = document([component('work', 60, [item(1, { due: unknown() }), item(2, { due: quoted('2031-01-01T00:00:00Z') })], { count: found(2) }),
      component('exam', 40, [], { kind: found('exam') })]);
    for (let i = 0; i < 2; i++) expect(await f.importCall(job.id, bad)).toMatchObject({ ok: false });
    const third = await f.importCall(job.id, bad);
    expect(third).toMatchObject({ ok: true, data: { submission: 3, unknownFields: expect.arrayContaining(['components[0].items[0].due', 'components[0].items[1].due']) } });
    for (const id of [1, 2]) expect(f.store.loadAssessment(assessmentId('2026:S2', `SYNA10001:canvas:assignment:${id}`))).toMatchObject({ readState: { due: { state: 'unknown', checkedAt: expect.any(String) } } });
    expect(f.store.loadSyncJob(job.id)?.results?.[key]?.unknownFields).toEqual(expect.arrayContaining(['components[0].items[0].due', 'components[0].items[1].due']));
  });

  it('a third submission without a valid code and term is still refused and the course is not read', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    expect(await f.importCall(job.id, { course: {} })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.store.loadSyncJob(job.id)?.results).toBeUndefined();
  });

  it('Weights do not add up: the document is stored with a weight-sum warning', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const ninety = document([component('assignments', 50, [item(1)]), component('exam', 40, [], { kind: found('exam') })]);
    expect(await f.importCall(job.id, ninety)).toMatchObject({ ok: true, data: { warnings: [{ code: 'WEIGHT_SUM', sum: 90 }] } });
    expect(f.store.loadSyncJob(job.id)?.results?.[key]).toMatchObject({ warnings: ['WEIGHT_SUM'], weightSum: 90 });
  });


  it('a job older than 25 minutes counts as ended, and only selected courses are accepted', async () => {
    const f = setup(); f.select();
    const stale = f.jobs.open([key]);
    f.store.saveSyncJob({ ...stale, startedAt: new Date(Date.now() - 26 * 60_000).toISOString() });
    expect(await f.importCall(stale.id, document())).toMatchObject({ ok: false });
    const job = f.jobs.open([key]);
    expect(await f.importCall(job.id, document(undefined, {}, 'SYNZ90009'))).toMatchObject({ ok: false,
      error: { message: expect.stringContaining('not selected') } });
  });

});

describe('review fixes: offers, import failures and closing', () => {
  it('an offer with no courses and no blocked platform is refused with a fixed hint', async () => {
    const f = setup();
    const job = f.jobs.open([]);
    expect(await f.agentCall('courses.offer', { jobId: job.id, courses: [], blocked: [] })).toMatchObject({ ok: false,
      error: { code: 'INVALID_INPUT', message: 'Offer the courses you see, or report the platforms you could not read in `blocked`.' } });
    expect(await f.agentCall('courses.offer', { jobId: job.id, courses: [], blocked: ['canvas', 'ed'] })).toMatchObject({ ok: true });
    expect(f.store.loadSyncJob(job.id)?.blocked).toEqual(['canvas', 'ed']);
  });

  it('an unexpected store failure still counts the submission and returns a fixed refusal; nothing partial is stored', async () => {
    const f = setup(); f.select();
    const failing = new SyncJobs(f.store, { importer: store => {
      store.saveModule({ id: 'partial', name: 'Partial', glyph: 'P', auto: false });
      throw new Error('private detail');
    } });
    const job = failing.open([key]);
    expect(() => failing.import({ jobId: job.id, document: document() })).toThrow('could not be stored');
    expect(f.store.loadSyncJob(job.id)?.submissions).toEqual({ [key]: 1 });
    expect(f.store.loadModule('partial')).toBeUndefined();
    expect(() => failing.import({ jobId: job.id, document: document() })).not.toThrow('private detail');
  });

  it('close reads the job inside its transaction, so a late import is in the coverage', () => {
    const f = setup();
    const job = f.jobs.open([key]);
    f.store.saveSyncJob({ ...job, submissions: { [key]: 2 } });
    const seen = f.jobs.close(job.id, latest => ({ outcome: 'PARTIAL' as const, run: { id: job.id, command: 'sync', startedAt: job.startedAt, endedAt: now, steps: 0,
      outcome: 'error' as const, turns: 0, syncOutcome: 'PARTIAL' as const, courseCoverage: [] }, value: latest.submissions[key] }));
    expect(seen).toBe(2);
    expect(f.store.loadSyncJob(job.id)).toMatchObject({ endedAt: now, outcome: 'PARTIAL' });
    expect(f.store.loadRun(job.id)).toMatchObject({ syncOutcome: 'PARTIAL' });
  });
});
