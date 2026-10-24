## MODIFIED Requirements

### Requirement: Read commands expose current state and accepted records
L0 commands SHALL provide bounded reads of courses (with provider sources, the effective AI policy with its origin, and the time of the last stored document), course candidates with their selection state, assessments (effective values with origin, citations and verdicts, read state and component group; retired assessments omitted), platform items (facts, links, removed state), annotations, the plan with estimates, start times and actual time, planning settings, course autonomy and effective levels, pending confirmations, conversations and messages, sources/material pages, runs, metrics, revision notes, exam scope, practice questions and attempt statistics, using repository/evidence interfaces. Current-state tables SHALL be authoritative. Outputs SHALL reuse the domain schemas and retain resolvable source-text evidence for extracted claims and explicit unknown/unsupported gaps. Missing evidence SHALL be reported as unavailable, never invented. Reads MUST NOT expose raw captures, private file paths, browser endpoints, the owner session, other students' answers or hidden quiz solutions. List reads SHALL validate filters and limits and use opaque continuation cursors. Conversation and pending-confirmation reads SHALL be owner-only over HTTP and SHALL NOT be listed to MCP agents.

#### Scenario: Read an assessment with its origin
- **WHEN** a synthetic assessment's weight comes from an agent annotation and its kind is unknown
- **THEN** the read returns the weight with origin `agent` and its citation, and the kind as unknown

#### Scenario: Unsupported or missing evidence
- **WHEN** a requested synthetic record has no resolvable source
- **THEN** output reports the gap or a safe missing-source failure without manufacturing a citation, grade or completeness claim

#### Scenario: Read an assessment with material evidence
- **WHEN** a synthetic assessment and a cited PDF page are requested
- **THEN** output contains the recorded fields, trusted redacted source evidence and the verified one-based page, without requiring a remote read
