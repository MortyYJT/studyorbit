## MODIFIED Requirements

### Requirement: Capture bounded selected-course endpoint coverage
Ed reads SHALL discover courses through `GET /api/user`, keep only its `courses` array, and, for each Ed course in sync scope (active current-term courses, optionally narrowed by `--course`), read its lessons list, every assignment lesson with `kind: attempt`, every slide referenced by those assignments, the first discussion thread-list page with `limit=30&sort=new`, and resources. Observed endpoint paths are `/api/courses/{id}/lessons`, `/api/lessons/{id}`, `/api/lessons/slides/{id}`, `/api/courses/{id}/threads`, and `/api/courses/{id}/resources`; the verified course-list path is `/api/user`. Ed reads SHALL NOT fetch ordinary content lesson bodies, subsequent thread pages, thread details/replies, workspaces or linked external resource files. Missing tabs/endpoints returning 404/405 SHALL be recorded as skipped/unavailable, not failures; other endpoints SHALL still be attempted within the budget. Assignment/slide ids SHALL come only from responses for courses in sync scope.

#### Scenario: Assignment with slides
- **WHEN** Ed course ABCD10001 in sync scope lists one attempt lesson with two slides and one content lesson
- **THEN** the run reads the course list, lessons list, attempt lesson, both slides, first thread-list page and resources, without fetching the content lesson body or thread page two

#### Scenario: No Lessons tab
- **WHEN** a course in sync scope has discussions and resources but its lessons endpoint returns 404
- **THEN** lessons are recorded as skipped without increasing the failed count, and threads/resources are still read

#### Scenario: Course outside scope
- **WHEN** sync runs with `--course ABCD10001` and `/api/user` also lists EFGH20002
- **THEN** no course-specific endpoint for EFGH20002 is requested
