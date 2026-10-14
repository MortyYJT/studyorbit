import { afterEach, expect, it, vi } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { SyncService } from '../../src/sync/service.js';
import { at, bodies, clock, json, readers } from './delivery-fixture.js';
import type { JsonReader } from '../../src/sync/canvas-reader.js';
import { CourseworkError } from '../../src/protocol/errors.js';
const stores: SqliteRepository[] = [];
afterEach(() => stores.splice(0).forEach(s => s.close()));
function setup(input = bodies()) {
  const store = new SqliteRepository(':memory:'); stores.push(store);
  const ports = readers(input); const requestClock = clock();
  const service = new SyncService({ store, clock: requestClock, readers: async limiter => ({
    canvas: { read: p => limiter.attempt(() => ports.canvas.read(p)) }, ed: { read: p => limiter.attempt(() => ports.ed.read(p)) },
  }) });
  return { store, service, ...ports, input };
}
it('102 retains the merged course and its relationships when Canvas discovery is unavailable', async () => {
  for (const failure of ['auth', 'gap', 'invalid', 'not-started'] as const) {
    const { store, service, input, read } = setup();
    await service.run({});
    const original = store.query('courses', { limit: 100 }).items[0]!;
    store.saveCourse({ ...original, assessmentsComplete: true });
    const annotation = { id: 'discovery-name', entity: 'course' as const, entityId: original.id, field: 'name', value: 'Owner name', origin: 'owner' as const, citations: [], at };
    store.appendAnnotation(annotation);
    const assessments = store.query('assessments', { limit: 100 }).items;
    const links = assessments.map(a => store.readAssessmentLinks(a.id));
    const sources = store.query('sourceItems', { limit: 100 }).items;
    read.mockImplementation(async p => {
      if (!p.startsWith('/api/v1/courses?')) return json(input[p]);
      if (failure === 'auth') return { kind: 'auth', code: 'AUTH_EXPIRED' };
      if (failure === 'gap') return { kind: 'gap', reason: 'unavailable' };
      if (failure === 'not-started') throw new CourseworkError('LIMIT_EXCEEDED', 'Synthetic discovery limit');
      return json({ malformed: true });
    });
    const result = await service.run({});
    expect(result.providers.canvas.status).toBe(failure === 'auth' ? 'AUTH_EXPIRED' : failure === 'not-started' ? 'LIMIT_EXCEEDED' : 'PARTIAL');
    expect(result.providers.ed.status).toBe('OK');
    expect(store.query('courses', { limit: 100 }).items).toHaveLength(1);
    expect(store.loadCourse(original.id)).toMatchObject({ name: 'Owner name', assessmentsComplete: true });
    expect(store.loadCourse(original.id)?.sources).toEqual(expect.arrayContaining(original.sources!));
    expect(store.readAnnotations('course', original.id)).toEqual([annotation]);
    expect(store.query('assessments', { limit: 100 }).items).toEqual(assessments);
    expect(assessments.map(a => store.readAssessmentLinks(a.id))).toEqual(links);
    const after = store.query('sourceItems', { limit: 100 }).items;
    expect(after).toHaveLength(sources.length);
    expect(after.every(s => s.courseId === original.id && !s.removed)).toBe(true);
    expect(after.filter(s => s.platform === 'canvas')).toEqual(sources.filter(s => s.platform === 'canvas'));
  }
});
it('102 preserves persisted course identity and manual links when a merged code becomes ambiguous', async () => {
  for (const edFirst of [false, true]) {
    const { store, service, input, read } = setup();
    if (edFirst) {
      const endpoint = '/api/v1/courses?enrollment_type=student&enrollment_state=active&include[]=term&per_page=100&page=1';
      const discovery = input[endpoint]; input[endpoint] = []; await service.run({});
      const edOnly = store.query('courses', { limit: 100 }).items[0]!;
      // Historical Ed-anchored IDs must remain usable after Canvas joins.
      input[endpoint] = discovery;
      await service.run({});
      expect(store.query('courses', { limit: 100 }).items).toHaveLength(1);
      expect(store.loadCourse(edOnly.id)?.sources).toHaveLength(2);
    } else await service.run({});
    const original = store.query('courses', { limit: 100 }).items[0]!;
    const group = store.query('assessments', { limit: 100 }).items[0]!;
    const assignment = store.query('sourceItems', { limit: 100 }).items.find(s => s.externalId === 'assignment:7')!;
    store.saveCourse({ id: 'manual-course', moduleId: 'school', code: 'IJKL30003', name: 'Manual', term: original.term, assessmentsComplete: false });
    store.saveAssessment({ ...group, id: 'manual-assessment', courseId: 'manual-course', origin: 'owner' });
    store.appendAssessmentLink({ assessmentId: 'manual-assessment', sourceItemId: assignment.id, origin: 'owner', at: '2026-10-16T00:00:00Z' });
    store.saveCourse({ ...original, assessmentsComplete: true });
    store.appendAnnotation({ id: 'identity-name', entity: 'course', entityId: original.id, field: 'name', value: 'Owner name', origin: 'owner', citations: [], at });
    const links = store.readAssessmentLinks(group.id);
    (input['/api/user'] as unknown[]).push({ course: { id: 15, code: 'ABCD10001', name: 'Second Ed course', status: 'active', year: 2026, session: 'S2' } });
    input['/api/courses/15/lessons'] = { lessons: [] };
    input['/api/courses/15/threads?limit=30&sort=new'] = { threads: [] };
    input['/api/courses/15/resources'] = { resources: [] };
    const beforeAuth = store.query('sourceItems', { limit: 100 }).items.filter(s => s.platform === 'ed');
    read.mockImplementation(async p => p === '/api/courses/9/lessons' ? { kind: 'auth', code: 'AUTH_EXPIRED' } : json(input[p]));
    await service.run({});
    expect(store.loadCourse(original.id)?.sources).toHaveLength(2);
    expect(store.query('courses', { limit: 100 }).items.filter(c => c.id !== 'manual-course')).toHaveLength(1);
    expect(store.query('sourceItems', { limit: 100 }).items.filter(s => s.platform === 'ed')).toEqual(beforeAuth);
    read.mockImplementation(async p => json(input[p]));
    const result = await service.run({});
    const courses = store.query('courses', { limit: 100 }).items.filter(c => c.id !== 'manual-course');
    expect(courses).toHaveLength(3);
    expect(store.loadCourse(original.id)).toMatchObject({ name: 'Owner name', assessmentsComplete: true, sources: [{ platform: 'canvas', externalId: '1' }] });
    expect(store.loadSourceItem(assignment.id)?.courseId).toBe(original.id);
    const edCourse = courses.find(c => c.sources?.some(s => s.platform === 'ed' && s.externalId === '9'))!;
    expect(store.query('sourceItems', { limit: 100 }).items.filter(s => s.platform === 'ed').every(s => s.courseId === edCourse.id && !s.removed)).toBe(true);
    expect(result.ambiguities).toContain(original.id);
    expect(store.query('assessments', { limit: 100 }).items.filter(a => a.origin === 'sync')).toHaveLength(1);
    expect(store.readAssessmentLinks(group.id)).toEqual(links);
    expect(store.readAssessmentLinks('manual-assessment')).toHaveLength(1);
  }
});
it('102 uses the same measured pages in run and durable status after an invalid Ed slide', async () => {
  const input = bodies(); input['/api/lessons/slides/21'] = { slide: { id: 21, questions: [{ id: 31, type: 'text', prompt: 5 }] } };
  const { store, service } = setup(input); const result = await service.run({});
  const restarted = new SyncService({ store, readers: async () => { throw Error('Status must not read providers'); } });
  const status = restarted.status();
  expect(status.ed.lastRun).toMatchObject({ id: result.run.id, ...result.providers.ed });
  expect(status.ed.lastRun?.status).toBe('PARTIAL');
  expect(status.canvas.lastRun).toMatchObject({ id: result.run.id, ...result.providers.canvas });
  expect(result.providers.ed.pages).toBe(6);
  expect(store.loadRun(result.run.id)?.pages).toBe(result.providers.canvas.pages + result.providers.ed.pages);
  expect(result.run.pages).toBe(status.canvas.lastRun!.pages + status.ed.lastRun!.pages);
  expect(result.providers.ed.failures).toBe(1);
});
it('5.4 two sources use one course transaction, shared limiter and measured durable run', async () => {
  const { store, service, read } = setup(); const save = vi.spyOn(store, 'saveBatch');
  const result = await service.run({});
  expect(store.query('courses', { limit: 100 }).items).toHaveLength(1);
  expect(save.mock.calls.filter(([batch]) => batch.courses?.length)).toHaveLength(1);
  expect(store.query('sourceItems', { limit: 100 }).items.filter(s => s.kind === 'assignment')).toHaveLength(3);
  expect(read.mock.calls.map(([p]) => p)).toHaveLength(13);
  expect(read.mock.calls.map(([p]) => p).some(p => /lessons\/12|offset=|replies|workspace/.test(p))).toBe(false);
  const run = store.loadRun(result.run.id)!;
  expect(run).toMatchObject({ requests: 13, pages: 13, failures: 0, outcome: 'ok' });
  expect(Date.parse(run.endedAt) - Date.parse(run.startedAt)).toBe(12000);
  expect(run.coverage?.map(c => c.provider)).toEqual(expect.arrayContaining(['canvas', 'ed']));
});
it('5.4 complete reads mark missing assignments removed without deleting links', async () => {
  const { store, service, input } = setup(); await service.run({});
  const before = store.query('sourceItems', { limit: 100 }).items.find(s => s.externalId === 'assignment:7')!;
  const assessment = store.query('assessments', { limit: 100 }).items[0]!;
  input['/api/v1/courses/1/assignments?per_page=100&page=1'] = [];
  await service.run({});
  expect(store.loadSourceItem(before.id)?.removed).toBe(true);
  expect(store.readAssessmentLinks(assessment.id).some(l => l.sourceItemId === before.id)).toBe(true);
});
it('5.4 partial read removes nothing; provider AUTH_EXPIRED preserves its data while Ed continues', async () => {
  const { store, service, read } = setup(); await service.run({});
  const before = store.query('sourceItems', { limit: 100 }).items.filter(s => s.platform === 'canvas');
  read.mockImplementation(async p => p.includes('/assignment_groups?') ? { kind: 'auth', code: 'AUTH_EXPIRED', status: 401 } : json(bodies()[p]));
  const result = await service.run({});
  expect(result.providers.canvas.status).toBe('AUTH_EXPIRED');
  expect(result.providers.ed.status).toBe('OK');
  expect(store.query('sourceItems', { limit: 100 }).items.filter(s => s.platform === 'canvas')).toEqual(before);
  expect(read.mock.calls.filter(([p]) => p.includes('/modules?'))).toHaveLength(1);
});
it('5.4 redacts every stored text using scope-wide names harvested before the course transaction', async () => {
  const input = bodies(); (input['/api/v1/courses/1/assignments?per_page=100&page=1'] as { description: string }[])[0]!.description = 'Work with Synthetic Peer on this task.';
  const { store, service } = setup(input); await service.run({});
  const text = JSON.stringify(store.query('sourceItems', { limit: 100 }).items);
  expect(text).not.toContain('Synthetic Peer'); expect(text).toContain('[redacted]');
});
it('5.3 annotation and agent/owner links survive resync and weight differences are reported', async () => {
  const { store, service } = setup(); await service.run({});
  const assessment = store.query('assessments', { limit: 100 }).items[0]!;
  const assignments = store.query('sourceItems', { limit: 100 }).items.filter(s => s.platform === 'canvas' && s.kind === 'assignment');
  const other = { ...assessment, id: 'other', origin: 'agent' as const };
  store.saveAssessment(other);
  store.appendAnnotation({ id: 'annotation', entity: 'assessment', entityId: assessment.id, field: 'weight', value: 10, origin: 'owner', citations: [], at });
  store.saveAssessment({ ...assessment, weight: 10 });
  assignments.forEach((s, i) => store.appendAssessmentLink({ assessmentId: other.id, sourceItemId: s.id, origin: i ? 'owner' : 'agent', at: '2026-10-16T00:00:00Z' }));
  const count = store.readAssessmentLinks(assessment.id).length;
  const result = await service.run({});
  expect(store.loadAssessment(assessment.id)?.weight).toBe(10);
  expect(result.differences).toEqual([{ entityId: assessment.id, field: 'weight' }]);
  expect(store.readAssessmentLinks(assessment.id)).toHaveLength(count);
  expect(store.readAssessmentLinks(other.id)).toHaveLength(2);
});
it('5.4 --course limits Ed and Canvas endpoints; unavailable lessons skip but other collections run', async () => {
  const input = bodies(); (input['/api/user'] as unknown[]).push({ course: { id: 15, code: 'EFGH20002', name: 'Outside', status: 'active', year: 2026, session: 'S2' } });
  delete input['/api/courses/9/lessons'];
  const { service, read } = setup(input); const result = await service.run({ course: 'ABCD10001' });
  expect(read.mock.calls.some(([p]) => p.startsWith('/api/courses/15/'))).toBe(false);
  expect(read.mock.calls.some(([p]) => p === '/api/courses/9/resources')).toBe(true);
  expect(result.run.failures).toBe(0);
  expect(result.run.coverage?.some(c => c.skipped === 1)).toBe(true);
});
it('5.4 Ed auth stops only Ed and invalid detail ids never extend endpoint scope', async () => {
  const { service, read } = setup();
  read.mockImplementation(async p => p === '/api/user' ? { kind: 'auth', code: 'AUTH_EXPIRED' } : json(bodies()[p]));
  const result = await service.run({});
  expect(result.providers).toMatchObject({ ed: { status: 'AUTH_EXPIRED' }, canvas: { status: 'OK' } });
  expect(read.mock.calls.filter(([p]) => p.startsWith('/api/courses/'))).toHaveLength(0);
});
it('5.4 rolls back course facts and links together when a link cannot be persisted', async () => {
  const { store, service } = setup();
  vi.spyOn(store, 'appendAssessmentLink').mockImplementation(() => { throw Error('Synthetic disk failure'); });
  await expect(service.run({})).rejects.toBeDefined();
  expect(store.query('courses', { limit: 100 }).items).toEqual([]);
  expect(store.query('sourceItems', { limit: 100 }).items).toEqual([]);
});
it('5.5 a second concurrent start returns LOCKED, and provider last run/success survives restart', async () => {
  const { service, store, read } = setup();
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  read.mockImplementationOnce(async () => { await wait; return json(bodies()['/api/v1/courses?enrollment_type=student&enrollment_state=active&include[]=term&per_page=100&page=1']); });
  const pending = service.run({});
  await expect(service.run({})).rejects.toMatchObject({ code: 'LOCKED' });
  release(); const success = await pending;
  read.mockImplementation(async p => p.startsWith('/api/v1/') ? { kind: 'auth', code: 'AUTH_EXPIRED' } : json(bodies()[p]));
  const expired = await service.run({});
  const restarted = new SyncService({ store, clock: clock(), readers: async () => ({ canvas: read as unknown as JsonReader, ed: read as unknown as JsonReader }) });
  const state = restarted.status();
  expect(state.running).toBe(false);
  expect(state.canvas.lastRun?.id).toBe(expired.run.id);
  expect(state.canvas.lastSuccess?.id).toBe(success.run.id);
  expect(state.ed.lastSuccess?.id).toBe(expired.run.id);
  expect(state.canvas.lastRun?.status).toBe('AUTH_EXPIRED');
});
it('5.4 partial collections never remove old items or report a complete provider success', async () => {
  const { store, service, input, read } = setup(); await service.run({});
  input['/api/v1/courses/1/assignments?per_page=100&page=1'] = [];
  read.mockImplementation(async p => p.includes('/modules?') ? json({ malformed: true }) : json(input[p]));
  const result = await service.run({});
  expect(result.providers.canvas.status).toBe('PARTIAL');
  expect(store.query('sourceItems', { limit: 100 }).items.filter(s => s.platform === 'canvas').every(s => !s.removed)).toBe(true);
});
it('5.4 malformed discovery is a measured failure; an unsafe course withholds only that course', async () => {
  const { service, read } = setup();
  read.mockImplementation(async p => p.startsWith('/api/v1/courses?') ? json([{ id: 'bad' }]) : json(bodies()[p]));
  const result = await service.run({});
  expect(result.providers.canvas).toMatchObject({ status: 'PARTIAL', failures: 1 });
  expect(result.providers.ed.status).toBe('OK');
});
it('5.3 returns stored group weight citations and applies annotated course fields', async () => {
  const { store, service } = setup(); const result = await service.run({});
  const citation = result.citations[0]!;
  expect(store.loadSourceItem(citation.sourceItemId)?.text).toContain(citation.quote);
  expect(citation.locator).toContain('group_weight');
  const course = store.query('courses', { limit: 100 }).items[0]!;
  store.appendAnnotation({ id: 'course-annotation', entity: 'course', entityId: course.id, field: 'name', value: 'Owner chosen name', origin: 'owner', citations: [], at });
  await service.run({});
  expect(store.loadCourse(course.id)?.name).toBe('Owner chosen name');
});
it('5.4 invalid Ed slide text is a measured isolated gap while valid Canvas data commits', async () => {
  const input = bodies(); input['/api/lessons/slides/21'] = { slide: { id: 21, questions: [{ id: 31, type: 'text', prompt: 5 }] } };
  const { store, service } = setup(input);
  const result = await service.run({});
  expect(result.providers).toMatchObject({ canvas: { status: 'OK' }, ed: { status: 'PARTIAL', failures: 1 } });
  expect(store.query('sourceItems', { limit: 100 }).items.some(s => s.platform === 'canvas')).toBe(true);
});
it('5.3 a missing platform weight clears stale sync weight while retaining its link target', async () => {
  const { store, service, input } = setup(); await service.run({});
  const assessment = store.query('assessments', { limit: 100 }).items[0]!;
  input['/api/v1/courses/1/assignment_groups?per_page=100&page=1'] = [{ id: 3, name: 'Assignments', group_weight: null }];
  await service.run({});
  expect(store.loadAssessment(assessment.id)?.weight).toBeUndefined();
  expect(store.readAssessmentLinks(assessment.id)).not.toHaveLength(0);
});
it('5.4 HTML descriptions are withheld without blocking safe platform facts or Ed data', async () => {
  const input = bodies(); (input['/api/v1/courses/1/assignments?per_page=100&page=1'] as { description: string }[])[0]!.description = '<p>Synthetic instructions</p>';
  const { service, store } = setup(input); const result = await service.run({});
  expect(result.providers.canvas.status).toBe('PARTIAL');
  expect(result.providers.ed.status).toBe('OK');
  const item = store.query('sourceItems', { limit: 100 }).items.find(s => s.externalId === 'assignment:7')!;
  expect(item.text).toContain('[withheld]');
  expect(item.text).not.toContain('<p>');
  expect(item.facts?.pointsEarned).toBe(8);
});
