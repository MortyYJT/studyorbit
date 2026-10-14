import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { SqliteStudyRecordStore } from '../../src/store/study-records.js';
import { courseEvidence } from '../../src/revision/source-fetch.js';
import { TrustedStoreEvidence } from '../../src/protocol/reads.js';
import { hash } from '../../src/citations/exact.js';

it('publishes with atomic CAS across connections and returns validated records after reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'study-records-'));
  const path = join(directory, 'study.db');
  const first = new SqliteRepository(path); const second = new SqliteRepository(path);
  const a = new SqliteStudyRecordStore(first); const b = new SqliteStudyRecordStore(second);
  first.saveCourse({ id: 'course-a', moduleId: 'm', code: 'SYN', name: 'Synthetic', term: 'test', assessmentsComplete: true });
  first.saveSourceItem({ id: 's', externalId: 's', courseId: 'course-a', platform: 'canvas', kind: 'announcement', title: 'Synthetic', text: 'Synthetic', contentHash: hash('Synthetic'), fetchedAt: '2026-01-01T00:00:00Z' });
  const snapshot = await courseEvidence(first, new TrustedStoreEvidence(first), 'course-a');
  const record = { id: 'note', revision: randomUUID(), courseId: 'course-a', sourceRevision: snapshot.sourceRevision,
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

it('rejects source changes between validation and publication across connections without replacing accepted state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'study-stale-'));
  const first = new SqliteRepository(join(directory, 'study.db'));
  const second = new SqliteRepository(join(directory, 'study.db'));
  try {
    first.saveCourse({ id: 'c', moduleId: 'm', code: 'SYN', name: 'Synthetic', term: 'test', assessmentsComplete: true });
    const source = { id: 's', externalId: 's', courseId: 'c', platform: 'canvas' as const, kind: 'announcement' as const, title: 'Synthetic', text: 'Trees.', contentHash: hash('Trees.'), fetchedAt: '2026-01-01T00:00:00Z' };
    first.saveSourceItem(source);
    const snapshot = await courseEvidence(first, new TrustedStoreEvidence(first), 'c');
    const record = { id: 'note', revision: randomUUID(), courseId: 'c', sourceRevision: snapshot.sourceRevision,
      claims: [{ text: 'Trees.', citations: [{ sourceItemId: 's', quote: 'Trees.', locator: 's' }] }],
      citations: [{ sourceItemId: 's', quote: 'Trees.', locator: 's', offset: 0, end: 6, sourceHash: hash('Trees.') }], limitations: [] };
    const store = new SqliteStudyRecordStore(first);
    await store.publish('revision.write', record.id, undefined, record);
    second.saveSourceItem({ ...source, text: 'Sorting.', contentHash: hash('Sorting.') });
    await expect(store.publish('revision.write', record.id, record.revision, { ...record, revision: randomUUID() })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await store.current('revision.write', record.id)).toEqual(record);
    await expect(store.publish('revision.write', 'new', undefined, { ...record, id: 'new' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await store.current('revision.write', 'new')).toBeUndefined();
  } finally { first.close(); second.close(); await rm(directory, { recursive: true, force: true }); }
});
