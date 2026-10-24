## ADDED Requirements

### Requirement: One local frontend with an owner session
`coursework ui` SHALL build-check and serve the React frontend from `dist/ui` in the same loopback process as the HTTP transport, bound to `127.0.0.1` with the existing Host/Origin checks, and open it in the owner's system browser, printing the URL if opening fails. At each start it SHALL create a random owner session secret kept only in server memory and pass it to the system browser in the URL fragment; the page SHALL move it into memory (not into browser storage) and remove it from the address bar. Owner commands over HTTP (see `command-registry`) SHALL require this secret; our code SHALL never write it to disk or log it, and it SHALL never be sent to an agent, or accepted from the resident browser. Restarting the server SHALL invalidate it. The frontend SHALL let the owner change levels, overrides, policies, confirmation switches, estimates, start times, manual tasks, actual time, planning settings and owner annotations (#116); it SHALL be the only place for autonomy settings and submit confirmations (#122), while the other owner changes are also accepted from a TTY (see `command-registry`).

#### Scenario: Secret not on disk
- **WHEN** the UI server starts with a temporary data directory
- **THEN** no file under that directory or the repository contains the session secret

#### Scenario: Stale page after restart
- **WHEN** the server restarts and the old page sends an owner command
- **THEN** the command is refused and the page tells the owner to reopen it with `coursework ui`

### Requirement: Real data only
Every view SHALL load data only through the registry's commands over HTTP and SHALL show no built-in sample data. An empty store SHALL show a message that nothing has been synced yet, with the sync button. Values that are unknown (weights, kinds, estimates, exam time) SHALL be shown as unknown, never filled with defaults.

#### Scenario: Empty store
- **WHEN** the store is empty
- **THEN** the week view says no data has been synced yet and offers the sync button, with no sample courses

### Requirement: Top bar and avatar menu
The top bar SHALL have two entries, "This week" and "Agent", the sync button with its running state, and an avatar menu with: sync and sign-in status (per-site sign-in state, last sync per provider, a button that brings the resident browser's sign-in page to the front by calling `POST /api/browser.signin` with `{ site: canvas | ed }` and the frontend's owner session in `X-Coursework-Session`), metrics, audit records, and settings (available hours per weekday, time zone, theme, language) (#142, #160). The button SHALL use the owner command defined in `command-registry`; K1 owns the frontend wiring. The interface SHALL support Chinese and English and light, dark and system themes; only "needs you" items use the alert colour (#140).

#### Scenario: Sign-in expired
- **WHEN** `browser.status` reports Ed signed out
- **THEN** the status panel shows Ed as expired, and "needs you" shows a sign-in item

### Requirement: Week view
The home page SHALL show seven columns, Monday to Sunday, for the selected week (#143). Above the columns SHALL be "needs you": pending submit confirmations, expired sign-ins, sync failures, overflow and unestimated work. Each day column SHALL show the used and available hours, a top row for that day's deadlines and all-day manual tasks, then that day's planned items ordered as `study-planning` defines, with timed items showing their start time. Overflow work SHALL be listed separately, not dropped. The owner SHALL be able to move between weeks, switch to a month calendar of deadlines (#135), add a manual task, set or clear an item's start time, and record actual time. The right side SHALL list courses with a small ring for graded weight and the next deadline.

#### Scenario: Deadline row
- **WHEN** an assessment is due Wednesday at 23:59 and has 60 planned minutes on Monday
- **THEN** it appears in Wednesday's deadline row and as a 60-minute item on Monday

#### Scenario: Overflow
- **WHEN** the plan reports 90 overflow minutes for an assessment
- **THEN** "needs you" and the overflow list show it with the missing time

### Requirement: Course page
A course page SHALL show the course's AI policy and its default level with the per-course confirm-before-submit switch, the score ring (#141: one segment per assessment sized by weight, earned / lost / ungraded / unknown-weight styles, earned total in the centre, with legend, current average, progress and the final score needed), and two tabs. The Assessments tab SHALL list name, due, weight, score, status and effective level per assessment; exams SHALL show "—" for level and no agent entry (#146). Prohibited courses SHALL show the level locked at L0 (#124). The Revision tab SHALL show the exam time, the cited exam scope, notes, practice statistics, and the "tutor me" and "wrong answers only" buttons (#142).

#### Scenario: Unknown weight in the ring
- **WHEN** one assessment has no effective weight
- **THEN** its segment uses the unknown-weight style and the final-score figure shows it is unavailable because weights are unknown

#### Scenario: Owner changes a level
- **WHEN** the owner sets an assessment's level to L1 on a course whose default is L0
- **THEN** the change is saved through the owner session and the effective level shows L1

### Requirement: Assessment drawer with origins
Clicking an assessment SHALL open a side drawer with its fields, each marked with its origin (platform, agent, or owner) (#138). Clicking an agent marker SHALL show the cited quote, a link to the original page, and "confirm" and "use my value" (see `agent-annotations`). The drawer SHALL show the effective estimate with its origin and reason, the actual time, the linked platform items, and buttons that open the Agent page with the "complete" or "explain" preset, except for exams.

#### Scenario: Agent value
- **WHEN** the owner opens an assessment whose weight came from an agent annotation
- **THEN** the weight shows the agent marker, and clicking it shows the quote and the source link

### Requirement: Agent page
The Agent page SHALL list conversations on the left, newest first, and show the open conversation on the right with streamed replies, tool steps (expandable screenshots, "view in Edge"), denied steps, stop and send (#144). A pending submit confirmation SHALL appear as a card with the agent's answer summary, the screenshot and "confirm submit" and "cancel" buttons (#137). Arriving from a preset SHALL create the conversation and send its prompt once.

#### Scenario: Confirmation card
- **WHEN** the agent calls `browser.submit` on a course that requires confirmation
- **THEN** the card appears in the conversation and in "needs you", and the submit happens only after "confirm submit"

### Requirement: Verified in a real browser
Each page SHALL be checked in a real browser against a synthetic data directory at a narrow (390 px) and a wide (1440 px) width, in light and dark themes, with screenshots attached to the pull request. Frontend logic that is not layout (view models, ordering, ring geometry, owner-session handling) SHALL have unit tests.

#### Scenario: Narrow width
- **WHEN** the week view is opened at 390 px
- **THEN** there is no horizontal page scroll and every day is reachable
