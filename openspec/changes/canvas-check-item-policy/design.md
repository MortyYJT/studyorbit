## Context

Since #165 the agent (Codex in the owner's Edge) reads every course fact, and code checks only format, common sense and required fields (#166). The first live read (#186) showed silent misses that Canvas's own `/api/v1` would have answered: a missing final weight in COMP20008 and three COMP20003 assignments dropped because their status was unreadable. The old API sync code was deleted (#172) and the Playwright browser removed in C-3, so code cannot reach Canvas by itself; it can only see what Codex hands it. A student session can read `/api/v1` (measured 200 on 2026-10-14, #100); students cannot issue tokens.

AI policy is one `aiPolicy` field per course (#180), capped in `src/protocol/autonomy.ts`. Real rules attach to particular assessments (COMP20003 bans AI for reports and reflections only), so the agent's course reading of `allowed` was not wrong, just unable to say more (#195).

Owner decisions: #193 (narrow fixed check, Codex opens the API page, no cookie, no dependency), #194 (conflicts listed, owner decides, agent value used until then), #195 (per-assessment policy with a course default), #196 (unknown stays uncapped, no forced re-read), #197 (resolution order).

## Goals / Non-Goals

**Goals:**
- Catch wrong or missing exact Canvas numbers (due, points, status, score, group weight) after every course read, in seconds, with fixed code.
- Let a policy apply to one assessment without changing the rest of the course, and never let an item-level `allowed` lift a course-level ban.

**Non-Goals:**
- No Ed check (Ed has few weights and dates; reconsider later).
- No full API sync, no crawling, no new assessments created from Canvas (missing assignments are reported only).
- No cookie or Keychain access, no Edge remote debugging, no new dependency.
- No forced policy re-read before L1/L2 work (#196).

## Decisions

**D1. One URL, copied through the clipboard.** Codex opens `/api/v1/courses/{id}/assignment_groups?include[]=assignments&include[]=submission&per_page=100`, presses select-all and copy, then calls `canvas.check {jobId, courseKey}`; the command reads the clipboard (`pbpaste` on macOS) itself.
- Why one URL instead of the two in #193: the assignment-groups endpoint with `include[]=assignments&include[]=submission` returns groups, weights, assignments, due dates, points and the owner's submission in one array, so one tool call holds everything and no cross-call state is needed (Codex's tool calls run in a separate `coursework mcp` process, so state would have to go into the store). Same intent as #193, fewer moving parts. If the live probe (task 1.1) shows the student session cannot use these includes, fall back to the two URLs of #193 and keep the first page's parsed facts per job in the store.
- Why the clipboard instead of a tool argument: a course's JSON can be hundreds of kilobytes (assignment descriptions). Passing it as an argument would make the agent transcribe it, costing tokens and risking silent edits; the check would then no longer be independent of the agent. The clipboard keeps Codex as a mover only.
- Alternatives rejected by the owner: code reading Edge cookies (reads the owner's session credential, against #181's stance); re-enabling Edge remote debugging (brings back what C-3 removed).

**D2. Tolerant, strict parsing.** Strip everything before the first `[` (covers `while(1);` and a JSON-viewer label), parse with a zod schema of only the needed keys (unknown keys stripped), require every `course_id` to equal the Course's Canvas source id, cap at 5 MB. Raw text is never stored or logged. 100 groups (page full) marks the check `partial`.

**D3. Compare stored platform values, field by field.** Matching uses the Canvas id inside the item key (`CODE:canvas:assignment:<id>`). Due equal to the minute; points and score as numbers; status through a fixed mapping (`unsubmitted` matches `not_started` or `in_progress`). Canvas `null` means no evidence. Component weight is compared only when the component's Canvas items all sit in one group that holds no other component's items (derived from `assignment_group_id`, never from names) and the course has a non-zero group weight. Annotations are not compared: they are already a newer, cited or owner value.

**D4. Conflict records, owner resolution by field.** A new append-friendly `check_conflicts` table holds one row per open (course, target, field). `check.resolve` is an owner command (owner session only). Choosing Canvas applies through the mechanism each field already has:
- `due`, item `weight`: an owner annotation, effective at once (existing precedence).
- `status`, `score`, `outOf`: these have no annotation field, so the stored platform value is updated with `readState.via = "api"`; the importer keeps it while the Canvas value in the open-or-resolved conflict is unchanged, so the next agent read does not undo it.
- component `weight`: component weights live only in the import mapping (they drive even splits and remainders), so the resolved value is applied by the importer from the next import on. "Needs you" says so.
Choosing the agent closes the row and suppresses the same value pair. Alternative considered: adding `status`/`score`/component annotations; rejected because it widens the annotation model for one feature.

**D5. Unconfirmed, not replaced.** Until resolved, reads return the agent value as effective with an `unconfirmed` flag and the Canvas value beside it (#194). Planning and the grade projection are unchanged by an open conflict.

**D6. Policy resolution in one function.** `AssessmentAutonomy.policy(courseId, assessmentId?)` returns `{ value, origin, level }` by #197: owner assessment value; else `prohibited` if owner course, agent course or agent item is prohibited; else nearest known (agent item, owner course, agent course); else unknown. Cap and `autonomy.read` use it per assessment. The course-level lock in the UI uses the course-level part only. Component Assessments take `prohibited` if any item is prohibited, else the agreed value; remainders take none.

**D7. Storage.** Assessment gains `aiPolicy` (and its read state inside the existing `readState` JSON); one additive migration adds the `aiPolicy` column and the `check_conflicts` table (local-store "Additive migrations"; data model approved by #195).

## Risks / Trade-offs

- [The assignment-groups includes are refused or shaped differently for a student session] → Task 1.1 probes live first; fallback is the two URLs of #193.
- [Edge's JSON viewer copies formatted text or adds labels] → Strip before the first `[`; JSON whitespace is harmless; the probe confirms what select-all copies.
- [The owner copies something else between Codex's copy and the tool call] → The `course_id` check and schema refuse it; the tool asks for a fresh copy; nothing is stored.
- [Clipboard reading is macOS-specific] → The project runs on the owner's Mac; the reader sits behind one function so tests inject text.
- [Status mapping hides a real difference, for example `unsubmitted` vs `in_progress`] → Accepted: Canvas cannot tell those apart.
- [Component weight resolution waits for the next import] → Shown in "needs you"; the alternative needs a stored document or new annotation kinds.
- [`prohibited` wins at any level, so an outdated course ban blocks an assessment the syllabus allows] → The owner sets that assessment's policy; owner assessment values are final.

## Migration Plan

One additive migration; no rows rewritten. Existing courses keep their course `aiPolicy` as the default; assessments start with no policy (unknown), so nothing gets less restricted. Rollback: the migration's column and table are unused by older code.

## Open Questions

- Does the student session accept `include[]=assignments&include[]=submission` on assignment groups, and what does Edge's select-all copy from a JSON page? (task 1.1)
