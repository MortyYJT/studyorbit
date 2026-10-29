import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LINEAGE_ANCESTORS, MIGRATIONS, openSyncStore, RETENTION_LINEAGES, sha256, storePath } from '../scripts/lib/sync-store.mjs';
import type { Migration, SyncStore } from '../scripts/lib/sync-store.mjs';

// Scenarios from openspec/specs/sync-job-store/spec.md and design §5 of the archived change local-server-sync-pipeline.
// Every test uses a real database file in a temporary project directory and synthetic course IDs only.
let dir: string;
const opened: SyncStore[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'sync-store-')); });
afterEach(async () => {
  for (const store of opened.splice(0)) store.close();
  await rm(dir, { recursive: true, force: true });
});

const mode = async (path: string) => (await stat(path)).mode & 0o777;
const dbFile = () => join(dir, '.local', 'studyorbit.db');

/** A clock the tests move by hand; each read returns the current value. */
function manualClock(start = Date.UTC(2026, 9, 30, 0, 0, 0)) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms: number) => { now += ms; };
  return clock;
}

async function open(options: { migrations?: readonly Migration[]; clock?: () => number } = {}) {
  const result = await openSyncStore({ projectDir: dir, ...options });
  if (!result.ok) throw new Error(`store unavailable: ${result.reason} ${result.message}`);
  opened.push(result.store);
  return result.store;
}

function rawVersion(path = dbFile()) {
  const db = new DatabaseSync(path);
  try { return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version; } finally { db.close(); }
}

