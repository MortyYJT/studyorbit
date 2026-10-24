## ADDED Requirements

### Requirement: Agent discovery and owner course selection
Each sync run SHALL start the chat agent adapter (Codex by default, see `agent-chat`) as a job with a fixed reading prompt and the `coursework` agent tools. The agent SHALL first list the courses it sees on the owner's Canvas dashboard and Ed dashboard and submit them with the agent command `courses.offer` (course code, name if visible, term, Canvas and Ed page URLs), together with the platforms it could not read because a sign-in page appeared (`blocked`). Offered courses SHALL be stored as CourseSelection candidates keyed by normalized code and term; a candidate the owner has not decided SHALL be undecided. Page URLs SHALL be accepted only on `https://canvas.lms.unimelb.edu.au` and `https://edstem.org`. The owner command `courses.select` SHALL record a selection (selected or not) for one or more candidates; agents SHALL have no command that changes a selection. Only selected courses SHALL be read in later steps of a run. A run with no selected course SHALL end after discovery with outcome `NEEDS_SELECTION`.

#### Scenario: First run
- **WHEN** a run starts with no CourseSelection and the agent offers three courses
- **THEN** three undecided candidates exist, no course is read, and the run ends with `NEEDS_SELECTION`

#### Scenario: Owner selects two courses
- **WHEN** the owner selects two of the three candidates and starts another run
- **THEN** the agent is asked to read exactly those two courses

#### Scenario: Agent cannot select
- **WHEN** an agent calls `courses.select` through MCP or HTTP without the owner session
- **THEN** it is refused and no selection changes

### Requirement: Run state is shared through the store
A run SHALL be recorded in the store when it starts, as an active sync job with its id, start time, selected courses and per-course submission counts, so that the `coursework mcp` process that executes the agent's commands and the process that started the run see the same state. `courses.offer` and `course.import` SHALL require the id of an active job, given to the agent in the prompt, and SHALL be refused for an unknown or ended job. Only one job SHALL be active; a job older than 25 minutes SHALL count as ended. The job SHALL be closed with its outcome when the run ends.

#### Scenario: Import outside a run
- **WHEN** an agent calls `course.import` with a job id that has ended
- **THEN** it is refused and nothing is stored

#### Scenario: Count shared across processes
- **WHEN** two submissions of a course are refused by the MCP process and the third arrives
- **THEN** the third is handled as the third submission, because the count is read from the store

### Requirement: Course JSON contract
For each selected course the agent SHALL submit one document with the agent command `course.import`. The document SHALL have a course level (`code`, `name`, `term`, `pages` with Canvas and Ed URLs, `aiPolicy`, and `platforms` saying for Canvas and Ed whether they were `read`, `blocked` by a sign-in page or `absent` for this course), a list of grading components (`key`, `name`, `kind`, `count`, `weight`, `isFinal`, `hurdleMin`, `items`) and, per component, items (`key`, `name`, `due`, `status`, `score` with `outOf`, `weight`). `term` SHALL match `YYYY:S1`, `YYYY:S2`, `YYYY:SUMMER` or `YYYY:WINTER`. Every field SHALL be an object with `value` (or `null`), `state` (`found` | `unknown` | `not_applicable` | `derived`), `via` (`ax` | `screenshot`) when found, and `checkedAt` when unknown; `due`, `weight` and `hurdleMin` that are found SHALL carry the page `quote` and source URL. Component keys SHALL be the course code and a slug of the component name; item keys SHALL be the course code, the platform and the platform's id (for example `ABCD10001:canvas:assignment:500001`). The contract SHALL be one zod schema shared by the command and the reading prompt.

#### Scenario: Valid document
- **WHEN** the agent submits a document whose fields all follow the contract
- **THEN** `course.import` returns `ok` with the counts of stored components and items

#### Scenario: Wrong field shape
- **WHEN** a found `due` has no quote or a value that is not an ISO time
- **THEN** `course.import` returns `INVALID_INPUT` naming the field path, and nothing is stored

