## MODIFIED Requirements

### Requirement: Data lives in .local only
The data directory SHALL be the `COURSEWORK_HOME` environment variable when set, otherwise `.local/` inside the package root (the nearest ancestor of the running module that contains this package's `package.json`). The data directory holds `coursework.db`, `snapshots/`, `profiles/` and `browser.json` (the resident browser endpoint); each is created when first needed. A `crawls/` directory left by the removed Canvas crawl SHALL be left in place, not deleted. The `.local/` directory MUST be ignored by git.

#### Scenario: Default location
- **WHEN** no override is set
- **THEN** the store resolves to `<package root>/.local/coursework.db` and creates the directory if missing

#### Scenario: Override
- **WHEN** `COURSEWORK_HOME` is set to a directory
- **THEN** the database, snapshots, profiles and `browser.json` all resolve inside that directory

#### Scenario: Git ignores local data
- **WHEN** the check command runs
- **THEN** a test confirms `git check-ignore` succeeds for `.local/coursework.db` and `.local/browser.json`

## REMOVED Requirements

### Requirement: The store assigns change sequence numbers
**Reason**: Decision #101 removes change detection; sync writes only the latest state.
**Migration**: Existing rows stay in the database unread; the change-event table is kept and receives no writes.
