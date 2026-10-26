## MODIFIED Requirements

### Requirement: Sync is started by the owner and its state is visible
Sync SHALL run only when started: by `coursework sync` or by the frontend's sync button through the `sync.run` command (#128); there is no schedule. A run SHALL be the per-course pipeline of `layered-sync` (course list, then each selected course in turn); `--course <code>` SHALL limit it to one selected course. One sync SHALL run at a time; a second start while one runs SHALL return `LOCKED` without starting another. Each agent job SHALL end within 10 minutes or be stopped and counted as a failed job; a run SHALL end within 20 minutes per selected course (at least 20 minutes) or be stopped and recorded as `TIMEOUT`, keeping every course already imported. Each run SHALL record a Run with its start and end, sync outcome (`OK`, `PARTIAL`, `NEEDS_SELECTION`, `AGENT_UNAVAILABLE`, `TIMEOUT`, `FAILED`), per-course coverage (stored, fields left unknown, platforms read or blocked, whether Canvas numbers came from the API), AI-policy changes, and per job its kind, course, steps, turns and outcome. `sync.status` SHALL report whether a run is active, the last run, the platforms the last run found blocked, and per selected course the time of its last stored document. When the agent is unavailable or a course could not be read, its previously stored data SHALL stay readable and SHALL be marked with the time of its last stored document.

#### Scenario: Sync from the frontend
- **WHEN** the owner presses the sync button and the agent is signed in
- **THEN** one sync run starts, the button shows it is running, and the frontend shows the new run's outcome when it ends

#### Scenario: Expired sign-in is not hidden
- **WHEN** the agent reports Canvas `blocked` by a sign-in page and reads Ed
- **THEN** Ed-based data updates, Canvas-based data stays as it was, the run is `PARTIAL`, and `sync.status` lists Canvas as blocked so "needs you" asks the owner to sign in

#### Scenario: Second start
- **WHEN** a sync is running and another start arrives
- **THEN** the second start returns `LOCKED` and no second run begins

### Requirement: Run state is shared through the store
A run SHALL be recorded in the store when it starts, as an active sync job with its id, start time, selected courses and each course's finished stage results, so that the `coursework mcp` process that executes the agent's commands and the process that started the run see the same state. `courses.offer`, `canvas.capture`, `handbook.capture`, `course.map`, `quizzes.read`, `assignment.saved`, `materials.saved` and `items.classify` SHALL require the id of an active job and, except for the course list, a course of that job, given to the agent in the prompt, and SHALL be refused for an unknown or ended job. Only one job SHALL be active; a job older than its run bound plus 5 minutes SHALL count as ended. The job SHALL be closed with its outcome when the run ends.

#### Scenario: Stage output outside a run
- **WHEN** an agent calls `course.map` with a job id that has ended
- **THEN** it is refused and nothing is stored

#### Scenario: Stage results shared across processes
- **WHEN** the MCP process stores a course's `course.map` result
- **THEN** the orchestrator reads it from the store and starts that course's routed jobs

### Requirement: Store mapping and precedence
A stored document SHALL write, in one transaction per course: the Course (found by normalized code and term, else created; its Canvas and Ed sources from the page URLs); for each item, one SourceItem (platform, platform id, title, URL, unlock, due, score and update-time facts, no page text) and one Assessment with the item's unlock time, due date, status, score as a percentage of `outOf` (unknown when `outOf` is unknown or zero), weight, the item's `kind` (the component's `kind` when the item has none), the item's agent-read `aiPolicy`, and a `group` tag with the component key, name, weight and count, linked to its SourceItem; and, while a component has fewer stored items than its `count` (or no items), one remainder Assessment with the component's name, kind and group tag, without `isFinal` or `hurdleMin`, and weight equal to the component weight minus the effective weights of its stored items, never below zero (a shortfall is reported as a warning). A component with `isFinal` or a `hurdleMin` SHALL instead always be stored as one component Assessment (due date its earliest item's, score the weighted mean of its items), linked to all its items; its items get no Assessment of their own and it has no remainder. An item whose current link has origin `agent` or `owner` SHALL keep that link and get no Assessment from import, and its weight counts against the remainder. Assessment ids SHALL be derived from the term and the item key, the component key (component Assessments) or the component key with a remainder suffix (remainders), so the three never collide. Imported values SHALL be the lowest-precedence platform values: owner and agent annotations keep winning (see `agent-annotations`). An Assessment of the course with origin `sync` that a document no longer produces SHALL be marked `retired`, never deleted: item Assessments only for platforms the document reports as `read`; remainder and component Assessments only when the document reports `componentsComplete`. A remainder whose component later has all its items SHALL be retired, and SHALL return if items disappear. Retired assessments SHALL be left out of every read, planning, the grade projection and the one-final rule. Agent- and owner-origin assessments SHALL NOT be retired by import. Each field's `state`, `via`, `checkedAt`, quote and source URL SHALL be stored in the entity's `readState`.

