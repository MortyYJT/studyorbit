## ADDED Requirements

### Requirement: Source settings file with safe defaults
The system SHALL store data-source settings in `.local/config/sources.json` (file 0600, directory 0700) as `{ version: 1, institution, canvasOrigin, browser, browserPath, edRegion, timeZone, codePattern }`. When the file is missing the effective settings SHALL be: institution `unimelb`, the UniMelb Canvas origin, browser `edge-applescript` on macOS and `cdp-chrome` elsewhere, Ed region `auto`, and the plugin's time zone. Settings SHALL be read once per sync and once per discovery and passed to the sources; collectors SHALL NOT read the file.

#### Scenario: No settings file
- **WHEN** `.local/config/sources.json` does not exist on macOS
- **THEN** discovery and sync use UniMelb Canvas through Edge, as before the change

### Requirement: Settings validation
Saving SHALL reject, with `400 INVALID_SOURCE_SETTINGS` and the field name: an unknown institution or browser; an AppleScript browser on a platform other than macOS; an invalid Canvas origin (§ course-source-adapters); a `generic` institution without a Canvas origin; a time zone not accepted by `Intl.DateTimeFormat`; a `codePattern` over 200 characters, that does not compile or that does not have exactly one capture group; `codePattern` or `timeZone` for `unimelb`; a `browserPath` that is not an absolute path to an existing file or is given for an AppleScript browser.

#### Scenario: Pattern without a group
- **WHEN** the owner saves `codePattern: "[A-Z]+\\d+"`
- **THEN** the route answers `400` naming `codePattern` and the file is unchanged

### Requirement: Settings route and page
`GET /api/local/source-settings` SHALL return the effective settings and `{ platform, available: { institutions, browsers } }`, where CDP browsers are marked experimental. `PUT` SHALL validate, write atomically and return the effective settings, SHALL use the same access checks as the other write routes, and SHALL answer `409 SYNC_RUNNING` while a sync or discovery runs. The settings page SHALL show a 「数据来源」 section with these fields, SHALL label CDP choices 「实验性，未在 Windows 上验证」, and SHALL tell the owner to fetch the course list again after the institution or Canvas address changes.

#### Scenario: Change during a sync
- **WHEN** the owner saves source settings while a sync runs
- **THEN** the route answers `409 SYNC_RUNNING` and the running sync keeps its settings
