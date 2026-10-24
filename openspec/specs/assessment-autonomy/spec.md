# assessment-autonomy Specification

## Purpose
TBD - created by archiving change v1-protocol. Update Purpose after archive.
## Requirements
### Requirement: Enforce recorded policy and exact assessment grants
Levels SHALL be by type of work (#120): L0 read (information, planning, revision), L1 complete quizzes, L2 complete assignments and essays; a higher level includes the lower ones. The level an assessment needs SHALL follow its effective kind: `quiz` and `ongoing` need L1; `assignment`, `exam` and unknown kind need L2. Each course SHALL have a default level and each assessment MAY have an override, higher or lower (#117). The course cap SHALL be L0 when the course's effective AI policy prohibits AI (#124), and L2 otherwise, including when no policy is known (#125). The effective policy SHALL be the owner's recorded policy, else the agent-read `aiPolicy` of the course (#180), else unknown; an owner value of `null` clears the owner's policy. The effective level of an assessment SHALL be the minimum of its override (or the course default when there is none) and the course cap. Exams SHALL have no separate code check (#126); the frontend offers no agent entry for them (#146). Course policies, default levels, overrides and the confirm-before-submit switch SHALL be recorded only from the frontend's owner session (#122) and audited; agents SHALL have no command that changes them, the agent-read `aiPolicy` takes effect without confirmation but never overrides an owner policy, and agents SHALL NOT record a course policy annotation. A read command `autonomy.check` SHALL return, for one assessment and a requested action, `allowed` or `denied` with a reason code, and the browser tools SHALL call it before every write (see `agent-browser-tools`). L0 SHALL NOT allow graded answers disguised as practice content. Private repository visibility SHALL be verified before pushing answering or submission code (#57).

#### Scenario: Missing policy or prohibited course
- **WHEN** a course is recorded as prohibiting AI and an assessment override says L2
- **THEN** the effective level is L0 and `autonomy.check` denies any write; with no recorded policy the same override gives L2

#### Scenario: Exam or mismatched grant
- **WHEN** the target is an exam on a course whose default level is L2, or an override names another assessment
- **THEN** the exam needs L2 like an assignment and no exam-specific denial is applied, and the other assessment's override has no effect on this one

#### Scenario: Owner attestation is recorded
- **WHEN** the owner sets a course default of L1 and confirms its policy as allowed from the frontend
- **THEN** `autonomy.check` allows quiz writes and denies assignment writes for that course, and the recording performs no browser action

#### Scenario: Agent tries to raise a level
- **WHEN** an agent calls an autonomy settings command through MCP, the CLI or HTTP without the frontend's owner session
- **THEN** it is refused and nothing changes

#### Scenario: Agent-read policy caps the course
- **WHEN** no owner policy is recorded and the stored agent-read `aiPolicy` is `prohibited`
- **THEN** the effective level of every assessment of that course is L0 and `autonomy.read` reports the policy as `prohibited`

### Requirement: Append-only audit and run records fail safely
Policy and level changes, permission checks, denials and every agent browser write (click, fill, select, submit) SHALL produce append-only audit metadata linking run, conversation, target assessment, effective level, policy, and the observed outcome. A submit record SHALL state how it was confirmed: `owner-ui` after the owner confirmed in the frontend, or `not-required` when the owner switched confirmation off for that course (#121). A submit on a course that requires confirmation without an owner confirmation SHALL be recorded as a violation, not as success. Only code SHALL write browser-action audit entries: the agent-callable `audit.record` command is removed, so no agent can record an action or a confirmation it did not go through. Audit SHALL exclude prose, answers, quotes, personal data, raw errors and credentials. If the audit writer fails, `autonomy.check` SHALL return `denied` with an audit-unavailable reason. The run ledger SHALL remain separate and record citation failures and actual measurements only.

#### Scenario: Intent audit unavailable
- **WHEN** the audit writer fails during `autonomy.check`
- **THEN** the check returns `denied` with an audit-unavailable reason and no browser write happens

#### Scenario: Completion failure after external action
- **WHEN** a browser write completes and the audit append fails
- **THEN** the tool reports the recording failure and the actual or uncertain browser state, and the write is not repeated

#### Scenario: Agent cannot write audit entries
- **WHEN** an agent tries to call `audit.record` through MCP or its tool set
- **THEN** the command is not listed and the call fails, and no audit entry is written

#### Scenario: Recorded submit
- **WHEN** the agent submits a quiz at L1 after the owner pressed "confirm submit" in the frontend
- **THEN** one append-only audit entry links the assessment, level, policy and confirmation `owner-ui`, and contains no answer text

