## MODIFIED Requirements

### Requirement: Read commands expose current state and accepted records
L0 commands SHALL provide bounded reads of courses (with provider sources), assessments (effective values with origin and citations), platform items (facts, links, removed state), annotations, the current plan and planning settings, sources/material pages, runs, revision notes and practice questions, using repository/evidence interfaces. Current-state tables SHALL be authoritative. Outputs SHALL reuse the domain schemas and retain resolvable source-text evidence for extracted claims and explicit unknown/unsupported gaps. Missing evidence SHALL be reported as unavailable, never invented. Reads MUST NOT expose raw captures, private file paths, browser endpoints, other students' answers or hidden quiz solutions. List reads SHALL validate filters and limits and use opaque continuation cursors.

#### Scenario: Read an assessment with its origin
- **WHEN** a synthetic assessment's weight comes from an agent annotation and its kind is unknown
- **THEN** the read returns the weight with origin `agent` and its citation, and the kind as unknown

#### Scenario: Unsupported or missing evidence
- **WHEN** a requested synthetic record has no resolvable source
- **THEN** output reports the gap or a safe missing-source failure without manufacturing a citation, grade or completeness claim

### Requirement: Every read respects the model privacy boundary
Persisted redacted evidence SHALL be revalidated as safe at model-facing output boundaries, including textual entity fields, citations, locators, URLs, annotation values and diagnostics. Default-on deterministic redaction SHALL be reused; unsafe or unproven content SHALL be withheld. Neither agent arguments nor owner redaction configuration SHALL bypass the model boundary. No self-issued Canvas token or model password input SHALL be accepted.

#### Scenario: Sensitive sentinel in stored output
- **WHEN** a synthetic record or error contains a classmate name, email, student number, phone or credential sentinel
- **THEN** the applicable privacy checks redact or withhold it before CLI, MCP or HTTP model-facing output

## REMOVED Requirements

### Requirement: Bounded paging never skips change evidence
**Reason**: Decision #101 removes the change stream, so there are no change cursors to page. Opaque list cursors are now part of "Read commands expose current state and accepted records", and run reads keep reporting missing measurements as absent.
**Migration**: Agents read current state instead of changes. The `changes` command is removed.
