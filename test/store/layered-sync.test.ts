import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';

const at = '2026-10-24T01:00:00Z';
const later = '2026-10-25T01:00:00Z';
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function path(): string {
  const directory = mkdtempSync(join(tmpdir(), 'coursework-layered-'));
  directories.push(directory);
  return join(directory, 'db.sqlite');
}
function version(file: string) { return readFileSync(file).readUInt32BE(60); }

it('repository stores saved files by course and assessment', () => {
  const store = new SqliteRepository(':memory:');
  try {
    const material = { id: 'file-1', courseId: 'course-1', path: 'materials/week-1.pdf', fingerprint: 'hash-1', savedAt: at };
    const assessment = { id: 'file-2', courseId: 'course-1', assessmentId: 'assessment-1', path: 'assessments/brief.mhtml',
      fingerprint: 'hash-2', savedAt: later, supersededAt: later, openedAt: later };
    const otherCourse = { id: 'file-3', courseId: 'course-2', path: 'materials/week-2.pdf', fingerprint: 'hash-3', savedAt: at };
    store.saveSavedFile(material);
    store.saveSavedFile(assessment);
    store.saveSavedFile(otherCourse);
    expect(store.loadSavedFile('file-1')).toEqual(material);
    expect(store.loadSavedFile('missing')).toBeUndefined();
    expect(store.listSavedFiles('course-1')).toEqual([assessment, material]);
    expect(store.listSavedFilesForAssessment('assessment-1')).toEqual([assessment]);
    expect(store.listSavedFiles('course-2')).toEqual([otherCourse]);
    expect(() => store.saveSavedFile({ ...material, id: '' })).toThrow();
    expect(store.listSavedFiles('course-1')).toHaveLength(2);
  } finally { store.close(); }
});

it('repository lists sync conflicts by course and only open ones on request', () => {
  const store = new SqliteRepository(':memory:');
  try {
    const openWeight = { id: 'conflict-1', courseId: 'course-1', target: { componentKey: 'COMP90099:assignments' },
      field: 'weight' as const, skeletonValue: { weight: 30 }, canvasValue: { weight: 40 }, state: 'open' as const, checkedAt: at };
    const openUnmatched = { id: 'conflict-2', courseId: 'course-1', target: { canvasAssignmentId: '500001' },
      field: 'unmatched' as const, canvasValue: { id: '500001', name: 'Synthetic item', due: null }, state: 'open' as const, checkedAt: later };
    const resolved = { ...openWeight, id: 'conflict-3', courseId: 'course-2', choice: 'skeleton' as const,
      state: 'resolved' as const, resolvedAt: later };
    for (const conflict of [openWeight, openUnmatched, resolved]) store.saveSyncConflict(conflict);
    expect(store.loadSyncConflict('conflict-1')).toEqual(openWeight);
    expect(store.loadSyncConflict('missing')).toBeUndefined();
    expect(store.listSyncConflicts('course-1')).toEqual([openUnmatched, openWeight]);
    expect(store.listOpenSyncConflicts('course-1')).toEqual([openUnmatched, openWeight]);
    expect(store.listOpenSyncConflicts()).toEqual([openUnmatched, openWeight]);
    expect(store.listSyncConflicts('course-2')).toEqual([resolved]);
    expect(() => store.saveSyncConflict({ ...openUnmatched, choice: 'skeleton' })).toThrow();
    expect(store.listSyncConflicts('course-1')).toHaveLength(2);
  } finally { store.close(); }
});

it('round-trips a stored ongoing assessment as participation', () => {
  const store = new SqliteRepository(':memory:');
  try {
    const old = { id: 'assessment-1', courseId: 'course-1', name: 'Synthetic ongoing work', kind: 'ongoing' as const,
      weight: 10, isFinal: false, status: 'not_started' as const };
    store.saveAssessment(old);
    expect(store.loadAssessment(old.id)).toMatchObject({ id: old.id, kind: 'participation' });
  } finally { store.close(); }
});

