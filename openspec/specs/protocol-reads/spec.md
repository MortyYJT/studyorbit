# protocol-reads Specification

## Purpose
TBD - created by archiving change v1-protocol. Update Purpose after archive.
## Requirements
### Requirement: Read commands expose current state and accepted records
L0 commands SHALL provide bounded reads of courses (with provider sources, the effective AI policy with its origin, and the time of the last stored document), course candidates with their selection state, assessments (effective values with origin, citations and verdicts, read state and component group; retired assessments omitted), platform items (facts, links, removed state), annotations, the plan with estimates, start times and actual time, planning settings, course autonomy and effective levels, conversations and messages, sources/material pages, runs, metrics, revision notes, exam scope, practice questions and attempt statistics, using repository/evidence interfaces. Current-state tables SHALL be authoritative. Outputs SHALL reuse the domain schemas and retain resolvable source-text evidence for extracted claims and explicit unknown/unsupported gaps. Missing evidence SHALL be reported as unavailable, never invented. Reads MUST NOT expose raw captures, private file paths, browser endpoints, the owner session, other students' answers or hidden quiz solutions. List reads SHALL validate filters and limits and use opaque continuation cursors. Conversation reads SHALL be owner-only over HTTP and SHALL NOT be listed to MCP agents; historical pending-confirmation rows are not read any more.

#### Scenario: Read an assessment with its origin
- **WHEN** a synthetic assessment's weight comes from an agent annotation and its kind is unknown
- **THEN** the read returns the weight with origin `agent` and its citation, and the kind as unknown

#### Scenario: Unsupported or missing evidence
- **WHEN** a requested synthetic record has no resolvable source
- **THEN** output reports the gap or a safe missing-source failure without manufacturing a citation, grade or completeness claim

#### Scenario: Read an assessment with material evidence
- **WHEN** a synthetic assessment and a cited PDF page are requested
- **THEN** output contains the recorded fields, trusted redacted source evidence and the verified one-based page, without requiring a remote read

### Requirement: Every read respects the model privacy boundary
Persisted redacted evidence SHALL be revalidated as safe at model-facing output boundaries, including textual entity fields, citations, locators, URLs, change before/after snapshots and diagnostics. Default-on deterministic M1 redaction SHALL be reused; unsafe/unproven content SHALL be withheld. Neither agent arguments nor owner redaction configuration SHALL bypass the model boundary. No self-issued Canvas token or model password input SHALL be accepted. Reads SHALL NOT start or attach to a browser; page access belongs to the agent in the owner's own Edge (#167).

#### Scenario: Sensitive sentinel in stored output
- **WHEN** a synthetic record or error contains a classmate name, email, student number, phone or credential sentinel
- **THEN** the applicable privacy checks redact or withhold it before CLI, MCP or HTTP model-facing output

#### Scenario: Live quiz session expires
- **WHEN** the agent meets an expired Canvas or Ed session while reading for a sync run
- **THEN** the run reports the platform blocked so "needs you" asks the owner to sign in, with no credential prompt, model password handling or token fallback

