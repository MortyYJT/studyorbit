## MODIFIED Requirements

### Requirement: Course page
A course page SHALL show the course's AI policy and its default level, the score ring (#141: one segment per assessment sized by weight, earned / lost / ungraded / unknown-weight styles, earned total in the centre, with legend, current average, progress and the final score needed), and two tabs. The Assessments tab SHALL group assessments by their grading component, showing each component's name, weight and the earned share computed by code, and SHALL list name, due, weight, score, status and effective level per assessment; retired assessments SHALL NOT be shown; exams SHALL show "—" for level and no agent entry (#146). Prohibited courses SHALL show the level locked at L0 (#124). The Revision tab SHALL show the exam time, the cited exam scope, notes, practice statistics, and the "tutor me" and "wrong answers only" buttons (#142).

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
Clicking an assessment SHALL open a side drawer with its fields, each marked with its origin (platform, agent, or owner) (#138). Clicking an agent marker SHALL show the cited quote, a link to the original page, a note when the cited source text was copied by the agent (`source.record`), and "confirm" and "use my value" (see `agent-annotations`). The drawer SHALL show the effective estimate with its origin and reason, the actual time, the linked platform items, and buttons that open the Agent page with the "complete" or "explain" preset, except for exams.

#### Scenario: Agent value
- **WHEN** the owner opens an assessment whose weight came from an agent annotation
- **THEN** the weight shows the agent marker, and clicking it shows the quote and the source link

#### Scenario: Agent-copied source
- **WHEN** an agent value cites a source recorded with `source.record`
- **THEN** the quote shows that its source text was copied by the agent

### Requirement: One local frontend with an owner session
`coursework ui` SHALL build-check and serve the React frontend from `dist/ui` in the same loopback process as the HTTP transport, bound to `127.0.0.1` with the existing Host/Origin checks, and open it in the owner's system browser, printing the URL if opening fails. At each start it SHALL create a random owner session secret kept only in server memory and pass it to the system browser in the URL fragment; the page SHALL move it into memory (not into browser storage) and remove it from the address bar. Owner commands over HTTP (see `command-registry`) SHALL require this secret; our code SHALL never write it to disk or log it, and it SHALL never be sent to an agent. Restarting the server SHALL invalidate it. The frontend SHALL let the owner change levels, overrides, policies, estimates, start times, manual tasks, actual time, planning settings and owner annotations (#116); it SHALL be the only place for autonomy settings (#122), while the other owner changes are also accepted from a TTY (see `command-registry`).

#### Scenario: Secret not on disk
- **WHEN** the UI server starts with a temporary data directory
- **THEN** no file under that directory or the repository contains the session secret

#### Scenario: Stale page after restart
- **WHEN** the server restarts and the old page sends an owner command
- **THEN** the command is refused and the page tells the owner to reopen it with `coursework ui`

### Requirement: Top bar and avatar menu
The top bar SHALL have two entries, "This week" and "Agent", the sync button with its running state, and an avatar menu with: sync and sign-in status (the platforms Codex could not read, the last sync run with its outcome, the platforms it found blocked, per selected course the time of its last stored document), metrics, audit records, and settings (available hours per weekday, time zone, theme, language) (#142, #160). The interface SHALL support Chinese and English and light, dark and system themes; only "needs you" items use the alert colour (#140).

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

### Requirement: Agent page
The Agent page SHALL list conversations on the left, newest first, and show the open conversation on the right with streamed replies, tool steps with their names and outcomes, failed steps, stop and send (#144). There is no submit-confirmation card: Codex stops before any final submit and asks the owner, who presses it in their own Edge (#173). Arriving from a preset SHALL create the conversation and send its prompt once.

#### Scenario: Confirmation card
- **WHEN** Codex has filled a quiz in the owner's Edge and reaches its final submit button
- **THEN** the conversation shows it asking the owner to review and submit, no card or code path submits, and nothing appears in "needs you"
