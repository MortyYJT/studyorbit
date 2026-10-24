## MODIFIED Requirements

### Requirement: Real data only
Every view SHALL load data only through the registry's commands over HTTP and SHALL show no built-in sample data. An empty store SHALL show a message that nothing has been synced yet, with the sync button. Values that are unknown (weights, kinds, estimates, exam time) SHALL be shown as unknown, with the time they were last checked when known, never filled with defaults. The only computed stand-in SHALL be an evenly split item weight with state `derived`, labelled as an even split (#171).

#### Scenario: Empty store
- **WHEN** the store is empty
- **THEN** the week view says no data has been synced yet and offers the sync button, with no sample courses

#### Scenario: Derived and unknown labels
- **WHEN** an item's weight is `derived` and another item's due date is unknown, last checked on 24 October
- **THEN** the first shows its weight marked as an even split, and the second shows its due date as unknown, checked 24 October

### Requirement: Week view
The home page SHALL show seven columns, Monday to Sunday, for the selected week (#143). Above the columns SHALL be "needs you": pending submit confirmations, expired sign-ins, sync failures, overflow and unestimated work, newly offered courses awaiting the owner's selection (with a dialog to tick them), required fields left unknown after retries, component weights that do not add up to 100, and AI policies the last run read differently. Each day column SHALL show the used and available hours, a top row for that day's deadlines and all-day manual tasks, then that day's planned items ordered as `study-planning` defines, with timed items showing their start time. Overflow work SHALL be listed separately, not dropped. The owner SHALL be able to move between weeks, switch to a month calendar of deadlines (#135), add a manual task, set or clear an item's start time, and record actual time. The right side SHALL list courses with a small ring for graded weight and the next deadline.

#### Scenario: Deadline row
- **WHEN** an assessment is due Wednesday at 23:59 and has 60 planned minutes on Monday
- **THEN** it appears in Wednesday's deadline row and as a 60-minute item on Monday

#### Scenario: Overflow
- **WHEN** the plan reports 90 overflow minutes for an assessment
- **THEN** "needs you" and the overflow list show it with the missing time

#### Scenario: Choose courses
- **WHEN** the last run ended with `NEEDS_SELECTION` and three undecided candidates
- **THEN** "needs you" offers a dialog listing them with checkboxes, and saving it records the selection through the owner session

### Requirement: Course page
A course page SHALL show the course's AI policy and its default level with the per-course confirm-before-submit switch, the score ring (#141: one segment per assessment sized by weight, earned / lost / ungraded / unknown-weight styles, earned total in the centre, with legend, current average, progress and the final score needed), and two tabs. The Assessments tab SHALL group assessments by their grading component, showing each component's name, weight and the earned share computed by code, and SHALL list name, due, weight, score, status and effective level per assessment; retired assessments SHALL NOT be shown; exams SHALL show "—" for level and no agent entry (#146). Prohibited courses SHALL show the level locked at L0 (#124). The Revision tab SHALL show the exam time, the cited exam scope, notes, practice statistics, and the "tutor me" and "wrong answers only" buttons (#142).

#### Scenario: Unknown weight in the ring
- **WHEN** one assessment has no effective weight
- **THEN** its segment uses the unknown-weight style and the final-score figure shows it is unavailable because weights are unknown

#### Scenario: Owner changes a level
- **WHEN** the owner sets an assessment's level to L1 on a course whose default is L0
- **THEN** the change is saved through the owner session and the effective level shows L1

#### Scenario: Component group
- **WHEN** a component "Written assignments" of weight 15 has two graded items of derived weight 3.75 each, scored 80% and 100%
- **THEN** the tab shows the group with 15% and 6.75 earned, and each item's weight marked as an even split
