# web-ui Specification

## Purpose
TBD - created by archiving change v1-delivery. Update Purpose after archive.
## Requirements
### Requirement: One local frontend with an owner session
`coursework ui` SHALL build-check and serve the React frontend from `dist/ui` in the same loopback process as the HTTP transport, bound to `127.0.0.1` with the existing Host/Origin checks, and open it in the owner's system browser, printing the URL if opening fails. At each start it SHALL create a random owner session secret kept only in server memory and pass it to the system browser in the URL fragment; the page SHALL move it into memory (not into browser storage) and remove it from the address bar. Owner commands over HTTP (see `command-registry`) SHALL require this secret; our code SHALL never write it to disk or log it, and it SHALL never be sent to an agent. Restarting the server SHALL invalidate it. The frontend SHALL let the owner change levels, overrides, policies, estimates, start times, manual tasks, actual time, planning settings and owner annotations (#116); it SHALL be the only place for autonomy settings (#122), while the other owner changes are also accepted from a TTY (see `command-registry`).

#### Scenario: Secret not on disk
- **WHEN** the UI server starts with a temporary data directory
- **THEN** no file under that directory or the repository contains the session secret

#### Scenario: Stale page after restart
- **WHEN** the server restarts and the old page sends an owner command
- **THEN** the command is refused and the page tells the owner to reopen it with `coursework ui`

### Requirement: Real data only
Every view SHALL load data only through the registry's commands over HTTP and SHALL show no built-in sample data. An empty store SHALL show a message that nothing has been synced yet, with the sync button. Values that are unknown (weights, kinds, estimates, exam time) SHALL be shown as unknown, with the time they were last checked when known, never filled with defaults. The only computed stand-in SHALL be an evenly split item weight with state `derived`, labelled as an even split (#171).

#### Scenario: Empty store
- **WHEN** the store is empty
- **THEN** the week view says no data has been synced yet and offers the sync button, with no sample courses

#### Scenario: Derived and unknown labels
- **WHEN** an item's weight is `derived` and another item's due date is unknown, last checked on 24 October
- **THEN** the first shows its weight marked as an even split, and the second shows its due date as unknown, checked 24 October