it('filters a raw version 5 ongoing row by participation', () => {
  const file = path();
  const current = new SqliteRepository(file);
  current.close();
  const raw = { id: 'raw-assessment', courseId: 'course-1', name: 'Synthetic ongoing work', kind: 'ongoing',
    weight: 10, isFinal: false, status: 'not_started' };
  // Bypass the schema: the v5 row's JSON column still holds `ongoing`.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const [file, raw] = JSON.parse(process.argv[1]);
    const db = new DatabaseSync(file);
    try {
      db.prepare('INSERT INTO assessments (id, courseId, kind, weight, json) VALUES (?, ?, ?, ?, ?)')
        .run(raw.id, raw.courseId, raw.kind, raw.weight, JSON.stringify(raw));
    } finally { db.close(); }
  `, JSON.stringify([file, raw])], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const store = new SqliteRepository(file);
  try {
    expect(store.query('assessments', { kind: 'participation', limit: 10 }).items)
      .toEqual([expect.objectContaining({ id: raw.id, kind: 'participation' })]);
    expect(store.queryEffectiveAssessments({ kind: 'participation', limit: 10 }).items)
      .toEqual([expect.objectContaining({ id: raw.id, kind: 'participation' })]);
  } finally { store.close(); }
});

it('migrates a version 5 database with old kind and sync job rows to version 6', () => {
  const file = path();
  const oldAssessment = { id: 'old-assessment', courseId: 'course-1', name: 'Synthetic ongoing work', kind: 'ongoing',
    weight: 10, isFinal: false, status: 'not_started' };
  const oldJob = { id: 'old-job', startedAt: at, courses: ['COMP90099:2026:S2'], submissions: { 'COMP90099:2026:S2': 2 } };
  const current = new SqliteRepository(file);
  current.close();
  expect(version(file)).toBe(6);
  // A version 5 database is the version 6 schema without migration 006's tables: remove only those tables.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const [file, assessment, job] = JSON.parse(process.argv[1]);
    const db = new DatabaseSync(file);
    try {
      db.exec('DROP TABLE saved_files; DROP TABLE sync_conflicts; PRAGMA user_version = 5');
      db.prepare('INSERT INTO assessments (id, courseId, kind, weight, json) VALUES (?, ?, ?, ?, ?)')
        .run(assessment.id, assessment.courseId, assessment.kind, assessment.weight, JSON.stringify(assessment));
      db.prepare('INSERT INTO sync_jobs (id, startedAt, json) VALUES (?, ?, ?)').run(job.id, job.startedAt, JSON.stringify(job));
    } finally { db.close(); }
  `, JSON.stringify([file, oldAssessment, oldJob])], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  expect(version(file)).toBe(5);

  const store = new SqliteRepository(file);
  try {
    expect(version(file)).toBe(6);
    expect(store.loadAssessment(oldAssessment.id)).toMatchObject({ id: oldAssessment.id, kind: 'participation' });
    expect(store.loadSyncJob(oldJob.id)).toEqual(oldJob);
    const fileRecord = { id: 'file-1', courseId: oldAssessment.courseId, assessmentId: oldAssessment.id,
      path: 'assessments/ongoing.mhtml', fingerprint: 'hash-1', savedAt: at };
    const conflict = { id: 'conflict-1', courseId: oldAssessment.courseId,
      target: { componentKey: 'COMP90099:ongoing' }, field: 'weight' as const,
      skeletonValue: { weight: 10 }, canvasValue: { weight: 0 }, state: 'open' as const, checkedAt: at };
    store.saveSavedFile(fileRecord);
    store.saveSyncConflict(conflict);
    expect(store.listSavedFilesForAssessment(oldAssessment.id)).toEqual([fileRecord]);
    expect(store.listOpenSyncConflicts(oldAssessment.courseId)).toEqual([conflict]);
  } finally { store.close(); }

  const reopened = new SqliteRepository(file);
  try {
    expect(reopened.loadAssessment(oldAssessment.id)).toMatchObject({ kind: 'participation' });
    expect(reopened.loadSyncJob(oldJob.id)).toEqual(oldJob);
    expect(reopened.listSavedFiles(oldAssessment.courseId)).toHaveLength(1);
    expect(reopened.listOpenSyncConflicts(oldAssessment.courseId)).toHaveLength(1);
  } finally { reopened.close(); }
});
