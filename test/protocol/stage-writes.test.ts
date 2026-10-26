import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { dispatch, isOwnerCommand } from '../../src/protocol/registry.js';
import { stageFor } from '../../src/sync/agent-job.js';
import { SyncJobs } from '../../src/sync/jobs.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const key = 'SYNA10001:2026:S2';
const otherKey = 'SYNB20002:2026:S2';
const at = '2026-10-24T00:00:00Z';
const assignmentId = '500123';

const map = {
  lms: { text: 'Synthetic LMS use', quote: 'Synthetic LMS quote' },
  ed: { text: 'Synthetic Ed use', quote: 'Synthetic Ed quote' },
  syllabus: { where: 'handbook', quote: 'Synthetic syllabus quote' },
  links: [
    { label: 'Synthetic lectures', url: 'https://canvas.lms.unimelb.edu.au/courses/12345/pages/lectures', quote: 'Synthetic Canvas link quote' },
    { label: 'Synthetic Ed discussion', url: 'https://edstem.org/au/courses/800001/discussion', quote: 'Synthetic Ed link quote' },
  ],
};
const quizzes = { quizzes: [{
  id: '700001', name: 'Synthetic practice quiz', survey: false, practice: true,
  availability: { text: 'Synthetic availability text', quote: 'Synthetic availability quote' },
  description: { text: 'Synthetic description text', quote: 'Synthetic description quote' },
}] };
const assignment = {
  assignmentId, policy: { value: 'allowed', quote: 'Synthetic AI policy quote' },
  files: ['synthetic-page.mhtml', 'synthetic-attachment.pdf'],
};
const materials = {
  files: ['synthetic-week-1.pdf'],
  links: [{ label: 'Synthetic lecture recording', url: 'https://echo360.example.edu/synthetic/lecture' }],
};
const classification = { items: [{
  id: '500001', category: 'quiz', component: 'Synthetic component', evidence: 'Synthetic group name',
}] };

/** Each command's payload without the job id and course key. */
const calls: [string, Record<string, unknown>][] = [
  ['course.map', map],
  ['quizzes.read', quizzes],
  ['assignment.saved', assignment],
  ['materials.saved', materials],
  ['items.classify', classification],
];

function setup() {
  const store = new SqliteRepository(':memory:');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'stage-writes-')));
  const host = createProductionProtocol({ store, files: new ProtocolFiles(join(directory, 'journal')), owner: { assertOwner: async () => {} } });
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const agent = host.registry.agentTools(host.context);
  const agentCall = (name: string, input: unknown) => dispatch(agent.registry, name, input, agent.context);
  const jobs = new SyncJobs(store);
  const select = () => store.saveCourseSelections([{ key, code: 'SYNA10001', term: '2026:S2',
    pages: { canvas: 'https://canvas.lms.unimelb.edu.au/courses/12345' }, offeredAt: at, selected: true, decidedAt: at }]);
  return { store, host, agentCall, jobs, select };
}

const stages = (f: ReturnType<typeof setup>, jobId: string) => f.store.loadSyncJob(jobId)?.stages?.[key] as Record<string, any> | undefined;
const data = (envelope: { ok: boolean }) => (envelope as unknown as { data: Record<string, number> }).data;

