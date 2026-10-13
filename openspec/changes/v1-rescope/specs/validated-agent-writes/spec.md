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
