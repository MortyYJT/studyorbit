## Why

The first live course read (#186) showed that the agent can drop or miss exact Canvas facts without saying so: COMP20008's final weight was never found, and three COMP20003 assignments were dropped because their status could not be read. The only check today is format and common sense (#166), so these errors reach planning silently. Canvas's own `/api/v1` already holds those numbers for the signed-in student, so a narrow fixed check can catch them (#193). Separately, a single course-level `aiPolicy` (#180) cannot express rules that apply to particular assessments, such as COMP20003 banning AI for reports and reflections only (#195).

## What Changes

- New narrow Canvas check: after a course is imported, Codex opens two fixed Canvas API URLs for that course in the owner's Edge and hands the raw page text to a new tool; fixed code parses it and compares due date, points possible, status, score and assignment-group weight with the stored values (#193). No cookie is read and no dependency is added.
- Mismatches become check conflicts shown in "needs you" with both values; the owner picks one, stored as an owner annotation; until then planning and views keep the agent value marked as unconfirmed (#194).
- **BREAKING (data contract):** the course JSON item gains an optional quoted `aiPolicy`; assessments store an agent-read `aiPolicy` with its read state; the course value becomes the default (#195).
- Effective policy per assessment follows #197: the owner's value on that assessment wins; otherwise `prohibited` at any level wins; otherwise the nearest known value; otherwise unknown, which stays uncapped (#196, #125).
- `autonomy.policy.set` also accepts an assessment; the assessment drawer gets a policy selector.
- Reading and workspace instructions ask Codex to read per-assessment AI statements, run the check step, and look up policy per assessment.

## Capabilities

### New Capabilities
- `canvas-check`: the narrow Canvas API check, its accepted URLs and parsing, the compared fields, conflict records and their resolution.

### Modified Capabilities
- `coursework-sync`: course JSON contract gains the item `aiPolicy`; the course-only AI policy requirement becomes per-assessment with a course default; the job runs the check step after each Canvas course import.
- `assessment-autonomy`: effective policy and cap are resolved per assessment with the #197 order.
- `domain-model`: Assessment gains `aiPolicy` and its read state; a check conflict entity is added.
- `web-ui`: "needs you" lists check conflicts with both values; the drawer marks unconfirmed fields and offers a per-assessment policy selector; the course page shows per-assessment locks.

## Impact

- Code: `src/sync/course-json.ts`, `src/sync/course-import.ts`, a new `src/sync/canvas-check.ts`, `src/protocol/sync.ts` and registry wiring, `src/protocol/autonomy.ts`, `src/protocol/annotations.ts`, store migration and repository, web UI course page, drawer and "needs you", `src/agent/course-reading.md`, `src/agent/codex-instructions.md`.
- Data: one additive migration (Assessment policy columns or JSON fields, a `check_conflicts` table), per #107; authorized by #195.
- No new dependency; no CI or deployment change. Canvas access stays inside the owner's signed-in Edge; no token or cookie is used by code.
