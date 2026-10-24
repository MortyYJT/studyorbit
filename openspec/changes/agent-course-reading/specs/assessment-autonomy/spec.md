## MODIFIED Requirements

### Requirement: Enforce recorded policy and exact assessment grants
Levels SHALL be by type of work (#120): L0 read (information, planning, revision), L1 complete quizzes, L2 complete assignments and essays; a higher level includes the lower ones. The level an assessment needs SHALL follow its effective kind: `quiz` and `ongoing` need L1; `assignment`, `exam` and unknown kind need L2. Each course SHALL have a default level and each assessment MAY have an override, higher or lower (#117). The course cap SHALL be L0 when the course's effective AI policy prohibits AI (#124), and L2 otherwise, including when no policy is known (#125). The effective policy SHALL be the owner's recorded policy, else the agent-read `aiPolicy` of the course (#180), else unknown. The effective level of an assessment SHALL be the minimum of its override (or the course default when there is none) and the course cap. Exams SHALL have no separate code check (#126); the frontend offers no agent entry for them (#146). Course policies, default levels, overrides and the confirm-before-submit switch SHALL be recorded only from the frontend's owner session (#122) and audited; agents SHALL have no command that changes them, and the agent-read `aiPolicy` takes effect without confirmation but never overrides an owner policy. A read command `autonomy.check` SHALL return, for one assessment and a requested action, `allowed` or `denied` with a reason code, and the browser tools SHALL call it before every write (see `agent-browser-tools`). L0 SHALL NOT allow graded answers disguised as practice content. Private repository visibility SHALL be verified before pushing answering or submission code (#57).

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