describe('opening the store', () => {
  it('creates .local/ as 0700 and the database as 0600 at .local/studyorbit.db, apart from the v1 coursework.db', async () => {
    const store = await open();
    expect(store.path).toBe(dbFile());
    expect(storePath(dir)).toBe(dbFile());
    expect(dbFile().endsWith('coursework.db')).toBe(false);
    expect(await mode(join(dir, '.local'))).toBe(0o700);
    expect(await mode(dbFile())).toBe(0o600);
    store.createJob({ id: 'job-1', courses: [{ courseId: 'SYN-1' }] });
    // SQLite gives the WAL file the database file's permissions.
    expect(await mode(`${dbFile()}-wal`)).toBe(0o600);
  });

  it('repairs an existing database file with loose permissions', async () => {
    (await open()).close();
    opened.length = 0;
    await chmod(dbFile(), 0o644);
    await open();
    expect(await mode(dbFile())).toBe(0o600);
  });

  it('opens in WAL mode with a busy timeout and foreign keys on', async () => {
    const store = await open();
    const db = new DatabaseSync(dbFile());
    try { expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' }); } finally { db.close(); }
    // Another process holds the write lock for a moment: our write waits for it instead of failing with SQLITE_BUSY.
    const holder = spawn(process.execPath, ['-e', [
      "const { DatabaseSync } = require('node:sqlite');",
      'const db = new DatabaseSync(process.argv[1]);',
      "db.exec('BEGIN IMMEDIATE'); console.log('locked');",
      "setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);",
    ].join('\n'), dbFile()], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, NODE_DEBUG: '' } });
    await new Promise<void>(resolve => holder.stdout.once('data', () => resolve()));
    const started = Date.now();
    store.createJob({ id: 'job-1', courses: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    await new Promise(resolve => holder.once('exit', resolve));
    expect(store.getJob('job-1')).not.toBeNull();
    expect(() => store.updateCourse('missing-job', 'SYN-1', { status: 'running' })).toThrow('COURSE_NOT_FOUND');
    expect(() => store.saveStage({ jobId: 'missing-job', courseId: 'SYN-1', stage: 'collect', inputHash: 'h', status: 'running' })).toThrow(/FOREIGN KEY/);
  });
});

describe('migrations', () => {
  it('brings a fresh database to the latest user_version', async () => {
    const store = await open();
    expect(store.version).toBe(MIGRATIONS.length);
    store.close();
    expect(rawVersion()).toBe(MIGRATIONS.length);
    expect(existsSync(join(dir, '.local', 'studyorbit.db.v0.bak'))).toBe(false);
  });

  it('backs up a version 1 database to .local/studyorbit.db.v1.bak (0600) before migration 2 runs', async () => {
    (await open({ migrations: MIGRATIONS.slice(0, 1) })).createJob({ id: 'job-1', courses: [{ courseId: 'SYN-1' }] });
    opened.pop()!.close();
    const backup = join(dir, '.local', 'studyorbit.db.v1.bak');
    await writeFile(backup, 'an older copy of that name');
    let seenBackup = false;
    const second: Migration = db => {
      seenBackup = existsSync(backup) && rawVersion(backup) === 1;
      db.exec('CREATE TABLE extra (x INTEGER)');
    };
    const store = await open({ migrations: [MIGRATIONS[0], second] });
    expect(seenBackup).toBe(true);
    expect(store.version).toBe(2);
    expect(await mode(backup)).toBe(0o600);
    const copy = new DatabaseSync(backup);
    try { expect(copy.prepare('SELECT id FROM jobs').all()).toEqual([{ id: 'job-1' }]); } finally { copy.close(); }
  });

  it('rolls a failing migration back, keeps the old version and makes the store unavailable', async () => {
    (await open({ migrations: MIGRATIONS.slice(0, 1) })).createJob({ id: 'job-1', courses: [] });
    opened.pop()!.close();
    const failing = 'CREATE TABLE extra (x INTEGER); INSERT INTO no_such_table VALUES (1);';
    const result = await openSyncStore({ projectDir: dir, migrations: [MIGRATIONS[0], failing] });
    expect(result).toMatchObject({ ok: false, error: 'SYNC_STORE_UNAVAILABLE', reason: 'MIGRATION_FAILED' });
    expect(rawVersion()).toBe(1);
    const db = new DatabaseSync(dbFile());
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'extra'").all()).toEqual([]);
      expect(db.prepare('SELECT id FROM jobs').all()).toEqual([{ id: 'job-1' }]);
    } finally { db.close(); }
  });

  it('refuses a database with a newer user_version and leaves its bytes unchanged', async () => {
    await mkdir(join(dir, '.local'), { recursive: true });
    const db = new DatabaseSync(dbFile());
    db.exec('PRAGMA journal_mode = DELETE; CREATE TABLE future (x INTEGER); PRAGMA user_version = 9;');
    db.close();
    const before = await readFile(dbFile());
    const result = await openSyncStore({ projectDir: dir });
    expect(result).toMatchObject({ ok: false, error: 'SYNC_STORE_UNAVAILABLE', reason: 'NEWER_VERSION' });
    expect((await readFile(dbFile())).equals(before)).toBe(true);
    expect(existsSync(`${dbFile()}-wal`)).toBe(false);
  });

  it('refuses a file that is not a database and leaves its bytes unchanged', async () => {
    await mkdir(join(dir, '.local'), { recursive: true });
    const bytes = Buffer.from('synthetic text that is not a SQLite database\n'.repeat(100));
    await writeFile(dbFile(), bytes, { mode: 0o600 });
    const result = await openSyncStore({ projectDir: dir });
    expect(result).toMatchObject({ ok: false, error: 'SYNC_STORE_UNAVAILABLE', reason: 'NOT_A_DATABASE' });
    expect((await readFile(dbFile())).equals(bytes)).toBe(true);
    expect(existsSync(join(dir, '.local', 'studyorbit.db.v0.bak'))).toBe(false);
  });
});

