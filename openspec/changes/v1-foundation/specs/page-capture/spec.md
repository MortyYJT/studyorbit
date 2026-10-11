## ADDED Requirements

### Requirement: User-driven capture in a headed browser
`coursework capture` SHALL open a visible Playwright browser on the persistent profile at `<data dir>/profiles/default` (data directory as defined in `local-store`). The user SHALL sign in and navigate by hand. The tool MUST NOT read, type, store, or log passwords or one-time codes.

#### Scenario: Start capture
- **WHEN** the user runs `coursework capture`
- **THEN** a visible browser opens on the persistent profile and the terminal explains how to save a page

### Requirement: Save the current page as a snapshot
While capture runs, the user SHALL be able to save the current page with a terminal command. Each snapshot SHALL be written under `<data dir>/snapshots/<host>/<timestamp>-<slug>/` with the rendered HTML, a full-page screenshot, and a `meta.json` holding the URL, title, capture time, and viewport. The URL in `meta.json` MUST have query strings and fragments removed.

#### Scenario: Save a page
- **WHEN** the user saves a Canvas assignment page
- **THEN** a snapshot folder appears with `page.html`, `page.png`, and `meta.json`, and the URL has no query string

#### Scenario: Snapshots stay local
- **WHEN** the check command runs
- **THEN** a test confirms git ignores `.local/snapshots/`

### Requirement: One process per browser profile
Capture SHALL hold an exclusive lock file at `<data dir>/profiles/default.lock` containing its process id while running, and remove it on exit. `capture` is a human-facing command, not an agent command: a second process using the same profile MUST exit with status 3 and print that the profile is locked by the named process id. The lock module SHALL throw `CourseworkError` with code `LOCKED`, so agent-facing commands that need the profile later get a `LOCKED` envelope. A lock left by a dead process SHALL be cleared automatically.

#### Scenario: Second capture
- **WHEN** a capture is running and the user starts another
- **THEN** the second exits with status 3 naming the holder's process id, and the first keeps running

#### Scenario: Stale lock
- **WHEN** the lock file names a process id that no longer exists
- **THEN** a new capture removes the lock and starts

### Requirement: Choose the browser
`coursework capture` SHALL accept `--browser chrome|msedge` (default `chrome`) and launch that installed browser channel on the same persistent profile. An unknown value MUST exit with status 2 and list the allowed values. The bundled-Chromium fallback still applies only after asking.

#### Scenario: Edge
- **WHEN** the user runs `coursework capture --browser msedge`
- **THEN** the persistent profile opens in the installed Microsoft Edge

### Requirement: Crawl Canvas after sign-in
While capture runs, the terminal command `c` SHALL crawl the Canvas site of the active tab and save each visited page as a snapshot (same format as a manual save). The crawl SHALL open its own tab, visit `/courses`, take every course link of the form `/courses/<id>` on that page, and for each course visit `assignments`, `announcements`, `grades`, and `assignments/syllabus`, plus every assignment page (`/courses/<id>/assignments/<id>`) and announcement page (`/courses/<id>/discussion_topics/<id>`) linked from them. It MUST only navigate with GET page loads on the same origin, MUST NOT click, type, or submit anything, MUST wait at least one second between page loads, and MUST stop after 300 pages. If a page load ends on another origin (for example a sign-in page), the crawl SHALL stop, keep what it saved, and tell the user to sign in again. At the end it SHALL print and write a summary (`crawl-<timestamp>.json` under `<data dir>/snapshots/<host>/`) with pages saved, pages failed, and duration. Ed is not crawled; it stays manual.

#### Scenario: Crawl a signed-in Canvas
- **WHEN** the active tab is on a signed-in Canvas site and the user enters `c`
- **THEN** snapshots appear for the course list, each course's assignments, announcements, grades, and syllabus pages, and each linked assignment and announcement, and a summary file records the counts and duration

#### Scenario: Session expired mid-crawl
- **WHEN** a page load is redirected to another origin
- **THEN** the crawl stops, earlier snapshots remain, and the terminal tells the user to sign in again

#### Scenario: Not on Canvas
- **WHEN** the active tab is not on a Canvas course site and the user enters `c`
- **THEN** nothing is crawled and the terminal says to open Canvas first

#### Scenario: Page cap
- **WHEN** the crawl plan reaches 300 pages
- **THEN** the crawl stops and the summary says the cap was reached