### Requirement: Validation with two retries
`course.import` SHALL check, in addition to the schema: due dates within the calendar year of the course term (Melbourne time); weights between 0 and 100; required fields (course code, name and term; component name and kind; item name, status and, for non-exam items, due) not `unknown`. A failed check SHALL return an error listing every failing field path so the agent can re-read the page, using a screenshot for empty fields (#170). On the third submission of a course in a run, every field that still fails a format, sanity or completeness check SHALL be stored as `unknown` with its `checkedAt` and reported in "needs you", and the rest of the document SHALL be stored; only a document without a valid course code and term SHALL still be refused, and that course SHALL be reported as not read. Component weights that do not add up to 100 SHALL be accepted and reported as a warning.

#### Scenario: Missing name triggers a retry
- **WHEN** the first submission of a course has its name `unknown`
- **THEN** it is refused with the path `course.name`, and a second submission with the name found is stored

#### Scenario: Third submission accepted with unknowns
- **WHEN** the third submission of a course still has an item's due date `unknown` and another item's due date in the wrong year
- **THEN** it is stored, both due dates are unknown with their check time, and "needs you" lists them

#### Scenario: Weights do not add up
- **WHEN** a course's component weights add up to 90
- **THEN** the document is stored and the run reports a weight-sum warning for that course

### Requirement: Store mapping and precedence
A stored document SHALL write, in one transaction per course: the Course (found by normalized code and term, else created; its Canvas and Ed sources from the page URLs); for each item, one SourceItem (platform, platform id, title, URL, due and score facts, no page text) and one Assessment with the item's due date, status, score as a percentage of `outOf` (unknown when `outOf` is unknown or zero), weight, the component's `kind`, and a `group` tag with the component key, name, weight and count, linked to its SourceItem; and, while a component has fewer stored items than its `count` (or no items), one remainder Assessment carrying the component's fields with weight equal to the component weight minus the stored items' weights. A component with `isFinal` or a `hurdleMin` SHALL always be stored as one Assessment (due date its earliest item's, score the weighted mean of its items), linked to all its items, so a course keeps at most one final. Assessment ids SHALL be derived from the term and the item or component key. Imported values SHALL be the lowest-precedence platform values: owner and agent annotations keep winning (see `agent-annotations`). An Assessment of the course with origin `sync` that a document no longer produces SHALL be marked `retired`, never deleted, but only for items of platforms the document reports as `read`; a remainder whose component later has all its items SHALL be retired, and SHALL return if items disappear. Agent- and owner-origin assessments SHALL NOT be retired by import. Each field's `state`, `via`, `checkedAt`, quote and source URL SHALL be stored in the entity's `readState`.

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

#### Scenario: Blocked platform keeps its data
- **WHEN** a document reports Canvas `blocked` and Ed `read`
- **THEN** Ed-based assessments are updated or retired as read, and no Canvas-based assessment of the course is retired

### Requirement: Unknown fields are re-checked and derived weights split evenly
Every run SHALL ask the agent to re-read each selected course in full, including fields stored as `unknown`; a later document that finds such a field SHALL replace the unknown value. When a component's weight is known, items whose own weight is not stated SHALL get state `derived` and an equal share of what remains, `(component weight − stated item weights) / (count − number of items with a stated weight)`, using the number of listed items when `count` is unknown (#171); a later stated weight SHALL replace it. Earned totals per component SHALL be computed by code from item scores and weights, never taken from the agent.

#### Scenario: A due date appears later
- **WHEN** an item's due date was stored as unknown and the next run finds it
- **THEN** the stored due date becomes the found value with state `found`

#### Scenario: Even split
- **WHEN** a component has weight 15, count 4 and no item weights
- **THEN** each of its items has weight 3.75 with state `derived`

#### Scenario: Split what remains
- **WHEN** a component has weight 20, count 3, and one item states its weight as 10
- **THEN** the other two items have weight 5 each with state `derived`

### Requirement: One AI policy field per course
The document's `aiPolicy` (`allowed` | `prohibited` | `owner-attested` | unknown) SHALL be the course's agent-read AI policy, stored on the Course with its quote and effective at once (#180). Agents SHALL NOT record a course `aiPolicy` annotation; `annotation.record` SHALL refuse that field. An owner policy recorded from the frontend SHALL take precedence and SHALL never be overwritten by import; an owner value of `null` SHALL clear the owner's policy, so the agent-read value applies again. Reads (`courses.list`, `annotation.read`, `autonomy.read`) SHALL report the effective policy with its origin. When a run stores a value different from the previously stored agent-read value, "needs you" SHALL show the course, the new value and its quote until the next run; no confirmation is required.

#### Scenario: Policy read changes
- **WHEN** the agent reads `prohibited` for a course previously read as unknown
- **THEN** the course is capped at L0 at once and "needs you" shows the change with the quote

#### Scenario: Owner policy kept
- **WHEN** the owner set a course to `allowed` and the agent reads `prohibited`
- **THEN** the effective policy stays `allowed`, and the agent-read value and quote are stored for display

#### Scenario: Owner clears the policy
- **WHEN** the owner records `null` for a course whose agent-read policy is `prohibited`
- **THEN** the effective policy is `prohibited` with origin `agent`

## MODIFIED Requirements

### Requirement: Sync is started by the owner and its state is visible
Sync SHALL run only when started: by `coursework sync` or by the frontend's sync button through the `sync.run` command (#128); there is no schedule. A run SHALL be an agent reading job (see "Agent discovery and owner course selection"); `--course <code>` SHALL limit it to one selected course. One sync SHALL run at a time; a second start while one runs SHALL return `LOCKED` without starting another. A run SHALL end within 20 minutes or be stopped and recorded as `TIMEOUT`. Each run SHALL record a Run with its start and end, sync outcome (`OK`, `PARTIAL`, `NEEDS_SELECTION`, `AGENT_UNAVAILABLE`, `TIMEOUT`, `FAILED`), per-course coverage (stored, submissions, fields left unknown, platforms read or blocked), AI-policy changes and the agent's turns and tool steps. `sync.status` SHALL report whether a run is active, the last run, the platforms the last run found blocked, and per selected course the time of its last stored document. When the agent is unavailable or a course could not be read, its previously stored data SHALL stay readable and SHALL be marked with the time of its last stored document.

#### Scenario: Sync from the frontend
- **WHEN** the owner presses the sync button and the agent is signed in
- **THEN** one sync run starts, the button shows it is running, and the frontend shows the new run's outcome when it ends

#### Scenario: Expired sign-in is not hidden
- **WHEN** the agent reports Canvas `blocked` by a sign-in page and reads Ed
- **THEN** Ed-based data updates, Canvas-based data stays as it was, the run is `PARTIAL`, and `sync.status` lists Canvas as blocked so "needs you" asks the owner to sign in

#### Scenario: Second start
- **WHEN** a sync is running and another start arrives
- **THEN** the second start returns `LOCKED` and no second run begins

## REMOVED Requirements

### Requirement: Sync current-term courses into the local store
**Reason**: The Canvas/Ed JSON API reading is replaced by agent reading (#165, #172).
**Migration**: Covered by "Agent discovery and owner course selection" and "Course JSON contract".

### Requirement: Merge Canvas and Ed courses by normalized course code
**Reason**: The agent reads both platforms and submits one document per course code and term.
**Migration**: "Store mapping and precedence" finds courses by normalized code and term.

### Requirement: Record platform facts, never guessed structure
**Reason**: Facts now come from the agent's document; per-item weights may be derived by the owner's choice (#171).
**Migration**: "Store mapping and precedence" and "Unknown fields are re-checked and derived weights split evenly".

### Requirement: Latest state only
**Reason**: Replaced by retiring assessments a document no longer produces, per platform read.
**Migration**: "Store mapping and precedence".

### Requirement: Redact before storing
**Reason**: The owner accepted that screen content reaches the agent unredacted (#168); the document holds course facts and short quotes only, and SourceItems from import hold no page text.
**Migration**: None; quotes are limited to due dates, weights and hurdles.

### Requirement: Bounded, measured, source-isolated runs
**Reason**: There are no per-provider API requests to bound.
**Migration**: Run records and the 20-minute bound are in "Sync is started by the owner and its state is visible"; shared run state in "Run state is shared through the store".
