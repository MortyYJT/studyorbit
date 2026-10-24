## 1. Contract and domain

- [ ] 1.1 Failing tests then `src/sync/course-json.ts`: schema with `term` format and `platforms`, required fields, sanity checks, path-listing errors, third-submission degrade (scenarios "Valid document", "Wrong field shape", "Missing name triggers a retry", "Third submission accepted with unknowns", "Weights do not add up")
- [ ] 1.2 Domain schema additions (Course `aiPolicy`, `readState`; Assessment `group`, `retired`, `readState`; CourseSelection; SyncJob; Run `turns` without conversation, `syncOutcome`, `courseCoverage`) with parse tests (scenario "Agent sync run"); migration `004` adds `course_selection` and `sync_jobs`

## 2. Store mapping

- [ ] 2.1 Failing tests then `src/sync/course-import.ts`: per-course transaction, ids with term, SourceItems and links, score percentage, kind inheritance, group tags, remainder weights, final/hurdle components as one Assessment, retire per platform read, old-sync course reused, owner value wins, readState, derived split, unknown replaced (scenarios under "Store mapping and precedence" and "Unknown fields are re-checked and derived weights split evenly")
- [ ] 2.2 Retired assessments skipped by `assessments.list`, planning `collectWork`, grade projection and `autonomy.read`

## 3. Commands and policy

- [ ] 3.1 Failing tests then the SyncJob store, `courses.offer`, `courses.candidates`, `courses.select` (owner only), `course.import` (job-scoped, counts in the store) (scenarios "First run", "Owner selects two courses", "Agent cannot select", "Import outside a run", "Count shared across processes"); MCP tool-count assertion updated
- [ ] 3.2 Failing tests then AI policy: effective owner > agent-read > unknown, owner `null` clears, agents refused for `aiPolicy` annotations, reads report effective policy and origin, change notice on the Run (scenarios "Policy read changes", "Owner policy kept", "Owner clears the policy", "Agent-read policy caps the course")

## 4. Agent job

- [ ] 4.1 Failing tests with a synthetic adapter that calls the commands, then `src/sync/agent-job.ts` and the prompt `src/agent/course-reading.md`: discovery, `NEEDS_SELECTION`, selected courses only, `--course`, 20-minute bound, Run outcome and course coverage, blocked platforms, `LOCKED` (scenarios "Sync from the frontend", "Expired sign-in is not hidden", "Second start", "Blocked platform keeps its data")
- [ ] 4.2 `sync.run`, `sync.status` (new shape) and `coursework sync` use the job; metrics per run (scenario "Sync success per run")

## 5. Delete the API sync

- [ ] 5.1 Remove the orchestration modules listed in design §6 and their tests; rewrite tests and the UI harness that seeded through `SyncService` to seed through `course.import` or the store; keep modules other code imports

## 6. Frontend

- [ ] 6.1 `shell.ts` and the avatar status panel read the new `sync.status`; "needs you" items and the course selection dialog (scenario "Choose courses")
- [ ] 6.2 Course page grouping with computed earned share, remainder rows, derived and unknown-checked labels; the agent-policy confirm entry removed (scenarios "Component group", "Derived and unknown labels")
- [ ] 6.3 Real-browser check on the synthetic harness at 390 and 1440 px, light and dark

## 7. Verification

- [ ] 7.1 `openspec validate agent-course-reading --strict`, `bash .claude/check.sh` (exit code), `npm run build`
- [ ] 7.2 Live run by Claude (#181) against a temporary data directory: real Codex reads the owner's current courses from their Edge, read-only; record courses, items, unknowns, retries, duration and turns in the PR
- [ ] 7.3 Owner final acceptance in the frontend on their real data
