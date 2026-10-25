## MODIFIED Requirements

### Requirement: Entity fields
The schemas SHALL contain at least these fields (ids are non-empty strings; times are ISO 8601 strings):
- Module: `id`, `name`, `glyph`, `auto` (fed by coursework sources).
- Course: `id`, `moduleId`, `code`, `name`, `term`, `assessmentsComplete`, `sources` (array of `{ platform: canvas | ed, externalId }`, may be empty for manual courses), `aiPolicy?` (the agent-read policy: `allowed` | `prohibited` | `owner-attested`; absent means unknown), `readState?` (per field: `state`, `via?`, `checkedAt?`, `quote?`, `source?`).
- Assessment: `id`, `courseId`, `name`, `kind?` (`quiz` | `ongoing` | `assignment` | `exam`; absent means unknown), `weight?` (absent means unknown), `score?`, `due?`, `hurdleMin?`, `isFinal`, `status` (`not_started` | `in_progress` | `submitted` | `graded`), `origin` (`sync` | `agent` | `owner`), `group?` (`{ key, name, weight?, count?, role? }`, the grading component an assessment belongs to; `role` is `item`, `remainder` or `component`), `retired?` (true when no longer listed or replaced by its items; reads omit retired assessments), `readState?` (per field, as for Course; `state` may be `derived` for an evenly split weight).
- SourceItem: `id`, `platform` (`canvas` | `ed` | `manual`), `externalId`, `courseId?`, `kind` (`assignment` | `announcement` | `material` | `post` | `event`), `title`, `url?`, `text` (as recorded, not redacted; #191), `contentHash`, `fetchedAt`, `removed` (boolean), `copiedBy?` (`agent` when the text was recorded by the agent with `source.record`), `facts?` (`{ due?, pointsPossible?, pointsEarned?, submitted? }`, only for kind `assignment`).
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

