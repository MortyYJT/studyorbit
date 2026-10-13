## Why

Two full dry runs on 2026-10-14 (one course's extraction and essay check; four courses' extraction and scheduling) showed that finding courses, understanding pages, matching requirements and operating web pages work better when the agent does them, while API reads, storage, scheduling, display and guardrails are the same every time and belong in code ([decisions #100–#102](../../../note/decisions.md)). Canvas `/api/v1` student-session reads were confirmed on 2026-10-14, which removes M1's main risk. Finals are on 2026-11-04/05, so the revision skill must work by **2026-10-26**.

## What Changes

- **New split of work:** the agent understands and operates web pages; fixed code owns memory (local store), scheduling, views and guardrails.
- **Resident browser:** one long-running managed Edge that code and agents attach to, keeps the owner signed in, reports expired sign-ins, and highlights every agent click first (#98).
- **`coursework sync`:** read Canvas `/api/v1` JSON and Ed JSON for current-term courses and write the latest state into the local store. Courses with the same normalized course code on Canvas and Ed merge into one course (owner choice, 2026-10-14). There is no change detection (#101).
- **Agent annotations:** the agent records cited facts that sync cannot know: assessment weights, exam/hurdle/final classification, assessments that exist only in a syllabus, and links from one assessment to many platform items. Code checks the citations before applying them. Owner values override agent values, and agent values override platform values.
- **Planning:** owner availability settings plus a deterministic earliest-deadline-first plan in core code, with overflow kept visible.
- **UI on real data:** `coursework ui` serves the existing prototype read-only, fed by the local HTTP read commands.
- **Revision skill:** a two-stage agent skill. A scheduled stage reads exam scope and course content through the resident browser, stores cited notes and practice questions, and notifies the owner. An interactive stage tutors from the stored material. Citation checks stay as a tool.
- **Simplified autonomy:** course policy, per-assessment grants and an append-only audit stay. The code-enforced fill/submit gates, single-use confirmations and Q1 compatibility layer go. The agent checks permission before acting, and records each browser write and each owner confirmation.
- **BREAKING (removals):** whole-page Canvas crawling, the `capture` terminal REPL, terminal course selection and discovery, the Canvas probe, protocol fill/submit gates, the change-event stream and `changes` cursor reads, and all of `src/quiz/`.
- **Deferred:** an email intake as a later information source (#99).

## Capabilities

### New Capabilities

- `resident-browser`: long-running attachable managed browser, session status, visible agent actions.
- `coursework-sync`: current-term Canvas and Ed JSON into the local store, course merging, redaction, run measurements.
- `agent-annotations`: cited agent and owner annotations, assessment creation and assessment–item links, precedence rules.
- `study-planning`: availability settings and the deterministic deadline-first weekly plan.
- `ui-live-data`: read-only local web view over real stored data.
- `revision-skill`: the scheduled preparation stage and the interactive tutoring stage, and the code they rely on.

### Modified Capabilities

- `page-capture`: drop the capture REPL, manual snapshots and the Canvas crawl. Lock and browser detection now serve the resident browser.
- `course-selection`: removed entirely. Sync scope replaces it.
- `ed-capture`: Ed reads cover the courses in sync scope, not a terminal selection.
- `domain-model`: no iCal, no Change entity; Assessment weight may be unknown; new course sources, platform facts, assessment links, annotations and planning settings.
- `local-store`: no change sequence numbers.
- `protocol-reads`: no change reads or change cursors; new reads for platform items, annotations and the plan.
- `command-registry`: no Q1 CLI compatibility.
- `validated-agent-writes`: no Q1 proposal provenance; annotation writes join the cited writes.
- `assessment-autonomy`: no fill/submit gates or Q1 absorption; permission checks and audit records for agent browser actions.

## Impact

- **Code removed:** `src/capture/` crawl, picker, selection, discovery, spike, REPL session and command; `src/quiz/`; `src/protocol/actions.ts`; `src/sync/` diff, reconciliation and changes handler; their tests.
- **Code kept and changed:** profile, lock and browser detection (now resident); Ed transport and limiter; domain model and grade projection; SQLite repository; redaction; Ed normalization (extended to Canvas); command registry with CLI, MCP and HTTP; authorization and audit (simplified).
- **Data model:** additive SQLite migrations for the new entities. The old `change_event` table stops receiving writes but is not dropped, so no local data is deleted.
- **Dependencies:** none outside the pre-approved list. `unpdf@1.8.1` (pre-approved, #74) is installed for `source.fetch`.
- **Specs:** this change is the only open v1 change. `v1-foundation`, `capture-selection-ed` and `v1-protocol` are archived as current truth; `v1-sync`, `ed-quiz-assist` and `v1-ui` are closed without syncing specs.
