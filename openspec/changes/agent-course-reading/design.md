## Context

C-1 (`codex-agent`, archived) made Codex the chat agent through `AgentAdapter`, with our tools on `coursework mcp` (a separate process started by Codex) and guardrails in a workspace `AGENTS.md`. The owner decided (#165–#172, #180–#183) that course data comes from the agent filling a three-level JSON, validated by a little code, and that the Canvas/Ed API sync is deleted. Planning, the week view, the score ring and the course page work per Assessment and read effective values through the annotation projection (owner > agent > platform value > unknown).

Live facts (2026-10-24): Codex reads the owner's Edge in ~20 s per page; Edge's accessibility tree omits visible course names that a screenshot shows; Codex's final message can describe actions that have no event, so only tool results are trusted; MCP calls need `default_tools_approval_mode="approve"`; the owner's real store already holds Canvas data from one partial API sync run.

## Goals / Non-Goals

**Goals:** agent discovery → owner selection → per-course document → validation with two retries → store; unknown re-checks; derived weights; one AI-policy field; frontend surfaces; delete the API sync orchestration.

**Non-Goals:** the resident browser, `browser.*`, `source.fetch`, the Canvas/Ed capture transports and their shared helpers (C-3); long-term memory (C-4); verifying values against page text or APIs (#166, later).

## Decisions

### 1. A sync run is an agent job over the existing adapter
`src/sync/agent-job.ts` opens a SyncJob in the store, then starts `AgentAdapter.start({ prompt, tools, transcript: [] })` with the fixed prompt in `src/agent/course-reading.md` plus the job id, the selected courses with their keys and page URLs, the course JSON schema as JSON Schema, and today's date. It consumes events only to count turns and tool steps and to stop at 20 minutes; it never parses the agent's text. All results reach us through `courses.offer` and `course.import`, executed in the `coursework mcp` process. When the adapter run ends, the job reads the SyncJob and the stored documents to build the Run (outcome, per-course coverage, policy changes) and closes the job. Alternative: `codex exec --output-schema` returning one big JSON (rejected: no per-course retry loop, no partial progress, Codex-specific).

### 2. Commands
| Command | Kind | Input → output |
| --- | --- | --- |
| `courses.offer` | agent write, job-scoped | `{ jobId, courses: [{ code, name?, term, pages }], blocked: ['canvas'\|'ed'] }` → stored candidates |
| `courses.candidates` | L0 read | → candidates with selection state |
| `courses.select` | owner (frontend session or TTY) | `{ selections: [{ key, selected }] }` |
| `course.import` | agent write, job-scoped | `{ jobId, document }` → `ok` counts and warnings, or `INVALID_INPUT` with every failing path |
| `sync.run` / `sync.status` | owner / L0 (existing names) | start the job / active flag, last run, blocked platforms, per-course last stored document |
The SyncJob row (migration `004`: `course_selection`, `sync_jobs`) is the cross-process lock and holds the per-course submission counts; `course.import` increments the count in the same transaction as its decision. A job older than 25 minutes is treated as ended (stale lock).

### 3. Contract in one place
`src/sync/course-json.ts` exports the zod schema (field wrapper `{ value, state, via?, checkedAt?, quote?, source? }`, `term` regex, `platforms`), the required-field list, the sanity checks, a function that degrades failing fields to `unknown` for the third submission, and `toJSONSchema()` for the prompt.

### 4. Store mapping (#182)
`src/sync/course-import.ts`, one `saveBatch` per course:
- Course by normalized code and term (reusing an existing old-sync course), sources from page URLs (Canvas and Ed origins only), `aiPolicy` and `readState`.
- Per item: SourceItem of kind `assignment` (platform and id from the item key, title, URL, `facts` due/points/submitted, empty text; URL on the Canvas or Ed origin) and an Assessment (`id = sha256(term:item key)`), kind inherited from the component, `group` tag, AssessmentLink origin `sync`.
- Remainder Assessment (`id = sha256(term:component key:remainder)`, no `isFinal`/`hurdleMin`) while stored items < `count` or no items: weight = component weight − effective weights of its items (including items kept on agent/owner links), floored at 0 with a warning; retired when items reach `count`, back when they drop.
- Components with `isFinal` or `hurdleMin`: one Assessment (`id = sha256(term:component key)`) linked to all items; due = earliest item due; score = weighted mean of item scores; items get no Assessment of their own; no remainder.
- Items whose current link is agent/owner origin keep it and get no import Assessment.
- Third-submission stand-ins: items/components without a valid name or status are left out; a course without a name shows its code; several finals → `isFinal` unknown on all.
- Derived weights: `(component weight − stated) / (count − stated count)`, or listed items when `count` is unknown.
- Retire sync-origin assessments of the course not produced by the document: item rows only for platforms reported `read`, remainder and component rows only when `componentsComplete`; never agent or owner origin.
Domain additions are optional JSON fields; `RunSchema` allows `turns` without a conversation for `sync.run`. Reads (`assessments.list`, planning `collectWork`, grade projection, `autonomy.read`) skip retired assessments.

### 5. AI policy
`AssessmentAutonomy` policy = newest owner annotation (frontend only; `null` clears it) else `Course.aiPolicy` else unknown. `annotation.record` refuses `aiPolicy` from agents; the annotation projection and `courses.list` report the effective policy with its origin. The "changed" notice is stored on the Run's course coverage, so it lasts until the next run. The K3 course page's agent-policy "confirm" entry is replaced by the owner policy select it already has.

### 6. Deleting the API sync
Delete the orchestration only: `src/sync/service.ts`, `runtime.ts`, `merge.ts`, `normalize.ts`, `ed-adapter.ts`, `privacy-boundary.ts` (only `ed-adapter.ts` imports it), `ed-reader.ts`, `ed-questions.ts`, `canvas-reader.ts` readers (types still used by `src/capture/canvas-transport.ts` move there or stay until C-3), and their tests. Keep what other code imports: `ed-scope.ts`, `redaction.ts` (used by `src/browser/*`, `src/protocol/read-privacy.ts`, `src/revision/*`); C-3 removes them with the transports. `src/protocol/sync.ts` and `production.ts` switch to the job. Tests that seed through `SyncService` or `delivery-fixture` (`test/protocol/annotations.test.ts`, `test/protocol/sync.test.ts`, `test/e2e/v1-delivery.test.ts`) and the UI harness (`test/web/harness.ts`) are rewritten to seed through `course.import` or the store.

### 7. Frontend
`web/src/shell.ts` reads the new `sync.status` (active, last run, blocked platforms, per-course times); the avatar status panel shows them. "Needs you" adds: candidates awaiting selection (dialog with checkboxes → `courses.select`), unknown fields after retries, weight-sum warnings, AI-policy changes, blocked platforms (sign-in). The course page groups by `group.key` with an earned share computed in `web/src/course.ts`; labels for `derived` and `unknown (checked …)`. Browser checks with the synthetic harness, extended with grouped, remainder and derived data.

## Risks / Trade-offs

- [Agent misreads a value without an error] → accepted at D level (#166); quotes kept for later checking; owner edits win.
- [Agent misses a field the accessibility tree hides] → required-field check + screenshot re-read; unknowns surface in "needs you".
- [Unstable component names across runs] → keys are code + name slug; a rename creates a new remainder and retires the old one; annotations on the old one stay attached to the retired row.
- [Old API-sync assessments are retired on the first import] → references to them (annotations, estimates, time logs, start times, overrides, tasks, conversations) stay attached to the retired rows and drop out of planning; accepted (#183): the owner's store holds one partial API run and no owner edits.
- [`source.fetch` for an Ed lesson needs a SourceItem of the course] → import writes SourceItems, so it keeps working; new citations still need `source.fetch` text first.
- [Long runs] → 20-minute bound, outcome recorded, unread courses untouched.
- [Agent imports outside a run] → job-scoped writes.

## Migration Plan

Merge; the next sync uses the agent. Old API-sync rows are reused or retired by the first imports. Rollback: revert the PR (migration `004` only adds tables).

## Open Questions

None blocking.
