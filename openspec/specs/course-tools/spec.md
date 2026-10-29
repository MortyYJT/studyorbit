# course-tools Specification

## Purpose
A shared registry of read-only course tools (course and assessment lookup, grade calculation, final needed, upcoming deadlines, schedule) with validated inputs, errors returned as results and a bounded output size.
## Requirements
### Requirement: Shared read-only tool registry
The system SHALL define the course tools once, in a pure module shared by the chat, the Q&A runner and the MCP server. Each tool SHALL have a name matching `^[a-z_]{1,64}$`, a description, a zod input schema and a function of its input and a tool context (`documents` in display shape, known `courses`, `scope`, `today`, optional `planning`). JSON Schemas for providers and MCP SHALL be generated from the zod schemas. Tools MUST NOT write files, change stored data, start a sync, read the clock or use the network, and every call within one reply SHALL see the same documents and date. Tools SHALL read synced course documents only; owner corrections are not applied.

#### Scenario: Six tools are registered
- **WHEN** the registry is listed
- **THEN** it contains `list_courses`, `get_assessments`, `calculate_grades`, `final_needed`, `upcoming_deadlines` and `plan_schedule`, each with a JSON Schema of `type: object`

#### Scenario: Same call, same answer
- **WHEN** the same tool is called twice with the same arguments and context
- **THEN** both results are identical

### Requirement: Inputs are validated and errors are returned as results
The system SHALL parse every tool call's arguments with the tool's schema and SHALL return failures as a result `{ error: { code, message } }` with `ok: false` instead of throwing. Codes SHALL include `UNKNOWN_TOOL`, `INVALID_ARGUMENTS` (listing each issue as `path: message`), `COURSE_NOT_IN_SCOPE` (listing the allowed course IDs), `COURSE_NOT_SYNCED`, `UNKNOWN_ASSESSMENT` and `RESULT_TOO_LARGE`.

#### Scenario: Course outside the chat scope
- **WHEN** `get_assessments` is called with a course ID that is not in the context scope
- **THEN** the result has code `COURSE_NOT_IN_SCOPE` and lists the scope course IDs

#### Scenario: Wrong argument type
- **WHEN** `final_needed` is called with `target: "ninety"`
- **THEN** the result has code `INVALID_ARGUMENTS` and names the `target` path

### Requirement: Course and assessment lookup
`list_courses` SHALL return `today` and, for every scope course, its ID, code, name, term, whether synced data exists, the document version, the number of assessments and the identified weight. `get_assessments` SHALL return a course's assessments (optionally only given IDs or one kind) with ID, parent ID, name, kind, nature, weight, score, maximum score, due date in Melbourne time, status, scoring rule and rule text, and SHALL return an unsourced weight or rule as `null` with `weightUnsourced: true` or `ruleUnsourced: true`.

#### Scenario: Course without synced data
- **WHEN** `list_courses` runs for a scope course that has no valid document
- **THEN** that course is listed with `synced: false`, and `get_assessments` for it returns `COURSE_NOT_SYNCED`

#### Scenario: Unsourced weight
- **WHEN** an assessment has `weight: null` and `unsourced: ['weight']`
- **THEN** `get_assessments` returns it with `weight: null` and `weightUnsourced: true`

