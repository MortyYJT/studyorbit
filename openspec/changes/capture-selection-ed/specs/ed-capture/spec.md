## ADDED Requirements

### Requirement: Read Ed JSON through its own logged-in page
Ed capture SHALL call Ed's own JSON API using GET inside a logged-in Playwright page on the fixed origin `https://edstem.org`, authenticated by the persistent browser profile's own session. It MUST NOT use a self-issued token, external HTTP client, password prompt, explicit renewal call, or write method. Requested endpoints and redirects SHALL stay on that exact origin; cross-origin redirects SHALL be refused before being followed. Lesson and slide requests MUST omit `view` and MUST never send `view=1`, even if content is unavailable without it.

#### Scenario: Same-origin session reads
- **GIVEN** the browser profile has an authenticated Ed page
- **WHEN** capture reads an assignment lesson and its slides
- **THEN** page-context GETs use that session on the Ed origin with no `view` parameter and no stored/exported auth headers

#### Scenario: View parameter required
- **GIVEN** a lesson or slide endpoint refuses to return content with `view` omitted
- **WHEN** capture encounters that refusal
- **THEN** it records the coverage gap and open question and never retries with `view=1`

#### Scenario: External redirect
- **GIVEN** an Ed endpoint responds with a cross-origin redirect
- **WHEN** capture handles the response
- **THEN** it does not follow the redirect or save external content and reports an Ed source gap

### Requirement: Capture bounded selected-course endpoint coverage
Ed capture SHALL snapshot the course-list response and, for each selected Ed course, its lessons list, every assignment lesson with `kind: attempt`, every slide referenced by those assignments, the first discussion thread-list page with `limit=30&sort=new`, and resources. Observed endpoint paths are `/api/courses/{id}/lessons`, `/api/lessons/{id}`, `/api/lessons/slides/{id}`, `/api/courses/{id}/threads`, and `/api/courses/{id}/resources`; the course-list path SHALL be verified before implementation. It SHALL NOT fetch ordinary content lesson bodies, subsequent thread pages, thread details/replies, workspaces or linked external resource files. Missing tabs/endpoints returning 404/405 SHALL be recorded as skipped/unavailable, not failures; other endpoints SHALL still be attempted within the budget. Assignment/slide ids SHALL come only from selected-course responses.

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
Successful Ed JSON responses SHALL be saved as raw `response.json` bodies with metadata under `<data dir>/snapshots/edstem.org/`, inside private local storage, preserving returned fields and embedded XML text. Metadata SHALL identify source, safe endpoint, capture time and HTTP status, without cookies or auth headers. Local selection, snapshots and summaries MUST remain Git-ignored. Classmates' personal data, including thread author names and identifying free text, MUST be stripped before anything reaches a model. Raw capture SHALL expose no response content to models, envelopes or logs; future ingestion/export SHALL verify redaction before model access. Fixtures and tests MUST use synthetic data only.

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
An Ed API 401 or 403 SHALL stop further Ed reads and report an Ed outcome with `AUTH_EXPIRED` and a manual sign-in recovery hint, retaining already saved snapshots. It MUST NOT stop or mark Canvas failed; Canvas SHALL continue within the shared budget. This auth rule SHALL take precedence over missing-endpoint handling. Other unavailable/malformed responses SHALL be reported per endpoint without storing them as successful JSON snapshots. The non-interactive envelope SHALL contain bounded per-source statuses/errors and counts, never raw response content.

#### Scenario: Ed expires while Canvas remains valid
- **GIVEN** selected courses from both sources and a usable Canvas session
- **WHEN** an Ed call returns 401 or 403
- **THEN** Ed reports `AUTH_EXPIRED` and stops, Canvas proceeds within the remaining budget, and completed snapshots remain

#### Scenario: Invalid JSON
- **GIVEN** an Ed API returns a non-JSON success body
- **WHEN** capture handles the response
- **THEN** that endpoint counts as failed, its body is not saved as a successful snapshot or leaked in diagnostics, and other eligible reads continue
