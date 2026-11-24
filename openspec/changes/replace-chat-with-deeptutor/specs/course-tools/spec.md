## MODIFIED Requirements

### Requirement: Schedule tool uses planning inputs only when provided
`plan_schedule` SHALL compute the plan with `schedulePlan` (spec `weekly-plan`) from today over every task it is given, keeping each task's own key, and return only the days within the requested window (from `from`, default today, for `days`, default 7, at most 28), optionally only for the given `courseIds`, and the overflow. Filtering MUST apply to the output only, never to the tasks planned. Tasks SHALL come from the `tasks` argument, else the planning snapshot; availability from the argument, else the snapshot, else the default availability; the result SHALL say which source was used and, when the snapshot was used and its save time is known, SHALL include that time as `snapshotSavedAt`. When neither tasks nor a snapshot are available, it SHALL return `available: false` with a reason and no plan.

#### Scenario: Chat with a snapshot
- **WHEN** the snapshot holds a 180-minute task due in two days and availability is 120 minutes a day
- **THEN** the plan places 120 minutes today and 60 minutes tomorrow, with `tasksSource: 'snapshot'`

#### Scenario: Same plan as the weekly page
- **WHEN** the snapshot holds two tasks of different courses due the same day, and `plan_schedule` is called with `courseIds` naming only the second course
- **THEN** the second task's minutes are placed exactly as on the weekly page (ties broken by the page's task keys), and only the second course's entries are returned

#### Scenario: No planning data
- **WHEN** `plan_schedule` is called without `tasks` and the context has no planning snapshot
- **THEN** the result is `available: false` with a reason that says to pass tasks

#### Scenario: Snapshot age
- **WHEN** the plan is computed from a snapshot saved at a known time
- **THEN** the result carries that time as `snapshotSavedAt`

## ADDED Requirements

### Requirement: Course list can name a course in focus
`list_courses` SHALL include `focus` with the ID and code of the course the owner is asking about when the tool context supplies one that is in scope, and SHALL omit `focus` otherwise.

#### Scenario: Focus supplied
- **WHEN** the context names course 101 as in focus and 101 is in scope
- **THEN** the result contains `focus` with course 101's ID and code

#### Scenario: Focus out of scope
- **WHEN** the context names a course that is not in scope
- **THEN** the result has no `focus`
