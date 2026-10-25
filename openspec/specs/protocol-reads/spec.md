# protocol-reads Specification

## Purpose
TBD - created by archiving change v1-protocol. Update Purpose after archive.
## Requirements
### Requirement: Read commands expose current state and accepted records
L0 commands SHALL provide bounded reads of courses (with provider sources, the effective AI policy with its origin, and the time of the last stored document), course candidates with their selection state, assessments (effective values with origin, citations and verdicts, read state and component group; retired assessments omitted), platform items (facts, links, removed state), annotations, the plan with estimates, start times and actual time, planning settings, course autonomy and effective levels, conversations and messages, sources/material pages, runs, metrics, revision notes, exam scope, practice questions and attempt statistics, using repository/evidence interfaces. Current-state tables SHALL be authoritative. Outputs SHALL reuse the domain schemas and retain resolvable source-text evidence for extracted claims and explicit unknown/unsupported gaps. Missing evidence SHALL be reported as unavailable, never invented. Reads MUST NOT expose raw captures, browser endpoints or the owner session; stored text is returned as recorded, without redaction (#191). List reads SHALL validate filters and limits and use opaque continuation cursors. Conversation reads SHALL be owner-only over HTTP and SHALL NOT be listed to MCP agents; historical pending-confirmation rows are not read any more.

#### Scenario: Read an assessment with its origin
- **WHEN** a synthetic assessment's weight comes from an agent annotation and its kind is unknown
- **THEN** the read returns the weight with origin `agent` and its citation, and the kind as unknown

#### Scenario: Unsupported or missing evidence
- **WHEN** a requested synthetic record has no resolvable source
- **THEN** output reports the gap or a safe missing-source failure without manufacturing a citation, grade or completeness claim

#### Scenario: Read an assessment with material evidence
- **WHEN** a synthetic assessment and a cited PDF page are requested
- **THEN** output contains the recorded fields, trusted source evidence and the verified one-based page, without requiring a remote read

### Requirement: Reads stay local and credential-free
Reads SHALL NOT redact or withhold stored text for privacy (#191): classmates' details, markup characters such as `<` and `>`, credential-like text and file paths are returned as stored. No self-issued Canvas token or model password input SHALL be accepted. Reads SHALL NOT start or attach to a browser; page access belongs to the agent in the owner's own Edge (#167).

#### Scenario: Text with markup characters
- **WHEN** a stored assessment group is named `Participation = Token Streak => Flexible assessments`
- **THEN** `assessments.list` returns it unchanged and the list read succeeds

#### Scenario: Classmate details are not masked
- **WHEN** a stored record contains a synthetic classmate name and email
- **THEN** CLI, MCP and HTTP reads return them as stored

#### Scenario: Live quiz session expires
- **WHEN** the agent meets an expired Canvas or Ed session while reading for a sync run
- **THEN** the run reports the platform blocked so "needs you" asks the owner to sign in, with no credential prompt, model password handling or token fallback

