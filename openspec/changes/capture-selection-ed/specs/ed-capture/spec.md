## ADDED Requirements

### Requirement: Read Ed JSON through its own logged-in page
Ed capture SHALL call Ed's own JSON API using GET inside a logged-in Playwright page on the fixed origin `https://edstem.org`, authenticated by the persistent browser profile's own session. Deterministic code SHALL read that session's existing token inside the page from `localStorage` key `authToken:<region>` (AU: `authToken:au`) and attach it in the `x-token` request header to each same-origin GET. This is the browser session's own post-login token, not a self-issued API token. Capture MUST NOT log, print, store, snapshot, return, or expose the token to a model; it MUST NOT store or export auth headers. Reading the existing browser-managed key MUST NOT create a capture-owned token store. Cookies alone are insufficient (verified 401); `Authorization: Bearer` MUST NOT be used (verified 400). A missing token SHALL yield Ed `AUTH_EXPIRED` without a cookie-only fallback. It MUST NOT use a self-issued token, external HTTP client, password prompt, explicit renewal call, or write method. Requested endpoints and redirects SHALL stay on that exact origin; cross-origin redirects SHALL be refused before being followed. Lesson and slide requests MUST omit `view` and MUST never send `view=1`, even if content is unavailable without it.

#### Scenario: Same-origin session reads
- **GIVEN** the browser profile has an authenticated Ed page
- **WHEN** capture reads an assignment lesson and its slides
- **THEN** deterministic page-context code reads the existing regional token and attaches `x-token` to each GET on the Ed origin with no `view` parameter and no stored/exported auth headers
- **AND** the token is never logged, printed, stored, snapshotted, returned, or exposed to a model

#### Scenario: Lesson read without view
- **GIVEN** a synthetic authenticated lesson endpoint returns 200 with `view` omitted, matching the verified endpoint behavior
- **WHEN** capture reads `GET /api/lessons/{id}`
- **THEN** it saves the lesson JSON without adding `view` or sending `view=1`

#### Scenario: View parameter required
- **GIVEN** a lesson or slide endpoint refuses to return content with `view` omitted
- **WHEN** capture encounters that refusal
- **THEN** it records the coverage gap and open question and never retries with `view=1`

#### Scenario: External redirect
- **GIVEN** an Ed endpoint responds with a cross-origin redirect
- **WHEN** capture handles the response
- **THEN** it does not follow the redirect or save external content and reports an Ed source gap

### Requirement: Capture bounded selected-course endpoint coverage
Ed capture SHALL discover courses through `GET /api/user` and snapshot only its `courses` array and, for each selected Ed course, its lessons list, every assignment lesson with `kind: attempt`, every slide referenced by those assignments, the first discussion thread-list page with `limit=30&sort=new`, and resources. Observed endpoint paths are `/api/courses/{id}/lessons`, `/api/lessons/{id}`, `/api/lessons/slides/{id}`, `/api/courses/{id}/threads`, and `/api/courses/{id}/resources`; the verified course-list path is `/api/user`. It SHALL NOT fetch ordinary content lesson bodies, subsequent thread pages, thread details/replies, workspaces or linked external resource files. Missing tabs/endpoints returning 404/405 SHALL be recorded as skipped/unavailable, not failures; other endpoints SHALL still be attempted within the budget. Assignment/slide ids SHALL come only from selected-course responses.

#### Scenario: Assignment with slides
- **GIVEN** selected Ed ABCD10001 lists one attempt lesson with two slides and one content lesson
- **WHEN** its capture completes within budget
- **THEN** raw snapshots contain the course list, lessons list, attempt lesson, both slides, first thread-list page and resources, without fetching the content lesson body or thread page two

#### Scenario: No Lessons tab
- **GIVEN** a selected course has discussions and resources but its lessons endpoint returns 404
- **WHEN** capture runs
- **THEN** lessons are recorded as skipped without increasing failed count, and threads/resources are still captured

### Requirement: Share capture rate limits and upper bound
Ed reads SHALL use the same scheduler as Canvas, with at least one second between the completion of one capture attempt (including snapshot writing) and the next start. All capture-initiated discovery, bootstrap navigation and API GET attempts, including failures and skipped endpoints, SHALL count toward one shared 300-attempt maximum per run. There SHALL be no automatic retries. Cap, cancellation and rate-limit responses SHALL be reported without discarding existing snapshots.

