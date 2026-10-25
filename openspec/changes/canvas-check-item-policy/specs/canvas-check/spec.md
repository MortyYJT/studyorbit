## ADDED Requirements

### Requirement: Check step after each Canvas course import
The course reading job SHALL ask the agent, after `course.import` returns `ok` for a course whose Canvas platform is `read` and whose Course has a Canvas source id, to open in its own Edge tab the one fixed URL `https://canvas.lms.unimelb.edu.au/api/v1/courses/{id}/assignment_groups?include[]=assignments&include[]=submission&per_page=100`, where `{id}` is that Canvas source id, select the whole page, copy it, and then call the agent command `canvas.check` with the job id and the course key (#193, #198). `canvas.check` SHALL read the copied text from the system clipboard itself; the agent SHALL NOT pass the page text as a tool argument. The check SHALL be read-only on Canvas and SHALL NOT fail the run. Each course's check coverage in the run SHALL be `checked` when an input was accepted, `partial` when an accepted input held exactly 100 groups, `unavailable` when the command refused every input for that course in this job, and `not_run` when the course was not eligible or the agent never called the command.

#### Scenario: Check runs after import
- **WHEN** the agent imports a Canvas course with Canvas id 12345, opens the fixed URL for 12345, copies the page and calls `canvas.check`
- **THEN** the command reads the clipboard, compares the values, returns `ok` with the counts of compared fields, open conflicts and Canvas assignments missing from the read, and the course's coverage is `checked`

#### Scenario: Sign-in page instead of JSON
- **WHEN** the copied text is a Canvas sign-in page and the agent does not get an accepted copy afterwards
- **THEN** `canvas.check` returns `INVALID_INPUT` saying the page is not the expected JSON, nothing is stored, and the course's coverage is `unavailable`

#### Scenario: Course without Canvas
- **WHEN** the imported document reports Canvas `absent` or `blocked`
- **THEN** the job does not ask for a check of that course and its coverage is `not_run`

### Requirement: Accepted check input
`canvas.check` SHALL accept the clipboard text only when, after removing any text before the first `[` (such as a `while(1);` prefix or a JSON viewer label), it parses as a JSON array of at most 100 assignment groups, each with a numeric `id`, a `name`, a numeric `group_weight` and an `assignments` array, and each assignment with a numeric `id`, a `name`, a numeric `course_id`, `due_at` (ISO time or `null`), `points_possible` (number or `null`), `assignment_group_id` and an optional `submission` with `workflow_state` and `score` (number or `null`). Every assignment's `course_id` SHALL equal the Course's Canvas source id, so a page of another course is refused. Text over 5 MB SHALL be refused. A refused input SHALL return `INVALID_INPUT` asking the agent to copy the page again and SHALL store nothing; the raw text SHALL NOT be stored, logged or returned.

#### Scenario: Wrong course copied
- **WHEN** the copied JSON lists assignments whose `course_id` is 999 for a course whose Canvas id is 12345
- **THEN** the input is refused with `INVALID_INPUT` and nothing is stored

#### Scenario: Prefix removed
- **WHEN** the copied text starts with `while(1);` followed by a valid array
- **THEN** the array is parsed and checked

#### Scenario: Unknown keys ignored
- **WHEN** an assignment has extra keys such as `description` or `rubric`
- **THEN** they are ignored and not stored

#### Scenario: Full page
- **WHEN** an accepted input holds exactly 100 groups
- **THEN** the comparison runs and the course's coverage is `partial`

### Requirement: Compared fields
The check SHALL compare the agent's own read, as the last import stored it in each item's SourceItem facts (never annotations or values the owner took from Canvas), with Canvas. For each item whose key is `<CODE>:canvas:assignment:<id>` and whose `<id>` matches a Canvas assignment: `due` (facts `due`) with `due_at`, equal to the minute; `outOf` (facts `pointsPossible`) with `points_possible`; `score` (facts `pointsEarned`) with `submission.score`; and `submitted` (facts `submitted`) with `submission.workflow_state`, where `submitted`, `pending_review` and `graded` mean true and `unsubmitted` means false. A Canvas value of `null`, or a missing submission, SHALL give no comparison for that field. An agent value that is missing while Canvas has a value SHALL be a conflict. For each grading component whose stored items with Canvas ids all belong to one assignment group, and whose group holds no Canvas assignment listed under another component, the check SHALL compare the component weight stored by the last import from the document with `group_weight`; when every group weight of the course is 0 the course is treated as unweighted and no weight is compared. Canvas assignments that match no stored item SHALL be reported as missing from the read.

#### Scenario: Due date differs
- **WHEN** the agent read an item due 2026-10-30T23:59+11:00 and Canvas says 2026-10-31T23:59+11:00
- **THEN** a `due` conflict holds both values

#### Scenario: Agent missed a weight
- **WHEN** a component's weight is stored as unknown and its items all sit in a Canvas group of weight 45
- **THEN** a `weight` conflict holds unknown and 45

#### Scenario: Submission state
- **WHEN** the agent read `in_progress` (not submitted) and Canvas says `unsubmitted`
- **THEN** no `submitted` conflict is recorded

#### Scenario: Unweighted course
- **WHEN** every assignment group of the course has `group_weight` 0
- **THEN** no component weight is compared

#### Scenario: Assignments missing from the read
- **WHEN** Canvas lists three assignments that match no stored item
- **THEN** the result and "needs you" list them by name and due date as missing from the read, and no assessment is created

### Requirement: Check conflicts and owner resolution
Each mismatch SHALL be stored as one open check conflict per course, target and field: the target is an item's Canvas assignment id for `due`, `outOf`, `score`, `submitted` and `presence` (a Canvas assignment missing from the read), and a component key for `weight`. A conflict SHALL hold the agent value, the Canvas value and the check time. A later check whose values agree SHALL close an open conflict as `agreed`; a later check with a different Canvas or agent value SHALL update it or open a new one. The owner SHALL resolve a conflict only through the frontend's owner session with the owner command `check.resolve` (`agent` or `canvas`); agents SHALL have no command that resolves, dismisses or changes conflicts (#194). Choosing `canvas` SHALL make the Canvas value an owner value (#198): for `due` on an item that has its own Assessment, it SHALL record an owner annotation on that Assessment, effective at once; for `outOf`, `score` and `submitted` on an item with its own Assessment, it SHALL recompute that Assessment's score (as a percentage) and status with the Canvas value at once; in every other case (items folded into a component Assessment, component `weight`) it SHALL be applied by the importer from the next import on. While the conflict stays resolved with the same Canvas value, later imports SHALL keep applying it; SourceItem facts SHALL keep the agent's read, so later checks still compare the agent's own read. Choosing `agent` SHALL close the conflict, and later checks with the same pair of values SHALL NOT reopen it. A `presence` conflict SHALL accept only `agent` (dismiss).

#### Scenario: Owner takes the Canvas due date
- **WHEN** the owner resolves a `due` conflict of an item with its own Assessment with `canvas`
- **THEN** an owner annotation sets the Canvas due date, the conflict is resolved, and planning uses the Canvas date at once

#### Scenario: Owner takes the Canvas score
- **WHEN** an item's facts say 8 of 10, Canvas says 9 of 10, and the owner resolves the `score` conflict with `canvas`
- **THEN** the item's Assessment score becomes 90% at once, its facts still say 8, and the next import keeps 90% while Canvas still says 9

#### Scenario: Owner keeps the agent value
- **WHEN** the owner resolves a `score` conflict with `agent` and the next check finds the same two values
- **THEN** the conflict stays resolved and is not shown again

#### Scenario: Agent cannot resolve
- **WHEN** an agent calls `check.resolve` through MCP, the CLI or HTTP without the owner session
- **THEN** it is refused and nothing changes

#### Scenario: Values later agree
- **WHEN** an open `due` conflict exists and the next import reads the Canvas date
- **THEN** the next check closes the conflict as `agreed`

### Requirement: Unconfirmed values in reads
While a check conflict is open, assessment and course reads SHALL mark the field as unconfirmed and return both values; planning, the grade projection and views SHALL keep using the stored agent value until the owner resolves it (#194).

#### Scenario: Open conflict in a read
- **WHEN** an item has an open `due` conflict
- **THEN** `assessments.list` returns the agent due date as the effective value, marked unconfirmed, with the Canvas due date beside it
