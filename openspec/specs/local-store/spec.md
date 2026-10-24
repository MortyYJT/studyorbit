# local-store Specification

## Purpose
TBD - created by archiving change v1-foundation. Update Purpose after archive.
## Requirements
### Requirement: Storage sits behind a repository interface
All reads and writes SHALL go through a repository interface. Only one implementation, backed by `node:sqlite`, SHALL know about SQL. Code outside the storage module MUST NOT import `node:sqlite`.

#### Scenario: In-memory store for tests
- **WHEN** a test opens the store with the in-memory option
- **THEN** it gets a working repository with the full schema and no file on disk

#### Scenario: SQL stays inside storage
- **WHEN** the check command runs
- **THEN** a test fails if any file outside `src/store/` imports `node:sqlite`

### Requirement: Versioned migrations
The store SHALL apply numbered migrations in order on open and record the applied version. Opening an up-to-date database SHALL apply nothing. Opening a database with a newer version than the code knows MUST fail without modifying it.

#### Scenario: Fresh database
- **WHEN** the store opens a path with no database
- **THEN** it creates the file, applies every migration, and records the latest version

#### Scenario: Database from newer code
- **WHEN** the recorded version is higher than the latest migration
- **THEN** opening fails with an error naming both versions and the file is unchanged

### Requirement: Data lives in .local only
The data directory SHALL be the `COURSEWORK_HOME` environment variable when set, otherwise `.local/` inside the package root (the nearest ancestor of the running module that contains this package's `package.json`). The data directory holds `coursework.db`, `snapshots/`, `profiles/`, `browser.json` (the resident browser endpoint), `materials/` (private raw files from `source.fetch`), `screenshots/` (private screenshots of agent browser steps) and `agent-workspace/` (the chat agent's working directory); each is created when first needed, and `materials/` and `screenshots/` are owner-only. A `crawls/` directory left by the removed Canvas crawl SHALL be left in place, not deleted. The `.local/` directory MUST be ignored by git.

#### Scenario: Default location
- **WHEN** no override is set
- **THEN** the store resolves to `<package root>/.local/coursework.db` and creates the directory if missing

#### Scenario: Override
- **WHEN** `COURSEWORK_HOME` is set to a directory
- **THEN** the database, snapshots, profiles, `browser.json`, materials, screenshots and the agent workspace all resolve inside that directory

#### Scenario: Git ignores local data
- **WHEN** the check command runs
- **THEN** a test confirms `git check-ignore` succeeds for `.local/coursework.db`, `.local/browser.json`, `.local/materials/`, `.local/screenshots/` and `.local/agent-workspace/`

### Requirement: Writes validate before storing
The repository SHALL parse every entity with its domain schema before writing and MUST reject invalid entities without a partial write.

#### Scenario: Rejected write leaves no trace
- **WHEN** a batch of three tasks where the third is invalid is saved
- **THEN** the save fails and none of the three tasks is stored

### Requirement: Additive migrations keep local data
Migrations for this change SHALL only add tables and columns. The existing change-event table and the old L0–L4 grant records SHALL stay in the database unchanged; neither SHALL receive new writes or be read for decisions. No existing row SHALL be deleted or rewritten, so the owner's local database loses nothing. Dropping old tables later needs a separate owner decision.

#### Scenario: Upgrade a database with old rows
- **WHEN** a synthetic database with change-event rows and an old L4 grant is migrated
- **THEN** the new tables exist, the old rows are still present and unchanged, and `autonomy.check` ignores the old grant

