# page-capture Specification

## Purpose
TBD - created by archiving change v1-foundation. Update Purpose after archive.
## Requirements
### Requirement: One process per browser profile
The resident browser (see `resident-browser`) SHALL hold an exclusive lock file at `<data dir>/profiles/default.lock` containing its process id while it runs, and remove it on exit. Any other attempt to launch a browser on the same profile SHALL fail with `CourseworkError` code `LOCKED` (one `LOCKED` envelope for agent-facing commands; exit status 3 with the holder's process id for interactive commands) and SHALL NOT launch a second browser. Commands that only need the profile's session SHALL attach to the resident browser instead of taking the lock. A lock left by a dead process SHALL be cleared automatically.

#### Scenario: Second capture
- **GIVEN** an interactive terminal command is used
- **WHEN** a resident browser is running and that command tries to launch another browser on the same profile
- **THEN** it exits with status 3 naming the holder's process id, and the resident browser keeps running

#### Scenario: Non-interactive profile contention
- **WHEN** a resident browser is running and an agent-facing command tries to launch a browser on the same profile
- **THEN** it returns one `LOCKED` envelope without launching a browser or printing human status text on stdout

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

