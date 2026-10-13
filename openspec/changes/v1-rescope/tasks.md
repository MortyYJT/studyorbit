Each numbered group after 1 is one issue: one standalone clone on a `codex/<topic>` branch (Codex implements, never commits), with Claude opening the PR and merging after a fresh-context review and green CI. Every code task is TDD: write a failing test on synthetic fixtures under `test/`, record the red output, write the smallest passing change, record the green output. Each issue ends with `bash .claude/check.sh` output, a privacy/diff check and the review. Real course data, profiles and tokens stay in `.local/`. Deletions follow decision #100's list only (owner approval, 2026-10-14). The only target date is the revision skill: **usable on one real course by 2026-10-26** (#102). Order: A → B → C → D (D may run alongside E–F) → E → F → G → H → I → J.

## 1. Spec housekeeping (this PR)

- [x] 1.1 Close `v1-foundation` 5.5 using the owner's 2026-10-13/14 sign-ins as evidence and archive it with specs
- [x] 1.2 Close `capture-selection-ed` 3.9/3.10 (#100) and archive it with specs, after `v1-foundation`
- [x] 1.3 Move `v1-protocol` issue I into this change and archive it with specs
- [x] 1.4 Close `v1-sync`, `ed-quiz-assist` and `v1-ui` with `--skip-specs`, each with a closing note in its tasks
- [x] 1.5 Write this change's proposal, design, delta specs and tasks; `openspec validate v1-rescope --strict` passes
- [x] 1.6 Record the owner's 2026-10-14 choices in `note/decisions.md` and update `note/handoff.md` and `note/product/roadmap.md`

## 2. Issue A — Remove cut code

Scope: deletions and the minimum rewiring to keep `main` green. No new behavior.

- [ ] 2.1 Move the policy, grant, binding and audit schemas and file helpers that `src/protocol/authorization.ts`, `audit.ts` and `contracts.ts` import from `src/quiz/` into `src/protocol/`; port their tests first and keep them green
- [ ] 2.2 Delete `src/quiz/`, the `quiz` CLI commands and `test/quiz/`; delete `src/protocol/actions.ts`, the fill/submit/review contracts and their tests
- [ ] 2.3 Delete the Canvas crawl, terminal picker, selection store/resolver, discovery, Canvas probe, capture REPL session and `capture` command, and their tests; keep `browser.ts`, `lock.ts`, `limiter.ts`, `ed-transport.ts`, `ed-snapshot.ts` and anything they import
- [ ] 2.4 Delete `src/sync/diff.ts`, `reconciliation.ts`, `changes-handler.ts`, the `changes` command and change-seq repository methods and their tests; stop all writes to the change-event table without dropping it
- [ ] 2.5 Remove `Change` from the domain schemas and add the iCal/Change guard tests from the `domain-model` delta
- [ ] 2.6 Delete branch `codex/quiz-fill` and drop `codex/ui-inventory`; list every deleted path in the PR description

## 3. Issue B — Resident browser

- [ ] 3.1 Failing tests with an injected launcher/clock: `browser start` launches once with a loopback debugging port, writes `browser.json` (0600) and holds the lock; a second start returns the same endpoint; stale files are cleared; `stop` cleans up
- [ ] 3.2 Failing tests: attach helper opens and closes only its own tabs; no resident browser gives one `AUTH_EXPIRED` envelope without launching
- [ ] 3.3 Failing tests: `browser status` per site with synthetic Canvas/Ed responses (signed in, login redirect, missing Ed token), no body content in output, limiter used
- [ ] 3.4 Failing tests on a synthetic page: highlight-then-click helper (outline, ≥1 s wait, one click; refuse hidden targets)
- [ ] 3.5 Owner check on the real profile: start Edge, sign in by hand, run `status`, leave it overnight and record the actual session lifetime; record whether remote debugging works on the managed profile or the fallback in design Decision 2 was used

## 4. Issue C — Protocol integration without gates

- [ ] 4.1 Rebase the useful parts of `claude/protocol-integration` onto A: production registry assembly and the integration tests that do not touch fill/submit/Q1; remove `note/issue-77-integration.md`; make tests use a temporary data directory, never the default one
- [ ] 4.2 Failing tests for `autonomy.check` (no policy, prohibited, exam, unknown kind, wrong grant, audit failure → denied) and `audit.record` (L4 needs a confirmation method; no answer text stored)
- [ ] 4.3 Failing tests: non-TTY owner commands are refused (planning settings also accept the #86 owner-token HTTP flow); one envelope per CLI call; MCP does not list owner-only commands
- [ ] 4.4 Write the assessment skill: call `autonomy.check` first and stop on `denied`; list all answers in chat and wait for the owner's confirmation before an L4 submit (#97); use the highlight-then-click rule (#98); record each browser write with `audit.record`. Reading quiz pages raw stays blocked until the owner confirms #96

## 5. Issue D — Revision skill (target 2026-10-26)

- [ ] 5.1 Failing tests for a SQLite `study_record` migration and store with compare-and-swap publication, surviving a reopen; replace `InMemoryStudyRecordStore` in production wiring
- [ ] 5.2 Install pre-approved `unpdf@1.8.1` with the owner present; failing tests with generated synthetic PDFs and pages for `source.fetch` (same-origin only, redirect refusal, size bound, per-page SourceItems, redaction, private raw files, empty image-only pages)
- [ ] 5.3 Write the skill file and scheduled-task prompt: status check first, find material only through L0 reads and `source.fetch` (no raw page reading), write cited notes and questions, notify with counts; interactive stage reads stored material and records weak topics in notes
- [ ] 5.4 Synthetic end-to-end run with fake browser and synthetic course content: signed-out stop, rejected citation counted, notes readable after restart
- [ ] 5.5 Owner acceptance on one real course by 2026-10-26: run the scheduled stage, then a tutoring session; record actual counts and problems in the PR, separately from synthetic results

## 6. Issue E — Schema and store for the new model

- [ ] 6.1 Failing schema tests: `Course.sources`, optional `Assessment.kind`/`weight` with `origin`, `SourceItem.removed`/`facts`, `AssessmentLink`, `Annotation` (agent needs citations), `PlanningSettings`, Run measurements
- [ ] 6.2 Failing tests for course weight validation with unknown weights and for grade projection `weights_unknown` first in the unavailable order
- [ ] 6.3 Failing migration tests on a synthetic database with old rows: additive tables/columns only, old change-event rows untouched; repository methods for the new entities

## 7. Issue F — `coursework sync`

- [ ] 7.1 Failing tests with synthetic Canvas JSON: active current-term enrollments, assignments, groups, owner submissions, modules; pagination bounded; no bearer header, no other students' submissions
- [ ] 7.2 Failing tests for course merging: single code match merges; no match or duplicate codes stay separate and are reported; names ignored
- [ ] 7.3 Failing tests for facts and sync assessments: Ed `effective_due_at` precedence; weighted Canvas groups create linked sync assessments; no split or zero weights; annotated fields and agent/owner links not overwritten
- [ ] 7.4 Failing tests: one transaction per course; complete reads mark missing items removed; partial reads remove nothing; redaction before storing; source-isolated auth expiry; shared limiter; measured Run
- [ ] 7.5 Wire `coursework sync [--course]` through the registry; owner live check on the real profile with results recorded in the PR

## 8. Issue G — Agent annotations

- [ ] 8.1 Failing tests: agent annotation with a valid citation applies; invented or stale quote is rejected with nothing changed and a ledger entry; owner annotation needs a TTY
- [ ] 8.2 Failing tests: syllabus-only assessment creation, one-to-many links, moving a link keeps history, cross-course links rejected
- [ ] 8.3 Failing tests: precedence owner > agent > sync; append-only history; reads return effective values with origin and citations; unknown kind stays unknown

## 9. Issue H — Planning

- [ ] 9.1 Failing tests for owner settings save/validation and the non-TTY refusal
- [ ] 9.2 Failing tests for the pure EDF planner: overdue first, undated last, splitting, stable ties, 180/120/60 overflow, unestimated items, identical outputs, time-zone day boundaries
- [ ] 9.3 Expose `plan.read` with inputs from stored tasks and unsubmitted platform items

## 10. Issue I — UI on real data

- [ ] 10.1 Failing tests: `coursework ui` serves the prototype from the HTTP process on 127.0.0.1 with Host/Origin checks, opens the system browser or prints the URL
- [ ] 10.2 Replace the prototype's sample data with fetches to the L0 reads; show origins, citation quotes, unknown weights, overflow and unestimated work; show the empty-store message
- [ ] 10.3 Verify in a real browser with synthetic data at narrow and wide widths; attach screenshots to the PR

## 11. Issue J — Acceptance and archive

- [ ] 11.1 Synthetic end-to-end test: browser status → sync → annotations → plan → UI reads → revision skill writes
- [ ] 11.2 Owner acceptance with the real profile, listing what passed and what was not tested
- [ ] 11.3 `openspec validate v1-rescope --strict`, `bash .claude/check.sh`, `npm run build`; archive `v1-rescope` with specs; update the roadmap and handoff
