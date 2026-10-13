# M3 implementation tasks — v1-ui

This change is the M3 spec, not a second implementation specification. The current request writes documentation only: no implementation, package changes, live actions, decisions/handoff edits, commit or archive. All checkboxes below describe future work and remain unchecked.

Each group is one independently reviewable GitHub issue/standalone clone on `codex/<topic>`. Claude records design selections and reasons before the affected checkpoint, dispatches, commits/pushes/opens PRs and merges after fresh-context read-only correctness review and CI; Codex never commits. Split oversized groups into follow-up issues preserving checkpoints, rather than mixing protocol/storage work into a UI PR. No milestone dates (#67). Up to three implementation lines only after M2 contracts merge (#76); no dependency on an unmerged peer.

**Common TDD/verification checkpoint for every implementation issue:** first capture baseline; write a meaningful failing Vitest or Playwright test on independent synthetic fixtures in `test/`; record red output; implement minimal passing behavior; record targeted green output. Pure appearance checks use real-browser screenshots rather than manufactured unit failures. At issue completion run fresh-context review, `bash .claude/check.sh` (= `npm run check`), applicable build/browser checks and privacy/diff/dependency checks. Record exact command/output and limitations in the issue/PR. Review/acceptance are gates, not tests to fake. Existing Playwright/Vitest only; approved UI packages and their @types may be installed during implementation; anything outside #69 needs approval. No CI/deployment edits without permission.

| Issue | Deliverable | Merge/checkpoint dependencies | Contract seam |
| --- | --- | --- | --- |
| A | Hermes interface spike and M2 gap inventory | Approved M3; merged M2 source | Synthetic probe, no production mutation |
| B | Loopback UI host and validated HTTP client | A inventory; O1; O2 before owner bootstrap | Existing M2 HTTP with synthetic services |
| C | Read calendar/shell/drawer/grades | B; O4; O9 before uploads | Existing read contracts; synthetic calendar config until approved contract |
| D | Modules/manual/recurring edits, completion and manual grades | B, C; O3 and delivered protocol CRUD/occurrence contracts | Selected M2 owner mutation commands; no UI storage implementation |
| E | Pure EDF weekly plan and view | B, C; O4/O5; O3 availability/occurrence contracts for integration | Explicit pure inputs, then M2 configuration/current state |
| F | Cited study, scoring and weak-topic feedback | B, C; O3/O6 and delivered study-state contracts; H for open feedback | Revision/practice reads, agreed objective encoding, attempts/weak topics |
| G | Exact review, fill and submit confirmation UI | B, C; O2/O7 and delivered owner/action-state/confirmation contracts | M2 review/fill/submit/audit; fake drivers only |
| H | Chat/open-practice external-agent relay | A successful spike, B; O8 and merged M2 relay contracts | Browser HTTP → M2 → verified Hermes interface |
| I | Integrated acceptance and closeout | C–H plus real M2 host/service integration for accepted paths | Synthetic E2E first; owner permitted real acceptance separately |

**Protocol prerequisite checkpoint:** O3/O6/O7/O8 imply missing contracts, not approved implementation names/table layouts. Claude creates separate contract-sized protocol issues, specifies/reviews/merges them at M2 and records selected options before dependent UI implementation. Schema/storage changes outside approved scope require owner approval. Independent read UI/pure-function tests may proceed; disabled gaps never count as complete M3 acceptance. A failed Hermes spike blocks H and open-feedback acceptance only, with the required question to the owner.

## 1. Issue A — Start-of-M3 Hermes spike and contract inventory

Scope: synthetic local connectivity evidence and English integration notes; no UI logic, production data, model keys or remote action. Covers `ui-chat-relay` spike and `local-web-ui` missing-feature scenario.

- [ ] 1.1 Reconcile merged contracts/HTTP/action implementations and consumer guide; list delivered versus absent module/task/grade-save/read/config/attempt/weak-topic/chat/review/confirmation seams. Verify current upstream integration state rather than trusting old handoff claims.
- [ ] 1.2 Probe the installed Hermes interface with bounded synthetic input only; record callable address/protocol/auth shape safely, result/failure behavior and whether cancellation/streaming exists. No assumed chat API, secret output or package installation.
- [ ] 1.3 For a callable seam, write a failing synthetic probe/adapter-boundary test for success/unavailable/malformed/ambiguous delivery, implement only the probe seam and record targeted green. If none is callable, record evidence, stop relay work and ask before a substitute; continue independent M3 tasks.
- [ ] 1.4 Present O1–O9 and checkpoint-specific recommendations to the coordinator for recorded choices; create file-based prerequisite descriptions for separate M2 contract issues, not wire APIs invented by UI.
- [ ] 1.5 Run applicable common checks/review; **checkpoint:** safe spike evidence and explicit dependency inventory available. **Acceptance:** usable interface is demonstrated or honestly blocked; no model calls/real data/actions, no option silently selected.

## 2. Issue B — Same-origin host, HTTP client and synthetic mode

Scope: local host/CLI integration, approved UI scaffold and browser-safe client; no product storage or real actions. Depends on A inventory and O1; owner bootstrap requires O2 and its reviewed host contract. Covers `local-web-ui` hosting/client/session requirements.

- [ ] 2.1 Record O1/O2 selections and approved packages/@types; capture baseline and write failing host tests for 127.0.0.1-only bind, `dist/ui` static allow-list, traversal/symlink refusal, API precedence, same-origin guards and graceful close. Implement selected same-process composition without relaxing M2 POST/security/bounds.
- [ ] 2.2 Write failing `coursework ui` lifecycle tests for injected browser launcher success/failure and shutdown; implement approved build/launch path and safe URL fallback. Do not edit CI/deployment; production asset output must be `dist/ui`.
- [ ] 2.3 Write failing client tests for strict input/envelope validation, non-200 command failures, HTTP-200 partial/unavailable/uncertain data, opaque paging/filter reset, repeated cursors and stale responses; implement one typed M2 HTTP client. Ensure browser bundle excludes Node/server/Q1/fake host code.
- [ ] 2.4 Write failing synthetic security tests for selected bootstrap replay/expiry/origin checks, owner-field forgery, token persistence/log/referrer leakage and restart invalidation; implement only after O2's approved seam exists. No capability passed to chat or used as L4 consent; read-only mode remains possible.
- [ ] 2.5 Run synthetic host with independent schema-valid service fixtures through real loopback HTTP; no filtering assertions against fixed M2 examples. Verify build and real-browser loading with visible synthetic label and no production ports.
- [ ] 2.6 Run common review/check/build and targeted security checks; **checkpoint:** B merged before UI peers import client/host. **Acceptance:** `coursework ui` opens built same-origin SPA, malformed/foreign requests are refused and fixtures use no real browser profile/action adapter.

## 3. Issue C — Read-only calendar shell, evidence and grades

Scope: read views/prototype styles and pure presentation; no CRUD/plan/chat/action code. Depends on B and O4; uploaded-avatar handling awaits O9 and prerequisite contract. Covers shell plus planning calendar/evidence/grade scenarios.

- [ ] 3.1 Record calendar configuration selection; design views from approved prototype (#25/#31) and write failing view-model tests for month/week boundaries, course/module filtering, teaching-week breaks and undated work. Implement read views with explicit timezone/configuration and independent synthetic records.
- [ ] 3.2 Write failing drawer/evidence tests for citation text/hash/locator/page preservation, coverage gaps, empty/missing sources and stale selection; implement M2-backed drawer and safe text rendering, loading/empty/error/unavailable states.
- [ ] 3.3 Write failing grade presentation tests using existing domain examples, hurdle/unavailable/secured/unreachable and incomplete-coverage labels; reuse pure projection instead of new formula. Required manual weight/score entry is delivered by D after O3 grade contracts merge; this read-only issue alone cannot satisfy #28.
- [ ] 3.4 Build module rail/nearest deadlines and avatar status/metrics/theme/language/preset controls; display real ledger fields only and label examples. Avatar upload awaits selected safe protocol handling; unsupported sync-trigger controls stay unavailable.
- [ ] 3.5 Verify real-browser narrow/wide layouts, keyboard navigation, focus restoration, theme/language and reduced motion; save screenshots with synthetic data only. Run common review/check/build.
- [ ] 3.6 **Checkpoint:** read UI merged independently of missing CRUD/chat adapters. **Acceptance:** month/week and drawer work from HTTP data, undated/partial inputs remain visible, existing grade results render accurately and screenshots show approved shell without private identity.

## 4. Issue D — Modules, manual tasks, recurrence, completion and manual grades

Scope: UI consumers of delivered M2 CRUD/completion contracts; no direct storage/schema or protocol implementation. Depends on B/C; O3 and relevant module/task/occurrence and assessment weight/score save/read commands must be specified, reviewed and merged first. Covers module progress, manual/recurring editing and required manual grade save/reload/projection scenarios (#28).

- [ ] 4.1 Verify prerequisite command schemas, owner authority, version/conflict and occurrence semantics; record supported operations and no direct persistence fallback. If absent, keep feature pending and continue independent E/F synthetic work.
- [ ] 4.2 Write failing synthetic HTTP/browser tests for module create/edit, manual task add/edit, no manual citations, daily/weekly repeat with no Task.due and validation failures; implement forms through agreed commands only. Delete operations, if requested later, require explicit approval and separate scope.
- [ ] 4.3 Write failing tests for completion/version conflicts, independent recurrence occurrence state and authoritative reread after save; implement completion controls without optimistic claims of durable success.
- [ ] 4.4 Write failing progress tests for 3/5 example, zero denominator and recurring exclusion; implement delivery progress and daily recurrence summary (#31), no budget-type modules.
- [ ] 4.5 Write failing synthetic HTTP/browser tests for manually entering assessment weights/scores, validated owner save, rejected/conflicting save, authoritative reread and page reload; implement entry controls through the merged O3 M2 grade contracts only. Recompute the existing projection from confirmed saved values, not unsaved edits; Canvas auto-fill is later work. Missing contracts keep this required v1 feature pending.
- [ ] 4.6 Run common review/check/build and real-browser form/error screenshots; **checkpoint:** CRUD contract and UI state are one authority. **Acceptance:** edits survive protocol-backed reload, conflict preserves prior state, recurrence is not a fabricated due date/history, progress matches domain behavior, and manually saved weights/scores survive reload and drive the existing projection; failed/conflicting saves preserve prior authoritative values and projection.

## 5. Issue E — Pure EDF planner and weekly plan

Scope: pure algorithm plus planning view; no agent solver or new persistence. Depends on B/C and selected O4/O5; production integration needs O3 config/occurrence contracts. Covers EDF scenarios.

- [ ] 5.1 Record timezone/horizon/budget, tie, split, undated/past-due and recurrence selections before algorithm tests. Derive explicit pure input/output types without changing Task/schema silently; use injected dates rather than clock access.
- [ ] 5.2 Write failing tests for chronological EDF, stable ties, done steps, zero capacity, overflow conservation (180 work / 120 capacity / 60 risk), missing effort/dates and repeated identical inputs; implement smallest deterministic allocator.
- [ ] 5.3 Write failing tests for selected deadline/day boundaries, DST, teaching breaks and daily/weekly occurrence expansion/completion; implement selected rules without assigning due dates to recurring Task records.
- [ ] 5.4 Write failing HTTP/view tests for available-hour input and plan/risk presentation, rejected configuration, stale inputs and coverage gaps; integrate selected M2 config/current state. Pure previews must be labelled unsaved until persistence exists.
- [ ] 5.5 Run common review/check/build and plan screenshots; **checkpoint:** complete input accounting and daily capacity constraints pass. **Acceptance:** identical inputs reproduce plan, no work disappears, overflow/unknowns stay visible and authoritative configuration reloads through M2.

## 6. Issue F — Study page, objective practice and weak topics

Scope: study UI and browser grading, not generation/storage implementations. Depends on B/C, selected O3/O6 and merged attempt/weak-topic/answer semantics; open feedback integrates H. Covers all `ui-study` scenarios.

- [ ] 6.1 Write failing tests for course/week/revision selection, cited claims/PDF pages, partial/empty/unavailable reads and stale revisions; implement `revision.list`/`practice.list` study view using B client.
- [ ] 6.2 Record agreed answer encoding; write failing objective tests for correct/incorrect, unsupported/ambiguous encoding and cited explanation display; implement deterministic supported scoring in browser with no fuzzy/model grader.
- [ ] 6.3 Write failing attempt/weak-topic tests for course/question/revision binding, failed save, incompatible revision and reload; consume merged M2 state commands and selected topic rules, no browser-only permanent authority.
- [ ] 6.4 Write failing tests proving misses reach subsequent revision-plan inputs, pending feedback is not a miss and graded targets cannot bypass policy/exam caps through practice; integrate selected feedback seam and H open-answer request/results. M4 exam-window scheduling is excluded.
- [ ] 6.5 Run common review/check/build and study browser screenshots; **checkpoint:** F open-feedback acceptance waits for H, while objective reads/scoring can merge first. **Acceptance:** supported local scoring is accurate, citations visible, authoritative misses influence revision planning and unavailable agent feedback never fabricates a grade.

## 7. Issue G — Exact owner review, fill and confirmation UI

Scope: UI consumption of approved owner/action seams with synthetic drivers only; no real endpoint, Q1 TTY calls or protocol gate implementation. Depends on B/C; O2/O7 plus merged browser-owner review, authorization/action-state and confirmation contracts. Covers `ui-assessment-review` scenarios.

- [ ] 7.1 Verify prerequisite current-state/read/owner contracts and existing five-minute single-use confirmation lifecycle. Write failing policy/exam/prohibited/missing-grant/unknown-category tests; display authoritative restrictions without treating cached receipts or capability as authorization.
- [ ] 7.2 Write failing tests for exact answers/citations/limitations/revision display, explicit owner review, changed source/page/attempt/policy/grant invalidation and forged owner/prose consent; implement trusted review interaction through M2.
- [ ] 7.3 Write failing synthetic fill tests for one explicit L3 command, incomplete partial receipt with no automatic retry or complete-fill claim, no submit side effect, stale/revoked preflight and accurate filled/partial/unavailable/uncertain display; implement fill interaction. Do not claim real Q1 driver integration from fakes.
- [ ] 7.4 Write failing synthetic L4 tests for displaying exact filled answers, explicit click before token issuance, default confirmation, expiry/replay/cross-target denial, auto-submit default-off and retained exam/grant gates; consume server-issued confirmation then submit once. No UI boolean consent or confirmation secret in chat/log/storage.
- [ ] 7.5 Write failing partial (`retrySafe: false`)/disconnect/audit/UNCERTAIN/no-driver tests proving zero blind retries and no saved/fill-to-submitted inference; implement reconciliation display and audit references. Claude verifies current private visibility before any action/answer code push.
- [ ] 7.6 Run common review/check/build and action screenshots on synthetic HTTP only; **checkpoint:** all owner/protocol prerequisites and safety denials pass. **Acceptance:** exact review, independent fill and confirmed synthetic submit work; absent real M4 submit remains unavailable, with zero real remote writes.

## 8. Issue H — Hermes chat and open-practice relay

Scope: UI consumer and integration of a verified protocol relay; no model API, direct-browser Hermes connection or M4 scheduler. Depends on successful A, B, recorded O8 and merged M2 relay contracts. Covers chat lifecycle and F open feedback.

- [ ] 8.1 Record interface selection from A evidence, command schemas/level/privacy, limits/request identity and timeout/cancellation behavior. If unavailable, stop and ask before substitution; do not implement guessed routes.
- [ ] 8.2 Write failing synthetic HTTP/UI tests for trusted-server redaction or rejection of ALL outgoing text (user messages, subjective/open-practice answers and selected context) containing classmates' names, emails or student numbers, bounded messages, explicit context selection, safe external reply, unavailable/malformed/ambiguous delivery and forbidden credential/capability/raw-capture sentinels; include a direct M2 request bypassing browser sanitization and synthetic name/email/student-number sentinels in each text category. Assert at the Hermes receiving boundary that no original sentinel is received, safe text is redacted, and rejected/unsafe input causes zero relay calls. Implement chat panel through B client and delivered M2 relay.
- [ ] 8.3 Write failing tests for open-practice question/revision correlation, pending/unavailable feedback, agent prose trying to grant/review/submit and output writes requiring normal validation; integrate F without converting agent text into owner authority.
- [ ] 8.4 Write failing disconnect/reconnect/cancellation tests matching proven semantics; implement honest pending/uncertain states, no auto-replay and no claim that UI cancellation stopped external execution without evidence.
- [ ] 8.5 Run common review/check/build and browser screenshots; separately run a permitted synthetic-content live Hermes call if available. **Checkpoint:** documented local interface and merged relay, no direct model call. **Acceptance:** chat and open-feedback round trips traverse M2, secrets excluded, trusted-server redaction/rejection covers all outgoing text and synthetic Hermes receiving-end assertions prove no original classmates' names/emails/student numbers arrive, failures honest; fixture versus actual Hermes evidence separated.

## 9. Issue I — Integration, owner acceptance and archive

Scope: delivered M3 composition, synthetic integration tests and English acceptance docs; no extra product features, remote actions or data deletion. Depends on C–H and real upstream host/service delivery for paths claimed complete. Covers cross-capability acceptance.

- [ ] 9.1 Write failing actual-loopback/browser E2E tests for calendar → cited task → EDF risk → grade → study miss/revision input → open feedback and proposal → owner review → fake fill → fake confirmation/submit. Include paging gaps, malformed data, exam/prohibited denials, expired consent, audit failure and no automatic uncertain retries; integrate delivered modules using one client/host.
- [ ] 9.2 Run fresh-context read-only review, `bash .claude/check.sh`, `npm run build`, `npx openspec validate v1-ui --strict`, real-browser narrow/wide/keyboard/theme/reduced-motion verification and synthetic screenshots. Check production assets contain no host imports/fixture secrets/private identity, packages remain approved and no CI/deployment changed.
- [ ] 9.3 Deliver exactly 3–5 owner acceptance steps using implemented command/UI labels: (1) `coursework ui`, check month/week/deadlines/teaching weeks and cited drawer with actual private reads; (2) create a permitted manual recurring task/module, reload and inspect progress; (3) enter available hours, inspect EDF risk, manually enter and save assessment weights/scores, reload and verify saved values drive the grade projection and its assumption; (4) answer objective/open study items, verify cited feedback and weak topics reach revision input; (5) review synthetic proposal, fake-fill and verify default L4 confirmation/unavailable-real-submit. Specify expected results and separate synthetic action probe from real data. Login/MFA/policy setup remain owner operations outside UI.
- [ ] 9.4 Obtain owner pass/failure on permitted real acceptance, record unverified Hermes/auth/real fill and all real M4 submit limitations. Any real fill/submit needs a separate exact grant and explicit action authorization; never infer it from the checklist. Missing scoped CRUD/relay/confirmation contracts keep full M3 acceptance pending, even if read-only UI is good.
- [ ] 9.5 After actual required acceptance/review/check/CI, reconcile foundation/M1/M2 current-truth archive order, sync additive UI requirements and archive through Claude. No archive or handoff edit in this draft. **Checkpoint/acceptance:** exact evidence and remaining limitations are recorded; no pending requirement is ticked from fake success or unavailable controls.

Closed (2026-10-14, v1-rescope) without syncing specs, at the owner's choice: under decision #100 the agent works in chat, so the review/fill/submit screens and the Hermes chat relay are dropped. The surviving UI scope (the prototype reading real local data, plus the planning view) is specified in `v1-rescope` (`ui-live-data`, `study-planning`). Nothing here was implemented.
