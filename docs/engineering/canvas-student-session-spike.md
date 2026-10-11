# Canvas student-session spike (synthetic harness)

Scope: `v1-sync` task 1.1, issue #44. This is not the production Canvas adapter or
evidence that a university student session can read these endpoints.

`probeCanvasStudentSession(page, selection, courseId, limiter, signal?)` consumes an
already-owned page, a validated saved `CaptureSelection`, and the shared
`CaptureLimiter`. It does not launch a browser, navigate, acquire a profile lock,
prompt for credentials, or close a caller-owned page. A future caller must retain
the existing managed-profile identity, exclusive lock and lifecycle contracts.
There is no new CLI command.

The probe makes at most five first-page GETs, with `per_page=100`, on the selected
Canvas course and validated Canvas origin:

| Collection | Candidate course-relative API path | Fixed field evidence |
| --- | --- | --- |
| Assignments | `assignments` | id, name, due_at, points_possible, assignment_group_id |
| Assignment groups | `assignment_groups` | id, group_weight, rules |
| Owner submissions | `assignments?include%5B%5D=submission` | id, submission, submission.score/grade/workflow_state/submitted_at |
| Modules | `modules` | id, name, items_count |
| Files | `files` | id, display_name, url, size, content-type |

The owner-submission include is a **candidate** current-student read, not a proven
live endpoint or schema. No all-student submissions, people directory, arbitrary
endpoint, token, or Authorization header is supported. Authentication uses only
page-local `fetch` with `credentials: 'same-origin'`. Redirects are manual and never
followed; each request has a 30-second timeout and uses the existing attempt budget
and spacing, without retry.

Only collection labels, status, row counts and fixed field **types** leave the
page. Unknown keys, values, response bodies, headers, URLs and thrown errors are
withheld. Empty collections provide no row-field proof. Optional missing fields
are recorded as `missing`; null submissions provide no score/grade proof. Wrong
present-field types, non-array collections, invalid row identities and missing
requested submission fields stop the probe with `SOURCE_UNAVAILABLE`.

Every readable collection has `coverage: 'first_page_only'`. Link metadata becomes
only `more`, `none` or `unknown`; no next URL is exported or followed. Even `none`
does not establish live completeness. Production safe pagination is task 3.1.
Missing usable page login, a login redirect, or 401/403 returns `AUTH_EXPIRED` with
owner sign-in guidance. A persistent 403 after confirmed student login is blocked
evidence, not authorization for HTML parsing.

## Pending owner-login verification (task 1.2)

This task has not run. Claude/owner must first establish the managed logged-in
student profile and selected course. Any future live runner must keep raw JSON
only in private `.local/` storage and publish only content-free structure evidence;
this harness deliberately exports no raw JSON or snapshot writer. Do not paste
responses or course content into tests, notes, logs or model output.

Open questions: are all five candidate reads permitted for a student session;
does the submission include return only the owner's score/status and what fields
are present; which grading/group rules and module/file link shapes occur; and can
safe selected-course pagination actually enumerate each required collection?
Synthetic success answers none of these. Blocked authenticated reads require an
owner decision before any HTML fallback or production Canvas adapter work.
