## ADDED Requirements

### Requirement: Enforce recorded policy and exact assessment grants
Course policies SHALL record allowed/prohibited status with source quote/location or dated owner attestation when no document exists. L2–L4 SHALL require a recorded course policy and exact assessment grant no higher than the course cap. Prohibited courses SHALL cap at L1, and exams SHALL never run above L1. Unknown assessment classification SHALL deny L2+. Policies/grants SHALL be recorded only through trusted owner interaction and audited. L0 read and L1 study assistance SHALL NOT imply an answering grant or allow graded answers disguised as practice content. Private repository visibility SHALL be verified before pushing L3/L4 answering/submission code.

#### Scenario: Missing policy or prohibited course
- **WHEN** an L2–L4 action has no course policy or its course is prohibited
- **THEN** it is denied regardless of a caller-supplied high-level grant

#### Scenario: Exam or mismatched grant
- **WHEN** a synthetic target is an exam/unknown category or the grant belongs to another assessment/course
- **THEN** an action above L1 is denied and a safe denial event is appended

#### Scenario: Owner attestation is recorded
- **WHEN** a trusted owner records an attestation/date and a valid exact non-exam grant within the cap
- **THEN** subsequent commands check those records and current versions without treating the recording as a fill or submit

### Requirement: Separate fill from confirmed submission
Fill SHALL be a separate command requiring at least L3, exact reviewed revision and current target/policy/grant preflight; it SHALL NOT submit. Submit SHALL require L4, the exact filled revision/page/attempt, current authorization and explicit owner confirmation by default. An explicitly owner-enabled, audited per-course auto-submit setting SHALL remove only the confirmation requirement. Confirmation MUST NOT be supplied by an agent boolean, replayed for another revision or remain valid after incompatible state changes. M2 SHALL test gates with fake action adapters and refuse unavailable/unverified real submission adapters without remote side effects; the Ed endpoint implementation belongs to M4. Live writes require separate authorization and SHALL NOT occur as development acceptance by default.

#### Scenario: L3 fill cannot submit
- **WHEN** a valid reviewed synthetic proposal has only an L3 grant
- **THEN** fill can run once without submit clicks/calls and submit is denied

#### Scenario: Default L4 confirmation and stale approval
- **WHEN** a valid L4 target lacks owner confirmation or has a confirmation for an old revision/attempt
- **THEN** no submission occurs and current owner confirmation is required

#### Scenario: Auto-submit keeps other gates
- **WHEN** a course has an owner-enabled auto-submit switch but its grant is revoked or the target is an exam
- **THEN** submission is denied despite the switch

#### Scenario: M4 endpoint not implemented
- **WHEN** all synthetic authorization gates pass but no verified submit adapter is installed
- **THEN** a safe unavailable failure is returned with zero network writes and no reported submission success

### Requirement: Append-only audit and run records fail safely
Grants, policy changes, proposals, reviews, fills, submits and denials SHALL produce append-only audit metadata linking command/run/target/revision/policy/grant and intent/outcome where applicable. Q1 read audit SHALL remain intact. Audit SHALL exclude prose, answers, quotes, personal data, raw errors and credentials. Intent failure SHALL prevent mutation. Local publication SHALL require durable mandatory records; external completion-record failure SHALL report actual/uncertain state rather than claim rollback or auto-retry. Run ledger SHALL remain distinct and record citation failures and actual measurements only.

#### Scenario: Intent audit unavailable
- **WHEN** an audit writer fails before a synthetic mutation or fill
- **THEN** no mutation/action occurs and a safe audit-unavailable failure is returned

#### Scenario: Completion failure after external action
- **WHEN** a fake fill/submit action completes but outcome auditing fails
- **THEN** the response reports the recording failure and actual/uncertain action state, and no automatic repeat occurs

### Requirement: Absorb Q1 records without weakening its commands
M2 SHALL provide shared policy/grant/audit/evidence services through a validated Q1 version-1 compatibility adapter or an explicitly selected versioned migration. Existing CLI syntax, proposal revisions, source identities/hashes, question/material checks, terminal review, safe private-file access and append-only history SHALL survive. A target SHALL have one active authority, not divergent legacy/new records. Identity/locator translation SHALL require verified provenance; ambiguous/invalid records SHALL fail closed without silent deletion, authorization escalation or reapproval. Real-Q1 dated prerequisites SHALL remain scoped to that original workflow. A later backend migration SHALL have a recorded lifecycle/rollback plan and SHALL NOT erase original evidence or logs.

#### Scenario: Existing Q1 proposal after transition
- **WHEN** valid synthetic version-1 policy, grant, snapshot, proposal, review and audit records are opened through M2
- **THEN** existing Q1 commands use the shared services with the same grant and exact-review semantics and retain history

#### Scenario: Ambiguous mapping or interrupted migration
- **WHEN** legacy Ed references cannot map uniquely to M1 or a selected migration is interrupted
- **THEN** affected actions fail safely or resume idempotently, original records remain intact and no new permission or approval is inferred
