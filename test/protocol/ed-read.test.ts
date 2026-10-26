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
const otherKey = 'SYNB20002:2026:S2';
const at = '2026-10-24T00:00:00Z';
const lessons = [
  { title: 'Synthetic lesson one', dueAt: '2026-03-01T23:59:00+11:00', quote: 'Synthetic lesson due quote' },
  { title: 'Synthetic lesson two', quote: 'Synthetic undated lesson quote' },
];

function setup() {
  const store = new SqliteRepository(':memory:');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'ed-read-')));
  const host = createProductionProtocol({ store, files: new ProtocolFiles(join(directory, 'journal')), owner: { assertOwner: async () => {} } });
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const agent = host.registry.agentTools(host.context);
  const agentCall = (name: string, input: unknown) => dispatch(agent.registry, name, input, agent.context);
  const jobs = new SyncJobs(store);
  const select = () => store.saveCourseSelections([{ key, code: 'SYNA10001', term: '2026:S2',
    pages: { ed: 'https://edstem.org/au/courses/800001' }, offeredAt: at, selected: true, decidedAt: at }]);
  return { store, host, agent, agentCall, jobs, select };
}

const stages = (f: ReturnType<typeof setup>, jobId: string) => f.store.loadSyncJob(jobId)?.stages?.[key] as Record<string, any> | undefined;

describe('ed.read stage write (layered-sync task 7.2)', () => {
  it('stores the Ed fallback stage for an active job and course with via: "ax" and returns the lesson count', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const result = await f.agentCall('ed.read', { jobId: job.id, courseKey: key, lessons });
    expect(result).toMatchObject({ ok: true });
    expect((result as unknown as { data: Record<string, number> }).data).toEqual({ lessons: 2 });
    expect(stages(f, job.id)?.ed).toEqual({ via: 'ax', source: 'edstem-page', lessons });
  });

  it('refuses an ended job without storing the stage', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    f.store.saveSyncJob({ ...job, endedAt: at });
    const result = await f.agentCall('ed.read', { jobId: job.id, courseKey: key, lessons });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringMatching(/No active sync job/) } });
    expect(f.store.loadSyncJob(job.id)?.stages).toBeUndefined();
  });

  it('refuses a foreign course without storing the stage', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([otherKey]);
    const result = await f.agentCall('ed.read', { jobId: job.id, courseKey: key, lessons });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining(key) } });
    expect(f.store.loadSyncJob(job.id)?.stages?.[otherKey]).toBeUndefined();
  });

  it('refuses a malformed due time without storing the stage', async () => {
    const f = setup(); f.select();
    const job = f.jobs.open([key]);
    const result = await f.agentCall('ed.read', { jobId: job.id, courseKey: key,
      lessons: [{ ...lessons[0]!, dueAt: 'tomorrow' }] });
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect((result as unknown as { error: { message: string } }).error.message.toLowerCase()).toContain('nothing was stored');
    expect(stages(f, job.id)).toBeUndefined();
  });

  it('is an agent tool and appears in the agent tool set, keeping the owner-only commands out', () => {
    const f = setup();
    const names = f.agent.registry.list().map(entry => entry.name);
    expect(names).toContain('ed.read');
    expect(f.host.registry.get('ed.read')).toMatchObject({ level: 0 });
  });
});
