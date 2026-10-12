Implementation follows this change as the sole spec. Every code increment below starts with a meaningful
**failing synthetic test**, records red evidence, implements the minimum passing behavior, then records
its targeted green run. Fixtures live only in `test/`; no real captured/redacted quiz content is a fixture.
Review/verification and live acceptance tasks are gates, not invented failing tests. Codex implements in
standalone clones on `codex/<topic>`, never commits; Claude creates issues, checks private visibility before
pushing answering code, handles commits/PRs/CI/merge and archive. Do not change CI, dependencies, domain
schemas or SQLite migrations. Unexpected model/schema needs go to Open Questions before implementation.

Issue-sized groups run in dependency order A → B → C → D → E. S0 issue C's transport must merge before A
is integrated. Proposed checkpoints: A/B by 2026-10-16, C by 2026-10-18, D by 2026-10-20, E delivery and
Claude structure check by 2026-10-22; **owner real-quiz test by 2026-10-23**, due 2026-10-25. These are
planning targets, not completed outcomes; Claude records/replans slips rather than silently moving dates.
Each group ends in a fresh-context read-only review and `bash .claude/check.sh` (= `npm run check`) output.
Fix correctness/requirement gaps before merge, preserving failing-first evidence for fixes.

## 1. Bounded selected-quiz read (issue A)

Scope: `src/quiz/read` adapter/validation modules, reusable handler and read CLI wiring; synthetic
`test/quiz/` tests. Reuse S0 profile/transport/selection/limiter contracts; no edits to their behavior.
Acceptance maps to selected transport and bounded/redacted read scenarios in the delta spec.

- [x] 1.1 Reconcile merged S0 and available foundation/current-truth specs; confirm exact injectable transport/lock/limiter/envelope interfaces. Record baseline `bash .claude/check.sh` output and concrete schema needs as open questions, without creating new entities or migrations.
- [x] 1.2 Write failing fake-transport tests for selected course/lesson/reference validation, same-origin GETs, no `view`, page-local regional `authToken`/`x-token` isolation, missing-token/401/403 `AUTH_EXPIRED`, shared cap/spacing and no retry on refusal; implement the minimal quiz read adapter. Reuse upstream transport tests for its internal auth mechanics and add boundary sentinel checks that Q1 never receives/export tokens.
- [x] 1.3 Write failing synthetic lesson/slide tests for stable question references, supported/unsupported structure, deterministic nested/free-text classmate redaction and withholding unsafe content; implement validated model-safe question/source output with explicit coverage, never grades/hidden solutions/other students' answers.
- [x] 1.4 Write failing CLI/envelope tests for a single stdout envelope, source/validation failures, profile `LOCKED`, 64 KiB limit and question narrowing without truncation; implement `coursework quiz read` with validated reusable handler and safe stderr diagnostics, no credential prompt without TTY.
- [x] 1.5 Run targeted green tests, fresh-context read-only review against the transport/read scenarios, `bash .claude/check.sh` and diff/privacy checks; record outputs and fixes for Claude's issue A PR, without committing.

## 2. Local policy, grants, audit and cited proposals (issue B)

Depends on A's assessment/question/source references. Scope: private operational record handling in
`src/quiz/`, propose/policy/grant CLI wiring and `test/quiz/`; shared domain/store schemas are out of scope.
Acceptance maps to policy/grant, cited proposals and append-only audit scenarios.

- [x] 2.1 Write failing tests for allowed/prohibited/dated owner-attested policy records, explicit per-assessment grants, course-cap checks, absent policy/grant and exam/unknown-category denial, and real-Q1 prerequisite checks; implement validated local records and explicit owner recording actions. Bind #75 only to the actual Q1 course, not a default policy for every course.
- [x] 2.2 Write failing synthetic tests for append-only successful/failed quiz-read and policy/grant/proposal/denial audit events, run/revision linkage, safe errors and pre-mutation audit failure. Exercise read success and invalid-target/authentication/transport/source-validation/output-limit failures; assert read events contain only safe timestamp/run metadata, validated assessment reference when available and sanitized outcome code, omitting unvalidated target input, raw payloads/exception messages, question/options/source text, personal-data sentinels, tokens and auth headers. Implement private audit intent/outcome handling and wire read outcomes from issue A, without tokens, question text, answers, quotes or personal data in messages.
- [x] 2.3 Write failing synthetic tests requiring each answer proposal to cite its specific question and every course-material statement in its answer/rationale to cite that material, plus trusted source lookup, NFKC/whitespace/quote matching, checked locator/offset/page and fabricated sources. Include rejection tests for a matching citation to another question/material source only, and for a material statement in either answer or rationale covered only by the question citation; assert `CITATION_MISMATCH`, safe run-ledger failure and preservation of the previous accepted revision. Include acceptance with both required citation kinds and prompt-only provenance with no course-material statements, visibly marked as an evidence limitation. Implement proposal validation using existing Citation fields and local validation metadata only.
- [x] 2.4 Write failing tests for assessment/question binding, atomic versioned proposal writes, previous revision preservation, owner-only permissions, ignored `.local/` default/private override, traversal/symlink escape and malformed references; implement `coursework quiz propose` and private persistence without SQLite/domain migrations or model calls.
- [x] 2.5 Run targeted green tests, fresh-context review against policy/proposal/audit scenarios, `bash .claude/check.sh` and diff/privacy checks; provide Claude outputs and unresolved concrete schema needs for issue B, without committing.

