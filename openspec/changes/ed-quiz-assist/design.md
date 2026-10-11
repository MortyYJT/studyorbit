## Context

This refines [v1 technical design sections 2–4, 6 and 7](../../../docs/engineering/v1-technical-design.md)
and [decisions #56, #57 and #75](../../../note/decisions.md). The owner tests by **2026-10-23**;
the real quiz is due 2026-10-25. This is L3: the owner submits. The obsolete iCal/no-L4 context in
`openspec/config.yaml` does not override the approved design or this explicitly scoped request.

`openspec/specs/` does not yet exist. Available baselines are `v1-foundation` (domain, local store,
agent envelope, managed profile) and `capture-selection-ed` (selection, limiter, Ed transport).
The latter transport is not present in this checkout; Q1 depends on S0 issue C merging. Lesson
GET without `view` is documented as observed; quiz question types, slide structure, DOM selectors
and submission endpoint are not verified. No real content is needed to draft or test this change.

## Goals / Non-Goals

**Goals:** one selected Ed assessment; bounded model-safe question reads; external-agent proposals
with source-text citations; terminal approval of an exact revision; policy/grant-gated audited
page filling; passive sanitized observation of the owner's submission; synthetic TDD; real
structure evidence and owner acceptance by 2026-10-23.

**Non-Goals:** model calls, screenshot-driven computer use, automated submit/L4, endpoint replay,
MCP/HTTP/UI delivery, full M1 sync or M2 registry, new dependencies, CI/deployment changes, new
Assessment kinds/fields, migrations, score/status updates inferred from network observation,
automated exams above L1, password/MFA handling by agents, or exporting real quiz data to Git.

## Decisions

### 1. Consume the existing transport, expose a separate redacted read contract

Use the selected-course mapping, profile lock, lifecycle, same-origin Ed GET transport and shared
limiter from S0. No second browser profile, external HTTP client or cookie-only fallback.
Page-context code reads the regional `authToken:<region>` (AU `authToken:au`) and attaches `x-token`;
no token or auth header leaves that code, is printed, logged, stored or returned. Do not use
`Authorization: Bearer`, token renewal, arbitrary URLs or `view` (especially `view=1`). Validate
lesson ids against selected-course discovery before detail reads; fetch only referenced slides
needed for that assessment. Include bootstrap/discovery/failures/redirects in the existing
300-attempt budget and one-second spacing; no automatic retries.

Command handlers validate zod inputs/outputs and are independent of commander for later M2 reuse.
Planned CLI names are `coursework quiz read`, `quiz propose`, `quiz review`, and `quiz fill`; these
names express separate read/write boundaries, not a second registry. Read takes course and lesson
references and an optional bounded question selection. It returns stable question references,
prompt/options/type where recognized, completeness/unsupported indicators and redacted source
references/text suitable for quoting. It never returns raw lesson JSON, authors, grades, hidden
solutions or classmates' answers. Apply deterministic author/people-field, email/student-number/
phone and free-text redaction per section 7 before local normalized storage or model access;
withhold unsafe data when redaction cannot be established. Raw transport snapshots stay private.

All agent commands use `coursework.agent/v1`, exactly one stdout envelope, at most 64 KiB including
metadata. Oversize returns `LIMIT_EXCEEDED` with a narrowing hint; no silent truncation. Missing
session token or 401/403 returns `AUTH_EXPIRED`, with owner sign-in recovery and no prompt/retry.
Malformed/unsupported source structure returns sanitized `SOURCE_UNAVAILABLE`; invalid inputs
use `INVALID_INPUT`, unknown references `NOT_FOUND`, stale state `CONFLICT`, profile contention
`LOCKED`. No raw payload or exception path in logs. Rejected: exposing raw capture as read output
(S0 explicitly forbids it); guessing undocumented question fields (could corrupt real answers).

### 2. Use only the local record concepts already authorized by the standing design

Keep existing Course, Assessment, SourceItem and Citation schemas unchanged. Quiz is not a new
Assessment enum; source lesson/question references are adapter/command data, linked to an existing
assessment identity. Do not fabricate weights, due dates or assessment records to satisfy schemas.
Before M1 mappings exist, a validated local binding references the selected Ed course/lesson and
assessment identity; its category must be explicitly known, never inferred to be non-exam.

Section 7 already calls for proposals tied to assessments, policy/grants, audit and source offsets.
Q1 persists these private operational records under `<data dir>/quiz/` (default `.local/`; existing
private `COURSEWORK_HOME` override remains), not new domain tables. Validate versioned local
records; confine filenames derived from ids to that directory, refuse traversal/symlink escapes,
use owner-only directories/files and atomic proposal replacement. Preserve original citations
`sourceItemId`, `quote`, `locator`; validated source hash and offset/page are local validation
metadata, not additions to the shared Citation entity. The source is trusted redacted local text,
not text supplied by the proposing agent. Normalize NFKC, whitespace and quotes consistently per
section 7; reject unmatched or fabricated locators/offsets with `CITATION_MISMATCH` and record a
safe failure in the run ledger.

Each answer proposal includes an assessment/question reference, answer and rationale, and must cite
the specific question it answers. Every statement drawn from course material in the answer or
rationale must cite that material. Validate both obligations, not just a nonempty matching citation:
reject a citation only to another question/material source with no answered-question citation, and
reject a material statement supported only by the question citation, with `CITATION_MISMATCH`, a
safe failure event and no replacement of the accepted revision. Citing the question establishes
provenance, not evidence of correctness; prompt-only proposals with no course-material statements
show a lack of supporting course material explicitly to the reviewer. No command invents a source
or correctness claim. Unsupported answers remain unfillable. Rejected: new quiz database entities
or extending the existing Assessment/Citation schemas (outside scope); accepting caller-provided
source text as citation proof (unverifiable).

### 3. Gate proposals and fills, bind review to exact content

Policy records use allowed/prohibited/owner-attested. Include source quote/location when available,
or owner attestation/date otherwise. Decision #75 records a 2026-10-12 attestation for the Q1 course;
Claude must bind it to the actual course locally, not silently authorize all courses. Before real
Q1 reads, verify this policy record and private-repository prerequisite. Ordinary L0 read semantics
remain read-only; this real graded Q1 run has the extra section 6 prerequisites.

Check policy and per-assessment grant before proposal acceptance (at least L2) and again immediately
before fill (at least L3, no higher than course cap). Prohibited courses cap at L1, absent policy or
grant denies the relevant write, and exams/unknown classification cannot enter L2/L3. Q1 never
uses L4 even if a broader grant exists. Denials use `INVALID_INPUT` with safe recovery guidance,
not new protocol codes. Owner policy/grant recording is a separate explicit terminal action;
neither proposals nor review manufacture consent.

TTY review displays every proposed answer, question identity, rationale, source quote/locator,
unsupported/missing support indicators and intended target. The owner approves or rejects the exact
proposal revision/hash; cancellation or non-TTY review approves nothing. Proposal edits, source
changes, new question structure or a changed page/attempt identity invalidate approval (`CONFLICT`).
Approval is not a grant and a grant is not approval. Agent writes pass validating handlers; no direct
DB writes. Rejected: implicit acceptance on timeout or stdin from an agent (not owner review).

Approval persistence keeps the record pending during asynchronous preparation. The private file
writer checks cancellation immediately before a synchronous rename and parent-directory sync,
with no event-loop yield until durable activation. Cancellation before this boundary leaves no
usable approval; cancellation after it does not undo completed consent. Review appends confirmation
intent before activation and completion only after the save succeeds. Failed saves must not label
failure outcomes as approved. Completion-audit failures invalidate approval under the same local
mutation lock and return a sanitized error rather than success.

Append-only private audit records cover successful and failed quiz reads, policy/grant decisions,
proposal acceptance/rejection, review, attempted/denied/successful/partial fill and observation
outcome, with timestamp, run id,
assessment reference, proposal revision, policy/grant reference and outcome as applicable. Read
events contain only safe timestamp/run metadata, a validated assessment reference when available
and a sanitized outcome code, including invalid-target, authentication, transport, source-validation
and output-limit failures. Never echo unvalidated target input, raw payloads or exception messages.
Keep question text, answer values, source quotes, tokens/auth headers and personal data out of audit
messages. Append intent before mutation; if audit cannot be written, do not mutate or fill.
Record completion/partial results; an audit failure after
a DOM mutation stops further actions and reports uncertain outcome rather than claiming success.

### 4. Fill only the owner's already-open quiz and passively observe submission

Acquire the existing managed-profile lock. Select only an already-open same-origin page whose
course, lesson and attempt (when exposed) match the approved proposal. Do not open/start an attempt,
click Next/Finish/Submit, press Enter in controls that might submit, navigate to a guessed quiz,
change unrelated answers or call a submit endpoint. Preflight all targeted question ids, supported
controls, current source/revision and policy/grant before the first mutation. Use deterministic
Playwright locators resolved from verified structure, not screen coordinates or guessed indices.
Initial supported controls are only those established by the final structure check and synthetic
contracts; unseen widgets fail closed. If a widget auto-submits on change, it is unsupported.
Fill and read back supported answers; report partial failure honestly if a later operation fails,
without blind retries or claiming rollback of changed controls. Owner inspects the page before
submitting. Existing page autosave is not permission for code to trigger final submission.

Arm a page-scoped request listener **before filling** for the reviewed assessment, and keep the
visible managed-profile session and lock alive while the owner reviews/submits. Do not use HAR,
Playwright tracing, screenshots, raw request logging or response-body capture. No headers/cookies
are retained at all. Correlate the owner action to an assessment-bound candidate request using
verified page/request structure; do not assume a submission URL. Ignore autosave, analytics, other
courses/pages and background requests; ambiguous matches produce an explicit inconclusive result.
Only deterministic sanitizer code transiently examines a candidate request body, with no exposure
to agents. Save method, same-origin path (no origin/query/fragment) and a bounded structural summary
of body keys/container/scalar types. Remove auth/token/credential/CSRF fields recursively, redact
sensitive path segments and dynamic keys, and omit all scalar values (including answers and ids).
Malformed/unknown encoding or shape overflow yields a safe failure, never a raw fallback dump.
Store only that sanitized artifact under private `.local/` with audit reference; it is structural
evidence for M4, not a replay payload or proof of successful grading.

Terminal stop/cancel, page close or a bounded observation timeout detaches listeners, closes the
managed session through the existing lifecycle and releases the lock. Missing/ambiguous capture
never retries submission or blocks the owner's manual action. Rejected: routing/replaying requests
or inspecting auth headers (unnecessary for Q1); an unattended listener that outlives the session
(privacy and lock leak).

## Risks / Trade-offs

- [Unknown real JSON/DOM/request structure] → synthetic adapter contracts first; Claude reads structure
  only on the owner's logged-in profile; update contracts from sanitized field/type evidence, never
  copy real quiz content into `test/` or docs. Report unsupported types rather than guessing.
- [Stale approval or revoked grant] → bind revision/source/page identity and recheck gate at fill.
- [DOM changes partially apply] → preflight, readback, audit partial outcome, owner inspects before submit.
- [Secrets in request body/path] → sanitizer before persistence, no headers, no raw values, nested sentinel
  tests and bounded summaries; unknown formats are not recorded raw.
- [Session expired or owner unavailable] → `AUTH_EXPIRED`, no login prompt in agent calls, report blocked
  real validation and let Claude schedule owner login/MFA; do not silently move 2026-10-23.

## Migration Plan

No SQLite/domain migration. Merge S0 transport contracts first, then issue-sized Q1 increments below.
Claude verifies repository visibility before pushing answering code and runs fresh-context review/CI
before merge. Rollback disables Q1 commands without deleting local proposals/audit; no Q1 command
can submit. Archive after dependencies establish current-truth specs and real acceptance is recorded,
not merely after synthetic tests. This drafting task does not archive any change.

## Open Questions

- What question/slide shapes, control types, stable question ids and attempt identity does the real Q1
  page expose? Which controls have autosave or final-submit side effects? Final Claude check resolves
  structure only; unsupported controls block fill rather than expanding scope.
- What exact method/path/body shape identifies the owner's submission, distinct from autosave? Resolve
  only by passive observation during authorized owner submission, not an exploratory POST.
- Is the target course policy/2026-10-12 attestation bound locally, its assessment classified as non-exam,
  and an L3 grant recorded? Decision #75 alone is not the runtime record.
- If real structure requires new shared Assessment/Citation fields, a new enum/table, or a storage schema
  beyond section 7's local proposals/policy/grants/audit, stop and list the concrete need for owner decision;
  no such domain/storage schema change is authorized by this draft.
