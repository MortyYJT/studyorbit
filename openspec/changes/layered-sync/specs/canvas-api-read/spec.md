## ADDED Requirements

### Requirement: Canvas API pages are captured through the clipboard
To read a Canvas API page, a sync job SHALL tell the agent to open exactly one fixed URL in its own Edge window, select the whole page, copy it, and call the agent command `canvas.capture` with the job id, the course key (absent for the course list) and the page kind. The URLs SHALL be, with `{id}` the Course's Canvas source id: `courses` = `https://canvas.lms.unimelb.edu.au/api/v1/courses?enrollment_state=active&include[]=term&per_page=100`; `tabs` = `https://canvas.lms.unimelb.edu.au/api/v1/courses/{id}/tabs`; `groups` = `https://canvas.lms.unimelb.edu.au/api/v1/courses/{id}/assignment_groups?include[]=assignments&include[]=submission&per_page=100` (#193, #198, #208). `canvas.capture` SHALL read the copied text from the system clipboard itself through one injectable reader; the agent SHALL NOT pass page text as a tool argument. Code SHALL read no cookie and use no token. Capturing SHALL be read-only on Canvas.

#### Scenario: Groups captured
- **WHEN** the agent opens the `groups` URL for Canvas course 12345, copies the page and calls `canvas.capture` with page `groups`
- **THEN** the command reads the clipboard, parses it, stores the values it sets, and returns `ok` with the number of groups and assignments

#### Scenario: Page text as an argument
- **WHEN** an agent calls `canvas.capture` with extra page text in its arguments
- **THEN** the call is refused with `INVALID_INPUT` and nothing is stored

### Requirement: Accepted capture input
`canvas.capture` SHALL accept the clipboard text only when, after removing any text before the first `[` or `{` (such as `while(1);` or a JSON viewer label), it parses as the page kind's shape: for `courses`, an array of courses each with a numeric `id`, a `name`, a `course_code` and an optional `term` with a `name`; for `tabs`, an array of tabs each with an `id`, a `label`, a `type` and an optional `html_url`; for `groups`, an array of at most 100 groups each with a numeric `id`, a `name`, a numeric `group_weight` and `assignments`, each assignment with a numeric `id`, a `name`, a numeric `course_id`, `due_at` and `unlock_at` (ISO time or `null`), `points_possible` (number or `null`), `assignment_group_id`, `html_url`, `updated_at` (ISO time or `null`), and an optional `submission` with `workflow_state` and `score` (number or `null`). For `groups`, every assignment's `course_id` SHALL equal the course's Canvas source id. Unknown keys SHALL be dropped. Text over 5 MB SHALL be refused. A refused input SHALL return `INVALID_INPUT` asking for a fresh copy and SHALL store nothing; raw clipboard text SHALL NOT be stored, logged or returned.

#### Scenario: Wrong course
- **WHEN** a `groups` capture lists assignments whose `course_id` is 999 for a course whose Canvas id is 12345
- **THEN** it is refused with `INVALID_INPUT` and nothing is stored

#### Scenario: Prefix removed
- **WHEN** the copied text starts with `while(1);` followed by a valid array
- **THEN** the array is parsed

#### Scenario: Sign-in page copied
- **WHEN** the copied text is a Canvas sign-in page
- **THEN** it is refused with `INVALID_INPUT` saying the page is not the expected JSON, and the job reports Canvas as `blocked` for that course if no accepted copy follows

#### Scenario: Full page
- **WHEN** an accepted `groups` capture holds exactly 100 groups
- **THEN** it is used and the course's run coverage marks Canvas numbers as `partial`

### Requirement: Values set from the API
An accepted `courses` capture SHALL offer each course as a CourseSelection candidate (code normalized from `course_code`, term from the term name, the Canvas course URL), replacing the agent's dashboard listing. An accepted `groups` capture SHALL be the source of each Canvas item's `due` (`due_at`), `unlockAt` (`unlock_at`), `outOf` (`points_possible`), `score` (`submission.score`), status (`graded` when the submission is graded, `submitted` when `submitted` or `pending_review`, else `not_started`) and of each group's weight; these values SHALL be stored with `via: "api"` and the API URL as source, without a quote. No agent job SHALL be asked to read these fields for Canvas items (#208). A Canvas `null` SHALL be stored as unknown. A course whose groups all have weight 0 SHALL be treated as unweighted, and its components take weights from the skeleton (see `layered-sync`).

#### Scenario: Due date from the API
- **WHEN** a `groups` capture gives an assignment `due_at` 2026-10-31T12:59:00Z
- **THEN** the item's due is stored as that instant with `via: "api"`, and no agent is asked for it

#### Scenario: Unweighted course
- **WHEN** every group of a course has `group_weight` 0
- **THEN** no group weight is used, and component weights come from the skeleton
