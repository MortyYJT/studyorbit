## Context

The v2 web app keeps course selection, corrections and planned work in browser localStorage and reads synced course JSON through `/api/local/course-reports`. `shared/course-calculations.ts` already computes earned points and graded weight. Agent chats are stored in `.local/chat/` by `scripts/lib/chat-store.mjs` behind a same-origin guard in `vite.config.ts`. The week view today places a planned task only on the date the owner typed, and only planned tasks appear on the calendar.

Owner decisions: #235 (final-needed over all remaining weight), #236 (Revision = exam info + agent-generated notes saved locally), #237 (forward earliest-deadline-first), #238 (L1/L2 not now).

## Goals / Non-Goals

**Goals:**
- Wire the three dead entries with deterministic, tested logic.
- Make the week view useful without manual planning: deadlines appear, work is spread ahead of them, overflow is visible.

**Non-Goals:**
- Autonomy levels, AI policy, any executor (#238).
- Task start times and all-day rows (#143); hurdle-aware targets; exam-scope discovery during sync (would change the course JSON contract).
- Moving planning data out of localStorage.

## Decisions

1. **Pure functions in `shared/`.** `finalNeeded` joins `course-calculations.ts`; the scheduler lives in a new `shared/planning.ts`. Both take plain data and a `today` string, so tests need no DOM or clock. Alternative: logic inside `LocalPlanning.tsx` — rejected, untestable and the file is already large.
2. **Remaining weight is `100 − gradedWeight`, not the identified total.** Weight the sync did not identify is still part of the course; using the identified total would overstate what is needed or make targets look unreachable. The UI discloses unidentified weight instead.
3. **Scheduler fills task by task in deadline order.** For preemptive work with daily capacity, placing each task (in deadline order) into the earliest free days gives the same result as choosing the earliest-deadline task each day, and is simpler to read. Days run in Melbourne local dates (the existing `localDay`). Minutes are kept as given; no rounding. Overdue unfinished tasks go straight to overflow.
4. **Tasks keep the existing storage key.** `Work` gains optional `spent` and `done`; a task without a course uses `courseId: ''`. Old entries parse unchanged. `due` already meant "deadline" in the form label; only its use changes (it was the plan day).
5. **Revision notes in one JSON file**, `.local/revision/notes.json` (dir 0700, file 0600, atomic temp-file rename like `chat-store`). Course ids are validated by a strict pattern before use; note ids are server-generated UUIDs. Alternative: browser storage — rejected by #236 (notes should outlive a browser profile, like chats).
6. **Preset prompts reuse `AgentRequest`.** It gains an optional `prompt`; the Agent page starts a draft scoped to the course and sends the prompt once per request nonce. Sending still goes through the normal send path, so model errors surface the same way.

## Risks / Trade-offs

- [Single notes file grows] → capped at 200 notes per course and 20,000 characters per note.
- [Auto-sent prompt spends model credit] → only on an explicit click; the button label says it asks the agent.
- [Assessment dates without a time or in odd formats] → only `YYYY-MM-DD` prefixes are placed on the calendar; others stay visible on the course page.
- [Overflow from many tiny tasks clutters the strip] → strip groups by task and shows unplaced minutes once per task.

## Migration Plan

No migration. New storage keys default when absent; existing tasks keep working. Rollback is a revert; `.local/revision/` can be deleted safely.