#### Scenario: Items replace part of a placeholder
- **WHEN** a component "Written assignments" of weight 15 and count 4 lists two published items
- **THEN** two item Assessments of weight 3.75 with the group tag exist, and one remainder Assessment of weight 7.5 keeps the unpublished share in the grade

#### Scenario: All items published
- **WHEN** the same component later lists all four items
- **THEN** four item Assessments exist and the remainder is retired

#### Scenario: Owner value wins
- **WHEN** the owner recorded an item's weight as 5 and the next import reads 3.75
- **THEN** the effective weight stays 5 with origin `owner`

#### Scenario: Old API data is reused
- **WHEN** the store already holds a course with the same code and term from the old API sync
- **THEN** the import updates that course instead of creating a second one, and its old sync-origin assessments not produced by the document are retired

#### Scenario: Final exam with items
- **WHEN** a component "Final exam" with `isFinal`, weight 50, hurdle 40 and count 2 lists one item
- **THEN** one component Assessment of weight 50 marked final with the hurdle exists, linked to the item, with no remainder and no separate item Assessment

#### Scenario: Agent link kept
- **WHEN** the agent had linked an imported item to its own "Workshops" Assessment and the next import lists that item under a component
- **THEN** the item stays linked to "Workshops", gets no import Assessment, and its weight counts against that component's remainder

#### Scenario: Blocked platform keeps its data
- **WHEN** a document reports Canvas `blocked` and Ed `read`
- **THEN** Ed-based assessments are updated or retired as read, and no Canvas-based assessment of the course is retired

