## MODIFIED Requirements

### Requirement: Enforce recorded policy and exact assessment grants
Levels SHALL be by type of work (#120): L0 read (information, planning, revision), L1 complete quizzes, L2 complete assignments and essays; a higher level includes the lower ones. The level an assessment needs SHALL follow its effective kind: `quiz` and `ongoing` need L1; `assignment`, `exam` and unknown kind need L2. Each course SHALL have a default level and each assessment MAY have an override, higher or lower (#117). The effective AI policy SHALL be resolved per assessment (#197): the owner's recorded policy on that assessment when there is one; otherwise `prohibited` when the owner's course policy, the agent-read course policy or the assessment's agent-read policy is `prohibited`; otherwise the nearest known value: the assessment's agent-read policy, else the owner's course policy, else the agent-read course policy; otherwise unknown. An owner value of `null` clears the owner's policy at that level. The assessment cap SHALL be L0 when its effective policy is `prohibited` (#124), and L2 otherwise, including when no policy is known (#125, #196). The effective level of an assessment SHALL be the minimum of its override (or the course default when there is none) and its cap. A course SHALL show as locked at L0 only when its course-level effective policy (owner course policy, else agent-read course policy) is `prohibited`. Exams SHALL have no separate code check (#126); the frontend offers no agent entry for them (#146). Course and assessment policies, default levels and overrides SHALL be recorded only from the frontend's owner session (#122) and audited; agents SHALL have no command that changes them, agent-read policies take effect without confirmation but never override an owner policy at the same level, and agents SHALL NOT record a policy annotation. `autonomy.policy.set` SHALL take a course id or an assessment id. `autonomy.read` SHALL report, per assessment, the effective policy, its origin (`owner` or `agent`) and the level it came from (`assessment` or `course`). A read command `autonomy.check` SHALL return, for one assessment and a requested action, `allowed` or `denied` with a reason code; the workspace rules tell Codex to call it before acting (see `agent-chat`), but no code path depends on it, because Codex acts on the screen (#168). L0 SHALL NOT allow graded answers disguised as practice content. Private repository visibility SHALL be verified before pushing answering or submission code (#57).

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
- **WHEN** no owner policy is recorded and the stored agent-read course `aiPolicy` is `prohibited`
- **THEN** the effective level of every assessment of that course is L0 and `autonomy.read` reports the policy as `prohibited` from the course level

#### Scenario: One assessment prohibited
- **WHEN** a course reads `allowed`, its "Report" assessment reads `prohibited`, and the course default level is L2
- **THEN** "Report" has effective level L0 and `autonomy.check` denies writes to it, while the course's other assessments stay at L2

#### Scenario: Item allowed does not lift a course ban
- **WHEN** the agent-read course policy is `prohibited` and an assessment's agent-read policy is `allowed`
- **THEN** that assessment's effective policy is `prohibited`

#### Scenario: Owner assessment policy is final
- **WHEN** the agent-read course policy is `prohibited` and the owner sets one assessment to `allowed`
- **THEN** that assessment's effective policy is `allowed` with origin `owner` from the assessment level, and the others stay `prohibited`

#### Scenario: Unknown item policy
- **WHEN** neither the course nor the assessment has a known policy
- **THEN** the effective policy is unknown and the cap is L2
