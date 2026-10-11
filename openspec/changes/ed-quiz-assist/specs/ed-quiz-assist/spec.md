## ADDED Requirements

### Requirement: Read selected quiz questions through the existing Ed transport
The read command SHALL validate course/lesson references against the saved selected-course scope and read lesson JSON and only required referenced slides through the `capture-selection-ed` managed-profile transport. It SHALL retain its same-origin validation, profile lock, 300-attempt shared cap, one-second spacing including bootstrap/discovery/failed attempts, and no automatic retries. It MUST omit `view` entirely. Page-context code alone SHALL read `authToken:<region>` and attach `x-token`; tokens/auth headers MUST NOT be logged, printed, returned, snapshotted, stored or exposed to a model. It MUST NOT use `Authorization: Bearer`, cookie-only fallback, token provisioning/renewal or external HTTP clients.

#### Scenario: Selected assessment read
- **WHEN** a selected synthetic Ed course references a quiz lesson and required slides
- **THEN** only the validated lesson and required slide GETs run on the fixed Ed origin through the existing limiter with no `view` parameter
- **AND** the page-local token remains inaccessible to stdout, logs, local files and command output

#### Scenario: Unselected or forged target
- **WHEN** a caller supplies an unselected course, unrelated lesson id, arbitrary URL or cross-origin redirect
- **THEN** the command refuses the invalid target or reports a source gap without reading unselected details or following an external redirect

#### Scenario: Authentication expired
- **WHEN** the regional token is absent or an Ed GET returns 401 or 403
- **THEN** the command stops Ed reads and returns `AUTH_EXPIRED` with owner sign-in guidance, without prompting for a password, handling MFA or retrying authentication

#### Scenario: Budget or no-view refusal
- **WHEN** the shared budget is exhausted or a source refuses a lesson/slide without `view`
- **THEN** the command reports incomplete/unavailable coverage and never increases the cap, retries automatically or sends `view=1`

### Requirement: Return bounded redacted agent data
The read command SHALL return exactly one validated `coursework.agent/v1` envelope, at most 64 KiB serialized, with stable assessment/question references, recognized prompt/options/types, redacted source-text references, and explicit completeness/unsupported indicators. Oversized results MUST return `LIMIT_EXCEEDED` and a narrowing hint without silent truncation. Deterministic redaction SHALL strip classmates' personal data from structured and free-text fields before normalized storage or model exposure. Raw payloads, author profiles, other students' answers, grades, hidden solutions, tokens and auth headers MUST NOT enter envelopes or logs. Unverifiably safe data SHALL be withheld; malformed/unsupported structure SHALL yield a sanitized source gap, not guessed answers. Raw snapshots SHALL remain private local data.

#### Scenario: Nested personal data
- **WHEN** a synthetic lesson contains nested authors and classmate names, email, student number and phone in free text
- **THEN** the output and normalized stored text exclude those identifiers while retaining safe question/source provenance

#### Scenario: Oversized quiz
- **WHEN** the complete envelope would exceed 64 KiB
- **THEN** exactly one bounded `LIMIT_EXCEEDED` envelope is returned with a hint to narrow the question selection

#### Scenario: Unknown structure
- **WHEN** a question widget is unknown or a lesson response cannot be validated/redacted
- **THEN** the command explicitly marks safely recognizable unsupported items or returns `SOURCE_UNAVAILABLE`, never exports raw JSON or invents question fields