### Requirement: Unknown fields are re-checked and derived weights split evenly
Every run SHALL capture each selected course's Canvas API pages again and run the main, quiz and classification jobs again; assignment pages SHALL be opened again unless their API `updated_at` and saved-file fingerprints are unchanged (see `layered-sync`). A later document that finds a field stored as `unknown` SHALL replace the unknown value. When a component's weight is known, items whose own weight is not stated SHALL get state `derived` and an equal share of what remains, `(component weight − stated item weights) / (slots − number of items with a stated weight)`, where `slots` is the larger of `count` and the number of listed items (the listed items when `count` is unknown), and more listed items than `count` SHALL be reported as a `COUNT_MISMATCH` warning (#171); a later stated weight SHALL replace it. Earned totals per component SHALL be computed by code from item scores and weights, never taken from the agent.

#### Scenario: A due date appears later
- **WHEN** an item's due date was stored as unknown and the next run finds it
- **THEN** the stored due date becomes the found value with state `found`

#### Scenario: Even split
- **WHEN** a component has weight 15, count 4 and no item weights
- **THEN** each of its items has weight 3.75 with state `derived`

#### Scenario: Split what remains
- **WHEN** a component has weight 20, count 3, and one item states its weight as 10
- **THEN** the other two items have weight 5 each with state `derived`

### Requirement: Agent discovery and owner course selection
Each sync run SHALL start with the course list: a capture job asks the agent (Codex by default, see `agent-chat`) to copy Canvas's course list API page and call `canvas.capture` with page `courses` (see `canvas-api-read`); code offers the listed courses as CourseSelection candidates keyed by normalized code and term. Ed pages for a course SHALL be found by the Ed source (see `layered-sync`). When the capture shows a sign-in page, or the computer-use tool or Edge is unavailable (for example a locked screen), the job SHALL call `courses.offer` with no courses and the platforms in `blocked` and stop. A candidate the owner has not decided SHALL be undecided. Page URLs SHALL be accepted only on `https://canvas.lms.unimelb.edu.au` and `https://edstem.org`. The owner command `courses.select` SHALL record a selection (selected or not) for one or more candidates; agents SHALL have no command that changes a selection. Only selected courses SHALL be read in later stages of a run. A run with no selected course SHALL end after the course list with outcome `NEEDS_SELECTION`. A run that stores nothing and finds both platforms blocked SHALL end with outcome `AGENT_UNAVAILABLE`.

#### Scenario: First run
- **WHEN** a run starts with no CourseSelection and the course list capture lists three courses
- **THEN** three undecided candidates exist, no course is read, and the run ends with `NEEDS_SELECTION`

#### Scenario: Owner selects two courses
- **WHEN** the owner selects two of the three candidates and starts another run
- **THEN** exactly those two courses go through the per-course pipeline

#### Scenario: Nothing readable
- **WHEN** the owner's screen is locked and the job reports Canvas and Ed blocked
- **THEN** the run ends `AGENT_UNAVAILABLE`, not `NEEDS_SELECTION`

#### Scenario: Agent cannot select
- **WHEN** an agent calls `courses.select` through MCP or HTTP without the owner session
- **THEN** it is refused and no selection changes

### Requirement: Course JSON contract
For each selected course, code SHALL build one course document from the pipeline's stages (see `layered-sync`) and import it with the same mapping that `course.import` uses; `course.import` SHALL no longer be offered to agents. The document SHALL have a course level (`code`, `name`, `term`, `pages` with Canvas and Ed URLs, `aiPolicy`, `platforms` saying for Canvas and Ed whether they were `read`, `blocked` by a sign-in page or `absent` for this course, and `componentsComplete`), a list of grading components (`key`, `name`, `kind`, `count`, `weight`, `isFinal`, `hurdleMin`, `items`) and, per component, items (`key`, `name`, `kind`, `unlockAt`, `due`, `status`, `score` with `outOf`, `weight`, and an optional `aiPolicy`). `kind` SHALL be one of `exam`, `quiz`, `assignment`, `presentation`, `participation`, `ungraded` (#202). `term` SHALL match `YYYY:S1`, `YYYY:S2`, `YYYY:SUMMER` or `YYYY:WINTER`. Every field SHALL be an object with `value` (or `null`), `state` (`found` | `unknown` | `not_applicable` | `derived`), `via` (`api` | `ax` | `screenshot` | `handbook`) when found, and `checkedAt` when unknown; fields found with `ax` or `screenshot` and `handbook` fields SHALL carry a quote and source URL; fields with `via: "api"` SHALL carry the API URL as source and no quote. An item without `aiPolicy` SHALL be treated as an unknown item policy. Component keys SHALL be the course code and a slug of the component name; item keys SHALL be the course code, the platform and the platform's id (for example `ABCD10001:canvas:assignment:500001`). The contract SHALL stay one zod schema.

#### Scenario: Valid document
- **WHEN** code builds a document whose fields all follow the contract
- **THEN** the import stores it and reports the counts of stored components and items

#### Scenario: Agent read without a quote
- **WHEN** a built document holds an item `aiPolicy` found with `ax` but no quote
- **THEN** the import refuses that field with `INVALID_INPUT` naming its path, stores it as unknown, and stores the rest

#### Scenario: API field without a quote
- **WHEN** an item's `due` is found with `via: "api"` and the API URL as source
- **THEN** it is accepted without a quote

### Requirement: Validation with two retries
The import SHALL check, in addition to the schema: due dates within the calendar year of the course term (Melbourne time); weights between 0 and 100; required fields (course code, name and term; component name and kind; item name and status) not `unknown`; at most one component with `isFinal` true; stated item weights of a component not above the component weight. Because code builds the document, a failing field SHALL NOT trigger a re-read of the whole course: when the failing field came from the classification job, that job SHALL be run once more with the failing paths; any field that still fails SHALL be stored as `unknown` with its `checkedAt` and reported in "needs you", and the rest of the document SHALL be stored, with these exceptions because the domain requires them: an item or component whose name or status is still invalid SHALL be left out and reported; a course whose name is still invalid SHALL be stored showing its code, with the name marked unknown; more than one final component SHALL be stored with `isFinal` unknown on all of them. Only a document without a valid course code and term SHALL be refused, and that course SHALL be reported as not read. Component weights that do not add up to 100 SHALL be accepted and reported as a warning.

#### Scenario: Classification retried once
- **WHEN** the classification job returns an unknown kind for a component
- **THEN** it is run once more with that path, and a still-unknown kind is stored as unknown and shown in "needs you"

#### Scenario: Weights do not add up
- **WHEN** a course's component weights add up to 90
- **THEN** the document is stored and the run reports a weight-sum warning for that course

## REMOVED Requirements

### Requirement: One AI policy field per course
**Reason**: AI rules usually apply to particular assessments, not a whole course (#195); one course field cannot express "AI banned for reports and reflections only".
**Migration**: The course `aiPolicy` stays in the document and on the Course as the course default. Its storage, owner precedence, missed-read and "needs you" rules move into "AI policy per assessment with a course default", which adds the same rules per item.

## ADDED Requirements

### Requirement: AI policy per assessment with a course default
The document's course `aiPolicy` SHALL be the course's agent-read default policy, read by the main job from the home page when it states one, stored on the Course with its quote. Each item's `aiPolicy`, read by the assignment-page job, SHALL be stored as the agent-read policy of that item's Assessment with its quote in the Assessment's read state (#195). A component Assessment (final or hurdle) SHALL store `prohibited` when any of its items reads `prohibited`, else the value its items agree on, else none; a remainder Assessment SHALL store none. A run that reads a course or item policy as unknown, or skips an unchanged page, SHALL keep the previously stored agent-read value and its quote and update its check time (#184). Agents SHALL NOT record an `aiPolicy` annotation on a course or an assessment; `annotation.record` SHALL refuse that field. Owner policies SHALL be recorded only from the frontend's owner session, per course or per assessment, SHALL never be overwritten by import, and an owner value of `null` SHALL clear the owner's policy at that level. Reads (`courses.list`, `annotation.read`, `autonomy.read`, `assessments.list`) SHALL report the effective policy with its origin, and for assessments the level it came from. When a run stores a course or item value different from the previously stored agent-read value, "needs you" SHALL show the course or assessment, the new value and its quote until the next run; no confirmation is required. How the stored values combine into the effective policy is defined in `assessment-autonomy`.

#### Scenario: Item policy read
- **WHEN** the assignment-page job reads `prohibited` for "Report" quoting "You must not use generative AI to write this report" and the course default is `allowed`
- **THEN** the Report Assessment stores `prohibited` with the quote, the Course stores `allowed`, and "needs you" shows the new item value

#### Scenario: Missed item read keeps the last value
- **WHEN** an item was read as `prohibited` earlier and this run reads its policy as unknown
- **THEN** the stored value stays `prohibited` and its check time is updated

#### Scenario: Owner item policy kept
- **WHEN** the owner set an assessment to `allowed` and the agent reads `prohibited` for its item
- **THEN** the owner value stays, and the agent-read value and quote are stored for display

#### Scenario: Owner clears the course policy
- **WHEN** the owner records `null` for a course whose agent-read policy is `prohibited`
- **THEN** the course-level effective policy is `prohibited` with origin `agent`

#### Scenario: Agent item policy annotation refused
- **WHEN** an agent records an `aiPolicy` annotation on an assessment
- **THEN** it is rejected and nothing is stored
