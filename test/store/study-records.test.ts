import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { SqliteStudyRecordStore } from '../../src/store/study-records.js';
import { hash } from '../../src/citations/exact.js';

it('publishes with atomic CAS across connections and returns validated records after reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'study-records-'));
  const path = join(directory, 'study.db');
  const first = new SqliteRepository(path); const second = new SqliteRepository(path);
  const a = new SqliteStudyRecordStore(first); const b = new SqliteStudyRecordStore(second);
  const record = { id: 'note', revision: randomUUID(), courseId: 'course-a', sourceRevision: hash('source'),
    claims: [{ text: 'Synthetic claim.', citations: [{ sourceItemId: 's', quote: 'Synthetic', locator: 'text' }] }],
    citations: [{ sourceItemId: 's', quote: 'Synthetic', locator: 'text', offset: 0, end: 9, sourceHash: hash('Synthetic') }], limitations: [] };
  let reopened: SqliteRepository | undefined;
  try {
    await a.publish('revision.write', record.id, undefined, record);
    await expect(b.publish('revision.write', record.id, undefined, { ...record, revision: randomUUID() })).rejects.toMatchObject({ code: 'CONFLICT' });
    const updated = { ...record, revision: randomUUID(), previousRevision: record.revision };
    await b.publish('revision.write', record.id, record.revision, updated);
    await expect(a.publish('revision.write', record.id, record.revision, record)).rejects.toMatchObject({ code: 'CONFLICT' });
    first.close(); second.close(); reopened = new SqliteRepository(path);
    expect(await new SqliteStudyRecordStore(reopened).current('revision.write', record.id)).toEqual(updated);
    expect(await new SqliteStudyRecordStore(reopened).read('revision.list', { courseId: 'course-a', limit: 100 })).toMatchObject({ items: [updated] });
  } finally { first.close(); second.close(); reopened?.close(); await rm(directory, { recursive: true, force: true }); }
});
