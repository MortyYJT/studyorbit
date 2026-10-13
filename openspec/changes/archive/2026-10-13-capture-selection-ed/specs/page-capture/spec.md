## MODIFIED Requirements

### Requirement: User-driven capture in a headed browser
`coursework capture` SHALL, after required selection preflight succeeds, open a visible Playwright browser on the persistent profile at `<data dir>/profiles/default` (data directory as defined in `local-store`) in the browser chosen by "Detect the browser". The user SHALL sign in and navigate by hand, except during a selected-course crawl started with `c` or the one-shot capture entry point (see "Crawl Canvas after sign-in", `course-selection`, and `ed-capture`). A model never sees or types passwords. `capture` itself MUST NOT read, type, store, or log passwords or one-time codes; terminal sign-in (`coursework login`) is out of scope here and planned for M1 (decision #46).

#### Scenario: Start capture
- **GIVEN** a TTY is available
- **WHEN** the user runs `coursework capture`
- **THEN** a visible browser opens on the persistent profile and the terminal lists the commands `s` (save the active tab), `c` (select/reuse courses and crawl Canvas and Ed), and `q` (quit)

#### Scenario: Non-interactive entry
- **GIVEN** no TTY is available
- **WHEN** capture is invoked
- **THEN** the `course-selection` one-shot and envelope rules apply without terminal prompts or waiting for commands

### Requirement: One process per browser profile
Capture SHALL hold an exclusive lock file at `<data dir>/profiles/default.lock` containing its process id while running, and remove it on exit. Interactive `capture` remains human-facing: a second interactive process using the same profile MUST exit with status 3 and print that the profile is locked by the named process id. Non-interactive one-shot capture SHALL instead return one `coursework.agent/v1` failure envelope with code `LOCKED`, without human status text on stdout or launching another browser. The lock module SHALL throw `CourseworkError` with code `LOCKED`, so non-interactive capture and other agent-facing commands get a `LOCKED` envelope. A lock left by a dead process SHALL be cleared automatically.

#### Scenario: Second capture
- **GIVEN** interactive terminal capture is used
- **WHEN** a capture is running and the user starts another
- **THEN** the second exits with status 3 naming the holder's process id, and the first keeps running

#### Scenario: Stale lock
- **GIVEN** no live process holds the profile
- **WHEN** the lock file names a process id that no longer exists
- **THEN** a new capture removes the lock and starts

#### Scenario: Non-interactive profile contention
- **GIVEN** a valid selection and a live process holding the profile lock
- **WHEN** capture runs without a TTY
- **THEN** it returns one `LOCKED` envelope, does not launch a browser, and leaves the first process running

### Requirement: Crawl Canvas after sign-in
While capture runs, the terminal command `c` SHALL resolve the stored or first-time selection as defined in `course-selection`, crawl only selected Canvas courses, and orchestrate selected Ed capture as defined in `ed-capture`. Each unique eligible loaded Canvas final URL SHALL be saved in the same format as a manual save. The one-shot capture entry point SHALL use the same crawl rules.

- **Start condition.** For interactive Canvas capture, the active Canvas tab (the most recently focused eligible Canvas tab in the profile) SHALL establish the origin; it need not be the foreground Ed tab. That Canvas tab's host is `canvas.lms.unimelb.edu.au` and its URL path is `/courses` or starts with `/courses/`. The crawl origin (scheme, host, and port) is that tab's origin, fixed when the crawl starts. If no eligible Canvas tab exists, the Canvas outcome reports the need to open a Canvas course page; selected Ed capture can still run. In one-shot mode, the selected Canvas origin SHALL be validated against this same host and used in the existing logged-in profile without requiring terminal navigation. Selection discovery is performed before course-specific reads. If `/courses` fails or lists no course, the crawl ends with `status: "completed"` and the counts show it.
- **Tab.** The crawl opens one new tab in the same browser context, never brings it to the front, and closes it when the crawl ends.
- **Ready page.** A page counts as loaded after the `load` event plus `networkidle` (Playwright), with a 30-second timeout; links are read from the rendered DOM.
- **Link rules.** Every `href` is resolved against the page URL, and its query and fragment are dropped. Course links are paths matching `^/courses/\d+/?$` on the `/courses` page, deduplicated by course id. Current-term discovery follows `course-selection`; only stored selected Canvas ids are queued for course-specific reads. Missing selected ids are reported, without substituting other courses. Assignment links match `^/courses/<course id>/assignments/\d+/?$` on that course's assignments page; announcement links match `^/courses/<course id>/discussion_topics/\d+/?$` on its announcements page. Only same-origin links are followed.
- **Order.** `/courses`; then, for each selected course in page order, `assignments`, `announcements`, `grades`, and `assignments/syllabus`; then the linked assignment and announcement pages, selected course by selected course. The `/courses` discovery snapshot SHALL be reused if already fetched during selection in this run.
- **Limits.** Navigation is GET page loads only: the crawl MUST NOT click, type, or submit anything. At least one second passes between the end of any capture attempt (including writing its snapshot) and the start of the next Canvas navigation or Ed GET. Canvas and Ed SHALL share one limit of 300 capture-initiated attempts for the entire run, counting discovery, bootstrap navigation, failures, skipped endpoints and redirects that produce duplicate snapshots. Browser subresources are not separately counted. No 301st attempt SHALL start.
- **Read state.** Opening an announcement page may mark it read in Canvas. The user accepted this (decision #44); it is the only account-state change the crawl may cause.
- **Failures.** A navigation error, a timeout before `load`, or HTTP status 400 or above counts as failed; if `load` fired but `networkidle` timed out, the page is still saved; no snapshot is written and there is no retry.
- **Signed out.** If a page load's final URL is on another origin, or on the crawl origin with a path starting with `/login`, Canvas capture stops and tells the user to sign in again; snapshots already saved remain and Ed can continue within the shared budget.
- **Commands during a crawl.** `c` is refused with "a crawl is already running"; `s` still saves the active tab; `q`, closing the browser, SIGINT, or SIGTERM stop both providers after the current in-flight attempt settles. Explicit reselection SHALL be refused while a crawl is running.
- **Final-URL deduplication.** Within one run, normalize final Canvas URLs by dropping credentials, query and fragment and equivalent trailing slashes; write each eligible final URL once after a successful save. A disabled course tab redirecting to its course home SHALL save that home only on its first successful encounter and record every redirect in the summary. Duplicate final URLs SHALL NOT increase `saved` or `failed`, but their navigation attempts count against the cap. Do not discover assignment/announcement links from redirected home HTML. A redirect into an unselected course SHALL be recorded but neither saved nor expanded. Off-origin/login redirects retain the signed-out rule.
- **Summary.** When the crawl ends for any reason, it prints and writes `<data dir>/crawls/<timestamp>.json` (UTC ISO 8601 with `:` replaced by `-`, e.g. `2026-10-11T10-08-17Z`) with `startedAt`, `durationMs`, `saved`, `failed`, `status` (`completed`, `capReached`, `signedOut`, or `aborted`), and the list of failed URLs with query and fragment removed. It holds no page content. The summary SHALL also include attempted counts, per-source outcomes (including Ed `AUTH_EXPIRED`), skipped/unavailable endpoints, selected-course availability gaps, and redirects as sanitized requested/final URL pairs with a deduplication indicator. Ed is captured as specified in `ed-capture`; its raw JSON and student names MUST NOT appear in the summary. The run-level cap/abort reason and per-source signed-out state SHALL remain distinguishable, so one source expiry does not mark the other source failed.

#### Scenario: Crawl a signed-in Canvas
- **GIVEN** capture has resolved its selection and profile context
- **WHEN** the active tab is on a signed-in Canvas course page and the user enters `c`
- **THEN** snapshots appear for `/courses`, each selected course's four fixed pages (deduplicated by final URL), and each linked assignment and announcement page, and a summary with `status: "completed"` records the counts and duration

#### Scenario: Session expired mid-crawl
- **GIVEN** capture has resolved its selection and profile context
- **WHEN** a page load ends on another origin or on a `/login` path
- **THEN** Canvas capture stops, Ed remains eligible, earlier snapshots remain, the summary has `status: "signedOut"`, and the terminal tells the user to sign in again

#### Scenario: Not on Canvas
- **GIVEN** capture has resolved its selection and profile context
- **WHEN** no eligible Canvas tab is on `canvas.lms.unimelb.edu.au` with path `/courses` or under `/courses/`, and the user enters `c`
- **THEN** Canvas is not crawled, Ed remains eligible, and the terminal says to open a Canvas course page first

#### Scenario: Page cap
- **GIVEN** capture has resolved its selection and profile context
- **WHEN** 300 shared Canvas/Ed capture attempts have been made
- **THEN** the crawl stops and the summary has `status: "capReached"`

#### Scenario: Quit during a crawl
- **GIVEN** capture has resolved its selection and profile context
- **WHEN** the user enters `q` while a crawl is running
- **THEN** the crawl stops both providers after the current attempt settles, the summary has `status: "aborted"`, the crawl tab closes, and the lock is released

#### Scenario: Second crawl
- **GIVEN** capture has resolved its selection and profile context
- **WHEN** a crawl is running and the user enters `c`
- **THEN** the terminal says a crawl is already running and the first crawl continues

#### Scenario: Selected courses only
- **GIVEN** `/courses` lists synthetic ids 101 and 202 but only 101 is selected
- **WHEN** Canvas capture runs
- **THEN** no course-specific URL for 202 is requested or saved, including linked detail pages

#### Scenario: Disabled tabs redirect home
- **GIVEN** selected synthetic course 101 has assignments and syllabus tabs redirecting to `/courses/101`
- **WHEN** both tab URLs are attempted in one run
- **THEN** that final home URL has one snapshot, both redirects are recorded, and the duplicate adds no saved or failed count
- **AND** redirected home HTML is not treated as an assignment listing

#### Scenario: First home save fails
- **GIVEN** the first redirected home snapshot write failed
- **WHEN** a later selected tab redirects to the same home
- **THEN** capture can save it successfully because failed writes do not mark the final URL saved

#### Scenario: Redirect to unselected course
- **GIVEN** selected course 101 redirects to unselected course 202
- **WHEN** the final URL is checked
- **THEN** the redirect is recorded but its page is neither saved nor expanded
