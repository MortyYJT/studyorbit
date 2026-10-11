## ADDED Requirements

### Requirement: User-driven capture in a headed browser
`coursework capture` SHALL open a visible Playwright browser on the persistent profile at `<data dir>/profiles/<browser>` (data directory as defined in `local-store`; `<browser>` is `chrome`, `msedge`, or `chromium` for the bundled fallback, see "Choose the browser"). The user SHALL sign in and navigate by hand, except during a crawl started with `c` (see "Crawl Canvas after sign-in"). The tool MUST NOT read, type, store, or log passwords or one-time codes.

#### Scenario: Start capture
- **WHEN** the user runs `coursework capture`
- **THEN** a visible browser opens on the persistent profile and the terminal lists the commands `s` (save the active tab), `c` (crawl Canvas), and `q` (quit)

### Requirement: Save the current page as a snapshot
While capture runs, the user SHALL be able to save the current page with a terminal command. Each snapshot SHALL be written under `<data dir>/snapshots/<host>/<timestamp>-<slug>/` with the rendered HTML, a full-page screenshot, and a `meta.json` holding the URL, title, capture time, and viewport. The URL in `meta.json` MUST have query strings and fragments removed.

#### Scenario: Save a page
- **WHEN** the user saves a Canvas assignment page
- **THEN** a snapshot folder appears with `page.html`, `page.png`, and `meta.json`, and the URL has no query string

#### Scenario: Snapshots stay local
- **WHEN** the check command runs
- **THEN** a test confirms git ignores `.local/snapshots/`

### Requirement: One process per browser profile
Capture SHALL hold an exclusive lock file at `<data dir>/profiles/<browser>.lock` containing its process id while running, and remove it on exit. `capture` is a human-facing command, not an agent command: a second process using the same profile MUST exit with status 3 and print that the profile is locked by the named process id. The lock module SHALL throw `CourseworkError` with code `LOCKED`, so agent-facing commands that need the profile later get a `LOCKED` envelope. A lock left by a dead process SHALL be cleared automatically.

#### Scenario: Second capture
- **WHEN** a capture is running and the user starts another
- **THEN** the second exits with status 3 naming the holder's process id, and the first keeps running

#### Scenario: Stale lock
- **WHEN** the lock file names a process id that no longer exists
- **THEN** a new capture removes the lock and starts

### Requirement: Choose the browser
`coursework capture` SHALL accept `--browser chrome|msedge` (default `chrome`) and launch that installed browser channel. Each browser SHALL use its own profile directory `<data dir>/profiles/<browser>` and lock `<data dir>/profiles/<browser>.lock`; Chrome and Edge never share a profile, so switching browsers means signing in again. An unknown value MUST exit with status 2 and list the allowed values. The bundled-Chromium fallback still applies only after asking (also when the chosen browser is not installed) and uses its own `chromium` profile and lock.

#### Scenario: Edge
- **WHEN** the user runs `coursework capture --browser msedge`
- **THEN** the installed Microsoft Edge opens on `<data dir>/profiles/msedge`

#### Scenario: Unknown browser
- **WHEN** the user runs `coursework capture --browser firefox`
- **THEN** the command exits with status 2 and lists `chrome` and `msedge`

### Requirement: Crawl Canvas after sign-in
While capture runs, the terminal command `c` SHALL crawl the Canvas site of the active tab (the most recently focused tab, as for `s`) and save each loaded page as a snapshot in the same format as a manual save.

- **Start condition.** The active tab's host is `canvas.lms.unimelb.edu.au` and its URL path is `/courses` or starts with `/courses/`. The crawl origin (scheme, host, and port) is that tab's origin, fixed when the crawl starts. Otherwise nothing is crawled and the terminal says to open a Canvas course page first. If `/courses` fails or lists no course, the crawl ends with `status: "completed"` and the counts show it.
- **Tab.** The crawl opens one new tab in the same browser context, never brings it to the front, and closes it when the crawl ends.
- **Ready page.** A page counts as loaded after the `load` event plus `networkidle` (Playwright), with a 30-second timeout; links are read from the rendered DOM.
- **Link rules.** Every `href` is resolved against the page URL, and its query and fragment are dropped. Course links are paths matching `^/courses/\d+/?$` on the `/courses` page, deduplicated by course id, with no filtering by term. Assignment links match `^/courses/<course id>/assignments/\d+/?$` on that course's assignments page; announcement links match `^/courses/<course id>/discussion_topics/\d+/?$` on its announcements page. Only same-origin links are followed.
- **Order.** `/courses`; then, for each course in page order, `assignments`, `announcements`, `grades`, and `assignments/syllabus`; then the linked assignment and announcement pages, course by course.
- **Limits.** Navigation is GET page loads only: the crawl MUST NOT click, type, or submit anything. At least one second passes between the end of one page load (including writing its snapshot) and the start of the next. The crawl stops after 300 page loads attempted, failures included.
- **Read state.** Opening an announcement page may mark it read in Canvas. The user accepted this (decision #44); it is the only account-state change the crawl may cause.
- **Failures.** A navigation error, a timeout before `load`, or HTTP status 400 or above counts as failed; if `load` fired but `networkidle` timed out, the page is still saved; no snapshot is written and there is no retry.
- **Signed out.** If a page load's final URL is on another origin, or on the crawl origin with a path starting with `/login`, the crawl stops and tells the user to sign in again; snapshots already saved remain.
- **Commands during a crawl.** `c` is refused with "a crawl is already running"; `s` still saves the active tab; `q`, closing the browser, SIGINT, or SIGTERM stop the crawl after the current page load.
- **Summary.** When the crawl ends for any reason, it prints and writes `<data dir>/crawls/<timestamp>.json` (UTC ISO 8601 with `:` replaced by `-`, e.g. `2026-10-11T10-08-17Z`) with `startedAt`, `durationMs`, `saved`, `failed`, `status` (`completed`, `capReached`, `signedOut`, or `aborted`), and the list of failed URLs with query and fragment removed. It holds no page content. Ed is not crawled; Ed pages are still saved by hand with `s`.

#### Scenario: Crawl a signed-in Canvas
- **WHEN** the active tab is on a signed-in Canvas course page and the user enters `c`
- **THEN** snapshots appear for `/courses`, each course's four fixed pages, and each linked assignment and announcement page, and a summary with `status: "completed"` records the counts and duration

#### Scenario: Session expired mid-crawl
- **WHEN** a page load ends on another origin or on a `/login` path
- **THEN** the crawl stops, earlier snapshots remain, the summary has `status: "signedOut"`, and the terminal tells the user to sign in again

#### Scenario: Not on Canvas
- **WHEN** the active tab is not on `canvas.lms.unimelb.edu.au`, or its path is neither `/courses` nor under `/courses/`, and the user enters `c`
- **THEN** nothing is crawled and the terminal says to open a Canvas course page first

#### Scenario: Page cap
- **WHEN** 300 page loads have been attempted
- **THEN** the crawl stops and the summary has `status: "capReached"`

#### Scenario: Quit during a crawl
- **WHEN** the user enters `q` while a crawl is running
- **THEN** the crawl stops after the current page load, the summary has `status: "aborted"`, the crawl tab closes, and the lock is released

#### Scenario: Second crawl
- **WHEN** a crawl is running and the user enters `c`
- **THEN** the terminal says a crawl is already running and the first crawl continues
