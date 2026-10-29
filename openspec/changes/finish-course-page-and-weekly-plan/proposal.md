## Why

The v2 course page and week view show three entry points that do nothing (the final-needed target always reads "—", the Revision tab says it is not connected, and "Add task" is disabled), and the week view only shows work the owner planned by hand: synced deadlines never appear and nothing is scheduled ahead of a deadline. The home page therefore does not answer "what should I do this week", which is the product's main promise (PRD US-3, US-6).

## What Changes

- **Final-needed target:** the course page computes, for the chosen band (H1 80, H2A 75, H2B 70, H3 65, P 50), the average still needed across all weight that has no mark yet, and says when the band is already secured or out of reach (decision #235).
- **Revision tab:** shows the course's exams (date, weight, rule), offers buttons that open the Agent page and send a preset revision prompt, and lists revision notes the owner saved from Agent replies. Saved notes live in `.local/revision/` through a new loopback API and persist across sessions (decision #236).
- **Manual tasks:** "Add task" creates a task with a title, deadline, estimate and an optional course; tasks outside coursework are allowed.
- **Weekly plan:** the owner sets available minutes per weekday; a deterministic earliest-deadline-first scheduler fills days from today, splitting tasks across days (decision #237); minutes that cannot fit before their deadline are listed instead of dropped.
- **Deadlines on the calendar:** synced assessment deadlines (with the owner's corrections) and task deadlines show on the week and month views.
- **Actual time:** each task records minutes spent and a done state; done tasks show estimate against actual.
- **Needs-you strip:** the week view lists overflow, overdue unfinished tasks, failed course syncs, and graded assessments due within seven days that have no plan.
- Out of scope: L0/L1/L2 autonomy levels and any executor (decision #238), task start times, hurdle-aware grade targets, and changes to the course JSON contract.

## Capabilities

### New Capabilities

- `grade-target`: the final-needed calculation and its display on the course page.
- `revision`: the Revision tab, preset prompts to the Agent page, and saved revision notes with their local API.
- `weekly-plan`: availability, manual tasks, the scheduler, overflow, calendar deadlines, actual time, and the needs-you strip.

### Modified Capabilities

None. There are no current specs in `openspec/specs/` (v1 specs left the main line with decision #223).

## Impact

- `shared/course-calculations.ts` (new `finalNeeded`), new `shared/planning.ts` (scheduler), new `scripts/lib/revision-store.mjs` (+ `.d.mts`).
- `vite.config.ts`: new route `/api/local/revision-notes` behind the existing same-origin guard.
- `web/src/LocalPlanning.tsx`, `web/src/Agent.tsx` (save-to-revision, preset prompt), `web/src/App.tsx` (agent request carries a prompt), `web/src/style.css`.
- Browser storage: new keys for availability and targets; the existing task key gains optional `spent` and `done` fields (older entries stay valid).
- No new dependencies; no change to `shared/course-data.ts`.
