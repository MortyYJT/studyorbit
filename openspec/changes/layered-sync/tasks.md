## 1. Live probes (owner present, screen unlocked; Codex quota needed except 1.2 and 1.3a)

- [ ] 1.1 In the owner's Edge, open the `courses`, `tabs` and `groups` URLs for one selected course, select all and copy; record in `.local/` only (never in git) whether each returns the expected keys for the student session and what text precedes the JSON. Write the content-free result into `design.md` Open Questions. If an include or `tabs` is refused, switch D2 to the #193 URLs (and an agent listing of the navigation) before 3.x.
- [ ] 1.2 Owner creates an Ed API token and runs `edstem auth login`; then `edstem units` and `edstem lessons <unit>` with JSON output for one course; record which fields hold due dates (content-free) in Open Questions.
- [x] 1.3a Fetch one Handbook assessment page by code: blocked by bot protection (block page, HTTP 200, about 1 KB), so the page is captured through the clipboard (#214).
- [ ] 1.3b (Codex) In the owner's Edge, open one Handbook assessment page, select all and copy; record in `.local/` only what the copied text looks like around the assessment table (row and column separators), content-free, in Open Questions.
- [ ] 1.4 Experiment (#206): two Codex jobs at once, each told to open its own Edge window; record whether either took the other's window or pointer. Set the default of `sync.parallel` from the result.
- [ ] 1.5 After 9.2: count false "content updated" notices over two syncs with no real change.

## 2. Data model and storage

- [ ] 2.1 Domain schemas: six kinds with `ongoing` read as `participation`; Assessment `unlockAt` and `aiPolicy`; read-state `via` adds `api` and `handbook`; SourceItem facts `unlockAt`, `updatedAt`; `SavedFile`; `SyncConflict`; Run `jobs`; SyncJob `stages`. Tests for the domain-model scenarios.
- [ ] 2.2 Additive migration and repository methods: assessment columns, `saved_files`, `sync_conflicts`, job stages; migration test on a database with old rows (including `ongoing`).

## 3. Canvas API captures

- [ ] 3.1 `src/sync/canvas-api.ts`: injectable clipboard reader, prefix strip, 5 MB cap, zod shapes for `courses`, `tabs`, `groups`, `course_id` check, `partial` at 100 groups; tests for the accepted-input scenarios.
- [ ] 3.2 Agent command `canvas.capture {jobId, courseKey?, page}` (refuses extra text arguments); `courses` offers candidates; `groups` stores API values with `via: "api"`; update the MCP tool count test.

## 4. Skeleton and routing

- [ ] 4.1 `src/sync/handbook.ts` and agent command `handbook.capture {jobId, courseKey}`: read the clipboard through the injectable reader, 1 MB cap, parse the copied page text into components (name, weight, timing, hurdle, quote), store the skeleton as a job stage, no raw text stored; failure is non-fatal; tests on synthetic copied text; update the MCP tool count test. Revisit the parser after 1.3b.
- [ ] 4.2 `src/sync/routing.ts`: the fixed route table, unknown tabs `never` and listed, home-page links unlock `on-home-link`; tests for the routing scenarios.

## 5. Pipeline and agent jobs

- [ ] 5.1 Orchestrator in `src/sync/agent-job.ts`: course list, then per course the stages in order; one retry per failed job; per-job records; 10-minute job bound and 20-minute-per-course run bound; job staleness from the run bound; `sync.parallel` (default 1); stage results in the store. Tests with a fake adapter for the sync-start, run-state and pipeline scenarios.
- [ ] 5.2 Job prompts under `src/agent/jobs/` (main, quiz page, assignment page, saver, classifier, Ed fallback, Handbook capture), each role · task · output, with only allowed URLs; tests that each prompt names its output tool and lists only routed URLs (the Handbook prompt lists only the one Handbook assessment URL).
- [ ] 5.2b Delete `src/agent/course-reading.md`, `courseReadingPrompt` and its prompt test, remove `course.import` from the agent tools (update the command-registry tool-list test) and rewrite the tests for "Import outside a run" and "Count shared across processes" into the stage-output scenarios, when production switches to the pipeline in `src/protocol/production.ts` (after 5.3 and 6.2; moved out of 5.2 because production still runs the legacy job).
- [ ] 5.3 Agent commands `course.map`, `quizzes.read`, `assignment.saved`, `materials.saved`, `items.classify`, each tied to an active job and course; tests for the stage-output scenarios.

## 6. Classification and document build

- [ ] 6.1 Grading rule: graded with a weighted group or a weighted skeleton component; weight-0 group under a weighted component opens `weight`; hurdle items keep their kind; everything else `ungraded`; `unmatched` conflicts; owner command `check.resolve` (owner session only; `skeleton`/`canvas` for weight, component or dismiss for unmatched); tests for the classification and conflict scenarios.
- [ ] 6.2 `src/sync/build-document.ts`: build the course document from the stages; `course-json.ts` accepts `via: "api" | "handbook"`, item `kind`, `unlockAt`, item `aiPolicy`; import maps the item kind (component kind as fallback), unlock time and new facts; one classification retry; re-capture rules for unchanged assignment pages; tests for the coursework-sync scenarios.

## 7. Course folder and Ed

- [ ] 7.1 `src/sync/course-folder.ts`: folder naming (`UniMelb 26S2`), `COURSEWORK_FILES` override, move from Downloads by exact name and time, fingerprint (with `.mhtml` normalization), superseded copies with date suffix, update notices; never delete; tests in a temp directory.
- [ ] 7.2 `src/sync/ed-cli.ts`: detect `edstem`, version and auth check, run `units`, `lessons`, `files get` with JSON output, map to Ed items and saved slides; fallback to the Ed job, with its output command (`ed.read` placeholder in `src/agent/jobs/index.ts`; name it in the spec); tests with a fake command runner.

## 8. Per-assessment AI policy (kept from C-5)

- [ ] 8.1 Import stores item policy with quote, keeps the last value on unknown or skipped pages, component and remainder rules, "needs you" on change; tests.
- [ ] 8.2 `AssessmentAutonomy`: #197 resolution, cap per assessment, `assessment-prohibited`, new kind-to-level mapping (`ungraded` needs L2), `autonomy.policy.set` by assessment (owner only, `null` clears), `annotation.record` refuses agent `aiPolicy` on assessments; tests for every assessment-autonomy scenario.
- [ ] 8.3 `src/agent/codex-instructions.md` rule 3 per assessment; update the workspace-instructions test.

## 9. Start flow and frontend (verify in a real browser with synthetic data, screenshots)

- [ ] 9.1 `assessment.files {assessmentId}` (HTML text, PDF text via `unpdf`, each recorded as a material SourceItem linked to the assessment; save first through one assignment-page job when nothing is saved); start preset; tests including a cited annotation that passes the citation check.
- [ ] 9.4 Planning leaves `ungraded` assessments out of plannable work; test for the study-planning scenario.
- [ ] 9.2 "Needs you": course list selection, `weight` and `unmatched` conflicts with owner actions (`check.resolve`), content-updated notices.
- [ ] 9.3 Course page and drawer: six kinds and order, ungraded folded, per-assessment lock, saved files with update markers, "from Canvas API" marker, Start button.

## 10. Verification and acceptance

- [ ] 10.1 `bash .claude/check.sh` passes; fresh-context review says ready to merge.
- [ ] 10.2 Owner live run (Codex quota needed): sync the four courses; fill the measured-runs table (steps and turns per job, total input tokens, quota used, time) and compare with the 2026-10-25 and 2026-10-26 runs; confirm the COMP20003 survey items are `ungraded` and no Gradescope/Echo360 page was opened.
