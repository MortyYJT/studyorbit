## Context

C-1 (`codex-agent`, archived) made Codex the chat agent through `AgentAdapter`, with our tools on `coursework mcp` and guardrails in a workspace `AGENTS.md`. The owner decided (#165–#172, #180, #181, #182) that course data comes from the agent filling a three-level JSON, validated by a little code, and that the Canvas/Ed API sync is deleted. Planning, the week view, the score ring and the course page all work per Assessment and read effective values through the annotation projection (owner > agent > platform value > unknown).

Live facts (2026-10-24): Codex reads the owner's Edge in ~20 s per page; Edge's accessibility tree omits visible course names that a screenshot shows; Codex's final message can describe actions that have no event, so only tool results are trusted; MCP calls need `default_tools_approval_mode="approve"`.

## Goals / Non-Goals

**Goals:** agent discovery → owner selection → per-course document → validation with two retries → store; unknown re-checks; derived weights; one AI-policy field; frontend surfaces; delete the API sync.

**Non-Goals:** the resident browser, `browser.*`, `source.fetch` and the Ed capture transport (C-3); long-term memory (C-4); verifying values against page text or APIs (#166, later).

## Decisions

### 1. A sync run is an agent job over the existing adapter
`src/sync/agent-job.ts` starts `AgentAdapter.start({ prompt, tools, transcript: [] })` with the fixed prompt in `src/agent/course-reading.md` plus the run's context (selected courses with their keys and page URLs, the course JSON schema as JSON Schema, today's date). It consumes events only to count turns and tool steps and to stop at 20 minutes; it never parses the agent's text. All results reach us through `courses.offer` and `course.import` calls. Alternative: `codex exec --output-schema` returning one big JSON (rejected: a single final message gives no per-course retry loop and no partial progress, and is Codex-specific).

### 2. Commands
| Command | Kind | Input → output |
| --- | --- | --- |
| `courses.offer` | agent write, run-scoped | `{ runId, courses: [{ code, name?, term, pages }] }` → stored candidates |
| `courses.candidates` | L0 read | → candidates with selection state |
| `courses.select` | owner (frontend session or TTY) | `{ selections: [{ key, selected }] }` |
| `course.import` | agent write, run-scoped | `{ runId, document }` → `ok` counts, or `INVALID_INPUT` with every failing path |
| `sync.run` / `sync.status` | owner / L0 (existing) | now start/report the agent job |
Agent writes carry the run id the job puts in the prompt; a write for an unknown or finished run is refused, so an agent outside a run cannot import. The retry counter (third submission accepts unknowns) lives in the job's memory per run and course key.

### 3. Contract in one place
`src/sync/course-json.ts` exports the zod schema (field wrapper `{ value, state, via?, checkedAt?, quote?, source? }`), the required-field list, the sanity checks and `toJSONSchema()` for the prompt. One test per spec scenario on synthetic documents.

### 4. Store mapping (#182)
`src/sync/course-import.ts`, one `saveBatch` per course: Course by normalized code and term (reusing an existing old-sync course), sources from page URLs; Assessment ids `sha256(item key)` for items and `sha256(component key)` for placeholders; score `value / outOf × 100`; `group` tag; `readState`; derived weights; retire sync-origin assessments of that course not in the document. Domain additions are optional JSON fields (no migration); `course_selection` is a new table in migration `004` (additive only, #107). Reads (`assessments.list`, planning `collectWork`, grade projection, autonomy) skip retired assessments.

### 5. AI policy
`Course.aiPolicy` + `readState.aiPolicy` from import. `AssessmentAutonomy` policy = owner annotation (existing, frontend only) else `Course.aiPolicy` else unknown. The "changed" notice compares the stored value before and after an import and is recorded on the Run, so it lasts until the next run.

### 6. Deleting the API sync
Delete `src/sync/` files whose only importers are the old sync path, and their tests; keep anything still imported by `src/revision/`, `src/browser/` or `src/protocol/reads*` (checked with the import graph; e.g. `src/store/platform-state.ts` stays). The `ed-capture` spec and transport stay for `source.fetch` until C-3. `test/e2e/v1-delivery.test.ts` step 2 switches to a synthetic adapter that calls `courses.offer` / `course.import`.

### 7. Frontend
"Needs you" items from `sync.status` (last run) and `courses.candidates`; a selection dialog; the course page groups by `group.key` with an earned share computed in `web/src/course.ts`; labels for `derived` and `unknown (checked …)`. Browser checks with the synthetic harness, extended with grouped and derived data.

## Risks / Trade-offs

- [Agent misreads a value without an error] → accepted at D level (#166); quotes kept for later checking; owner edits win.
- [Agent misses a field the accessibility tree hides] → required-field check + screenshot re-read; unknowns surface in "needs you".
- [Long runs] → 20-minute bound, run outcome recorded, data of unread courses untouched.
- [Duplicate courses from old API data] → reuse by normalized code and term; old sync assessments retired.
- [Agent imports outside a run] → run-scoped writes.

## Migration Plan

Merge; the next sync uses the agent. Old API-sync rows stay and are reused or retired by the first imports. Rollback: revert the PR (migration `004` only adds a table).

## Open Questions

None blocking.
