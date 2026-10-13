## ADDED Requirements

### Requirement: Validate structured writes before publication
Breakdown, revision-note, practice-question and quiz-answer writes SHALL pass strict schemas, trusted course/assessment binding, command authorization, privacy checks and citation validation before repository publication. Breakdown SHALL reuse Task-compatible steps; notes and practice explanations SHALL have source-derived claim units fixed in issue A. Quiz answers/drafts SHALL remain versioned proposals tied to the exact assessment, not implicit fills/submissions. The core SHALL never call a model. Concurrent/stale source or proposal revisions SHALL fail without replacing previous accepted state.

#### Scenario: Valid study write
- **WHEN** an external agent sends a schema-valid synthetic course note or practice explanation with trusted citations
- **THEN** the shared command stores a validated revision and evidence receipt without calling a model or granting assessment autonomy

#### Scenario: Invalid or stale write
- **WHEN** a write has invalid shape, wrong course binding, unsafe text or stale source identity
- **THEN** publication is rejected, previous accepted records survive and a safe failure is recorded

### Requirement: Exact normalized citations prove source membership
For every breakdown step, source-derived revision claim and practice explanation, the service SHALL resolve trusted redacted source text, NFKC-normalize both sides, unify whitespace and quotes, and require a nonempty exact substring. Accepted metadata SHALL record source id, checked offsets, source hash and verified PDF page where applicable, preserving existing Citation fields. Agent-provided source text/offsets/page assertions SHALL never constitute trusted evidence. Fuzzy matching SHALL NOT replace #63. Citation failure SHALL return `CITATION_MISMATCH` and be recorded in both run ledger and safe audit without storing rejected prose.

#### Scenario: Unicode and whitespace normalization
- **WHEN** synthetic source and quote differ only by NFKC compatibility characters, repeated whitespace or equivalent quotes
- **THEN** membership succeeds and metadata identifies the matched original-source range

#### Scenario: Wrong source or PDF page
- **WHEN** a quote is absent, empty, assigned to another course or claims a page inconsistent with trusted provenance
- **THEN** the complete write is rejected with `CITATION_MISMATCH`, safe failure records and no replacement of the previous accepted revision

### Requirement: Q1 answer provenance and review remain intact
Each quiz proposal SHALL cite its own supported question and every material-derived statement in both answer and rationale. Existing statement coverage/provenance checks and prompt-only limitations SHALL remain. Trusted Q1 snapshots and M1 material pages SHALL be resolved through compatibility adapters, never trusted from proposal payloads. Exact-review approvals SHALL bind proposal/source/policy/grant/page/attempt identities and become stale when those identities change. Literal citation success MUST NOT be described as correctness proof.

#### Scenario: Another question citation
- **WHEN** an answer cites a matching quote from another question or material only
- **THEN** it is rejected because its own question provenance is absent

#### Scenario: Prompt-only answer and later source change
- **WHEN** a synthetic answer has only valid question provenance and the trusted source later changes after approval
- **THEN** the receipt first displays the prompt-only limitation and the later fill preflight refuses the stale approval