### Requirement: Enforce recorded policy and assessment grants
The system SHALL use a recorded per-course allowed/prohibited/owner-attested AI policy, source quote/location when available or owner attestation/date otherwise. Real Q1 reads SHALL require the section 6 course-policy and private-repository prerequisites to be verified. Proposal writes SHALL require at least L2 and filling SHALL require at least L3 in an explicit per-assessment grant, never above the course cap; a prohibited course SHALL cap at L1. Exams MUST NOT be automated above L1; unknown assessment classification SHALL deny proposal/fill. Policy/grant recording MUST be explicit owner actions, never implied by a proposal or review. Gates SHALL be rechecked immediately before fill; denial SHALL use sanitized `INVALID_INPUT` guidance and be audited. Claude MUST verify private repository visibility before answering/submitting code is pushed (#57).

#### Scenario: Attested Q1 course
- **WHEN** the actual target course has a locally recorded owner attestation dated 2026-10-12, a known non-exam assessment and an L3 assessment grant
- **THEN** an approved proposal can proceed to fill if the remaining preflight checks pass
- **AND** the attestation does not authorize other courses or assessments

#### Scenario: Missing or insufficient authorization
- **WHEN** policy is missing, course policy is prohibited, the assessment grant is absent/below the required level, or the grant exceeds the course cap
- **THEN** the relevant proposal/fill command is refused with no answer write or page mutation and a denial audit event

#### Scenario: Exam or unknown classification
- **WHEN** an assessment is an exam or its classification cannot be established
- **THEN** L2 proposal acceptance and L3 fill are denied regardless of review or grant

#### Scenario: Changed policy or revoked grant
- **WHEN** the policy/grant changes between owner review and fill
- **THEN** the gate is evaluated against current records and a newly unauthorized fill performs no page mutation

### Requirement: Store checked cited proposals privately
Validated command handlers SHALL accept external-agent answer proposals tied to an assessment and stable question references, with answer, rationale and source-text citations for each answer. Every answer proposal SHALL cite the specific question it answers. Every statement drawn from course material in the answer or rationale SHALL cite that material; a question citation alone MUST NOT satisfy this material-evidence requirement. They MUST NOT call a model. Each citation SHALL resolve trusted redacted local source text and match after NFKC normalization and whitespace/quote unification, with validated locator and source offset (page for PDFs) retained as local metadata. Missing required question/material citations or mismatched quotes SHALL reject the write with `CITATION_MISMATCH` and a safe run-ledger entry. Prompt-only provenance SHALL be visibly distinguished from supporting course-material evidence without claiming correctness. Proposals SHALL be versioned and stored atomically with owner-only permissions under the private local data directory (default `.local/`), excluding traversal/symlink escapes. Existing domain schemas and SQLite schema MUST remain unchanged; unmet model needs SHALL be open questions, not implemented extensions.

#### Scenario: Valid proposal
- **WHEN** a granted synthetic non-exam proposal cites each answered question and the material for every course-material statement in its answers/rationale, with quotes matching trusted local sources after normalization
- **THEN** its revision, answers, rationale, existing Citation fields and validation metadata are saved privately and acknowledged through a bounded envelope

#### Scenario: Fabricated or mismatched evidence
- **WHEN** the agent supplies invented source text, a quote absent from the cited source or a fabricated locator
- **THEN** the proposal is rejected, no accepted revision replaces the old one, and the run ledger records a sanitized citation failure

#### Scenario: Prompt provenance alone
- **WHEN** an answer cites only its question prompt, makes no statement drawn from course material in its answer/rationale and has no supporting course material
- **THEN** review explicitly identifies that evidence limitation and does not label the answer verified correct

#### Scenario: Citation to another source only
- **WHEN** a synthetic answer proposal has a valid matching citation to another question or course-material source but no citation to the specific question it answers
- **THEN** validation rejects the proposal with `CITATION_MISMATCH`, preserves the previous accepted revision and records a safe citation-failure event

#### Scenario: Material statement covered only by the question citation
- **WHEN** a synthetic answer proposal cites its question but a statement drawn from course material in its answer or rationale has no citation to that material
- **THEN** validation rejects the proposal with `CITATION_MISMATCH`, preserves the previous accepted revision and records a safe citation-failure event rather than accepting prompt-only provenance as material evidence

#### Scenario: Unsafe local write
- **WHEN** a proposal has malformed references, attempts path traversal/symlink escape or cannot be written atomically
- **THEN** it is rejected without writing outside private local storage or destroying the previous accepted revision

### Requirement: Owner reviews an exact proposal in the terminal
Terminal review SHALL display the target assessment/questions, all proposed answers, rationale, citation quotes/locators and unsupported/missing-support indicators. Only explicit owner approval in a TTY SHALL record approval of a specific proposal revision and source identity. Rejection, cancellation, timeout or non-TTY invocation MUST NOT approve anything. Approval SHALL neither create a grant nor alter course policy. Any changed proposal, source/question structure or target page/attempt identity SHALL invalidate approval before fill with `CONFLICT`.

#### Scenario: Explicit terminal approval
- **WHEN** the owner reviews and approves a complete displayed revision in a TTY
- **THEN** the exact revision/source identity is recorded for subsequent gated fill

#### Scenario: Agent or canceled review
- **WHEN** review runs without a TTY, is rejected or canceled, or receives no explicit approval
- **THEN** no approval is recorded and filling remains blocked

#### Scenario: Proposal changed after review
- **WHEN** the proposal, source or question/page/attempt identity changes after approval
- **THEN** fill returns `CONFLICT` without mutation and asks for a fresh read/review

### Requirement: Fill the matching open quiz without submitting
Playwright SHALL fill only explicitly approved supported answers on an already-open matching quiz page in the managed profile, under the existing lock and a current L3 gate. Before mutation it SHALL preflight course/lesson/attempt identity when exposed, stable question mapping, source/revision, supported controls and the ability to observe submission safely. It MUST NOT start an attempt, navigate to a guessed quiz, click Submit/Finish/Next, press keys that submit, change unrelated answers, invoke/replay submission requests or use screenshot-driven computer use. Widgets that submit on change SHALL be unsupported. It SHALL read back filled values and leave submission to the owner. Partial mutation failures SHALL stop further actions and report/audit the actual partial outcome without blind retries or false rollback/success claims.

#### Scenario: Successful L3 fill
- **WHEN** a currently granted approved revision matches the open synthetic quiz and all supported controls pass preflight
- **THEN** Playwright fills and verifies only those answers, and final submission remains an owner action

#### Scenario: Wrong page or unsupported control
- **WHEN** page/attempt identity differs, a control is ambiguous/unsupported or a widget submits on change
- **THEN** preflight refuses fill before the first answer mutation

#### Scenario: Partial failure
- **WHEN** a control fails after an earlier approved answer was changed
- **THEN** further filling stops, the changed/failed targets are reported and audited, and the owner is asked to inspect the page before manual submission

### Requirement: Audit reads, authorization and mutations append-only
Private append-only auditing SHALL record successful and failed quiz reads, policy/grant decisions, proposal acceptance/rejection, review, attempted/denied/successful/partial fill and submission-observation outcomes, with safe timestamp/run/assessment/revision/policy/grant references as applicable. Read events SHALL contain only safe timestamp/run metadata, a validated assessment reference when available and a sanitized outcome code; invalid or unresolved target input MUST NOT be echoed as an assessment reference. Audit output MUST exclude question text, tokens, auth headers, personal data and answer/source text, including raw payloads and exception messages on failures. Mutation intent SHALL be appended before changes; unavailable audit storage SHALL deny mutation/fill. Completion SHALL be recorded separately; audit failure after a page mutation SHALL stop further actions and report the uncertain outcome.

#### Scenario: Audited workflow
- **WHEN** quiz read, policy/grant, proposal, review and fill operations run
- **THEN** attributable append-only events link each operation to its run and validated assessment when available, without replacing prior events or recording answer values

#### Scenario: Successful read audit
- **WHEN** a selected synthetic quiz read succeeds
- **THEN** an append-only success event records only safe timestamp/run metadata, its validated assessment reference and outcome code
- **AND** question/options/source text, personal-data sentinels, tokens and auth headers do not appear in the event

#### Scenario: Failed read audit
- **WHEN** a synthetic quiz read fails through invalid target input, expired authentication, transport failure, unsafe/malformed source data or an output limit
- **THEN** an append-only failure event records only safe timestamp/run metadata, a validated assessment reference if available and a sanitized outcome code
- **AND** unvalidated target input, raw payloads/exception messages, question text, personal-data sentinels, tokens and auth headers do not appear in the event

#### Scenario: Audit storage unavailable
- **WHEN** the pre-mutation audit append fails
- **THEN** proposal replacement or page filling does not occur and the command reports failure

#### Scenario: Audit completion failure
- **WHEN** a page mutation occurred but completion auditing fails
- **THEN** subsequent actions stop and the result reports uncertain/partial state rather than successful completion

### Requirement: Passively record a sanitized owner submission request
The system SHALL arm an assessment/page-scoped passive request listener before filling and retain the managed session/lock while the owner reviews and submits. It MUST NOT cause, intercept for modification, retry or replay submission. It SHALL correlate owner submission with the reviewed assessment using verified structure, excluding autosave/analytics/other pages; ambiguous/missing matches SHALL be inconclusive. Only method, sanitized same-origin path without query/fragment and bounded body shape (keys, containers and scalar types) SHALL be stored privately under `.local/` or the configured private data directory. No request headers/cookies SHALL be retained; tokens, auth/credential/CSRF fields, sensitive path segments/dynamic keys and all scalar values MUST be stripped before logging, persistence or model exposure. Unsupported body formats/oversize shapes MUST NOT fall back to raw dumps. Raw requests/responses, HAR/traces and screenshot capture SHALL be disabled. The artifact SHALL be future M4 structure evidence, never a replay payload or proof of grading success.

#### Scenario: Owner submits
- **WHEN** the owner manually submits the reviewed synthetic quiz while observation is armed
- **THEN** one correlated artifact records only sanitized method/path/body structure, without tokens, auth headers, answer values or unrelated requests

#### Scenario: Nested credentials and dynamic identifiers
- **WHEN** a synthetic submission contains token/auth/CSRF fields in nested arrays, credentials in query/path, dynamic identifier keys and scalar answer values
- **THEN** none survive in the artifact, audit, envelope or logs, while safe structural types remain

#### Scenario: Ambiguous or unsupported request
- **WHEN** autosave cannot be distinguished from final submission or the body encoding/size cannot be sanitized safely
- **THEN** observation reports inconclusive/unsupported evidence, stores no raw request and does not attempt another submission

#### Scenario: Observation ends
- **WHEN** the owner cancels/stops, the page closes or the bounded observation timeout expires
- **THEN** listeners detach, the managed session lifecycle completes, the lock is released and missing observation is reported honestly

### Requirement: Synthetic verification and owner-profile acceptance
All repository fixtures SHALL be wholly synthetic and live under `test/`, never copied/redacted real captures. Implementation SHALL use failing tests first for each issue-sized increment, targeted green tests, fresh-context review and `bash .claude/check.sh` evidence. The final implementation task SHALL be a Claude-run real structure check on the owner's managed profile, recording only safe field/type/control evidence outside repository fixtures. Missing login SHALL return `AUTH_EXPIRED` gracefully with owner sign-in guidance; no agent password/MFA handling or inferred success. The owner SHALL have a real-quiz acceptance checklist by 2026-10-23; actual acceptance, auth failures and unverified submission structure SHALL be reported separately.

#### Scenario: Synthetic test evidence
- **WHEN** an issue is delivered for review
- **THEN** evidence includes the meaningful failing-first test, targeted green run, project check output and no real course content in repository fixtures

#### Scenario: Claude profile check signed out
- **WHEN** Claude runs the final structure check with no valid Ed login
- **THEN** it returns `AUTH_EXPIRED` without mutation or credential prompting and records that real structure/acceptance remain unverified

#### Scenario: Owner acceptance
- **WHEN** the owner runs the supplied read, propose, review, fill and manual-submit checklist by 2026-10-23 with required policy/grant
- **THEN** evidence separately states question coverage, reviewed fill/readback outcome and sanitized observation outcome without treating request observation as grade confirmation