describe('data API', () => {
  it('creates a job with its courses in order and updates job and course state', async () => {
    const clock = manualClock();
    const store = await open({ clock });
    const previous = store.putArtifact('{"earlier":"synthetic"}');
    const job = store.createJob({
      id: 'job-1', provider: 'deepseek', model: 'synthetic-model',
      courses: [{ courseId: 'SYN-2', code: 'SYN20002', term: '2026 S2', previous }, { courseId: 'SYN-1', code: 'SYN10001', term: '2026 S2' }],
    });
    expect(job).toMatchObject({ id: 'job-1', kind: 'course-sync', status: 'running', provider: 'deepseek', model: 'synthetic-model', resumedFrom: null, createdAt: '2026-10-30T00:00:00.000Z', startedAt: '2026-10-30T00:00:00.000Z', finishedAt: null });
    expect(job.courses.map(course => [course.courseId, course.position, course.status, course.previous, course.reused])).toEqual([
      ['SYN-2', 0, 'pending', previous, false], ['SYN-1', 1, 'pending', null, false],
    ]);
    store.updateCourse('job-1', 'SYN-1', { status: 'failed', reason: '合成原因', stoppedStage: 'analyse', phase: 'analyse', reused: true });
    store.updateJob('job-1', { status: 'failed', finishedAt: '2026-10-30T00:05:00.000Z', error: null });
    const read = store.getJob('job-1')!;
    expect(read.status).toBe('failed');
    expect(read.finishedAt).toBe('2026-10-30T00:05:00.000Z');
    expect(read.courses[1]).toMatchObject({ courseId: 'SYN-1', status: 'failed', reason: '合成原因', stoppedStage: 'analyse', reused: true });
    expect(() => store.updateCourse('job-1', 'SYN-1', { status: 'bogus' as never })).toThrow(/CHECK/);
    expect(() => store.updateJob('job-1', { nope: 1 } as never)).toThrow('INVALID_FIELD');
    expect(() => store.updateJob('missing', { status: 'failed' })).toThrow('JOB_NOT_FOUND');
    expect(store.getJob('missing')).toBeNull();
  });

  it('writes and reads stage checkpoints with JSON fields', async () => {
    const store = await open();
    store.createJob({ id: 'job-1', courses: [{ courseId: 'SYN-1' }] });
    const output = store.putArtifact('{"final":"synthetic"}');
    const row = store.saveStage({ jobId: 'job-1', courseId: 'SYN-1', stage: 'collect', inputHash: 'in-1', status: 'running', checkpoint: { sources: {} } });
    expect(row).toMatchObject({ status: 'running', checkpoint: { sources: {} }, attempts: 0, outputHash: null, usage: null });
    expect(row.startedAt).not.toBeNull();
    store.updateStage('job-1', 'SYN-1', 'collect', { checkpoint: { sources: { canvas: { file: 'canvas.json', sha256: 'abc', exitCode: 0 } } } });
    store.updateStage('job-1', 'SYN-1', 'collect', { status: 'succeeded', outputHash: output, attempts: 1, usage: { input: 3, output: 1 }, durationMs: 12, finishedAt: '2026-10-30T00:00:01.000Z' });
    expect(store.getStage('job-1', 'SYN-1', 'collect')).toMatchObject({
      inputHash: 'in-1', status: 'succeeded', outputHash: output, attempts: 1, usage: { input: 3, output: 1 }, durationMs: 12,
      checkpoint: { sources: { canvas: { file: 'canvas.json', sha256: 'abc', exitCode: 0 } } },
    });
    expect(store.getStage('job-1', 'SYN-1', 'merge')).toBeNull();
    expect(() => store.updateStage('job-1', 'SYN-1', 'merge', { status: 'failed' })).toThrow('STAGE_NOT_FOUND');
    expect(() => store.saveStage({ jobId: 'job-1', courseId: 'SYN-1', stage: 'analyse', inputHash: 'x', status: 'running', outputHash: 'not-an-artifact' })).toThrow(/FOREIGN KEY/);
  });

  it('stores artifacts once by sha256', async () => {
    const store = await open();
    const content = '{"synthetic":true}';
    const hash = store.putArtifact(content);
    expect(hash).toBe(sha256(content));
    expect(store.putArtifact(content)).toBe(hash);
    expect(store.getArtifact(hash)).toBe(content);
    expect(store.getArtifact(sha256('other'))).toBeNull();
  });

  it('keeps one snapshot per job and course whose content_hash is the document sha256', async () => {
    const store = await open();
    store.createJob({ id: 'job-1', courses: [{ courseId: 'SYN-1' }] });
    const document = '{"version":2,"course":"SYN-1"}\n';
    const snapshot = store.putSnapshot({ jobId: 'job-1', courseId: 'SYN-1', document, version: 2, status: 'completed', reason: null, file: '/synthetic/SYN/分数结构.json' });
    expect(snapshot).toMatchObject({ jobId: 'job-1', courseId: 'SYN-1', contentHash: sha256(document), file: '/synthetic/SYN/分数结构.json', status: 'completed' });
    // Recording the same snapshot again (a resumed merge) is a no-op; different content is refused.
    expect(store.putSnapshot({ jobId: 'job-1', courseId: 'SYN-1', document, version: 2, status: 'completed', file: '/synthetic/SYN/分数结构.json' }).id).toBe(snapshot.id);
    expect(() => store.putSnapshot({ jobId: 'job-1', courseId: 'SYN-1', document: '{}' })).toThrow('SNAPSHOT_CONFLICT');
    expect(store.getSnapshot('job-1', 'SYN-1')!.document).toBe(document);
    expect(store.getSnapshot('job-1', 'SYN-2')).toBeNull();
  });

  it('looks checkpoints up only in the lineage (self plus at most 20 ancestors), newest first', async () => {
    const clock = manualClock();
    const store = await open({ clock });
    const ids = Array.from({ length: LINEAGE_ANCESTORS + 3 }, (_, index) => `job-${index}`);
    ids.forEach((id, index) => {
      clock.advance(1000);
      store.createJob({ id, resumedFrom: index ? ids[index - 1] : null, courses: [{ courseId: 'SYN-1' }] });
      store.updateJob(id, { status: 'failed' });
    });
    clock.advance(1000);
    store.createJob({ id: 'unrelated', courses: [{ courseId: 'SYN-1' }] });
    const last = ids.at(-1)!;
    expect(store.lineage(last)).toEqual(ids.slice().reverse().slice(0, LINEAGE_ANCESTORS + 1));
    expect(store.lineage('unrelated')).toEqual(['unrelated']);
    expect(store.lineage('missing')).toEqual([]);
    expect(store.childOf(ids[3]!)?.id).toBe(ids[4]);
    expect(store.childOf(last)).toBeNull();

    const succeeded = (jobId: string, inputHash: string) => store.saveStage({ jobId, courseId: 'SYN-1', stage: 'collect', inputHash, status: 'succeeded' });
    succeeded('unrelated', 'same');
    expect(store.findCheckpoint(last, 'SYN-1', 'collect', 'same')).toBeNull();
    succeeded(ids[1], 'old'); // the 21st ancestor of the last job: outside the lineage
    expect(store.findCheckpoint(last, 'SYN-1', 'collect', 'old')).toBeNull();
    succeeded(ids[5], 'same');
    succeeded(ids[8], 'same');
    store.saveStage({ jobId: ids[9], courseId: 'SYN-1', stage: 'collect', inputHash: 'same', status: 'failed' });
    expect(store.findCheckpoint(last, 'SYN-1', 'collect', 'same')).toMatchObject({ jobId: ids[8], status: 'succeeded' });
    expect(store.findCheckpoint(last, 'SYN-1', 'analyse', 'same')).toBeNull();
    expect(store.findCheckpoint(last, 'SYN-2', 'collect', 'same')).toBeNull();

    // Merge consults every row of the lineage whatever its status, newest first.
    store.saveStage({ jobId: ids[6], courseId: 'SYN-1', stage: 'merge', inputHash: 'm', status: 'interrupted', checkpoint: { plannedPath: '/synthetic/a.json' } });
    store.saveStage({ jobId: ids[7], courseId: 'SYN-1', stage: 'merge', inputHash: 'm', status: 'cancelled', checkpoint: { plannedPath: '/synthetic/b.json' } });
    store.saveStage({ jobId: 'unrelated', courseId: 'SYN-1', stage: 'merge', inputHash: 'm', status: 'succeeded' });
    expect(store.lineageStages(last, 'SYN-1', 'merge').map(row => [row.jobId, row.status])).toEqual([[ids[7], 'cancelled'], [ids[6], 'interrupted']]);
  });

  it('returns the newest job and the newest 20 jobs with their courses', async () => {
    const clock = manualClock();
    const store = await open({ clock });
    expect(store.newestJob()).toBeNull();
    expect(store.listJobs()).toEqual([]);
    for (let index = 0; index < 25; index++) {
      clock.advance(1000);
      store.createJob({ id: `job-${String(index).padStart(2, '0')}`, courses: [{ courseId: 'SYN-1' }, { courseId: 'SYN-2' }] });
    }
    // Same creation time: the later insert counts as newer.
    store.createJob({ id: 'job-same-time', courses: [] });
    expect(store.newestJob()!.id).toBe('job-same-time');
    const list = store.listJobs();
    expect(list).toHaveLength(20);
    expect(list[0].id).toBe('job-same-time');
    expect(list[1].id).toBe('job-24');
    expect(list[1].courses.map(course => course.courseId)).toEqual(['SYN-1', 'SYN-2']);
    expect(store.listJobs(3).map(job => job.id)).toEqual(['job-same-time', 'job-24', 'job-23']);
  });

  it('runs writes inside a transaction and rolls back on error', async () => {
    const store = await open();
    expect(() => store.transaction(() => {
      store.createJob({ id: 'job-1', courses: [] });
      throw new Error('synthetic failure');
    })).toThrow('synthetic failure');
    expect(store.getJob('job-1')).toBeNull();
    expect(store.transaction(() => store.transaction(() => store.createJob({ id: 'job-2', courses: [] }).id))).toBe('job-2');
    expect(store.getJob('job-2')).not.toBeNull();
  });
});

