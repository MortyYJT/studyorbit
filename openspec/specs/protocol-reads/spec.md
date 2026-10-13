# protocol-reads Specification

## Purpose
TBD - created by archiving change v1-protocol. Update Purpose after archive.
## Requirements
### Requirement: Read commands expose current state and accepted records
L0 commands SHALL provide bounded course, assessment, task, source/material-page, change, run, revision-note, practice-question and proposal reads using repository/evidence interfaces. M1 current-state tables SHALL remain authoritative. Outputs SHALL reuse existing domain schemas and retain resolvable source-text evidence for extracted claims, source hashes/locators/pages and explicit completeness/unsupported gaps. Missing evidence SHALL be reported as unavailable, never invented. Reads MUST NOT expose raw captures, private file paths, other students' answers or hidden quiz solutions.

#### Scenario: Read an assessment with material evidence
- **WHEN** a synthetic M1 assessment and PDF page are requested
- **THEN** output contains the recorded fields, trusted redacted source evidence and the verified one-based page, without requiring a remote read

#### Scenario: Unsupported or missing evidence
- **WHEN** a requested synthetic record has incomplete material coverage or no resolvable source
- **THEN** output reports the gap or safe missing-source failure without manufacturing a citation, grade or completeness claim

### Requirement: Bounded paging never skips change evidence
Every list SHALL validate filters, limits and continuation semantics fixed in issue A. `changes` SHALL preserve an exclusive nonnegative safe integer cursor, ascending sequence order and the existing bounded handler behavior. Empty results SHALL retain the input cursor. An oversized first event SHALL return `LIMIT_EXCEEDED` without cursor advancement; a later oversized event SHALL remain pending after the preceding bounded page. New-list cursors SHALL follow the recorded O1 contract without altering change cursors.

#### Scenario: Oversized event remains pending
- **WHEN** a synthetic change exceeds the response bound
- **THEN** it is not silently omitted or marked consumed, and querying its preceding cursor fails safely or first returns only preceding fitting events

#### Scenario: Stored runs include historical unmeasured records
- **WHEN** measured and historical unmeasured runs are listed
- **THEN** actual counts are returned where recorded and missing measurements remain absent, without guessed time/cost/accuracy

### Requirement: Every read respects the model privacy boundary
Persisted redacted evidence SHALL be revalidated as safe at model-facing output boundaries, including textual entity fields, citations, locators, URLs, change before/after snapshots and diagnostics. Default-on deterministic M1 redaction SHALL be reused; unsafe/unproven content SHALL be withheld. Neither agent arguments nor owner redaction configuration SHALL bypass the model boundary. No self-issued Canvas token or model password input SHALL be accepted. Any live Q1 read SHALL keep the existing managed-profile selection/authentication contracts and Q1-specific prerequisites.

#### Scenario: Sensitive sentinel in stored output
- **WHEN** a synthetic record or error contains a classmate name, email, student number, phone or credential sentinel
- **THEN** the applicable privacy checks redact or withhold it before CLI, MCP or HTTP model-facing output

#### Scenario: Live quiz session expires
- **WHEN** a Q1 read adapter reports expired authentication during an agent call
- **THEN** `AUTH_EXPIRED` directs the owner to sign in, with no credential prompt, model password handling or token fallback

