# assessment-autonomy Specification

## Purpose
TBD - created by archiving change v1-protocol. Update Purpose after archive.
## Requirements
### Requirement: Enforce recorded policy and exact assessment grants
Course policies SHALL record allowed/prohibited status with source quote/location or dated owner attestation when no document exists. L2–L4 SHALL require a recorded course policy and an exact assessment grant no higher than the course cap. Prohibited courses SHALL cap at L1, and exams SHALL never run above L1. An assessment whose kind is unknown SHALL be treated as possibly an exam and denied L2+. Policies and grants SHALL be recorded only through trusted owner interaction and audited. A read command `autonomy.check` SHALL return, for one assessment and requested level, `allowed` or `denied` with a reason code; agents SHALL call it before any L2+ browser action and SHALL NOT act on `denied`. L0 read and L1 study assistance SHALL NOT imply an answering grant or allow graded answers disguised as practice content. Private repository visibility SHALL be verified before pushing L3/L4 answering or submission code.

#### Scenario: Missing policy or prohibited course
- **WHEN** `autonomy.check` is called for an L2–L4 action on a course with no policy or a prohibited policy
- **THEN** it returns `denied` with the reason, regardless of any grant

#### Scenario: Exam or mismatched grant
- **WHEN** the target assessment is an exam or has an unknown kind, or the grant belongs to another assessment or course
- **THEN** any level above L1 is denied and a safe denial event is appended

#### Scenario: Owner attestation is recorded
- **WHEN** a trusted owner records an attestation/date and a valid exact non-exam grant within the cap
- **THEN** `autonomy.check` returns `allowed` for that assessment and level, and the recording itself performs no browser action

### Requirement: Append-only audit and run records fail safely
Grants, policy changes, permission checks, denials and every agent browser write (fill, submit, or other state change on Canvas or Ed) SHALL produce append-only audit metadata linking run, target assessment, level, policy and grant, and the outcome reported by the agent. An L4 submit record SHALL state how the owner confirmed it (for example, a chat confirmation of the listed answers); L4 without owner confirmation SHALL be recorded as a violation, not as success. Audit SHALL exclude prose, answers, quotes, personal data, raw errors and credentials. If the audit writer fails, `autonomy.check` SHALL return `denied` with an audit-unavailable reason. The run ledger SHALL remain separate and record citation failures and actual measurements only.

#### Scenario: Intent audit unavailable
- **WHEN** the audit writer fails during `autonomy.check`
- **THEN** the check returns `denied` with an audit-unavailable reason

#### Scenario: Completion failure after external action
- **WHEN** the agent reports a browser write through `audit.record` and the audit writer fails
- **THEN** the response reports the recording failure, the agent reports the actual or uncertain browser state, and the write is not repeated

#### Scenario: Recorded submit
- **WHEN** the agent submits a granted L4 workshop after the owner confirmed the listed answers in chat and records the action
- **THEN** one append-only audit entry links the assessment, level, grant and confirmation method, and contains no answer text