describe('job-scoped stage write commands (layered-sync task 5.3)', () => {
  it('course.map stores the map stage and returns only the link count', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const result = await f.agentCall('course.map', { jobId: job.id, courseKey: key, ...map });
    expect(result).toMatchObject({ ok: true });
    expect(data(result)).toEqual({ links: 2 });
    expect(stages(f, job.id)?.map).toEqual(map);
  });

  it('quizzes.read stores the quizzes stage and returns the quiz count', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const result = await f.agentCall('quizzes.read', { jobId: job.id, courseKey: key, ...quizzes });
    expect(result).toMatchObject({ ok: true });
    expect(data(result)).toEqual({ quizzes: 1 });
    expect(stages(f, job.id)?.quizzes).toEqual(quizzes);
  });

  it('assignment.saved stores only policy and file names under stageFor({ kind: assignment, target })', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const result = await f.agentCall('assignment.saved', { jobId: job.id, courseKey: key, ...assignment });
    expect(result).toMatchObject({ ok: true });
    expect(data(result)).toEqual({ files: 2 });
    const stage = stageFor({ kind: 'assignment', jobId: job.id, courseKey: key, urls: [], target: assignmentId });
    expect(stage).toBe(`assignments.${assignmentId}`);
    expect(stages(f, job.id)?.[stage]).toEqual({ policy: assignment.policy, files: assignment.files });
    expect(stages(f, job.id)?.[stage]).not.toHaveProperty('assignmentId');
  });

  it('assignment.saved refuses instruction or rubric keys and stores nothing (rubric not read at sync)', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    for (const extra of [{ rubric: 'Synthetic rubric text' }, { instructions: 'Synthetic instruction text' }]) {
      const result = await f.agentCall('assignment.saved', { jobId: job.id, courseKey: key, ...assignment, ...extra });
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(stages(f, job.id)).toBeUndefined();
    }
    expect(JSON.stringify(f.store.loadSyncJob(job.id))).not.toContain('Synthetic rubric text');
    expect(JSON.stringify(f.store.loadSyncJob(job.id))).not.toContain('Synthetic instruction text');
  });

  it('materials.saved stores file names and link-only targets separately', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const result = await f.agentCall('materials.saved', { jobId: job.id, courseKey: key, ...materials });
    expect(result).toMatchObject({ ok: true });
    expect(data(result)).toEqual({ files: 1, links: 1 });
    expect(stages(f, job.id)?.materials).toEqual(materials);
    expect(stages(f, job.id)?.materials.files).toEqual(['synthetic-week-1.pdf']);
    expect(stages(f, job.id)?.materials.links).toEqual(materials.links);
  });

  it('items.classify stores the classification and returns the item count', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const result = await f.agentCall('items.classify', { jobId: job.id, courseKey: key, ...classification });
    expect(result).toMatchObject({ ok: true });
    expect(data(result)).toEqual({ items: 1 });
    expect(stages(f, job.id)?.classification).toEqual(classification);
  });

  it('course.map refuses a link off the two allowed origins and names the link (refused: nothing stored)', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const result = await f.agentCall('course.map', { jobId: job.id, courseKey: key, ...map,
      links: [{ label: 'Synthetic Gradescope', url: 'https://gradescope.example.edu/course/1', quote: 'Synthetic quote' }] });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const message = (result as unknown as { error: { message: string } }).error.message;
    expect(message).toContain('Synthetic Gradescope');
    expect(message).toContain('https://gradescope.example.edu/course/1');
    expect(message.toLowerCase()).toContain('nothing was stored');
    expect(stages(f, job.id)).toBeUndefined();
  });

  it('assignment.saved and materials.saved refuse a file name with a path separator', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    for (const [name, payload] of [['assignment.saved', { ...assignment, files: ['folder/synthetic.pdf'] }],
      ['materials.saved', { ...materials, files: ['folder\\synthetic.pdf'] }]] as const) {
      const result = await f.agentCall(name, { jobId: job.id, courseKey: key, ...payload });
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect((result as unknown as { error: { message: string } }).error.message.toLowerCase()).toContain('nothing was stored');
      expect(stages(f, job.id)).toBeUndefined();
    }
  });

  it('assignment.saved and materials.saved refuse the file names . and .. (they name no file in Downloads)', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    for (const [name, payload] of [['assignment.saved', { ...assignment, files: ['..'] }],
      ['materials.saved', { ...materials, files: ['.'] }]] as const) {
      const result = await f.agentCall(name, { jobId: job.id, courseKey: key, ...payload });
      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      expect(stages(f, job.id)).toBeUndefined();
    }
  });

  it('assignment.saved and quizzes.read refuse a non-digit Canvas id', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const badAssignment = await f.agentCall('assignment.saved', { jobId: job.id, courseKey: key, ...assignment, assignmentId: '500123a' });
    expect(badAssignment).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    const badQuiz = await f.agentCall('quizzes.read', { jobId: job.id, courseKey: key,
      quizzes: [{ ...quizzes.quizzes[0]!, id: 'quiz-700001' }] });
    expect(badQuiz).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(stages(f, job.id)).toBeUndefined();
  });

  it('items.classify refuses a duplicate id within the call', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const item = classification.items[0]!;
    const result = await f.agentCall('items.classify', { jobId: job.id, courseKey: key, items: [item, { ...item, category: 'assignment' }] });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect((result as unknown as { error: { message: string } }).error.message).toContain('500001');
    expect(stages(f, job.id)).toBeUndefined();
  });

  it('items.classify refuses an unknown category', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const result = await f.agentCall('items.classify', { jobId: job.id, courseKey: key,
      items: [{ ...classification.items[0]!, category: 'lecture' }] });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(stages(f, job.id)).toBeUndefined();
  });

  it('course.map stores a quoted course-wide AI rule and refuses a known one without a quote', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const policy = { value: 'prohibited', quote: 'Synthetic course-wide AI quote' };
    const result = await f.agentCall('course.map', { jobId: job.id, courseKey: key, ...map, aiPolicy: policy });
    expect(result).toMatchObject({ ok: true });
    expect(stages(f, job.id)?.map.aiPolicy).toEqual(policy);

    const refused = await f.agentCall('course.map', { jobId: job.id, courseKey: key, ...map, aiPolicy: { value: 'allowed' } });
    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect((refused as unknown as { error: { message: string } }).error.message.toLowerCase()).toContain('nothing was stored');
    expect(stages(f, job.id)?.map.aiPolicy).toEqual(policy);
  });

  it('course.map refuses a known syllabus location without a quote', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const result = await f.agentCall('course.map', { jobId: job.id, courseKey: key, ...map, syllabus: { where: 'canvas' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect((result as unknown as { error: { message: string } }).error.message.toLowerCase()).toContain('nothing was stored');
    expect(stages(f, job.id)).toBeUndefined();
  });

  it('assignment.saved refuses a known policy value without a quote', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const result = await f.agentCall('assignment.saved', { jobId: job.id, courseKey: key, ...assignment, policy: { value: 'prohibited' } });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect((result as unknown as { error: { message: string } }).error.message.toLowerCase()).toContain('nothing was stored');
    expect(stages(f, job.id)).toBeUndefined();
  });

  it('course.map accepts an unknown syllabus location without a quote', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const result = await f.agentCall('course.map', { jobId: job.id, courseKey: key, ...map, syllabus: { where: 'unknown' } });
    expect(result).toMatchObject({ ok: true });
    expect(stages(f, job.id)?.map.syllabus).toEqual({ where: 'unknown' });
  });

  it.each(calls)('%s refuses an ended job and nothing is stored', async (name, body) => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    f.store.saveSyncJob({ ...job, endedAt: at, outcome: 'OK' });
    const result = await f.agentCall(name, { jobId: job.id, courseKey: key, ...body });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringMatching(/No active sync job/) } });
    expect(stages(f, job.id)).toBeUndefined();
  });

  it.each(calls)('%s refuses an unknown job id and nothing is stored', async (name, body) => {
    const f = setup(); f.select();
    const result = await f.agentCall(name, { jobId: 'synthetic-missing-job', courseKey: key, ...body });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringMatching(/No active sync job/) } });
    expect(f.store.listSyncJobs()).toEqual([]);
  });

  it.each(calls)('%s refuses a course not in the job and nothing is stored', async (name, body) => {
    const f = setup(); f.select();
    const job = f.jobs.open([otherKey]);
    const result = await f.agentCall(name, { jobId: job.id, courseKey: key, ...body });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining(key) } });
    expect(stages(f, job.id)).toBeUndefined();
    expect(f.store.loadSyncJob(job.id)?.stages?.[otherKey]).toBeUndefined();
  });

  it('Stage output outside a run: course.map with an ended job id is refused and nothing is stored', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    f.store.saveSyncJob({ ...job, endedAt: at, outcome: 'OK' });
    expect(await f.agentCall('course.map', { jobId: job.id, courseKey: key, ...map }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringMatching(/No active sync job/) } });
    expect(stages(f, job.id)).toBeUndefined();
  });

  it('Stage results shared across processes: a second SyncJobs instance stores course.map and the first reads it', () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'stage-shared-')));
    const file = join(directory, 'coursework.sqlite');
    const first = new SqliteRepository(file); const second = new SqliteRepository(file);
    cleanups.push(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); });
    const jobs = new SyncJobs(first); const other = new SyncJobs(second);
    const job = jobs.open([key]);
    other.recordStage(job.id, key, 'map', map);
    expect(jobs.load(job.id)?.stages?.[key]?.map).toEqual(map);
  });

  it('lists the six job-scoped stage writes as agent tools, without the removed course.import, and adds no owner-only command', () => {
    const f = setup();
    const names = f.host.registry.agentTools(f.host.context).registry.list().map(entry => entry.name);
    for (const name of ['course.map', 'quizzes.read', 'assignment.saved', 'materials.saved', 'ed.read', 'items.classify']) {
      expect(names).toContain(name);
      expect(f.host.registry.get(name)).toMatchObject({ level: 0 });
    }
    expect(names).not.toContain('course.import');
    expect(names.some(name => isOwnerCommand(name))).toBe(false);
  });
});