describe('startup maintenance', () => {
  it('marks running jobs, their running stages and pending or running courses interrupted', async () => {
    const store = await open();
    store.createJob({ id: 'job-old', courses: [{ courseId: 'SYN-1' }] });
    store.updateCourse('job-old', 'SYN-1', { status: 'completed' });
    store.updateJob('job-old', { status: 'finished' });
    store.createJob({ id: 'job-live', courses: [{ courseId: 'SYN-1' }, { courseId: 'SYN-2' }, { courseId: 'SYN-3' }] });
    store.updateCourse('job-live', 'SYN-1', { status: 'completed' });
    store.updateCourse('job-live', 'SYN-2', { status: 'running' });
    store.saveStage({ jobId: 'job-live', courseId: 'SYN-1', stage: 'merge', inputHash: 'a', status: 'succeeded' });
    store.saveStage({ jobId: 'job-live', courseId: 'SYN-2', stage: 'analyse', inputHash: 'b', status: 'running' });
    expect(store.markInterrupted()).toEqual({ jobs: 1, courses: 2, stages: 1 });
    const job = store.getJob('job-live')!;
    expect(job.status).toBe('interrupted');
    expect(job.courses.map(course => course.status)).toEqual(['completed', 'interrupted', 'interrupted']);
    expect(store.getStage('job-live', 'SYN-2', 'analyse')!.status).toBe('interrupted');
    expect(store.getStage('job-live', 'SYN-1', 'merge')!.status).toBe('succeeded');
    expect(store.getJob('job-old')!.status).toBe('finished');
    expect(store.markInterrupted()).toEqual({ jobs: 0, courses: 0, stages: 0 });
  });

  /** Creates one finished job per call, each a second newer than the last, with one course, stage, snapshot and artifact. */
  function seed(store: SyncStore, clock: ReturnType<typeof manualClock>) {
    return (id: string, options: { resumedFrom?: string; status?: 'running' | 'finished'; shared?: string } = {}) => {
      clock.advance(1000);
      const own = store.putArtifact(`{"job":"${id}"}`);
      store.createJob({ id, resumedFrom: options.resumedFrom ?? null, courses: [{ courseId: 'SYN-1', previous: options.shared ?? null }] });
      store.saveStage({ jobId: id, courseId: 'SYN-1', stage: 'analyse', inputHash: id, status: 'succeeded', outputHash: own });
      store.putSnapshot({ jobId: id, courseId: 'SYN-1', document: `{"job":"${id}"}` });
      if (options.status !== 'running') store.updateJob(id, { status: 'finished' });
      return own;
    };
  }

  it('keeps the newest 50 lineages and deletes the rest with their rows and unreferenced artifacts', async () => {
    const clock = manualClock();
    const store = await open({ clock });
    const add = seed(store, clock);
    const shared = store.putArtifact('{"shared":"synthetic"}');
    const artifacts = Array.from({ length: 55 }, (_, index) => add(`job-${String(index).padStart(2, '0')}`, { shared: index === 0 || index === 54 ? shared : undefined }));
    const orphan = store.putArtifact('{"orphan":"synthetic"}');
    expect(RETENTION_LINEAGES).toBe(50);
    expect(store.prune()).toEqual({ jobs: 5, artifacts: 6 });
    expect(store.listJobs(100)).toHaveLength(50);
    for (let index = 0; index < 5; index++) {
      const id = `job-0${index}`;
      expect(store.getJob(id)).toBeNull();
      expect(store.getStage(id, 'SYN-1', 'analyse')).toBeNull();
      expect(store.getSnapshot(id, 'SYN-1')).toBeNull();
      expect(store.getArtifact(artifacts[index])).toBeNull();
    }
    expect(store.getJob('job-05')).not.toBeNull();
    expect(store.getArtifact(artifacts[5])).not.toBeNull();
    expect(store.getArtifact(shared)).not.toBeNull();
    expect(store.getArtifact(orphan)).toBeNull();
    const db = new DatabaseSync(dbFile());
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM job_courses').get()).toEqual({ n: 50 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { db.close(); }
  });

  it('counts a lineage once by its newest job and never deletes a parent whose child is kept', async () => {
    const clock = manualClock();
    const store = await open({ clock });
    const add = seed(store, clock);
    add('root-old');
    for (let index = 0; index < 50; index++) add(`job-${String(index).padStart(2, '0')}`);
    add('child-new', { resumedFrom: 'root-old' });
    // 51 lineages: root-old → child-new is the newest; job-00 is the oldest lineage and goes.
    expect(store.prune()).toEqual({ jobs: 1, artifacts: 1 });
    expect(store.getJob('root-old')).not.toBeNull();
    expect(store.getJob('child-new')).not.toBeNull();
    expect(store.getJob('job-00')).toBeNull();
  });

  it('deletes a whole old lineage in one go and keeps lineages with a running job', async () => {
    const clock = manualClock();
    const store = await open({ clock });
    const add = seed(store, clock);
    add('running-root', { status: 'running' });
    add('old-root');
    add('old-child', { resumedFrom: 'old-root' });
    add('old-grandchild', { resumedFrom: 'old-child' });
    for (let index = 0; index < 50; index++) add(`job-${String(index).padStart(2, '0')}`);
    expect(store.prune()).toEqual({ jobs: 3, artifacts: 3 });
    expect(store.getJob('running-root')).not.toBeNull();
    for (const id of ['old-root', 'old-child', 'old-grandchild']) expect(store.getJob(id)).toBeNull();
    expect(store.prune({ keep: 50 })).toEqual({ jobs: 0, artifacts: 0 });
  });

  it('runs maintenance on open: interrupts running jobs, then prunes, without touching run directories', async () => {
    const clock = manualClock();
    const first = await open({ clock });
    const add = seed(first, clock);
    for (let index = 0; index < 51; index++) add(`job-${String(index).padStart(2, '0')}`, { status: index === 0 ? 'running' : 'finished' });
    const runDir = join(dir, '.local', 'lms', 'runs', 'job-00', 'SYN-1');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'canvas.json'), '{}');
    first.close();
    opened.length = 0;
    const second = await open({ clock });
    // The running job became interrupted first, so its lineage is no longer protected and is the oldest.
    expect(second.getJob('job-00')).toBeNull();
    expect(second.listJobs(100)).toHaveLength(50);
    expect(existsSync(join(runDir, 'canvas.json'))).toBe(true);
  });
});
