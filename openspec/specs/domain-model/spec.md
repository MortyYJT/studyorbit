# domain-model Specification

## Purpose
TBD - created by archiving change v1-foundation. Update Purpose after archive.
## Requirements
### Requirement: Every entity has a validating schema
The system SHALL define a zod schema for each stored entity: Module, Course, Assessment, SourceItem, AssessmentLink, Annotation, AnnotationVerdict, PlanningSettings, Estimate, StartTime, TimeLog, CourseAutonomy, Conversation, Message, PendingConfirmation, PracticeAttempt, Task and Run. Every value written to storage or returned to an agent MUST pass its schema first.

#### Scenario: Valid entity is accepted
- **WHEN** a Task with an id, module id, title, and at least one step is parsed
- **THEN** parsing succeeds and returns a typed value

#### Scenario: Invalid entity is rejected with a path
- **WHEN** a Task without a title is parsed
- **THEN** parsing fails and the error names the `title` path

### Requirement: Entity fields
The schemas SHALL contain at least these fields (ids are non-empty strings; times are ISO 8601 strings):
- Module: `id`, `name`, `glyph`, `auto` (fed by coursework sources).
- Course: `id`, `moduleId`, `code`, `name`, `term`, `assessmentsComplete`, `sources` (array of `{ platform: canvas | ed, externalId }`, may be empty for manual courses), `aiPolicy?` (the agent-read policy: `allowed` | `prohibited` | `owner-attested`; absent means unknown), `readState?` (per field: `state`, `via?`, `checkedAt?`, `quote?`, `source?`).
- Assessment: `id`, `courseId`, `name`, `kind?` (`quiz` | `ongoing` | `assignment` | `exam`; absent means unknown), `weight?` (absent means unknown), `score?`, `due?`, `hurdleMin?`, `isFinal`, `status` (`not_started` | `in_progress` | `submitted` | `graded`), `origin` (`sync` | `agent` | `owner`), `group?` (`{ key, name, weight?, count?, role? }`, the grading component an assessment belongs to; `role` is `item`, `remainder` or `component`), `retired?` (true when no longer listed or replaced by its items; reads omit retired assessments), `readState?` (per field, as for Course; `state` may be `derived` for an evenly split weight).
- SourceItem: `id`, `platform` (`canvas` | `ed` | `manual`), `externalId`, `courseId?`, `kind` (`assignment` | `announcement` | `material` | `post` | `event`), `title`, `url?`, `text` (already redacted), `contentHash`, `fetchedAt`, `removed` (boolean), `copiedBy?` (`agent` when the text was recorded by the agent with `source.record`), `facts?` (`{ due?, pointsPossible?, pointsEarned?, submitted? }`, only for kind `assignment`).
- AssessmentLink: `assessmentId`, `sourceItemId`, `origin` (`sync` | `agent` | `owner`), `at`.
- Annotation: `id`, `entity` (`assessment` | `course`), `entityId`, `field`, `value`, `origin` (`agent` | `owner`), `citations` (array; at least one when origin is `agent`), `at`.
- AnnotationVerdict: `annotationId`, `verdict` (`correct` | `incorrect`), `at` (owner only).
- PlanningSettings: `timeZone`, `weekdayMinutes` (seven nonnegative integers, Monday first), `teachingWeekAnchor`, `breakWeeks`.
- Estimate: `workId` (an assessment id, task step id or manual task id), `minutes` (positive integer), `origin` (`agent` | `owner`), `reason?` (required when origin is `agent`), `at`.
- StartTime: `workId`, `date` (local date), `time` (`HH:MM`), `at`.
- TimeLog: `workId`, `minutes` (positive integer), `at`.
- CourseAutonomy: `courseId`, `defaultLevel` (0 | 1 | 2), `confirmBeforeSubmit` (historical; no longer read or written after the submit-confirmation flow was removed), `at`.
- Conversation: `id`, `title`, `adapter`, `sessionRef?`, `courseId?`, `assessmentId?`, `preset?`, `createdAt`, `updatedAt`.
- Message: `id`, `conversationId`, `seq`, `role` (`owner` | `agent`), `parts` (text, tool step; confirmation parts are historical), `stopped`, `at`.
- PendingConfirmation (historical; no longer written): `id`, `conversationId`, `assessmentId`, `summary`, `screenshotRef`, `state` (`pending` | `confirmed` | `cancelled` | `expired`), `createdAt`, `decidedAt?`.
- PracticeAttempt: `questionId`, `revision`, `outcome` (`correct` | `incorrect` | `skipped`), `at` (no answer text).
- Citation: `sourceItemId`, `quote`, `locator`.
- Step: `title`, `estimateMinutes`, `done`, `citations` (array, may be empty only for manual tasks).
- Task: `id`, `moduleId`, `courseId?`, `assessmentId?`, `title`, `source` (`coursework` | `manual`), `due?`, `repeat?` (`daily` | `weekly`), `steps`, `done` (manual tasks are completed as a whole), `allDay?` (manual tasks only, and requires `due` when true; an all-day task occupies its due date as a whole, for example a career fair).
- Run: `id`, `command`, `startedAt`, `endedAt`, `steps`, `outcome` (`ok` | `error`), `errorCode?`, `costUsd?`, for agent replies `conversationId` and `turns`, and for sync runs either the historical measured `pages`, `requests`, `failures` and per-source `coverage`, or, for agent jobs, `turns` without a conversation, `syncOutcome` and per-course `courseCoverage`.
- CourseSelection: `key` (normalized code and term), `code`, `name?`, `term` (`YYYY:S1` | `YYYY:S2` | `YYYY:SUMMER` | `YYYY:WINTER`), `pages` (`{ canvas?, ed? }` URLs on the Canvas and Ed origins), `selected?` (absent while undecided), `offeredAt`, `decidedAt?`.
- SyncJob: `id`, `startedAt`, `endedAt?`, `courses` (selected keys), `submissions` (per course key, a count), `outcome?`.

