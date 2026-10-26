import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { dispatch } from '../../src/protocol/registry.js';
import { SyncJobs } from '../../src/sync/jobs.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

const key = 'SYNA10001:2026:S2';
const canvasPage = 'https://canvas.lms.unimelb.edu.au/courses/12345';
const groupsSource = 'https://canvas.lms.unimelb.edu.au/api/v1/courses/12345/assignment_groups?include[]=assignments&include[]=submission&per_page=100';
const tabsSource = 'https://canvas.lms.unimelb.edu.au/api/v1/courses/12345/tabs';
const at = '2026-10-24T00:00:00Z';

const groupsPage = (courseId = 12345, extra: Record<string, unknown> = {}) => JSON.stringify([{
  id: 501, name: 'Synthetic Assignments', group_weight: 30,
  assignments: [{
    id: 700001, name: 'Synthetic Assignment 1', course_id: courseId,
    due_at: '2026-10-31T12:59:00Z', unlock_at: '2026-10-01T00:00:00Z', points_possible: 20,
    assignment_group_id: 501, html_url: 'https://canvas.lms.unimelb.edu.au/courses/12345/assignments/700001',
    updated_at: '2026-10-20T08:00:00Z', submission: { workflow_state: 'graded', score: 17.5 },
    ...extra,
  }],
}]);

function setup() {
  const store = new SqliteRepository(':memory:');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'canvas-capture-')));
  const clipboard = { text: '', reads: 0, read(): string { this.reads++; return this.text; } };
  const host = createProductionProtocol({ store, files: new ProtocolFiles(join(directory, 'journal')), owner: { assertOwner: async () => {} }, clipboard });
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const agent = host.registry.agentTools(host.context);
  const agentCall = (name: string, input: unknown) => dispatch(agent.registry, name, input, agent.context);
  const jobs = new SyncJobs(store);
  const select = () => store.saveCourseSelections([{ key, code: 'SYNA10001', term: '2026:S2', pages: { canvas: canvasPage }, offeredAt: at, selected: true, decidedAt: at }]);
  return { store, host, agentCall, jobs, clipboard, select };
}

const data = <T = Record<string, any>>(envelope: { ok: boolean }) => (envelope as unknown as { data: T }).data;
const stage = (f: ReturnType<typeof setup>, jobId: string, name: 'tabs' | 'groups') => (f.store.loadSyncJob(jobId)?.stages?.[key] as Record<string, any> | undefined)?.[name];

