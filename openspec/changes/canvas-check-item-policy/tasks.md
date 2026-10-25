## 1. Live probe (owner present, screen unlocked)

- [ ] 1.1 In the owner's Edge, open the fixed assignment-groups URL for one selected course, select all and copy; record in `.local/` only (never in git) whether the student session returns groups with embedded assignments and submissions, and the shape of the copied text (prefix, viewer labels). Write the content-free result (keys present, prefix seen, yes/no) into `design.md` Open Questions. If the includes are refused, stop and switch the plan to the two URLs of #193 before 3.x.

## 2. Data model and storage

- [ ] 2.1 Add `aiPolicy?` to `AssessmentSchema`, `via: "api"` to the read-state entry, and the `CheckConflictSchema` (presence accepts only choice `agent`); tests for the domain-model scenarios.
- [ ] 2.2 Additive migration: `aiPolicy` column on assessments and the `check_conflicts` table; repository methods to upsert, close, resolve and list conflicts; migration test on a database with old rows.

## 3. Canvas check

- [ ] 3.1 `src/sync/canvas-check.ts`: clipboard reader behind an injectable function; prefix strip, 5 MB cap, zod schema of the needed keys, `course_id` check, `partial` at 100 groups; tests for the accepted-input scenarios (wrong course, prefix, unknown keys, sign-in page).
- [ ] 3.2 Comparison: item due, outOf, score, status mapping; component weight via `assignment_group_id`; unweighted courses; missing assignments; tests for each compared-fields scenario.
- [ ] 3.3 Conflict lifecycle: open, update, close as `agreed`, suppression after an `agent` choice; tests.
- [ ] 3.4 Agent command `canvas.check {jobId, courseKey}` in the registry (job and selection checks, run course coverage `checked` / `partial` / `unavailable` / `not_run`); update the MCP tool count in `test/cli.test.ts`.
- [ ] 3.5 Owner command `check.resolve {conflictId, choice}`: owner session only; `canvas` writes an owner annotation for due and item weight, updates platform status / score / outOf with `via: "api"`, records component weight for the next import; importer keeps resolved Canvas values while unchanged and applies resolved component weights; tests for the resolution scenarios and the agent refusal.
- [ ] 3.6 Reads: `assessments.list` and `annotation.read` mark unconfirmed fields with the Canvas value; a conflicts read for the UI; tests.

## 4. Per-assessment AI policy

- [ ] 4.1 Course JSON contract: optional quoted item `aiPolicy`; reading-prompt JSON Schema regenerated; tests for the contract scenarios.
- [ ] 4.2 Import: store item policy with quote, keep the last value on an unknown read, component and remainder rules, "needs you" on change; tests.
- [ ] 4.3 `AssessmentAutonomy`: per-assessment resolution (#197), cap per assessment, `autonomy.read` reports value, origin and level, `autonomy.policy.set` accepts an assessment id (owner only, `null` clears); `annotation.record` refuses agent `aiPolicy` on assessments; tests for every assessment-autonomy scenario.

## 5. Agent instructions

- [ ] 5.1 `src/agent/course-reading.md`: read AI statements on assessment pages into item `aiPolicy`; after each Canvas course import open the fixed URL, select all, copy, call `canvas.check`; never paste the JSON into a tool argument.
- [ ] 5.2 `src/agent/codex-instructions.md` rule 3: look up each assessment's effective policy and stay read-only where it prohibits AI; update the workspace-instructions test.

## 6. Web UI (verify in a real browser with synthetic data, screenshots)

- [ ] 6.1 "Needs you": check conflicts with both values and keep / use buttons; missing assignments with dismiss; changed item policies.
- [ ] 6.2 Assessment drawer: unconfirmed marker with the Canvas value; policy with origin, level and quote; owner policy selector.
- [ ] 6.3 Course page: per-assessment L0 lock; course lock unchanged.

## 7. Verification and acceptance

- [ ] 7.1 `bash .claude/check.sh` passes; fresh-context review says ready to merge.
- [ ] 7.2 Owner live run: sync the four courses, confirm the check runs per Canvas course and the COMP20008 weight and COMP20003 assignment gaps show up as conflicts or missing entries; record sync time and conflict counts as metrics.