### Requirement: Grade calculation tool
`calculate_grades` SHALL compute a course's graded weight, earned points, average and remaining weight with `calculateGrades` on the same grading inputs the chat context uses, and SHALL list each counted item with its earned points and each excluded item with a reason (`bonus`, `ungraded`, `alternative`, `zero-weight`, `no-mark`, `incomplete-group`). The counted items' earned points and weights MUST sum to the totals. An optional `whatIf` list of `{ assessmentId, percent }` SHALL apply hypothetical marks to a copy of the inputs only, and every entry SHALL be reported in `whatIfApplied` with `effect: 'counted'` when the item or its group is counted after applying, or `effect: 'none'` with a reason (`no-weight`, `parent-score-overrides`, `group-incomplete`, or the item's exclusion reason) when it cannot change the total.

#### Scenario: Points group and a leaf item
- **WHEN** a course has a 20% assessment scored 15/20 and a 30% `points` group whose two children scored 8/10 and 6/10
- **THEN** the result has graded weight 50, earned 36 and average 72, and both the assessment and the group are listed as counted

#### Scenario: What-if on the exam
- **WHEN** `whatIf` sets the 50% exam (maximum score 100) to 70 percent on that course
- **THEN** the result has graded weight 100 and earned 71, and no stored data changes

#### Scenario: What-if that cannot change the total
- **WHEN** `whatIf` sets a child of a group whose parent has its own score, or an item with no weight outside any weighted group
- **THEN** the totals are unchanged and `whatIfApplied` lists that entry with `effect: 'none'` and reason `parent-score-overrides` or `no-weight`

#### Scenario: What-if on a bonus item
- **WHEN** `whatIf` names a bonus assessment
- **THEN** the result has code `INVALID_ARGUMENTS`

### Requirement: Final-needed tool
`final_needed` SHALL return the result of `finalNeeded` (spec `grade-target`) for a course and a target given as a band name or a percentage, with the target's source: `argument`, `saved` (the band saved for that course in the planning snapshot) or `default` (H1, as on the course page). It SHALL also return earned points, graded weight, remaining weight and the weight not identified by any assessment, and SHALL accept the same `whatIf` list as `calculate_grades`.

#### Scenario: Saved target used
- **WHEN** the planning snapshot saves H2A for the course and no target is given, with 40% graded and 30 earned
- **THEN** the result is reachable, the needed average is 75, and the target source is `saved`

#### Scenario: Nothing saved, nothing given
- **WHEN** there is no planning snapshot and no target
- **THEN** the target is H1 with source `default`

### Requirement: Upcoming deadlines tool
`upcoming_deadlines` SHALL list assessments of scope courses (or the given course IDs) due from today through today plus `days − 1` (default 14, at most 120), sorted by due date, excluding submitted and graded items unless `includeDone` is true, at most 50 items.

#### Scenario: Submitted item hidden
- **WHEN** an assessment due tomorrow has status `submitted`
- **THEN** it is not listed unless `includeDone` is true

### Requirement: Schedule tool uses planning inputs only when provided
`plan_schedule` SHALL compute the plan with `schedulePlan` (spec `weekly-plan`) from today over every task it is given, keeping each task's own key, and return only the days within the requested window (from `from`, default today, for `days`, default 7, at most 28), optionally only for the given `courseIds`, and the overflow. Filtering MUST apply to the output only, never to the tasks planned. Tasks SHALL come from the `tasks` argument, else the planning snapshot; availability from the argument, else the snapshot, else the default availability; the result SHALL say which source was used. When neither tasks nor a snapshot are available, it SHALL return `available: false` with a reason and no plan.

#### Scenario: Chat with a snapshot
- **WHEN** the snapshot holds a 180-minute task due in two days and availability is 120 minutes a day
- **THEN** the plan places 120 minutes today and 60 minutes tomorrow, with `tasksSource: 'snapshot'`

#### Scenario: Same plan as the weekly page
- **WHEN** the snapshot holds two tasks of different courses due the same day, and `plan_schedule` is called with `courseIds` naming only the second course
- **THEN** the second task's minutes are placed exactly as on the weekly page (ties broken by the page's task keys), and only the second course's entries are returned

#### Scenario: No planning data
- **WHEN** `plan_schedule` is called without `tasks` and the context has no planning snapshot
- **THEN** the result is `available: false` with a reason that says to pass tasks

### Requirement: Tool output size limit
Every tool result SHALL have its numbers rounded to two decimals and its serialised text SHALL be at most 8 000 characters. A larger result SHALL have its largest list cut and carry `truncated: { field, shown, total, hint }`; if it still does not fit, the result SHALL be `RESULT_TOO_LARGE`.

#### Scenario: Large course
- **WHEN** `get_assessments` would return more than 8 000 characters
- **THEN** the assessment list is shortened, `truncated.total` gives the full count and the hint suggests passing `ids` or `kind`