describe('canvas.capture agent command (layered-sync task 3.2)', () => {
  it('Groups captured: reads the fake clipboard, stores API values with via api and returns counts', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    f.clipboard.text = `while(1);\n${groupsPage()}`;
    const result = await f.agentCall('canvas.capture', { jobId: job.id, courseKey: key, page: 'groups' });
    expect(result).toMatchObject({ ok: true, data: { page: 'groups', groups: 1, assignments: 1, coverage: 'api' } });
    expect(f.clipboard.reads).toBe(1);
    const groups = stage(f, job.id, 'groups')!;
    expect(groups).toMatchObject({ source: groupsSource, via: 'api', coverage: 'api', unweighted: false });
    expect(groups.groups[0].assignments[0]).toMatchObject({
      due: { value: '2026-10-31T12:59:00Z', state: 'found', via: 'api', source: groupsSource },
      unlockAt: { value: '2026-10-01T00:00:00Z', state: 'found', via: 'api', source: groupsSource },
      outOf: { value: 20, state: 'found', via: 'api', source: groupsSource },
      score: { value: 17.5, state: 'found', via: 'api', source: groupsSource },
      status: { value: 'graded', state: 'found', via: 'api', source: groupsSource },
      updatedAt: { value: '2026-10-20T08:00:00Z', state: 'found', via: 'api', source: groupsSource },
    });
    expect(JSON.stringify(f.store.loadSyncJob(job.id))).not.toContain('while(1)');
  });

  it('Page text as an argument: an extra key is refused with INVALID_INPUT while the clipboard is not read and nothing is stored', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    f.clipboard.text = groupsPage();
    const result = await f.agentCall('canvas.capture', { jobId: job.id, courseKey: key, page: 'groups', text: f.clipboard.text });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.clipboard.reads).toBe(0);
    expect(f.store.loadSyncJob(job.id)?.stages).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('Synthetic Assignment 1');
  });

  it('Wrong course: assignments for another Canvas course are refused and nothing is stored', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    f.clipboard.text = groupsPage(999);
    const result = await f.agentCall('canvas.capture', { jobId: job.id, courseKey: key, page: 'groups' });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringMatching(/999/) } });
    expect(f.store.loadSyncJob(job.id)?.stages).toBeUndefined();
  });

  it('Sign-in page copied: INVALID_INPUT says the page is not the expected JSON and the marker text is never echoed or stored', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const marker = 'SYNTHETIC_SIGN_IN_MARKER';
    f.clipboard.text = `<html><body>${marker}: sign in to Canvas</body></html>`;
    const result = await f.agentCall('canvas.capture', { jobId: job.id, courseKey: key, page: 'groups' });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringMatching(/not the expected JSON/i) } });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(f.store.loadSyncJob(job.id)?.stages).toBeUndefined();
    expect(JSON.stringify(f.store.loadSyncJob(job.id))).not.toContain(marker);
  });

  it('Full page: exactly 100 groups is accepted and the stage records partial coverage', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    f.clipboard.text = JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
      id: 600 + index, name: `Synthetic Group ${index}`, group_weight: 0,
      assignments: index === 0 ? [{ id: 700001, name: 'Synthetic Assignment 1', course_id: 12345, due_at: null, unlock_at: null,
        points_possible: null, assignment_group_id: 600, html_url: 'https://canvas.lms.unimelb.edu.au/courses/12345/assignments/700001',
        updated_at: null, submission: null }] : [],
    })));
    const result = await f.agentCall('canvas.capture', { jobId: job.id, courseKey: key, page: 'groups' });
    expect(result).toMatchObject({ ok: true, data: { groups: 100, assignments: 1, coverage: 'partial' } });
    expect(stage(f, job.id, 'groups')).toMatchObject({ coverage: 'partial', unweighted: true });
  });

  it('Unweighted course: all group weights are 0, so the stage is marked unweighted', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    f.clipboard.text = JSON.stringify([{ id: 501, name: 'Synthetic Assignments', group_weight: 0,
      assignments: [{ ...JSON.parse(groupsPage())[0].assignments[0], points_possible: 20 }] }]);
    expect(await f.agentCall('canvas.capture', { jobId: job.id, courseKey: key, page: 'groups' })).toMatchObject({ ok: true });
    expect(stage(f, job.id, 'groups')).toMatchObject({ unweighted: true });
  });

  it('Over 5 MB: refused, and the marker in the clipboard never appears in the error or a stored row', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const marker = 'SYNTHETIC_OVERSIZE_MARKER';
    f.clipboard.text = `${marker}${'x'.repeat(5 * 1024 * 1024)}`;
    const result = await f.agentCall('canvas.capture', { jobId: job.id, courseKey: key, page: 'groups' });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringMatching(/5 MB|too large/i) } });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(f.store.loadSyncJob(job.id)?.stages).toBeUndefined();
    expect(JSON.stringify(f.store.loadSyncJob(job.id))).not.toContain(marker);
  });

  it('courses: offers mapped candidates through courses.offer, counts skipped rows and keeps earlier decisions', async () => {
    const f = setup();
    f.store.saveCourseSelections([{ key, code: 'SYNA10001', term: '2026:S2', pages: { canvas: canvasPage }, offeredAt: at, selected: true, decidedAt: at }]);
    const job = f.jobs.open([]);
    f.clipboard.text = JSON.stringify([
      { id: 12345, name: 'Synthetic Systems', course_code: 'SYNA10001_2026_SM2', term: { name: 'Semester 2 2026' } },
      { id: 12346, name: 'Synthetic Winter WXYZ20002', course_code: 'WXYZ20002', term: { name: 'Winter 2026' } },
      { id: 12347, name: 'Synthetic Unknown EFGH30003', course_code: 'EFGH30003', term: { name: 'Synthetic Term' } },
    ]);
    const result = await f.agentCall('canvas.capture', { jobId: job.id, page: 'courses' });
    expect(result).toMatchObject({ ok: true, data: { page: 'courses', stored: 2, skipped: 1, undecided: 1, selected: 1 } });
    const candidates = data<{ items: { key: string; selected?: boolean }[] }>(await f.agentCall('courses.candidates', {})).items;
    expect(candidates.map(candidate => candidate.key)).toEqual(['SYNA10001:2026:S2', 'WXYZ20002:2026:WINTER']);
    expect(candidates.map(candidate => candidate.selected)).toEqual([true, undefined]);
  });

  it('tabs: stores the parsed tab list with the API URL as source', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    f.clipboard.text = JSON.stringify([{ id: 'assignments', label: 'Assignments', type: 'internal',
      html_url: 'https://canvas.lms.unimelb.edu.au/courses/12345/assignments' }, { id: 'home', label: 'Home', type: 'internal' }]);
    const result = await f.agentCall('canvas.capture', { jobId: job.id, courseKey: key, page: 'tabs' });
    expect(result).toMatchObject({ ok: true, data: { page: 'tabs', tabs: 2 } });
    expect(stage(f, job.id, 'tabs')).toEqual({ source: tabsSource, via: 'api', tabs: [
      { id: 'assignments', label: 'Assignments', type: 'internal', url: 'https://canvas.lms.unimelb.edu.au/courses/12345/assignments' },
      { id: 'home', label: 'Home', type: 'internal' },
    ] });
  });

  it('requires an active job, a courseKey for tabs and groups, and a selected course with a Canvas URL', async () => {
    const f = setup();
    const job = f.jobs.open([key]);
    f.clipboard.text = groupsPage();
    expect(await f.agentCall('canvas.capture', { jobId: job.id, page: 'groups' })).toMatchObject({ ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringMatching(/courseKey/i) } });
    expect(await f.agentCall('canvas.capture', { jobId: job.id, courseKey: 'SYNB20002:2026:S2', page: 'groups' })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    f.store.saveSyncJob({ ...job, endedAt: at, outcome: 'OK' });
    expect(await f.agentCall('canvas.capture', { jobId: job.id, courseKey: key, page: 'groups' })).toMatchObject({ ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringMatching(/No active sync job/) } });
    expect(f.store.loadSyncJob(job.id)?.stages).toBeUndefined();

    const noCanvas = setup();
    noCanvas.store.saveCourseSelections([{ key, code: 'SYNA10001', term: '2026:S2', pages: {}, offeredAt: at, selected: true, decidedAt: at }]);
    const noCanvasJob = noCanvas.jobs.open([key]);
    noCanvas.clipboard.text = groupsPage();
    expect(await noCanvas.agentCall('canvas.capture', { jobId: noCanvasJob.id, courseKey: key, page: 'groups' })).toMatchObject({ ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringMatching(/Canvas/i) } });
  });
});

describe('canvas.capture tool list', () => {
  it('is an agent tool and not owner-only', async () => {
    const f = setup();
    const names = f.host.registry.agentTools(f.host.context).registry.list().map(entry => entry.name);
    expect(names).toContain('canvas.capture');
    expect(f.host.registry.get('canvas.capture')).toMatchObject({ level: 0 });
  });
});
