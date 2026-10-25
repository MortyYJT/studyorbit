## MODIFIED Requirements

### Requirement: Week view
The home page SHALL show seven columns, Monday to Sunday, for the selected week (#143). Above the columns SHALL be "needs you": platforms the last sync could not read, sync failures, overflow and unestimated work, newly offered courses awaiting the owner's selection (with a dialog to tick them), required fields left unknown after retries, component weights that do not add up to 100, AI policies (course or assessment) the last run read differently, open Canvas check conflicts with the agent value, the Canvas value and buttons to keep either one through the owner session, and Canvas assignments missing from the read with a button to dismiss them. Each day column SHALL show the used and available hours, a top row for that day's deadlines and all-day manual tasks, then that day's planned items ordered as `study-planning` defines, with timed items showing their start time. Overflow work SHALL be listed separately, not dropped. The owner SHALL be able to move between weeks, switch to a month calendar of deadlines (#135), add a manual task, set or clear an item's start time, and record actual time. The right side SHALL list courses with a small ring for graded weight and the next deadline.

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
A course page SHALL show the course's AI policy and its default level, the score ring (#141: one segment per assessment sized by weight, earned / lost / ungraded / unknown-weight styles, earned total in the centre, with legend, current average, progress and the final score needed), and two tabs. The Assessments tab SHALL group assessments by their grading component, showing each component's name, weight and the earned share computed by code, and SHALL list name, due, weight, score, status and effective level per assessment; retired assessments SHALL NOT be shown; exams SHALL show "—" for level and no agent entry (#146). Prohibited courses SHALL show the level locked at L0 (#124); an assessment whose own effective policy is `prohibited` SHALL show its level locked at L0 with the policy's origin, even when the course is not locked. The Revision tab SHALL show the exam time, the cited exam scope, notes, practice statistics, and the "tutor me" and "wrong answers only" buttons (#142).

#### Scenario: Unknown weight in the ring
- **WHEN** one assessment has no effective weight
- **THEN** its segment uses the unknown-weight style and the final-score figure shows it is unavailable because weights are unknown

#### Scenario: Owner changes a level
- **WHEN** the owner sets an assessment's level to L1 on a course whose default is L0
- **THEN** the change is saved through the owner session and the effective level shows L1

#### Scenario: Component group
- **WHEN** a component "Written assignments" of weight 15 has two graded items of derived weight 3.75 each, scored 80% and 100%
- **THEN** the tab shows the group with 15% and 6.75 earned, and each item's weight marked as an even split


### Requirement: Assessment drawer with origins
Clicking an assessment SHALL open a side drawer with its fields, each marked with its origin (platform, agent, or owner) (#138). Clicking an agent marker SHALL show the cited quote, a link to the original page, a note when the cited source text was copied by the agent (`source.record`), and "confirm" and "use my value" (see `agent-annotations`). A field with an open Canvas check conflict SHALL show an "unconfirmed" marker with the Canvas value beside it. The drawer SHALL show the assessment's effective AI policy with its origin and level (assessment or course) and the agent-read quote, and a selector (`allowed`, `prohibited`, `owner-attested`, or clear) that records the owner's assessment policy through the owner session. The drawer SHALL show the effective estimate with its origin and reason, the actual time, the linked platform items, and buttons that open the Agent page with the "complete" or "explain" preset, except for exams.

#### Scenario: Agent value
- **WHEN** the owner opens an assessment whose weight came from an agent annotation
- **THEN** the weight shows the agent marker, and clicking it shows the quote and the source link

#### Scenario: Agent-copied source
- **WHEN** an agent value cites a source recorded with `source.record`
- **THEN** the quote shows that its source text was copied by the agent

#### Scenario: Check conflict in needs you
- **WHEN** an item has an open `due` conflict between 30 October (agent) and 31 October (Canvas)
- **THEN** "needs you" shows both dates with "keep agent" and "use Canvas", and choosing "use Canvas" records it through the owner session and moves the deadline

#### Scenario: Assessment locked by its own policy
- **WHEN** a course reads `allowed` and one of its assessments reads `prohibited`
- **THEN** the course page shows that assessment's level locked at L0 and the course level unlocked

#### Scenario: Owner sets an assessment policy
- **WHEN** the owner picks `allowed` in the drawer of an assessment whose agent-read policy is `prohibited`
- **THEN** the assessment's effective policy shows `allowed` with origin owner, and its level unlocks
