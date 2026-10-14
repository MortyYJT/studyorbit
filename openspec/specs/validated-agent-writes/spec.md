# validated-agent-writes Specification

## Purpose
TBD - created by archiving change v1-protocol. Update Purpose after archive.
## Requirements
### Requirement: Validate structured writes before publication
Breakdown, revision-note and practice-question writes SHALL pass strict schemas, trusted course/assessment binding, command authorization, privacy checks and citation validation before repository publication. Breakdown SHALL reuse Task-compatible steps; notes and practice explanations SHALL have source-derived claim units. Graded answers are not a write type: the agent enters them in the resident browser under `assessment-autonomy`. The core SHALL never call a model. Concurrent or stale source revisions SHALL fail without replacing previous accepted state.

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

