## MODIFIED Requirements

### Requirement: Validate structured writes before publication
Breakdown, revision-note, practice-question and annotation writes (including assessment creation and assessment–item links) SHALL pass strict schemas, trusted course/assessment binding, command authorization, privacy checks and citation validation before repository publication. Breakdown SHALL reuse Task-compatible steps; notes and practice explanations SHALL have source-derived claim units. Graded answers are not a write type: the agent enters them in the resident browser under `assessment-autonomy`. The core SHALL never call a model. Concurrent or stale source revisions SHALL fail without replacing previous accepted state.

#### Scenario: Valid study write
- **WHEN** an external agent sends a schema-valid synthetic course note or practice explanation with trusted citations
- **THEN** the shared command stores a validated revision and evidence receipt without calling a model or granting assessment autonomy

#### Scenario: Invalid or stale write
- **WHEN** a write has invalid shape, wrong course binding, unsafe text or stale source identity
- **THEN** publication is rejected, previous accepted records survive and a safe failure is recorded

## ADDED Requirements

### Requirement: Annotation writes use the same validation gate
Agent annotations, assessment creation and assessment–item links (see `agent-annotations`) SHALL pass the same zod validation, privacy check and exact normalized citation check as study writes before they are stored. A rejected write SHALL leave stored values unchanged and be recorded in the run ledger.

#### Scenario: Annotation with a stale source
- **WHEN** an annotation cites a source whose stored content hash has changed since the agent read it
- **THEN** it is rejected and the previous effective value remains

## REMOVED Requirements

### Requirement: Q1 answer provenance and review remain intact
**Reason**: Decision #94 moved quiz answering to the agent in the browser, and #100 removes the Q1 proposal and terminal review workflow.
**Migration**: The shared citation service stays available to skills as a tool (#102). Past Q1 files under `.local/` are kept.