## 3. Exact-revision terminal review (issue C)

Depends on B. Scope: terminal review module/CLI and `test/quiz/` fake-TTY tests; no browser filling yet.
Acceptance maps to explicit terminal approval, cancellation/non-TTY and stale-revision scenarios.

- [x] 3.1 Write failing TTY tests for displaying every question/answer/rationale/citation locator, target identity and unsupported/prompt-only evidence indicators; implement `coursework quiz review` for a specific proposal revision.
- [x] 3.2 Write failing tests for explicit approval/rejection, cancellation/timeout, non-TTY denial, audit failure, approval bound to proposal/source identity and no implicit grant/policy changes; implement approval persistence and safe review outcomes.
- [x] 3.3 Write failing tests for edited proposal, changed source/question/page/attempt identities and concurrent replacement invalidating review with `CONFLICT`; implement the reusable reviewed-revision preflight contract for D.
- [x] 3.4 Run targeted green tests, fresh-context review against terminal review scenarios, `bash .claude/check.sh` and diff/privacy checks; provide Claude outputs for issue C without committing.

## 4. L3 page fill and passive owner-submission observation (issue D)

Depends on A–C. Scope: Playwright page adapter, fill/observation handlers/CLI, local sanitized artifact
writer and `test/quiz/` synthetic DOM/network tests. No submission endpoint implementation or replay.
Acceptance maps to fill, audit-failure and passive-observation scenarios. Unverified widget/endpoint
structures remain adapter evidence gaps; synthetic success is not proof of real Ed compatibility.

- [ ] 4.1 Write failing tests for matching already-open managed-profile quiz/attempt, current policy/L3 grant and exact review revision, full preflight, wrong page, unsupported/auto-submit widgets and `LOCKED`; implement preflight without opening/starting an attempt or navigating to a guessed page.
- [ ] 4.2 Write failing sentinel tests for recursive token/auth/CSRF removal, header exclusion, query/fragment/sensitive path and dynamic-key removal, all scalar values omitted, bounded body shapes and unknown encodings with no raw fallback; implement the transient sanitizer and private structural artifact writer, with no HAR/traces/screenshots.
- [ ] 4.3 Write failing fake-page tests for listener armed before mutation, reviewed-assessment correlation, ignoring autosave/analytics/unrelated requests, ambiguity/missing request outcomes, bounded timeout/cancel/page-close cleanup and lock/session release; implement passive observation that keeps the visible managed session alive for the owner's manual action and never causes/retries/replays a submit.
- [ ] 4.4 Write failing synthetic DOM tests for deterministic supported-control filling/readback and zero Submit/Finish/Next clicks, submit keypresses or direct submission calls; implement `coursework quiz fill` using approval and current grant. Test mid-fill errors/partial mutation, pre-audit failure and post-mutation audit failure; stop and report actual/uncertain state without blind retry or false rollback.
- [ ] 4.5 Run targeted green tests, fresh-context review against fill/observation/audit scenarios, `bash .claude/check.sh` and diff/privacy checks; provide Claude outputs for issue D without committing. Claude re-verifies private GitHub visibility before any answering code push.

## 5. Integration, acceptance handoff and final Claude structure check (issue E)

Depends on A–D and merged S0. Scope: synthetic CLI workflow tests, English CLI acceptance guidance and
Chinese milestone/handoff evidence under `note/`; any fixes stay within A–D scope. Owner test deadline is
2026-10-23. Archive is Claude's later closeout after actual acceptance and dependency archives, not this
draft or the structure check alone. No task here authorizes an automated or exploratory submission.

- [ ] 5.1 Write failing end-to-end synthetic workflow tests: bounded read → granted cited proposal → explicit TTY approval → gated fill → owner-simulated request observation; cover denied policy, expired auth, stale review, unsupported widget, listener cleanup and secret/privacy sentinels. Implement only integration fixes and record targeted green output.
- [ ] 5.2 Prepare a 3–5 step owner acceptance checklist with exact implemented CLI syntax: verify private visibility and locally record actual-course policy/non-exam binding/L3 grant; read and save a cited agent proposal locally; explicitly approve it in terminal; fill/read back and inspect the open page; manually click submit and check the sanitized artifact. State that observation is not grade confirmation. Deliver for owner execution by 2026-10-23; no passwords/real quiz content in docs.
- [ ] 5.3 Run fresh-context read-only integration review, `bash .claude/check.sh`, `npm run build`, `openspec validate ed-quiz-assist --strict` and diff/privacy checks; record exact outputs and unverified live items in `note/handoff.md`. Claude checks CI and visibility before PR merge; do not claim real acceptance from synthetic checks.
- [ ] 5.4 **Final task — Claude-run real structure check by 2026-10-22 for owner testing by 2026-10-23.** On the owner's managed profile, run the read-only quiz structure check: first verify private-repository prerequisite and actual-course policy record; inspect only safe lesson/slide field types, stable ids/attempt binding and DOM control structure, no fills/submits or view-marking calls. If not logged in, return `AUTH_EXPIRED` gracefully with owner login/MFA guidance, record the block and leave real acceptance unverified. Keep real content only in private `.local/`; never copy it into Git/test fixtures. If authenticated, record safe structure evidence and supported-control coverage; any necessary fix starts with a failing independently synthetic regression test, then targeted green, project check and fresh-context review before owner use. Submission shape remains unverified until the owner manually submits with observation armed; record actual acceptance separately, and Claude archives only after that outcome and prerequisite archives.
