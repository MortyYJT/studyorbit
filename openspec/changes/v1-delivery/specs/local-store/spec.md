## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Additive migrations keep local data
Migrations for this change SHALL only add tables and columns. The existing change-event table and the old L0–L4 grant records SHALL stay in the database unchanged; neither SHALL receive new writes or be read for decisions. No existing row SHALL be deleted or rewritten, so the owner's local database loses nothing. Dropping old tables later needs a separate owner decision.

#### Scenario: Upgrade a database with old rows
- **WHEN** a synthetic database with change-event rows and an old L4 grant is migrated
- **THEN** the new tables exist, the old rows are still present and unchanged, and `autonomy.check` ignores the old grant
