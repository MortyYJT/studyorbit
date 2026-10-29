## 1. Final-needed target (PR 1)

- [x] 1.1 Tests then `finalNeeded` in `shared/course-calculations.ts` (reachable, secured, unreachable, nothing left, nothing graded)
- [x] 1.2 Course page shows the result per band, remembers the band per course, and discloses unidentified weight

## 2. Revision (PR 1)

- [x] 2.1 Tests then `scripts/lib/revision-store.mjs` (+ `.d.mts`): list newest first, create, delete, validation, limits, permissions
- [x] 2.2 `/api/local/revision-notes` route in `vite.config.ts` (GET `?courseId=`, POST, DELETE `/:id`)
- [x] 2.3 Revision tab: exams with date, weight, rule; empty state; saved notes with delete
- [x] 2.4 Preset prompts: `AgentRequest.prompt`, Revision buttons, Agent page auto-sends once per request
- [x] 2.5 Agent page: "存到复习" on finished replies in single-course chats

## 3. Manual tasks (PR 1)

- [x] 3.1 Enable "Add task": title, deadline, estimate, optional course; external tasks kept and shown

## 4. Weekly plan (PR 2)

- [ ] 4.1 Tests then `shared/planning.ts`: deadline order, splitting, spent time, overflow, overdue, determinism, zero-capacity days
- [ ] 4.2 Availability editor (per weekday) stored in browser storage with defaults
- [ ] 4.3 Week view uses the schedule; week and month views show assessment and task deadlines once
- [ ] 4.4 Task list records spent minutes and done; done tasks show estimate against actual
- [ ] 4.5 Needs-you strip: overflow, overdue, failed syncs, unplanned graded deadlines within 7 days

## 5. Verification and close

- [ ] 5.1 `bash .claude/check.sh` passes; real-browser screenshots of course page, Revision tab, week view and strip
- [ ] 5.2 Fresh-context review of each PR; update `note/handoff.md`; archive the change after PR 2 merges
