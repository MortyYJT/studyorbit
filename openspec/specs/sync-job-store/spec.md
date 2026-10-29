# sync-job-store Specification

## Purpose
Sync jobs, stage checkpoints and course snapshots are stored in an owner-only `node:sqlite` database with versioned migrations, retention and a single server instance; an unusable database is never replaced.
## Requirements
### Requirement: Jobs and snapshots are stored with node:sqlite
The system SHALL store sync jobs, per-course job state, stage checkpoints, content-addressed stage outputs and course snapshots in `.local/studyorbit.db` using the built-in `node:sqlite` module and no other database library. All SQL and `node:sqlite` calls SHALL live in `scripts/lib/sync-store.mjs`. A course snapshot SHALL hold the stored document written for a course in a job together with its sha256 content hash. The Desktop course files SHALL remain the user-facing output, and course readers SHALL keep reading them. `package.json` SHALL require Node `>=24.15.0`.

#### Scenario: Snapshot after a saved course
- **WHEN** a job saves a course file
- **THEN** the store has one snapshot for that job and course whose `content_hash` is the sha256 of the saved document and whose `file` is the saved path

#### Scenario: Readers ignore the database
- **WHEN** the database is deleted after a sync
- **THEN** the course page still shows the synced course from its Desktop file

### Requirement: Owner-only database file
The store SHALL create `.local/` with mode `0700` and the database file with mode `0600` before SQLite opens it, and SHALL reset an existing database file to `0600`. It SHALL open the database in WAL mode with a busy timeout. Only the server process SHALL open it.

#### Scenario: New database
- **WHEN** the server starts and no database exists
- **THEN** `.local/studyorbit.db` is created with mode `0600`

#### Scenario: Loose permissions repaired
- **WHEN** the existing database file has mode `0644`
- **THEN** after startup it has mode `0600`

### Requirement: Single server instance
The server SHALL create `.local/server.lock` exclusively with its process ID before opening the store, SHALL refuse to start while the lock names a live process, SHALL replace a lock whose process is gone, and SHALL remove the lock on exit.

#### Scenario: Second server
- **WHEN** a second server starts for the same project while the first is running
- **THEN** the second exits with 「另一个 StudyOrbit 本地服务正在运行」 and the first server's running job is untouched

#### Scenario: Stale lock
- **WHEN** the lock names a process that no longer exists
- **THEN** the server replaces the lock and starts

### Requirement: Migrations by user_version
The store SHALL keep an ordered list of migrations and SHALL record the number applied in `PRAGMA user_version`. Each migration and its `user_version` update SHALL run in one transaction. Before migrating a database whose `user_version` is at least 1, the store SHALL copy it with `node:sqlite` `backup()` to `.local/studyorbit.db.v<old version>.bak` (mode `0600`).

#### Scenario: Fresh database
- **WHEN** the store opens an empty database
- **THEN** all migrations run and `user_version` equals their count

#### Scenario: Crash during a migration
- **WHEN** a migration fails partway
- **THEN** the transaction is rolled back and `user_version` keeps its previous value

#### Scenario: Backup before upgrade
- **WHEN** a version 1 database is opened by code with two migrations
- **THEN** `.local/studyorbit.db.v1.bak` exists before migration 2 runs

### Requirement: Unusable database is never replaced
When the database file is not a SQLite database, has a `user_version` higher than the code knows, or a migration fails, the store SHALL be unavailable: the sync routes SHALL answer `503` with `{ "error": "SYNC_STORE_UNAVAILABLE" }`, all other routes SHALL keep working, and the file MUST NOT be deleted, truncated or overwritten.

#### Scenario: Newer database
- **WHEN** the database has `user_version` 9 and the code knows 1
- **THEN** `POST /api/local/course-sync` answers `503 SYNC_STORE_UNAVAILABLE`, `GET /api/local/course-reports` still works, and the file is unchanged

#### Scenario: Corrupt file
- **WHEN** `.local/studyorbit.db` contains bytes that are not a SQLite database
- **THEN** the sync routes answer `503 SYNC_STORE_UNAVAILABLE` and the file's bytes are unchanged

### Requirement: Retention
On startup the store SHALL prune whole lineages only (a root job and its chain of resumed jobs): it SHALL keep the 50 lineages with the newest jobs and every lineage containing a running job, delete each other lineage's jobs together in one statement with their course, stage and snapshot rows, and then delete artifacts no remaining row references. It SHALL never delete a job whose resumed child is kept. It SHALL NOT delete run directories or Desktop files.

#### Scenario: Old jobs pruned
- **WHEN** the store holds 55 single-job lineages at startup
- **THEN** the oldest 5 jobs and their rows are deleted, and artifacts referenced only by them are deleted

#### Scenario: Parent with a kept child
- **WHEN** the 51st-newest lineage is a job whose resumed child is among the newest jobs
- **THEN** the lineage counts once by its newest job, neither job is deleted on its own, and no foreign key error occurs