#### Scenario: Shared cap
- **GIVEN** discovery and Canvas have consumed 299 attempts
- **WHEN** Ed makes one more GET attempt
- **THEN** no 301st attempt starts, remaining Ed coverage is reported incomplete and the run records `capReached`

#### Scenario: Rate-limited response
- **GIVEN** Ed returns 429
- **WHEN** capture records the failed attempt
- **THEN** it does not retry automatically and the next attempt waits at least one second after completion

### Requirement: Store raw JSON privately with a model-access boundary
Successful Ed JSON responses SHALL be saved as raw `response.json` bodies with metadata under `<data dir>/snapshots/edstem.org/`, inside private local storage, preserving returned fields and embedded XML text. The exception is `GET /api/user`: its snapshot SHALL contain only the `courses` array, never the full body or top-level `user`, `push_key`, `push_subscriptions`, or other non-course fields. Metadata SHALL identify source, safe endpoint, capture time and HTTP status, without cookies or auth headers. Local selection, snapshots and summaries MUST remain Git-ignored. Classmates' personal data, including thread author names and identifying free text, MUST be stripped before anything reaches a model. Raw capture SHALL expose no response content to models, envelopes or logs; future ingestion/export SHALL verify redaction before model access. Fixtures and tests MUST use synthetic data only.

#### Scenario: Courses-only discovery snapshot
- **GIVEN** a synthetic `GET /api/user` response contains `courses` plus `user`, `push_key`, `push_subscriptions`, and other top-level fields
- **WHEN** discovery is snapshotted
- **THEN** `response.json` contains only the `courses` array and no non-course top-level fields or full-body snapshot is stored
- **AND** profile and push subscription data do not enter metadata, summaries, logs, envelopes, or model output

#### Scenario: Thread authors remain local
- **GIVEN** a synthetic thread-list response contains a classmate author and identifying text
- **WHEN** capture saves it
- **THEN** its raw JSON remains only in the private local snapshot, and the envelope/logs contain no author name or thread text

#### Scenario: Model access requires redaction
- **GIVEN** raw thread snapshots have not passed a verified redaction boundary
- **WHEN** a model-facing consumer requests capture content
- **THEN** raw content is withheld until classmates' personal data is stripped

#### Scenario: Snapshot fidelity and fixture privacy
- **GIVEN** synthetic assignment JSON includes XML slides and ISO date fields
- **WHEN** it is saved and project privacy checks run
- **THEN** the raw values are preserved, local snapshot paths are ignored by Git and repository fixtures contain no real course data

### Requirement: Isolate Ed authentication and partial failures
A missing page-local session token or an Ed API 401 or 403 SHALL stop further Ed reads and report an Ed outcome with `AUTH_EXPIRED` and a manual sign-in recovery hint, retaining already saved snapshots. It MUST NOT stop or mark Canvas failed; Canvas SHALL continue within the shared budget. This auth rule SHALL take precedence over missing-endpoint handling. Other unavailable/malformed responses SHALL be reported per endpoint without storing them as successful JSON snapshots. The non-interactive envelope SHALL contain bounded per-source statuses/errors and counts, never raw response content.

#### Scenario: Ed expires while Canvas remains valid
- **GIVEN** selected courses from both sources and a usable Canvas session
- **WHEN** an Ed call returns 401 or 403
- **THEN** Ed reports `AUTH_EXPIRED` and stops, Canvas proceeds within the remaining budget, and completed snapshots remain

#### Scenario: Missing regional session token
- **GIVEN** the page has no token at the applicable `authToken:<region>` key and Canvas remains usable
- **WHEN** Ed discovery or capture attempts a read
- **THEN** Ed reports `AUTH_EXPIRED` with a manual sign-in recovery hint and stops without a cookie-only request, token provisioning, or credential prompt
- **AND** Canvas continues within the shared budget and prior snapshots remain

#### Scenario: Invalid JSON
- **GIVEN** an Ed API returns a non-JSON success body
- **WHEN** capture handles the response
- **THEN** that endpoint counts as failed, its body is not saved as a successful snapshot or leaked in diagnostics, and other eligible reads continue
