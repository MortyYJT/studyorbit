import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = '2026-10-24T01:00:00Z';

it('migration 004 adds course_selection and sync_jobs; rows survive reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coursework-004-')); dirs.push(dir);
  const file = join(dir, 'db.sqlite');
  const first = new SqliteRepository(file);
  first.saveModule({ id: 'm', name: 'Synthetic', glyph: 'S', auto: false });
  first.saveSyncJob({ id: 'job', startedAt: at, courses: [], submissions: {} });
  first.close();
  // PRAGMA user_version is a big-endian 32-bit integer at SQLite header offset 60.
  expect(readFileSync(file).readUInt32BE(60)).toBe(6);
  const second = new SqliteRepository(file);
  try {
    expect(second.loadModule('m')).toMatchObject({ id: 'm' });
    expect(second.loadSyncJob('job')).toMatchObject({ id: 'job' });
  } finally { second.close(); }
});

it('stores course selections and sync jobs and runs a batch inside one shared transaction', () => {
  const store = new SqliteRepository(':memory:');
  try {
    const selection = { key: 'SYNA10001:2026:S2', code: 'SYNA10001', term: '2026:S2', pages: {}, offeredAt: at };
    store.saveCourseSelections([selection]);
    expect(store.listCourseSelections()).toEqual([selection]);
    const job = { id: 'job', startedAt: at, courses: [selection.key], submissions: {} };
    store.saveSyncJob(job);
    expect(store.loadSyncJob('job')).toEqual(job);
    expect(store.listSyncJobs()).toEqual([job]);
    expect(() => store.transaction(() => {
      store.saveSyncJob({ ...job, submissions: { [selection.key]: 1 } });
      store.saveBatch({ modules: [{ id: 'm', name: 'Synthetic', glyph: 'S', auto: false }] });
      throw new Error('synthetic failure');
    })).toThrow('synthetic failure');
    expect(store.loadSyncJob('job')).toEqual(job);
    expect(store.loadModule('m')).toBeUndefined();
  } finally { store.close(); }
});
