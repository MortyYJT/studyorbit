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
const at = '2026-10-24T00:00:00Z';

describe('stage results shared across processes (coursework-sync)', () => {
  it('a course.map stored through one registry on a database file is read by another SyncJobs on the same file', async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'stage-share-')));
    const path = join(directory, 'coursework.db');
    const first = new SqliteRepository(path);
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    first.saveCourseSelections([{ key, code: 'SYNA10001', term: '2026:S2',
      pages: { canvas: 'https://canvas.lms.unimelb.edu.au/courses/12345' }, offeredAt: at, selected: true, decidedAt: at }]);
    const jobs = new SyncJobs(first);
    const job = jobs.open([key]);
    const host = createProductionProtocol({ store: first, files: new ProtocolFiles(join(directory, 'journal')), owner: { assertOwner: async () => {} } });
    const agent = host.registry.agentTools(host.context);
    const value = {
      lms: { text: 'Synthetic LMS use', quote: 'Synthetic LMS quote' },
      ed: { text: 'Synthetic Ed use', quote: 'Synthetic Ed quote' },
      syllabus: { where: 'canvas', quote: 'Synthetic syllabus quote' },
      links: [{ label: 'Synthetic page', url: 'https://canvas.lms.unimelb.edu.au/courses/12345/pages/synthetic', quote: 'Synthetic link quote' }],
    };
    const result = await dispatch(agent.registry, 'course.map', { jobId: job.id, courseKey: key, ...value }, agent.context);
    expect(result).toMatchObject({ ok: true });
    first.close();

    const second = new SqliteRepository(path);
    try {
      expect(new SyncJobs(second).load(job.id)?.stages?.[key]?.map).toEqual(value);
    } finally { second.close(); }
  });
});
