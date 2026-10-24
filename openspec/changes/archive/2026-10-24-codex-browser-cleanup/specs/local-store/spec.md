## MODIFIED Requirements

### Requirement: Data lives in .local only
The data directory SHALL be the `COURSEWORK_HOME` environment variable when set, otherwise `.local/` inside the package root (the nearest ancestor of the running module that contains this package's `package.json`). The data directory holds `coursework.db` and `agent-workspace/` (the Claude adapter's working directory; Codex uses a workspace outside the repository, see `agent-chat`); each is created when first needed. Directories left by removed features (`crawls/`, `snapshots/`, `profiles/`, `browser.json`, `materials/`, `screenshots/`) SHALL be left in place, not deleted, and are no longer written. The `.local/` directory MUST be ignored by git.

#### Scenario: Default location
- **WHEN** no override is set
- **THEN** the store resolves to `<package root>/.local/coursework.db` and creates the directory if missing

#### Scenario: Override
- **WHEN** `COURSEWORK_HOME` is set to a directory
- **THEN** the database and the agent workspace resolve inside that directory

#### Scenario: Git ignores local data
- **WHEN** the check command runs
- **THEN** a test confirms `git check-ignore` succeeds for `.local/coursework.db`, `.local/browser.json`, `.local/materials/`, `.local/screenshots/` and `.local/agent-workspace/`
