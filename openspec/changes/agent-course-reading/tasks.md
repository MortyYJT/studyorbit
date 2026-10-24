## 1. Contract and domain

- [ ] 1.1 Failing tests then `src/sync/course-json.ts`: schema, required fields, sanity checks, path-listing errors (scenarios "Valid document", "Wrong field shape", "Missing name triggers a retry", "Weights do not add up")
- [ ] 1.2 Domain schema additions (Course `aiPolicy`, `readState`; Assessment `group`, `retired`, `readState`; CourseSelection) with parse tests; migration `004` adds `course_selection`

## 2. Store mapping

- [ ] 2.1 Failing tests then `src/sync/course-import.ts`: per-course transaction, ids, score percentage, group tags, placeholders retired when items appear, missing items retired, old-sync course reused, owner value wins, readState, derived weights, unknown replaced when found (scenarios under "Store mapping and precedence" and "Unknown fields are re-checked and derived weights split evenly")
- [ ] 2.2 Retired assessments skipped by `assessments.list`, planning `collectWork`, grade projection and `autonomy.read`

## 3. Commands and policy

- [ ] 3.1 Failing tests then `courses.offer`, `courses.candidates`, `courses.select` (owner only), `course.import` with run scoping and the third-submission rule (scenarios "First run", "Owner selects two courses", "Agent cannot select", "Third submission accepted with unknowns"); MCP tool-count assertion updated
- [ ] 3.2 Failing tests then AI policy: effective policy owner > agent-read > unknown, change notice on the Run (scenarios "Policy read changes", "Owner policy kept", "Agent-read policy caps the course")

## 4. Agent job

- [ ] 4.1 Failing tests with a synthetic adapter then `src/sync/agent-job.ts` and the reading prompt `src/agent/course-reading.md`: discovery, `NEEDS_SELECTION`, selected courses only, `--course`, 20-minute bound, Run outcome and coverage, `LOCKED` (scenarios "Sync from the frontend", "Expired sign-in is not hidden")
- [ ] 4.2 `sync.run`, `sync.status` and `coursework sync` use the job; metrics read sync success per run (scenario "Sync success per run")

## 5. Delete the API sync

- [ ] 5.1 Remove old sync modules and tests no longer imported; adapt `test/e2e/v1-delivery.test.ts` and the UI harness to seed through `course.import`

## 6. Frontend

- [ ] 6.1 Needs-you items and the course selection dialog (scenario "Choose courses")
- [ ] 6.2 Course page grouping with computed earned share, derived and unknown-checked labels (scenarios "Component group", "Derived and unknown labels")
- [ ] 6.3 Real-browser check on the synthetic harness at 390 and 1440 px, light and dark

## 7. Verification

- [ ] 7.1 `openspec validate agent-course-reading --strict`, `bash .claude/check.sh` (exit code), `npm run build`
- [ ] 7.2 Live run by Claude (#181) against a temporary data directory: real Codex reads the owner's selected current courses from their Edge, read-only; record courses, items, unknowns, retries, duration and turns in the PR
- [ ] 7.3 Owner final acceptance in the frontend on their real data
