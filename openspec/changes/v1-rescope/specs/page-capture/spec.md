## MODIFIED Requirements

### Requirement: One process per browser profile
The resident browser (see `resident-browser`) SHALL hold an exclusive lock file at `<data dir>/profiles/default.lock` containing its process id while it runs, and remove it on exit. Any other attempt to launch a browser on the same profile SHALL fail with `CourseworkError` code `LOCKED` (one `LOCKED` envelope for agent-facing commands; exit status 3 with the holder's process id for interactive commands) and SHALL NOT launch a second browser. Commands that only need the profile's session SHALL attach to the resident browser instead of taking the lock. A lock left by a dead process SHALL be cleared automatically.

#### Scenario: Second launch
- **WHEN** a resident browser is running and another command tries to launch a browser on the same profile
- **THEN** the second attempt fails with `LOCKED` naming the holder, and the resident browser keeps running

#### Scenario: Stale lock
- **WHEN** the lock file names a process id that no longer exists
- **THEN** the next `coursework browser start` removes the lock and starts

### Requirement: Detect the browser
`coursework browser start` SHALL pick the browser itself, with no command-line option: Microsoft Edge if installed, otherwise Google Chrome; if neither is installed it SHALL ask on the terminal before using Playwright's bundled Chromium (no TTY: exit with an error, never download). A browser counts as installed when its channel's standard executable exists for the platform. The environment variable `COURSEWORK_BROWSER=msedge|chrome|chromium` overrides detection; any other value MUST exit with status 2 and list the allowed values. If the overriding browser is not installed (`chromium` counts as installed when Playwright's bundled build is present), start exits with an error and does not fall back. If the user declines bundled Chromium, start exits with status 1 without launching or recording anything. On first launch with a new profile the tool SHALL record the browser (`msedge`, `chrome`, or `chromium`) in `<data dir>/profiles/default/coursework-browser.json`. If a later run picks a different browser than the recorded one, it MUST NOT launch and SHALL exit with an error naming both browsers and telling the user to set `COURSEWORK_BROWSER` to the recorded one, or to remove the profile and sign in again. A profile that exists without this file MUST NOT launch unless `COURSEWORK_BROWSER` names the browser, which is then recorded. The profile and lock paths do not change (decision #45).

#### Scenario: Edge preferred
- **WHEN** Edge and Chrome are both installed and no profile exists
- **THEN** the resident browser starts in Edge and records `msedge` in the profile

#### Scenario: Browser changed
- **WHEN** the profile records `chrome` and detection now picks `msedge`
- **THEN** start exits without launching, naming both browsers and how to recover

#### Scenario: Override
- **WHEN** `COURSEWORK_BROWSER=chrome` is set and the profile records `chrome`
- **THEN** start opens Chrome even if Edge is installed

#### Scenario: Profile without a record
- **WHEN** `profiles/default` exists without `coursework-browser.json` and `COURSEWORK_BROWSER` is not set
- **THEN** start exits without launching and tells the user to set `COURSEWORK_BROWSER` or remove the profile

#### Scenario: Neither installed
- **WHEN** neither Edge nor Chrome is installed
- **THEN** start asks before using bundled Chromium, records `chromium` if the user agrees, and exits with status 1 without launching if the user declines

## REMOVED Requirements

### Requirement: User-driven capture in a headed browser
**Reason**: Decision #100 replaces the `coursework capture` terminal REPL with the resident browser; the owner signs in by hand in that browser and the agent operates it directly.
**Migration**: Run `coursework browser start` and sign in there. Agents attach through `resident-browser`.

### Requirement: Save the current page as a snapshot
**Reason**: Manual page saving served the old whole-page pipeline. Sync now reads JSON and keeps raw responses as private snapshots; the agent reads pages directly when it needs them.
**Migration**: Existing snapshots under `.local/snapshots/` stay where they are and are not deleted.

### Requirement: Crawl Canvas after sign-in
**Reason**: Decision #100 cuts whole-page Canvas crawling; Canvas `/api/v1` student-session JSON reads were confirmed on 2026-10-14.
**Migration**: Use `coursework sync` (see `coursework-sync`). Existing crawl summaries under `.local/crawls/` are left in place.
