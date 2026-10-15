Each numbered group after 1 is one GitHub issue: one standalone clone on a `codex/<topic>` branch (Codex implements, never commits), Claude opens the PR and merges after a fresh-context review and, for code, green CI (#40, #48, #49, #156). Work runs unattended through the scheduled dispatcher (#155). Every logic task is TDD (small non-behaviour changes skip it, #156): a failing test on synthetic fixtures under `test/`, the red output, the smallest passing change, the green output, all in the PR description (#90). Each issue ends with `bash .claude/check.sh`, `npm run build`, a privacy/diff check and the review. Real course data, profiles, screenshots and secrets stay in `.local/`. "Covers" lists the PRD acceptance items (`note/product/prd.md`) the issue must satisfy; the issue copies them as its checklist. Order and parallel lines: design Decision 13. No target dates (#67, #127).

## 1. Housekeeping (this PR)

- [x] 1.1 Archive `v1-rescope` with only the specs `main` implements (A–C); move its unimplemented deltas here; delete the empty `course-selection` spec; `openspec validate --specs --strict` passes
- [x] 1.2 Write this change's proposal, design, specs and tasks; `openspec validate v1-delivery --strict` passes
- [x] 1.3 Record the owner's 2026-10-15 choices (#147–#150) and Claude's choices (#151–#153) in `note/decisions.md`; update `note/handoff.md` and `note/product/roadmap.md`
- [x] 1.4 During dispatch: create one issue per group below with its "Covers" checklist; close superseded issues #31, #44, #46, #55, #77, #79 and #92 with a pointer here; decide whether the unpushed `codex/revision-skill` clone is reused for group 8 (it only installs `unpdf@1.8.1`)

## 2. Issue A — Schema and store

Covers: foundation for all stories. Spec: `domain-model`, `local-store`.

- [x] 2.1 Failing schema tests for every new entity and field in `domain-model` "Entity fields", including the `quiz` kind, agent estimate without reason, level out of range, agent annotation without citation, `platform: "ical"`
- [x] 2.2 Failing tests: course weight validation with unknown weights; grade projection `weights_unknown` first in the unavailable order
- [x] 2.3 Failing migration test on a synthetic database with change-event rows and an old L4 grant: one additive migration creates all new tables and columns, old rows unchanged
- [x] 2.4 Repository methods (read and append) for each new entity, with tests on the in-memory store; data-directory paths for `materials/`, `screenshots/`, `agent-workspace/` with owner-only permissions and git-ignore tests

## 3. Issue B — Owner session, HTTP host and agent tool set

Covers: US-5 "MCP stays"; US-7 "only I set levels in the frontend". Spec: `web-ui` (owner session), `command-registry`.

- [x] 3.1 Failing tests: `coursework ui` creates an in-memory secret, opens the system browser with it in the fragment (injected opener), prints the URL on failure; no file under a temporary data directory contains it; restart invalidates it
- [x] 3.2 Failing tests: owner commands accept only the session header (constant-time compare); autonomy settings and confirmations refuse TTY; other owner commands accept TTY or session; the capability-file token is no longer accepted for owner commands; Host/Origin checks unchanged
- [x] 3.3 Failing tests: static serving of `dist/ui` with an allow-list, traversal and symlink refusal, API routes take precedence
- [x] 3.4 Failing tests: the registry builds an agent tool set with agent commands only and an agent context that cannot carry owner authority; MCP stdio still lists no owner commands

## 4. Issue C — Autonomy by type of work

Covers: US-7 items 1–4. Spec: `assessment-autonomy`. Depends on A; owner-only tests use an injected owner context until B merges.

- [x] 4.1 Failing tests for `required(kind)`, cap and effective level: prohibited → L0 even with an L2 override; no policy → L2 cap; exam and unknown → L2; override for another assessment ignored
- [x] 4.2 Failing tests for owner commands: set course policy, default level, per-assessment override (set and clear), confirm-before-submit; each audited; agent and TTY calls refused
- [x] 4.3 Remove `audit.record` from MCP and the agent tool set (browser tools write audit entries in group 11), with a test that it is not listed and cannot be called by an agent
- [x] 4.4 Rework `autonomy.check` to the new rules (audit unavailable still denies); old grant rows ignored; update `skills/assessment/SKILL.md` to the new levels and to using the browser tools

## 5. Issue D — `coursework sync`

Covers: US-1 items 1–5, item 6 manual part (email trigger deferred, #129). Spec: `coursework-sync`, `ed-capture`. Depends on A.

- [x] 5.1 Failing tests with synthetic Canvas JSON: active current-term enrollments, assignments, groups, own submissions, modules; bounded pagination; no bearer header; no other students' submissions
- [x] 5.2 Failing tests for course merging: single code match merges; no match or duplicates stay separate and are reported; names ignored
- [x] 5.3 Failing tests for facts and sync assessments: Ed `effective_due_at` precedence; weighted Canvas groups create linked sync assessments; no split or zero weights; annotated fields and agent/owner links not overwritten
- [x] 5.4 Failing tests: one transaction per course; complete reads mark missing items removed; partial reads remove nothing; redaction before storing; provider-isolated `AUTH_EXPIRED`; shared limiter; measured Run; Ed reads limited to sync scope
- [x] 5.5 Failing tests for `sync.run`: one run at a time (`LOCKED`), last run and last success per provider readable; wire `coursework sync [--course]`
- [ ] 5.6 Owner live check on the real profile; record actual counts and problems in the PR, separately from synthetic results

## 6. Issue E — Agent annotations and owner verdicts

Covers: US-2 items 1–4. Spec: `agent-annotations`, `validated-agent-writes`. Depends on A; owner-only tests use an injected owner context until B merges.

- [x] 6.1 Failing tests: valid cited agent annotation applies; invented or stale quote rejected with nothing changed and a ledger entry
- [x] 6.2 Failing tests: syllabus-only assessment creation, one-to-many links, moving a link keeps history, cross-course links rejected
- [x] 6.3 Failing tests: precedence owner > agent > sync; append-only history; reads return effective value, origin, citations and verdicts; unknown kind stays unknown
- [x] 6.4 Failing tests: owner "confirm" records verdict `correct`; owner "use my value" records an owner annotation and verdict `incorrect`; both owner-only

## 7. Issue F — Planning

Covers: US-3 items 1–7. Spec: `study-planning`. Depends on A; owner-only tests use an injected owner context until B merges.

- [x] 7.1 Failing tests for planning settings save/validation and agent refusal
- [x] 7.2 Failing tests for plannable work: submitted and removed items drop out; exams are deadlines only; manual tasks included
- [x] 7.3 Failing tests for the pure day-granular EDF planner: overdue first, undated last, splitting, stable ties, 180/120/60 overflow, unestimated, identical outputs, Melbourne day boundary
- [x] 7.4 Failing tests: agent estimate needs a reason; owner estimate wins; start times order a day (timed then untimed) and are dropped when the item leaves that day; time logs sum; manual task create/edit/complete/delete owner-only; all-day manual tasks take no minutes and sit on their date
- [x] 7.5 Expose `plan.read` (with estimates, start times, actual totals, overflow, unestimated) and the owner commands through the registry

## 8. Issue G — Revision

Covers: US-6 items 1–3 (backend). Spec: `revision`. Depends on A.

- [x] 8.1 Failing tests: SQLite study-record store with compare-and-swap, surviving a reopen; replaces `InMemoryStudyRecordStore` in production wiring
- [x] 8.2 Install pre-approved `unpdf@1.8.1` with the owner present; failing tests with generated synthetic PDFs and pages for `source.fetch` (same-origin only, discussion refused, redirect refusal, size bound, per-page SourceItems, redaction, private raw files, image-only pages)
- [x] 8.3 Failing tests: `exam-scope` record with cited topics (one bad quote rejects the write); exam time from the final's effective due; `practice.attempt.record` without answer text; per-course counts and wrong-answer list
- [x] 8.4 Write `skills/revision/SKILL.md` for the prepare, tutor and wrong-only presets: status check first, L0 reads and `source.fetch` only, cited writes, attempt recording, no fabricated sources, no graded work

## 9. Issue H — Chat backend

Covers: US-5 items 1–2 (backend). Spec: `agent-chat`. Depends on A, B.

- [x] 9.1 Define `AgentAdapter` and `AgentEvent`; a synthetic adapter for tests
- [x] 9.2 Failing tests: conversation service stores owner and agent messages with ordered parts, survives restart, lists newest first, owner-only delete
- [x] 9.3 Failing tests: SSE stream through the owner session; resume from `Last-Event-ID` without duplicates; events stored with no listener; stop interrupts and marks the message stopped
- [x] 9.4 Failing tests: preset registry renders each preset with stored ids and titles only; creating from a preset sends once (reload does not resend); no exam presets
- [x] 9.5 Failing tests: each reply records turns, tool steps and reported cost; unreported cost stored as unknown

## 10. Issue I — Claude Agent SDK adapter and tool policy

Covers: US-5 items 3 and 6. Spec: `agent-chat`. Depends on H. New dependency approved by the owner (#147).

- [x] 10.1 Install `@anthropic-ai/claude-agent-sdk` at an exact version; keep SDK types inside `src/agent/claude.ts`
- [x] 10.2 Failing tests with a stubbed SDK `query`: message mapping to `AgentEvent`s, session resume, in-process MCP tool set wired, `cwd` is the agent workspace, skills injected per preset, cost and turns read from the result, not-signed-in → `AGENT_UNAVAILABLE`
- [x] 10.3 Failing tests for the policy hook: data-directory access outside the workspace, `browser.json`, debugging port, local UI port, `coursework` owner commands, pseudo-terminal wrappers, `ps`, frontend origin are denied and stored as denied steps; ordinary workspace file writes are allowed
- [ ] 10.4 Owner live check: one real conversation through the frontend backend with the signed-in agent; record steps and cost in the PR

## 11. Issue J — Agent browser tools

Covers: US-5 item 4; US-7 items 3–4. Spec: `agent-browser-tools`. Depends on C, H.

- [x] 11.1 Failing tests on synthetic pages with a fake resident browser: `browser.open` origin allow-list (frontend, localhost, login and off-origin refused), tool-owned tabs only, sign-in page → `AUTH_EXPIRED`
- [x] 11.2 Failing tests for `browser.read`: quiz and workshop pages (Ed attempt lessons) unredacted except peer answers, discussion refused, other pages redacted, bounded, no hidden values
- [x] 11.3 Failing tests for writes: course/platform mismatch refused before highlight; denied check types nothing and audits a denial; allowed write highlights ≥1 s, acts once, screenshots, audits; audit failure after action reports uncertain state without repeating
- [x] 11.4 Failing tests for `browser.submit`: pending confirmation created with summary and screenshot; owner confirm releases one click (`owner-ui`); cancel, timeout and restart leave it unsubmitted; confirmation via MCP or without session refused; single use; confirmation off → `not-required`
- [x] 11.5 Every tool call emits a conversation step with outcome, screenshot reference and "view in Edge"
- [x] 11.6 Owner command that brings the resident browser's sign-in page to the front, for K1's sign-in status button (issue J2, #136; decision #160)

## 12. Issue K1 — Frontend shell, status and settings

Covers: US-1 items 5–6 (status, manual sync button; email trigger deferred, #129); US-7 item 5 (audit). Spec: `web-ui`. Depends on B; owner approval of `@types/react` and `@types/react-dom`.

- [x] 12.1 Scaffold `web/` with pre-approved Vite, React, react-dom and `@vitejs/plugin-react`; build into `dist/ui`; typed envelope client with zod; owner-session handling with unit tests
- [x] 12.2 Top bar (This week, Agent, sync button with running state), avatar menu panels: sync and sign-in status with "bring sign-in page to front", audit records, settings (weekday hours, time zone, theme, language); empty-store message
- [x] 12.3 Real-browser check at 390 px and 1440 px, light and dark, screenshots in the PR

## 13. Issue K2 — Week view

Covers: US-1 item 3 (listing); US-3 items 1, 5–8 (including all-day tasks in the top row). Spec: `web-ui`. Depends on F, K1.

- [ ] 13.1 View-model tests: seven columns Monday–Sunday, deadline row, timed-then-untimed order, used/available hours, overflow and unestimated lists, "needs you" items
- [ ] 13.2 Build the week view, week navigation, month calendar toggle, course side list with rings and next deadline, manual-task dialog, start-time and actual-time editing through the owner session
- [ ] 13.3 Real-browser check and screenshots as in 12.3

## 14. Issue K3 — Course page and assessment drawer

Covers: US-1 items 3–4; US-2 item 1 (display); US-3 item 4; US-6 item 4; US-7 items 1, 5–6. Spec: `web-ui`. Depends on C, E, F, G, K1.

- [ ] 14.1 Ring geometry tests (segments by weight, earned/lost/ungraded/unknown styles, centre total) and grade figures including `weights_unknown`
- [ ] 14.2 Course header (policy, default level, confirm switch, L0 lock for prohibited), Assessments tab (exams show "—", no agent entry), overrides through the owner session
- [ ] 14.3 Drawer with origin markers, citation popover with source link, "confirm" and "use my value", estimate with reason and owner override, actual time, linked items, preset buttons
- [ ] 14.4 Revision tab: exam time, cited scope, notes, practice stats, "tutor me" and "wrong answers only" buttons
- [ ] 14.5 Real-browser check and screenshots as in 12.3

## 15. Issue K4 — Agent page

Covers: US-5 items 1–2, 4; US-6 item 5; US-7 item 3. Spec: `web-ui`, `agent-chat`. Depends on I, J, K1.

- [ ] 15.1 Conversation list and view with streamed text, tool steps (expandable screenshots, "view in Edge"), denied steps, stop, send, reconnect
- [ ] 15.2 Preset arrival from the drawer, the revision tab and "needs you" sends once
- [ ] 15.3 Confirmation card (summary, screenshot, confirm and cancel) in the conversation and in "needs you"
- [ ] 15.4 Real-browser check with the synthetic adapter and screenshots as in 12.3

## 16. Issue L — Metrics

Covers: PRD §1 auxiliary metrics (#133). Spec: `metrics`. Depends on D, E, F, I; frontend panel after K1.

- [x] 16.1 Failing tests for `metrics.read`: sync duration and success per provider, accuracy with `no_labels`, estimate ratios (60/90, 120/120 → mean 1.25), agent steps/turns/cost with unknown costs excluded and counted
- [ ] 16.2 Metrics panel in the avatar menu showing values, counts and "unavailable" reasons

## 17. Issue M — Acceptance and archive

- [ ] 17.1 Synthetic end-to-end test: status → sync → annotations → plan → UI reads → preset conversation with the synthetic adapter → browser tool submit with confirmation → audit and metrics
- [ ] 17.2 Owner task R-B 3.5 (carried): start Edge on the managed profile, sign in by hand, run `browser status`, leave it overnight, record the sign-in lifetime and whether remote debugging or the fallback is used
- [ ] 17.3 Owner acceptance on real data against every PRD acceptance item of US-1, US-2, US-3, US-5, US-6 and US-7; failures become new issues linked to their story
- [ ] 17.4 `openspec validate v1-delivery --strict`, `bash .claude/check.sh`, `npm run build`; archive `v1-delivery` with specs; update the roadmap and handoff