#### Scenario: Unknown enum value
- **WHEN** a SourceItem with `platform: "moodle"` or `platform: "ical"` is parsed
- **THEN** parsing fails and the error names the `platform` path

#### Scenario: Agent estimate without a reason
- **WHEN** an Estimate with origin `agent` and no reason is parsed
- **THEN** parsing fails and the error names the `reason` path

#### Scenario: Level out of range
- **WHEN** a CourseAutonomy with `defaultLevel: 3` is parsed
- **THEN** parsing fails and the error names the `defaultLevel` path

#### Scenario: Agent annotation without a citation
- **WHEN** an Annotation with origin `agent` and no citations is parsed
- **THEN** parsing fails and the error names the `citations` path

### Requirement: Modules are user-defined and delivery-type
A Module SHALL have an id, a name, a glyph, and a flag saying whether it is fed automatically by coursework sources. Module progress SHALL equal completed steps divided by all steps of its non-recurring tasks (decision #31).

#### Scenario: Progress of a module
- **WHEN** a module has two non-recurring tasks with 1 of 2 and 2 of 3 steps done, plus one recurring task
- **THEN** its progress is 3/5 and the recurring task does not count

#### Scenario: Module with no counted steps
- **WHEN** a module has no non-recurring tasks
- **THEN** its progress is 0, not NaN

### Requirement: Assessments carry weight, score, and hurdle floor
An Assessment SHALL belong to a Course and MAY carry a kind (`quiz`, `ongoing`, `assignment`, `exam`) and a weight in percent (0–100); an absent kind or weight means unknown and MUST NOT be read as non-exam or zero. It carries an optional score in percent (0–100), an optional due date, an optional `hurdleMin` in percent, and a flag marking the final exam. The weights of one course's assessments MUST all be known and sum to 100 when the course has `assessmentsComplete: true`. A course MUST have at most one assessment with `isFinal: true`.

#### Scenario: Weight out of range
- **WHEN** an assessment with weight 120 is parsed
- **THEN** parsing fails

#### Scenario: Course weights do not add up
- **WHEN** a course with `assessmentsComplete: true` has assessment weights summing to 95, or one weight unknown
- **THEN** validation fails with a message naming the course and the problem

#### Scenario: Two finals
- **WHEN** a course has two assessments with `isFinal: true`
- **THEN** validation fails

### Requirement: Grade projection
The system SHALL compute, for a course: the graded weight, earned points, the current average over graded items, and the final-exam score needed to reach a target band. Ungraded non-final items SHALL be assumed to score the current average. Bands are H1 80, H2A 75, H2B 70, H3 65, P 50.
The result's `need` SHALL be one of: `{ status: "score", value, setByHurdle }`, `{ status: "unreachable" }`, `{ status: "secured" }`, or `{ status: "unavailable", reason }` with reason `weights_unknown`, `nothing_graded`, `no_final`, or `final_graded`. Order of evaluation: first the `unavailable` checks in this order, the first match wins: `weights_unknown` (any assessment of the course has an unknown weight), then `nothing_graded`, then `no_final`, then `final_graded`; then compute the raw need; if it is above 100 the status is `unreachable`; otherwise, if the final has `hurdleMin`, the value is `max(raw, hurdleMin)` and `setByHurdle` is true when the floor won (this applies even when raw ≤ 0); otherwise raw ≤ 0 is `secured`. Values are not rounded; tests compare to one decimal place.

#### Scenario: Needed final score
- **WHEN** graded items are 10% at 82, 15% at 88, and 10% at 74, an ungraded 25% assignment exists, the final is 40%, and the target is H1
- **THEN** earned is 28.8, the current average is 82.29 (to two decimals), and the needed final score is 76.6 (to one decimal)

#### Scenario: Hurdle sets the floor
- **WHEN** the same course has a final with `hurdleMin` 40, the assignment is graded 60, and the target is P
- **THEN** the needed final score is 40 and the result marks that the hurdle set it

#### Scenario: Out of reach and secured
- **WHEN** the raw need is above 100, or at most 0 for a final without `hurdleMin`
- **THEN** the status is `unreachable` or `secured` respectively

#### Scenario: Hurdle beats secured
- **WHEN** the raw need is at most 0 and the final has `hurdleMin` 50
- **THEN** the status is `score` with value 50 and `setByHurdle` true

#### Scenario: Unknown weight
- **WHEN** one assessment of a course has no known weight
- **THEN** the need is `unavailable` with reason `weights_unknown`

#### Scenario: Nothing graded yet
- **WHEN** a course with known weights has no graded items
- **THEN** the current average is null and the need is `unavailable` with reason `nothing_graded`

#### Scenario: No final or final already graded
- **WHEN** a course has no final, or its final already has a score
- **THEN** the need is `unavailable` with reason `no_final` or `final_graded`

### Requirement: Tasks have steps, citations, and recurrence
A Task SHALL belong to a Module, optionally to a Course and an Assessment, and SHALL have one or more steps with an estimate in minutes and a done flag. A Task with `source: "coursework"` SHALL carry, on each step, at least one citation `{ sourceItemId, quote, locator }`. A manual Task SHALL carry no citations. A Task MAY repeat `daily` or `weekly`; a recurring Task has no due date.

#### Scenario: Coursework step without a citation
- **WHEN** a Task whose source is `coursework` has a step with no citation
- **THEN** validation fails

#### Scenario: Recurring task with a due date
- **WHEN** a Task has `repeat: "daily"` and a due date
- **THEN** validation fails

### Requirement: Runs are recorded with measurements
A Run SHALL record the command, start and end time, step count, outcome, and an optional cost reported by the caller. Historical API sync runs record measured nonnegative integer `pages`, `requests` and `failures` and per-source `coverage` entries (provider, opaque scope reference, collection, planned/attempted/completed/skipped/failed/not-started counts and sanitized outcome codes) and SHALL stay readable. Agent sync runs SHALL record `turns` (without a `conversationId`), a `syncOutcome` (`OK` | `PARTIAL` | `NEEDS_SELECTION` | `AGENT_UNAVAILABLE` | `TIMEOUT` | `FAILED`) and per-course `courseCoverage` entries (opaque course reference, stored, submissions, unknown field count, platforms read or blocked, AI policy changed). Runs without measurements SHALL stay readable without backfilled values. Coverage MUST NOT contain URLs, course titles, names, quotes or free-form errors.

#### Scenario: Invalid metrics
- **WHEN** a synthetic sync Run has a negative count or a coverage entry with a raw URL
- **THEN** validation refuses it rather than storing false metrics

#### Scenario: Historical run
- **WHEN** a historical Run without measurements is read
- **THEN** it is returned without invented counts

#### Scenario: Agent sync run
- **WHEN** an agent sync Run with `turns` 12, no conversation and `syncOutcome` `PARTIAL` is parsed
- **THEN** it is valid and its course coverage holds counts and platform states only

