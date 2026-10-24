## Why

The owner decided that course information is read by the agent, not by fixed API-scraping code, with code only validating (#165, #166). The first live run of the old API sync failed on a field type it had assumed (Ed `course.year` is a string), the kind of brittleness the owner wants to avoid. Sub-project C-1 made Codex the agent and proved it can read the owner's Edge (`codex-agent`, archived). This change, sub-project C-2, replaces the Canvas/Ed API sync with agent reading.

## What Changes

- **BREAKING:** the Canvas/Ed JSON API sync orchestration (`src/sync/` service, runtime, readers, merge, normalize and their tests) is deleted (#172); helpers still imported by the browser and revision code stay until C-3. `sync.run` / `coursework sync` / the sync button now start an agent reading job through the chat agent adapter (Codex by default).
- Course discovery and selection: each run, the agent lists the courses it sees on Canvas and Ed and offers them (`courses.offer`); the owner ticks which courses to plan in the frontend (`courses.select`, owner command); only selected courses are read.
- Course JSON (#169): for each selected course the agent submits one three-level document (course → grading components → items) through a validated agent command `course.import`. Every field carries `value`, `state` (`found` | `unknown` | `not_applicable` | `derived`), `via` (`ax` | `screenshot`), `checkedAt`, and, for due dates, weights and hurdles, the page quote.
- Validation (#166, #170): format (zod), sanity (due dates within the term's year; weights 0–100), completeness (required fields not empty). Errors go back to the agent, which re-reads (screenshot for empty fields); on the third submission every field still failing is stored as `unknown` and listed in "needs you"; run state and counts live in the store because the agent's commands run in a separate process. Component weights that do not add up to 100 are a warning, not an error.
- Store mapping (#182): each item becomes a SourceItem and an Assessment with its own due date, score and weight and a `group` tag for its component; the unpublished share of a component stays in a remainder Assessment until all items exist; final or hurdled components stay one Assessment; items a later read no longer lists are retired, but only for platforms that read reports as read. Imported values are the lowest-precedence platform values; owner and agent annotations still win. `unknown` fields are re-checked every run.
- Per-item weights not stated on the page are split evenly from the component weight and stored as `derived` (#171); "earned so far" per component is computed by code.
- One `aiPolicy` field per course is the AI switch (#180): agent-read with its quote and effective at once, owner-editable from the frontend and then never overwritten, unknown means uncapped (#125). A changed value appears in "needs you".
- Frontend: course selection dialog, new "needs you" items, component grouping with earned totals, `derived` and `unknown (checked …)` labels.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `coursework-sync`: replaces the API sync requirements with agent discovery, owner selection, the course JSON contract, validation with retries, store mapping and re-checking.
- `assessment-autonomy`: the course cap reads the effective `aiPolicy` (owner value, else the agent-read value); unknown stays uncapped.
- `domain-model`: Assessment gains optional `group`, `retired` and `readState`; Course gains optional `aiPolicy` and `readState`; new CourseSelection and SyncJob entities; agent sync Runs record `syncOutcome` and per-course coverage.
- `web-ui`: "Real data only" allows labelled `derived` values; the week view's "needs you" and the course page gain the new items and grouping.
- `metrics`: sync duration and success rate are per run (agent job), no longer per provider.
- `protocol-reads`: courses report the effective AI policy and last stored document; candidates are readable; retired assessments are omitted.
- `command-registry`: `courses.select` joins the owner commands accepted from the frontend session or a TTY.

## Impact

- Code removed: the API sync orchestration listed in design §6 and its tests; tests and the UI harness that seeded through it are rewritten.
- Code added: `src/sync/course-json.ts` (schema and checks), `src/sync/course-import.ts` (store mapping), `src/sync/agent-job.ts` (job runner over the adapter), job prompt `src/agent/course-reading.md`, registry commands, migration `004` (`course_selection`, `sync_jobs` tables), frontend pieces in `web/src/`.
- Not changed here: the resident browser, `browser.*` tools and `source.fetch` (sub-project C-3).
