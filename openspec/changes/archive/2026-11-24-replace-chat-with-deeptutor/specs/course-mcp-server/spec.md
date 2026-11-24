## MODIFIED Requirements

### Requirement: Reads the same course files, with an optional filter
On every tool call the server SHALL load courses with the same loader the app uses (`.local/lms/courses.json` in the project and the newest valid course document per course in the Desktop course folders), convert them to display documents and use today's date in the institution's time zone. The project and Desktop directories SHALL default to the repository containing the script and the user's Desktop and MAY be overridden with `--project` and `--desktop`. Only when started with `--page-context` (the registration StudyOrbit writes for DeepTutor), the server SHALL on every tool call also read the page-context file `.local/agent-context.json` of the project; without the flag the file SHALL change nothing. When that file is valid, its selected course IDs that are in the course list SHALL be the scope (a selection naming none of them SHALL narrow nothing), its planning snapshot SHALL be the planning data, and its course in focus SHALL be reported by `list_courses` when that course is in scope and the file was saved less than 30 minutes ago. A comma-separated course ID filter from `--courses` or `STUDYORBIT_COURSES` SHALL narrow the scope further; without a context file and without a filter every listed course is in scope. A missing or invalid context file SHALL mean no planning data and no focus, not an error. A missing course list SHALL produce tool errors, not a crash.

#### Scenario: Course filter
- **WHEN** the server starts with `--courses 101` and the course list has courses 101 and 202
- **THEN** `list_courses` returns only course 101 and `get_assessments` for 202 returns `COURSE_NOT_IN_SCOPE`

#### Scenario: File changed after a sync
- **WHEN** a newer valid course document is written while the server is running
- **THEN** the next tool call uses the newer document

#### Scenario: Other MCP clients
- **WHEN** the context file exists and the server was started without `--page-context`
- **THEN** every listed course is in scope and `plan_schedule` without tasks returns `available: false`

#### Scenario: Page context present
- **WHEN** the server was started with `--page-context` and the context file holds a snapshot with two tasks and selects course 101 of the listed courses 101 and 202
- **THEN** `plan_schedule` without arguments plans those two tasks and `list_courses` returns only course 101

#### Scenario: Page context missing
- **WHEN** there is no context file
- **THEN** `plan_schedule` without tasks returns `available: false` and every listed course is in scope

#### Scenario: Stale focus
- **WHEN** the context file names a course in focus and was saved two hours ago
- **THEN** `list_courses` reports no focus
