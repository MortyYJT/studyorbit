## ADDED Requirements

### Requirement: Reflect authoritative autonomy without granting it
The UI SHALL explain L0 read, L1 assist, L2 draft, L3 fill-for-review and L4 submit semantics. L2–L4 SHALL require recorded course policy and exact assessment grant within the course cap. Prohibited courses and exams SHALL cap at L1; unknown classification SHALL fail closed above L1. Current policy/grant/action visibility SHALL use selected M2 read contracts; cached receipts, disabled controls and HTTP capability SHALL NOT substitute for execution-time M2 checks. Course policy/login/MFA configuration SHALL remain outside the UI.

#### Scenario: Exam or missing authorization
- **WHEN** a target is an exam, prohibited, unknown, missing policy or lacks the exact grant
- **THEN** the UI explains the restriction and M2 denies any inadmissible action even if a forged client tries to invoke it

### Requirement: Exact owner review precedes separate fill
The UI SHALL show the exact proposal answers/revision, question/material citations and limitations from M2, and use a selected trusted owner interaction for `quiz.review`. A client boolean or agent message SHALL NOT create review authority. Fill SHALL invoke only `quiz.fill` after current exact-review/authorization preflight; it SHALL NOT submit. Revision/source/page/attempt/policy/grant changes SHALL invalidate incompatible cached review and action state.

#### Scenario: Reviewed L3 fill
- **WHEN** the owner approves a current synthetic proposal with a valid L3 grant and explicitly requests fill
- **THEN** one M2 fill command executes and the UI displays the returned filled outcome without a submit call or grade claim

#### Scenario: Changed revision during review
- **WHEN** source/proposal/target bindings change after the displayed review
- **THEN** stale review is not reused for filling and fresh authoritative review/preflight is required

### Requirement: Default L4 owner confirmation binds exact filled state
Before default L4 submission the UI SHALL display exact filled answers/target and require an explicit owner submit interaction. The selected owner-only M2 confirmation seam SHALL issue a server token bound to the exact filled revision, source, page/attempt and policy/grant references. The UI SHALL pass it only to `quiz.submit`, honor expiry/single-use/replay protections and never substitute a boolean, chat message or HTTP capability. Explicit owner-enabled audited per-course auto-submit SHALL remove only this confirmation step; it SHALL remain off by default and SHALL NOT bypass any other gate.

#### Scenario: Default confirmed synthetic submission
- **WHEN** a valid synthetic L4 target is filled and the owner explicitly confirms its current answers
- **THEN** the server issues bound confirmation and one submit command uses it; merely opening the review does not issue consent

#### Scenario: Expired or replayed confirmation
- **WHEN** a token expires, has already been presented or belongs to different filled/source/authorization state
- **THEN** M2 refuses submission and the UI requires a fresh explicit owner interaction without auto-retry

#### Scenario: Auto-submit does not override exam cap
- **WHEN** a per-course auto-submit setting exists but the target is an exam or its grant is revoked
- **THEN** submission is denied regardless of that setting

### Requirement: Accurate action outcomes and no implicit live acceptance
The UI SHALL distinguish filled, submitted, partial, unavailable, failed and uncertain outcomes, including successful envelopes containing partial/unavailable/uncertain data. It SHALL NOT infer submitted/graded state from saved proposals or fill success, promise rollback or blindly retry ambiguous actions. Real Ed submit adapters belong to M4. Development fixtures SHALL mount no real actions; live writes SHALL require separate exact authorization. Private repository visibility SHALL be rechecked before action/answer implementation is pushed.

#### Scenario: Real submit driver absent
- **WHEN** a valid target has no verified submit adapter
- **THEN** the UI reports unavailable and no real submission or success is claimed

#### Scenario: Outcome cannot be reconciled
- **WHEN** an action may have occurred but durable outcome recording or response delivery fails
- **THEN** the UI shows uncertain/recording-failure state with safe reconciliation guidance and does not repeat the action

#### Scenario: Partial action receipt
- **WHEN** M2 returns a partial receipt with `retrySafe: false`
- **THEN** the UI displays incomplete action state requiring reconciliation, claims no complete fill/submission and performs no automatic retry
