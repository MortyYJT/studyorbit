import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { createProductionProtocol } from '../../src/protocol/production.js';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { dispatch } from '../../src/protocol/registry.js';
import { SyncJobs } from '../../src/sync/jobs.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });

const key = 'SYNA10001:2026:S2';
const source = 'https://handbook.unimelb.edu.au/2026/subjects/syna10001/assessment';
const at = '2026-10-24T00:00:00Z';

const copied = (marker = 'SYNTHETIC_HANDBOOK_PAGE_MARKER') => [
  marker,
  'The University of Melbourne Handbook',
  'SYNA10001 Synthetic Systems',
  'Assessment',
  'Description\tTiming\tPercentage',
  'Assignments\tWeeks 3-10\t30%',
  'Mid-semester test\tWeek 6\t20%',
  'Exam\tDuring the examination period\t50%',
  '',
  'Hurdle requirements',
  'Students must pass the exam to pass the subject.',
].join('\n');

function setup() {
  const store = new SqliteRepository(':memory:');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'handbook-capture-')));
  const clipboard = { text: '', reads: 0, read(): string { this.reads++; return this.text; } };
  const host = createProductionProtocol({ store, files: new ProtocolFiles(join(directory, 'journal')), owner: { assertOwner: async () => {} }, clipboard });
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const agent = host.registry.agentTools(host.context);
  const agentCall = (name: string, input: unknown) => dispatch(agent.registry, name, input, agent.context);
  const jobs = new SyncJobs(store);
  const select = () => store.saveCourseSelections([{ key, code: 'SYNA10001', term: '2026:S2', pages: {}, offeredAt: at, selected: true, decidedAt: at }]);
  return { store, host, agent, agentCall, jobs, clipboard, select };
}

const stage = (f: ReturnType<typeof setup>, jobId: string) => (f.store.loadSyncJob(jobId)?.stages?.[key] as Record<string, any> | undefined)?.skeleton;

describe('handbook.capture agent command (layered-sync task 4.1)', () => {
  it('reads the fake clipboard, stores the parsed skeleton with via handbook and the Handbook URL as source, and returns the count', async () => {
    const f = setup();
    f.select();
    const job = f.jobs.open([key]);
    f.clipboard.text = copied();
    const result = await f.agentCall('handbook.capture', { jobId: job.id, courseKey: key });
    expect(result).toMatchObject({ ok: true, data: { components: 3 } });
    expect(f.clipboard.reads).toBe(1);
    expect(stage(f, job.id)).toMatchObject({ source, via: 'handbook', components: [
      { name: 'Assignments', weight: 30, timing: 'Weeks 3-10' },
      { name: 'Mid-semester test', weight: 20, timing: 'Week 6' },
      { name: 'Exam', weight: 50, timing: 'During the examination period', hurdle: expect.stringMatching(/pass the exam/i) },
    ] });
    expect(JSON.stringify(f.store.loadSyncJob(job.id))).not.toContain('SYNTHETIC_HANDBOOK_PAGE_MARKER');
  });

  it('works with fetch stubbed to throw: the command makes no network request to the Handbook', async () => {
    const f = setup();
    f.select();
    const job = f.jobs.open([key]);
    f.clipboard.text = copied();
    const fetch = vi.fn(() => { throw new Error('network access is forbidden'); });
    vi.stubGlobal('fetch', fetch);
    expect(await f.agentCall('handbook.capture', { jobId: job.id, courseKey: key })).toMatchObject({ ok: true, data: { components: 3 } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('page text as an argument: an extra key is refused with INVALID_INPUT while the clipboard is not read and nothing is stored', async () => {
    const f = setup();
    f.select();
    const job = f.jobs.open([key]);
    f.clipboard.text = copied('SYNTHETIC_ARGUMENT_MARKER');
    const result = await f.agentCall('handbook.capture', { jobId: job.id, courseKey: key, text: f.clipboard.text });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(f.clipboard.reads).toBe(0);
    expect(f.store.loadSyncJob(job.id)?.stages).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_ARGUMENT_MARKER');
  });

  it('block page copied: INVALID_INPUT asks for a fresh copy and the marker is never echoed or stored', async () => {
    const f = setup();
    f.select();
    const job = f.jobs.open([key]);
    const marker = 'SYNTHETIC_HANDBOOK_BLOCK_MARKER';
    f.clipboard.text = `${marker}: Access denied. Complete the bot check.`;
    const result = await f.agentCall('handbook.capture', { jobId: job.id, courseKey: key });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringMatching(/assessment table/i) } });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(f.store.loadSyncJob(job.id)?.stages).toBeUndefined();
    expect(JSON.stringify(f.store.loadSyncJob(job.id))).not.toContain(marker);
  });

  it('over 1 MB: refused, and the marker in the clipboard never appears in the error or a stored row', async () => {
    const f = setup();
    f.select();
    const job = f.jobs.open([key]);
    const marker = 'SYNTHETIC_HANDBOOK_OVERSIZE_MARKER';
    f.clipboard.text = `${marker}${'x'.repeat(1024 * 1024)}`;
    const result = await f.agentCall('handbook.capture', { jobId: job.id, courseKey: key });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringMatching(/1 MB|too large/i) } });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(f.store.loadSyncJob(job.id)?.stages).toBeUndefined();
    expect(JSON.stringify(f.store.loadSyncJob(job.id))).not.toContain(marker);
  });

  it('requires an active job and a course of that job', async () => {
    const f = setup();
    f.select();
    const job = f.jobs.open(['SYNB20002:2026:S2']);
    f.clipboard.text = copied();
    expect(await f.agentCall('handbook.capture', { jobId: job.id, courseKey: key })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await f.agentCall('handbook.capture', { jobId: job.id })).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(await f.agentCall('handbook.capture', { jobId: 'synthetic-missing-job', courseKey: key })).toMatchObject({ ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringMatching(/No active sync job/) } });
    f.store.saveSyncJob({ ...job, endedAt: at, outcome: 'OK' });
    expect(await f.agentCall('handbook.capture', { jobId: job.id, courseKey: 'SYNB20002:2026:S2' })).toMatchObject({ ok: false,
      error: { code: 'INVALID_INPUT', message: expect.stringMatching(/No active sync job/) } });
    expect(f.store.loadSyncJob(job.id)?.stages).toBeUndefined();
    expect(f.clipboard.reads).toBe(0);
  });
});

describe('handbook.capture tool list', () => {
  it('is an agent tool and not owner-only', () => {
    const f = setup();
    const names = f.host.registry.agentTools(f.host.context).registry.list().map(entry => entry.name);
    expect(names).toContain('handbook.capture');
    expect(f.host.registry.get('handbook.capture')).toMatchObject({ level: 0 });
  });
});
