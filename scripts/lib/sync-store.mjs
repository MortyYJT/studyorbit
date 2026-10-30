// SQLite store for sync jobs, per-course job state, stage checkpoints, content-addressed stage outputs and course
// snapshots (design §5, decisions #340, #344, #356). Every SQL statement and every `node:sqlite` call lives in this
// file, so an API change before the module reaches Stable is a one-file fix. The Desktop course files stay the
// user-facing output; this database is an audit copy and the pipeline's checkpoint record.
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

export const STORE_FILE = 'studyorbit.db';
export const RETENTION_LINEAGES = 50;
export const LINEAGE_ANCESTORS = 20;
const BUSY_TIMEOUT_MS = 5000;
const JOB_LIST_LIMIT = 20;
const SQLITE_NOTADB = 26;

/** Ordered schema steps; `PRAGMA user_version` is the number applied. Never edit a released step: append a new one. */
export const MIGRATIONS = Object.freeze([
  `CREATE TABLE jobs (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL CHECK (kind IN ('course-sync')),
     status TEXT NOT NULL CHECK (status IN ('running', 'finished', 'failed', 'cancelled', 'interrupted')),
     provider TEXT,
     model TEXT,
     resumed_from TEXT UNIQUE REFERENCES jobs (id),
     created_at TEXT NOT NULL,
     started_at TEXT,
     finished_at TEXT,
     error TEXT
   );
   CREATE INDEX jobs_created ON jobs (created_at);
   CREATE TABLE artifacts (
     hash TEXT PRIMARY KEY,
     content TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE TABLE job_courses (
     job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
     course_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     previous TEXT REFERENCES artifacts (hash),
     code TEXT,
     term TEXT,
     status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted')),
     phase TEXT,
     reason TEXT,
     file TEXT,
     stopped_stage TEXT CHECK (stopped_stage IN ('collect', 'analyse', 'validate', 'merge')),
     reused INTEGER NOT NULL DEFAULT 0 CHECK (reused IN (0, 1)),
     PRIMARY KEY (job_id, course_id)
   );
   CREATE TABLE stages (
     job_id TEXT NOT NULL,
     course_id TEXT NOT NULL,
     stage TEXT NOT NULL CHECK (stage IN ('collect', 'analyse', 'validate', 'merge')),
     input_hash TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
     checkpoint TEXT,
     output_hash TEXT REFERENCES artifacts (hash),
     reused_from TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     usage TEXT,
     started_at TEXT,
     finished_at TEXT,
     duration_ms INTEGER,
     error_code TEXT,
     error TEXT,
     PRIMARY KEY (job_id, course_id, stage),
     FOREIGN KEY (job_id, course_id) REFERENCES job_courses (job_id, course_id) ON DELETE CASCADE
   );
   CREATE INDEX stages_checkpoint ON stages (course_id, stage, input_hash) WHERE status = 'succeeded';
   CREATE INDEX stages_output ON stages (output_hash);
   CREATE INDEX job_courses_previous ON job_courses (previous);
   CREATE TABLE course_snapshots (
     id INTEGER PRIMARY KEY,
     job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
     course_id TEXT NOT NULL,
     content_hash TEXT NOT NULL,
     version INTEGER,
     document TEXT NOT NULL,
     status TEXT,
     reason TEXT,
     file TEXT,
     created_at TEXT NOT NULL,
     UNIQUE (job_id, course_id)
   );`,
  // The job's resolved course source ids as a JSON array (openspec change generic-adapters, design §1), so a resume
  // runs the same sources. NULL for jobs created before: they ran the default institution's three sources.
  'ALTER TABLE jobs ADD COLUMN sources TEXT;',
  // Course status `incomplete` (decision #480) and job warnings (a JSON array of reasons, decision #485). SQLite cannot
  // change a CHECK constraint, so `job_courses` is rebuilt; `stages` references it and is rebuilt too, first pointing
  // at the new table, so dropping the old ones cascades nothing. Renaming the new table rewrites that reference.
  `CREATE TABLE job_courses_new (
     job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
     course_id TEXT NOT NULL,
     position INTEGER NOT NULL,
     previous TEXT REFERENCES artifacts (hash),
     code TEXT,
     term TEXT,
     status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'partial', 'incomplete', 'failed', 'cancelled', 'interrupted')),
     phase TEXT,
     reason TEXT,
     file TEXT,
     stopped_stage TEXT CHECK (stopped_stage IN ('collect', 'analyse', 'validate', 'merge')),
     reused INTEGER NOT NULL DEFAULT 0 CHECK (reused IN (0, 1)),
     PRIMARY KEY (job_id, course_id)
   );
   INSERT INTO job_courses_new (job_id, course_id, position, previous, code, term, status, phase, reason, file, stopped_stage, reused)
     SELECT job_id, course_id, position, previous, code, term, status, phase, reason, file, stopped_stage, reused FROM job_courses;
   CREATE TABLE stages_new (
     job_id TEXT NOT NULL,
     course_id TEXT NOT NULL,
     stage TEXT NOT NULL CHECK (stage IN ('collect', 'analyse', 'validate', 'merge')),
     input_hash TEXT NOT NULL,
     status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled', 'interrupted')),
     checkpoint TEXT,
     output_hash TEXT REFERENCES artifacts (hash),
     reused_from TEXT,
     attempts INTEGER NOT NULL DEFAULT 0,
     usage TEXT,
     started_at TEXT,
     finished_at TEXT,
     duration_ms INTEGER,
     error_code TEXT,
     error TEXT,
     PRIMARY KEY (job_id, course_id, stage),
     FOREIGN KEY (job_id, course_id) REFERENCES job_courses_new (job_id, course_id) ON DELETE CASCADE
   );
   INSERT INTO stages_new (job_id, course_id, stage, input_hash, status, checkpoint, output_hash, reused_from, attempts, usage, started_at, finished_at, duration_ms, error_code, error)
     SELECT job_id, course_id, stage, input_hash, status, checkpoint, output_hash, reused_from, attempts, usage, started_at, finished_at, duration_ms, error_code, error FROM stages;
   DROP TABLE stages;
   DROP TABLE job_courses;
   ALTER TABLE job_courses_new RENAME TO job_courses;
   ALTER TABLE stages_new RENAME TO stages;
   CREATE INDEX stages_checkpoint ON stages (course_id, stage, input_hash) WHERE status = 'succeeded';
   CREATE INDEX stages_output ON stages (output_hash);
   CREATE INDEX job_courses_previous ON job_courses (previous);
   ALTER TABLE jobs ADD COLUMN warnings TEXT;`,
]);

