## ADDED Requirements

### Requirement: Owner availability settings
The store SHALL hold one owner-editable planning settings record: time zone (default `Australia/Melbourne`), available minutes for each weekday, teaching-week anchor date and break weeks. Settings SHALL be validated before saving and changed only through the frontend's owner session or a TTY, never by an agent.

#### Scenario: Invalid minutes
- **WHEN** the owner sets Monday to -30 minutes
- **THEN** the save is rejected and the previous settings remain

#### Scenario: Agent tries to change settings
- **WHEN** an agent calls the settings command through MCP
- **THEN** it receives a safe refusal and the settings are unchanged

### Requirement: Plannable work
Plannable work SHALL be: every unsubmitted, not-removed assessment of the current term that is not an exam, every unfinished step of a stored task, and every unfinished manual task (#132). Each work item carries an id, a title, its course (if any), a due time (if any), an estimate in minutes (if any) and the estimate's origin. An exam SHALL appear only as a deadline in the week view, not as plannable work.

#### Scenario: Submitted work drops out
- **WHEN** a platform item linked to an assessment reports `submitted: true`
- **THEN** that assessment is no longer plannable work

### Requirement: Estimates with reasons
An agent SHALL be able to record an estimate in minutes for a work item with a short reason based on the item's requirements (#131). The owner SHALL be able to replace it from the frontend; the owner's estimate wins over the agent's. Reads SHALL return the effective estimate with its origin and the agent's reason. An item without an estimate SHALL stay unestimated; no default duration is guessed.

#### Scenario: Owner overrides the agent
- **WHEN** the agent estimated 240 minutes with a reason and the owner sets 180
- **THEN** the plan uses 180 with origin `owner`, and the agent's estimate and reason remain readable

### Requirement: Manual tasks
The owner SHALL be able to add, edit, complete and delete off-campus tasks from the frontend with a title, an optional due date and an optional estimate (#132). Manual tasks SHALL be planned together with coursework and SHALL NOT be created or changed by an agent.

#### Scenario: Manual task in the plan
- **WHEN** the owner adds "Internship application", due Friday, 120 minutes
- **THEN** the next plan allocates those minutes alongside assessments in deadline order

### Requirement: Day-granular earliest-deadline-first plan
A pure planning function SHALL take explicit inputs (settings, a start date, a horizon in days, plannable work with effective estimates) and SHALL assign minutes to days, not to clock times (#145), in earliest-deadline-first order, filling each day up to its available minutes. Work MAY split across days. Overdue work SHALL come first and undated work last. Ties SHALL break by a stable id order. Identical inputs SHALL produce identical plans. Work that does not fit before its deadline SHALL stay in the output as overflow with the missing minutes; no work SHALL disappear. Unestimated work SHALL be listed as unestimated and take no minutes. Day boundaries SHALL use the settings' time zone. The plan SHALL be exposed as a read command and MUST NOT call a model.

#### Scenario: Overflow is visible
- **WHEN** 180 minutes of work are due in two days and the settings allow 60 minutes per day
- **THEN** 120 minutes are assigned across the two days and 60 minutes are reported as overflow for that item

#### Scenario: Same input, same plan
- **WHEN** the planner runs twice on identical inputs
- **THEN** both plans are identical

#### Scenario: Unestimated item
- **WHEN** an assessment has a due date but no estimate
- **THEN** it appears as unestimated with its due date and takes no minutes

#### Scenario: Time-zone day boundary
- **WHEN** an item is due at 2026-10-20T13:30Z and the time zone is `Australia/Melbourne`
- **THEN** it counts as due on 2026-10-21, local date

### Requirement: Owner start times order each day
The owner SHALL be able to set or clear a start time for a planned work item on a given day from the frontend. Within one day, items with a start time SHALL be listed by start time, followed by items without one in plan order (#145). Start times SHALL NOT change which day the planner assigns minutes to; when a later plan moves an item off that day, its start time for that day SHALL be dropped and the item listed as untimed.

#### Scenario: Timed before untimed
- **WHEN** Tuesday has A (no time), B (14:00) and C (09:30)
- **THEN** Tuesday lists C, B, A

### Requirement: Actual time is recorded
The owner SHALL be able to record the minutes actually spent on a work item, any number of times, from the frontend. Reads SHALL return the total actual minutes per item next to its effective estimate, for the estimate-versus-actual metric (#133).

#### Scenario: Two sessions
- **WHEN** the owner records 50 and then 40 minutes on one assessment
- **THEN** its actual total is 90 minutes