### Requirement: Top bar and avatar menu
The top bar SHALL have two entries, "This week" and "Agent", the sync button with its running state, and an avatar menu with: sync and sign-in status (the platforms Codex could not read, the last sync run with its outcome, the platforms it found blocked, per selected course the time of its last stored document), metrics, memory (long-term-memory), audit records, and settings (available hours per weekday, time zone, theme, language) (#142, #160). The interface SHALL support Chinese and English and light, dark and system themes; only "needs you" items use the alert colour (#140).

#### Scenario: Sign-in expired
- **WHEN** the last sync run reports Ed blocked by a sign-in page
- **THEN** the status panel shows Ed as not read, and "needs you" asks the owner to sign in to Ed in their Edge or unlock the screen

### Requirement: Week view
The home page SHALL show seven columns, Monday to Sunday, for the selected week (#143). Above the columns SHALL be "needs you": platforms the last sync could not read, sync failures, overflow and unestimated work, newly offered courses awaiting the owner's selection (with a dialog to tick them), required fields left unknown after retries, component weights that do not add up to 100, and AI policies the last run read differently. Each day column SHALL show the used and available hours, a top row for that day's deadlines and all-day manual tasks, then that day's planned items ordered as `study-planning` defines, with timed items showing their start time. Overflow work SHALL be listed separately, not dropped. The owner SHALL be able to move between weeks, switch to a month calendar of deadlines (#135), add a manual task, set or clear an item's start time, and record actual time. The right side SHALL list courses with a small ring for graded weight and the next deadline.

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
A course page SHALL show the course's AI policy and its default level, the score ring (#141, #192: one segment per assessment sized by weight on a recessed groove track, drawn in two colours only, the earned share in yellow and everything else, lost, ungraded or of unknown weight, in white; earned total in the centre, with legend, current average, progress and the final score needed), and two tabs. The Assessments tab SHALL group assessments by their grading component, showing each component's name, weight and the earned share computed by code, and SHALL list name, due, weight, score, status and effective level per assessment (#192): groups SHALL be ordered by kind, ongoing, then quiz, then assignment, then exam, then unknown kind, and items within a group by due time with undated items last; assessments that carry no marks (an effective weight of 0, such as an attendance hurdle or a feedback-only presentation) SHALL be collected in one section at the bottom, collapsed by default; a score SHALL show earned and possible points before the percentage (for example `4/5 · 80%`) when the linked platform item states both, and the percentage alone otherwise; retired assessments SHALL NOT be shown; exams SHALL show "—" for level and no agent entry (#146). Prohibited courses SHALL show the level locked at L0 (#124). The Revision tab SHALL show the exam time, the cited exam scope, notes, practice statistics, and the "tutor me" and "wrong answers only" buttons (#142).

#### Scenario: Unknown weight in the ring
- **WHEN** one assessment has no effective weight
- **THEN** its segment is white like every segment that is not earned, and the final-score figure shows it is unavailable because weights are unknown

#### Scenario: Owner changes a level
- **WHEN** the owner sets an assessment's level to L1 on a course whose default is L0
- **THEN** the change is saved through the owner session and the effective level shows L1

#### Scenario: Component group
- **WHEN** a component "Written assignments" of weight 15 has two graded items of derived weight 3.75 each, scored 80% and 100%
- **THEN** the tab shows the group with 15% and 6.75 earned, and each item's weight marked as an even split

#### Scenario: Order by kind and due time
- **WHEN** a course has an ongoing component, a quiz due 1 May, a quiz due 1 April, an assignment and an exam
- **THEN** the tab lists the ongoing component first, then the 1 April quiz before the 1 May quiz, then the assignment, then the exam

#### Scenario: Items without marks are folded
- **WHEN** a course has an attendance hurdle with weight 0
- **THEN** it appears in a collapsed section at the bottom of the tab and is shown when the owner expands it

#### Scenario: Points and percentage
- **WHEN** a graded quiz's platform item states 4 points earned of 5
- **THEN** its score reads `4/5 · 80%`

### Requirement: Assessment drawer with origins
Clicking an assessment SHALL open a side drawer with its fields, each marked with its origin (platform, agent, or owner) (#138). Clicking an agent marker SHALL show the cited quote, a link to the original page, a note when the cited source text was copied by the agent (`source.record`), and "confirm" and "use my value" (see `agent-annotations`). The drawer SHALL show the effective estimate with its origin and reason, the actual time, the linked platform items, and buttons that open the Agent page with the "complete" or "explain" preset, except for exams.

#### Scenario: Agent value
- **WHEN** the owner opens an assessment whose weight came from an agent annotation
- **THEN** the weight shows the agent marker, and clicking it shows the quote and the source link

#### Scenario: Agent-copied source
- **WHEN** an agent value cites a source recorded with `source.record`
- **THEN** the quote shows that its source text was copied by the agent

### Requirement: Agent page
The Agent page SHALL list conversations on the left, newest first, and show the open conversation on the right with streamed replies, tool steps with their names and outcomes, failed steps, stop and send (#144). There is no submit-confirmation card: Codex stops before any final submit and asks the owner, who presses it in their own Edge (#173). Arriving from a preset SHALL create the conversation and send its prompt once.

#### Scenario: Confirmation card
- **WHEN** Codex has filled a quiz in the owner's Edge and reaches its final submit button
- **THEN** the conversation shows it asking the owner to review and submit, no card or code path submits, and nothing appears in "needs you"

### Requirement: Verified in a real browser
Each page SHALL be checked in a real browser against a synthetic data directory at a narrow (390 px) and a wide (1440 px) width, in light and dark themes, with screenshots attached to the pull request. Frontend logic that is not layout (view models, ordering, ring geometry, owner-session handling) SHALL have unit tests.

#### Scenario: Narrow width
- **WHEN** the week view is opened at 390 px
- **THEN** there is no horizontal page scroll and every day is reachable

### Requirement: Memory panel
The avatar menu SHALL include a "Memory" panel listing live memories newest first with kind, course (or "general"), date, origin (agent or owner) and, for agent memories, a link that opens the source conversation, or "conversation deleted" when it no longer exists. The owner SHALL be able to edit a memory's text and kind, delete it after a confirmation, and add one, through the owner session. Empty state SHALL say that nothing is remembered yet.

#### Scenario: Edit and delete
- **WHEN** the owner edits an agent memory's text and deletes another
- **THEN** the panel shows the new text and no longer shows the deleted memory, and both changes went through the owner session