export const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
export const storePath = projectDir => join(projectDir, '.local', STORE_FILE);

// Patchable fields: API name → column. Anything else is refused, so a typo cannot silently drop an update.
const JOB_FIELDS = { status: 'status', provider: 'provider', model: 'model', startedAt: 'started_at', finishedAt: 'finished_at', error: 'error', warnings: 'warnings' };
const COURSE_FIELDS = {
  previous: 'previous', code: 'code', term: 'term', status: 'status', phase: 'phase', reason: 'reason', file: 'file',
  stoppedStage: 'stopped_stage', reused: 'reused',
};
const STAGE_FIELDS = {
  inputHash: 'input_hash', status: 'status', checkpoint: 'checkpoint', outputHash: 'output_hash', reusedFrom: 'reused_from',
  attempts: 'attempts', usage: 'usage', startedAt: 'started_at', finishedAt: 'finished_at', durationMs: 'duration_ms',
  errorCode: 'error_code', error: 'error',
};
const JSON_COLUMNS = new Set(['checkpoint', 'usage', 'warnings']);

function toColumnValue(column, value) {
  if (value === undefined || value === null) return null;
  if (JSON_COLUMNS.has(column)) return JSON.stringify(value);
  if (column === 'reused') return value ? 1 : 0;
  return value;
}

function assignments(fields, patch) {
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  for (const [key] of entries) if (!Object.hasOwn(fields, key)) throw new Error(`INVALID_FIELD: ${key}`);
  return {
    sql: entries.map(([key]) => `${fields[key]} = $${key}`).join(', '),
    params: Object.fromEntries(entries.map(([key, value]) => [key, toColumnValue(fields[key], value)])),
    empty: entries.length === 0,
  };
}

const parseJson = text => (text === null ? null : JSON.parse(text));
const jobFrom = (row, courses) => ({
  id: row.id, kind: row.kind, status: row.status, provider: row.provider, model: row.model, resumedFrom: row.resumed_from,
  sources: parseJson(row.sources ?? null), createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at, error: row.error,
  warnings: parseJson(row.warnings ?? null) ?? [], courses,
});
const courseFrom = row => ({
  courseId: row.course_id, position: row.position, previous: row.previous, code: row.code, term: row.term, status: row.status,
  phase: row.phase, reason: row.reason, file: row.file, stoppedStage: row.stopped_stage, reused: row.reused === 1,
});
const stageFrom = row => (row ? {
  jobId: row.job_id, courseId: row.course_id, stage: row.stage, inputHash: row.input_hash, status: row.status,
  checkpoint: parseJson(row.checkpoint), outputHash: row.output_hash, reusedFrom: row.reused_from, attempts: row.attempts,
  usage: parseJson(row.usage), startedAt: row.started_at, finishedAt: row.finished_at, durationMs: row.duration_ms,
  errorCode: row.error_code, error: row.error,
} : null);
const snapshotFrom = row => (row ? {
  id: row.id, jobId: row.job_id, courseId: row.course_id, contentHash: row.content_hash, version: row.version, document: row.document,
  status: row.status, reason: row.reason, file: row.file, createdAt: row.created_at,
} : null);

// Lineage = the job plus its chain of `resumed_from` ancestors, at most LINEAGE_ANCESTORS of them, nearest first.
const LINEAGE_CTE = `WITH RECURSIVE lineage (id, parent, depth) AS (
    SELECT id, resumed_from, 0 FROM jobs WHERE id = $jobId
    UNION ALL
    SELECT jobs.id, jobs.resumed_from, lineage.depth + 1 FROM jobs JOIN lineage ON jobs.id = lineage.parent
    WHERE lineage.depth < ${LINEAGE_ANCESTORS}
  )`;

function createStore(db, path, clock, version) {
  const now = () => new Date(clock()).toISOString();
  const statements = new Map();
  const prepare = sql => {
    let statement = statements.get(sql);
    if (!statement) { statement = db.prepare(sql); statements.set(sql, statement); }
    return statement;
  };
  let closed = false;

  function transaction(fn) {
    if (db.isTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }

  function coursesOf(jobId) {
    return prepare('SELECT * FROM job_courses WHERE job_id = $jobId ORDER BY position').all({ jobId }).map(courseFrom);
  }
  function getJob(id) {
    const row = prepare('SELECT * FROM jobs WHERE id = $id').get({ id });
    return row ? jobFrom(row, coursesOf(id)) : null;
  }
  function listJobs(limit = JOB_LIST_LIMIT) {
    return prepare('SELECT * FROM jobs ORDER BY created_at DESC, rowid DESC LIMIT $limit').all({ limit })
      .map(row => jobFrom(row, coursesOf(row.id)));
  }
  function getStage(jobId, courseId, stage) {
    return stageFrom(prepare('SELECT * FROM stages WHERE job_id = $jobId AND course_id = $courseId AND stage = $stage').get({ jobId, courseId, stage }));
  }
  function getSnapshot(jobId, courseId) {
    return snapshotFrom(prepare('SELECT * FROM course_snapshots WHERE job_id = $jobId AND course_id = $courseId').get({ jobId, courseId }));
  }

  return {
    path,
    version,
    transaction,

    createJob({ id, provider = null, model = null, resumedFrom = null, sources = null, courses }) {
      if (sources !== null && (!Array.isArray(sources) || sources.some(source => typeof source !== 'string'))) throw new Error('INVALID_FIELD: sources');
      return transaction(() => {
        const at = now();
        // The column is named only when a list is given, so the statement also works on a schema before migration 2.
        if (sources === null) {
          prepare(`INSERT INTO jobs (id, kind, status, provider, model, resumed_from, created_at, started_at)
            VALUES ($id, 'course-sync', 'running', $provider, $model, $resumedFrom, $at, $at)`).run({ id, provider, model, resumedFrom, at });
        } else {
          prepare(`INSERT INTO jobs (id, kind, status, provider, model, resumed_from, sources, created_at, started_at)
            VALUES ($id, 'course-sync', 'running', $provider, $model, $resumedFrom, $sources, $at, $at)`)
            .run({ id, provider, model, resumedFrom, sources: JSON.stringify(sources), at });
        }
        const insert = prepare(`INSERT INTO job_courses (job_id, course_id, position, previous, code, term, status)
          VALUES ($jobId, $courseId, $position, $previous, $code, $term, 'pending')`);
        courses.forEach((course, position) => insert.run({
          jobId: id, courseId: course.courseId, position, previous: course.previous ?? null, code: course.code ?? null, term: course.term ?? null,
        }));
        return getJob(id);
      });
    },

    updateJob(id, patch) {
      const set = assignments(JOB_FIELDS, patch);
      if (set.empty) return;
      if (prepare(`UPDATE jobs SET ${set.sql} WHERE id = $id`).run({ ...set.params, id }).changes === 0) throw new Error('JOB_NOT_FOUND');
    },

    updateCourse(jobId, courseId, patch) {
      const set = assignments(COURSE_FIELDS, patch);
      if (set.empty) return;
      const sql = `UPDATE job_courses SET ${set.sql} WHERE job_id = $jobId AND course_id = $courseId`;
      if (prepare(sql).run({ ...set.params, jobId, courseId }).changes === 0) throw new Error('COURSE_NOT_FOUND');
    },

    getJob,
    newestJob: () => listJobs(1)[0] ?? null,
    listJobs,

    /** The job that resumed `jobId` (at most one), or null. */
    childOf(jobId) {
      const row = prepare('SELECT id FROM jobs WHERE resumed_from = $jobId').get({ jobId });
      return row ? getJob(row.id) : null;
    },

    lineage(jobId) {
      return prepare(`${LINEAGE_CTE} SELECT id FROM lineage ORDER BY depth`).all({ jobId }).map(row => row.id);
    },

    putArtifact(content) {
      const hash = sha256(content);
      prepare('INSERT OR IGNORE INTO artifacts (hash, content, created_at) VALUES ($hash, $content, $at)').run({ hash, content, at: now() });
      return hash;
    },
    getArtifact(hash) {
      return prepare('SELECT content FROM artifacts WHERE hash = $hash').get({ hash })?.content ?? null;
    },

    /** Inserts or replaces the whole stage row; omitted fields become empty and `startedAt` defaults to now. */
    saveStage({ jobId, courseId, stage, ...fields }) {
      const values = { attempts: 0, startedAt: now(), ...fields };
      for (const key of Object.keys(values)) if (!Object.hasOwn(STAGE_FIELDS, key)) throw new Error(`INVALID_FIELD: ${key}`);
      const columns = Object.values(STAGE_FIELDS);
      const params = Object.fromEntries(Object.entries(STAGE_FIELDS).map(([key, column]) => [key, toColumnValue(column, values[key])]));
      params.attempts ??= 0;
      prepare(`INSERT INTO stages (job_id, course_id, stage, ${columns.join(', ')})
        VALUES ($jobId, $courseId, $stage, ${Object.keys(STAGE_FIELDS).map(key => `$${key}`).join(', ')})
        ON CONFLICT (job_id, course_id, stage) DO UPDATE SET ${columns.map(column => `${column} = excluded.${column}`).join(', ')}`)
        .run({ ...params, jobId, courseId, stage });
      return getStage(jobId, courseId, stage);
    },

    updateStage(jobId, courseId, stage, patch) {
      const set = assignments(STAGE_FIELDS, patch);
      if (set.empty) return;
      const sql = `UPDATE stages SET ${set.sql} WHERE job_id = $jobId AND course_id = $courseId AND stage = $stage`;
      if (prepare(sql).run({ ...set.params, jobId, courseId, stage }).changes === 0) throw new Error('STAGE_NOT_FOUND');
    },

    getStage,

    /** The newest succeeded checkpoint for (course, stage, input hash) within the job's lineage, or null. */
    findCheckpoint(jobId, courseId, stage, inputHash) {
      return stageFrom(prepare(`${LINEAGE_CTE}
        SELECT stages.* FROM stages JOIN lineage ON stages.job_id = lineage.id
        WHERE stages.course_id = $courseId AND stages.stage = $stage AND stages.input_hash = $inputHash AND stages.status = 'succeeded'
        ORDER BY lineage.depth LIMIT 1`).get({ jobId, courseId, stage, inputHash }));
    },

    /** Every row of one stage for a course in the job's lineage, whatever its status, newest job first. */
    lineageStages(jobId, courseId, stage) {
      return prepare(`${LINEAGE_CTE}
        SELECT stages.* FROM stages JOIN lineage ON stages.job_id = lineage.id
        WHERE stages.course_id = $courseId AND stages.stage = $stage ORDER BY lineage.depth`).all({ jobId, courseId, stage }).map(stageFrom);
    },

    /** Records the document saved for a course in a job. Recording the same content again is a no-op. */
    putSnapshot({ jobId, courseId, document, version = null, status = null, reason = null, file = null }) {
      const contentHash = sha256(document);
      return transaction(() => {
        prepare(`INSERT INTO course_snapshots (job_id, course_id, content_hash, version, document, status, reason, file, created_at)
          VALUES ($jobId, $courseId, $contentHash, $version, $document, $status, $reason, $file, $at)
          ON CONFLICT (job_id, course_id) DO NOTHING`).run({ jobId, courseId, contentHash, version, document, status, reason, file, at: now() });
        const stored = getSnapshot(jobId, courseId);
        if (stored.contentHash !== contentHash) throw new Error('SNAPSHOT_CONFLICT');
        return stored;
      });
    },
    getSnapshot,

    /** Startup: a job still `running` belongs to a server that died; mark it and its unfinished parts `interrupted`. */
    markInterrupted() {
      return transaction(() => {
        const running = "SELECT id FROM jobs WHERE status = 'running'";
        const stages = prepare(`UPDATE stages SET status = 'interrupted' WHERE status = 'running' AND job_id IN (${running})`).run().changes;
        const courses = prepare(`UPDATE job_courses SET status = 'interrupted'
          WHERE status IN ('pending', 'running') AND job_id IN (${running})`).run().changes;
        const jobs = prepare("UPDATE jobs SET status = 'interrupted' WHERE status = 'running'").run().changes;
        return { jobs: Number(jobs), courses: Number(courses), stages: Number(stages) };
      });
    },

    /**
     * Retention by whole lineages (decision #356): keep the `keep` lineages with the newest jobs and every lineage with
     * a running job; delete all jobs of every other lineage in one statement (foreign keys are checked at the end of the
     * statement, so a parent and its child go together; course, stage and snapshot rows cascade), then delete artifacts
     * no remaining row references. Run directories and Desktop files are never touched.
     */
    prune({ keep = RETENTION_LINEAGES } = {}) {
      return transaction(() => {
        const jobs = prepare(`WITH RECURSIVE members (id, root) AS (
            SELECT id, id FROM jobs WHERE resumed_from IS NULL
            UNION ALL
            SELECT jobs.id, members.root FROM jobs JOIN members ON jobs.resumed_from = members.id
          ),
          lineages AS (
            SELECT members.root AS root, MAX(jobs.created_at) AS newest, MAX(jobs.rowid) AS newest_row,
                   MAX(jobs.status = 'running') AS running
            FROM members JOIN jobs ON jobs.id = members.id GROUP BY members.root
          ),
          kept AS (
            SELECT root FROM (SELECT root FROM lineages ORDER BY newest DESC, newest_row DESC LIMIT $keep)
            UNION SELECT root FROM lineages WHERE running = 1
          )
          DELETE FROM jobs WHERE id IN (SELECT id FROM members WHERE root NOT IN (SELECT root FROM kept))`).run({ keep }).changes;
        const artifacts = prepare(`DELETE FROM artifacts WHERE
            NOT EXISTS (SELECT 1 FROM stages WHERE stages.output_hash = artifacts.hash)
            AND NOT EXISTS (SELECT 1 FROM job_courses WHERE job_courses.previous = artifacts.hash)`).run().changes;
        return { jobs: Number(jobs), artifacts: Number(artifacts) };
      });
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}

function unavailable(reason, error) {
  return { ok: false, error: 'SYNC_STORE_UNAVAILABLE', reason, message: error instanceof Error ? error.message : String(error) };
}

/** Creates (or keeps) a file with owner-only permissions before SQLite opens it; `a` never truncates. */
function ownerOnlyFile(path) {
  closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);
}

function runMigrations(db, migrations, from) {
  for (let index = from; index < migrations.length; index++) {
    const step = migrations[index];
    db.exec('BEGIN IMMEDIATE');
    try {
      if (typeof step === 'function') step(db); else db.exec(step);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  }
}

/**
 * Opens `.local/studyorbit.db`, migrates it and runs startup maintenance (interrupt running jobs, then retention).
 * A file that is not a database, a newer `user_version` or a failed migration leaves the store unavailable and the
 * file is never deleted, truncated or overwritten. Only the server process may call this (it holds `.local/server.lock`).
 * `migrations` is a test seam; production uses MIGRATIONS.
 */
export async function openSyncStore({ projectDir, clock = Date.now, migrations = MIGRATIONS }) {
  const path = storePath(projectDir);
  let db;
  try {
    mkdirSync(join(projectDir, '.local'), { recursive: true, mode: 0o700 });
    ownerOnlyFile(path);
    db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
  } catch (error) {
    db?.close();
    return unavailable('OPEN_FAILED', error);
  }
  const fail = (reason, error) => { try { db.close(); } catch { /* Already reporting a failure. */ } return unavailable(reason, error); };

  // Read the version before anything that writes (journal mode, migrations), so a refused file keeps its bytes.
  let version;
  try {
    version = db.prepare('PRAGMA user_version').get().user_version;
  } catch (error) {
    return fail(error?.errcode === SQLITE_NOTADB ? 'NOT_A_DATABASE' : 'OPEN_FAILED', error);
  }
  if (version > migrations.length) return fail('NEWER_VERSION', new Error(`database user_version ${version} is newer than ${migrations.length}`));

  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
  } catch (error) {
    return fail('OPEN_FAILED', error);
  }

  if (version >= 1 && version < migrations.length) {
    const copy = `${path}.v${version}.bak`;
    try {
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${copy}${suffix}`, { force: true });
      ownerOnlyFile(copy);
      await backup(db, copy);
      chmodSync(copy, 0o600);
    } catch (error) {
      return fail('BACKUP_FAILED', error);
    }
  }

  try {
    runMigrations(db, migrations, version);
  } catch (error) {
    return fail('MIGRATION_FAILED', error);
  }

  const store = createStore(db, path, clock, migrations.length);
  try {
    store.markInterrupted();
    store.prune();
  } catch (error) {
    return fail('OPEN_FAILED', error);
  }
  return { ok: true, store };
}
