## ADDED Requirements

### Requirement: Record measured sync lifecycle and per-source coverage
Sync SHALL persist a safe start ledger record before reads and finalize a validated Run with start/end, actual operation/pages/requests/failures counts, outcome and per-source coverage for every normal success/failure/cancel path. Coverage SHALL distinguish attempted/completed/skipped/failed/not-started scopes and auth/cap/cancel causes, not equate success HTTP responses with normalized publication. Partial runs SHALL finalize as error while retaining committed successful scopes. Safe refs/codes/counts SHALL exclude personal data, question/answer/quote text, raw payloads/errors and auth material. Performance/resume numbers SHALL derive only from measured ledger records; no model cost SHALL be invented.

#### Scenario: Successful measured run
- **WHEN** a synthetic sync finishes both selected providers and material extraction
- **THEN** its ledger links run id, start/end, measured counts and actual coverage without source content or secrets

#### Scenario: Partial authentication and cap
- **WHEN** Canvas completes but Ed expires or queued reads cannot start before the shared cap
- **THEN** coverage distinguishes completed/failed/not-started work and the error Run does not claim complete success or discard committed Canvas state

### Requirement: Report ledger failure and interrupted runs honestly
An unavailable start ledger SHALL prevent network sync. A persisted start without completion after crash SHALL remain interrupted/unverified, never synthesized success. A completion-ledger error after state/event commit SHALL report failure/uncertainty and preserve committed state, not claim rollback. Q1 citation failure adapters SHALL retain safe ledger linkage without replacing append-only audit. `coursework sync --json` SHALL return exactly one bounded validated envelope with run id and safe counts on complete success, or the existing failure code/recovery guidance on failed/partial runs; detailed safe coverage SHALL remain available in the private ledger.

#### Scenario: Ledger unavailable before read
- **WHEN** the synthetic start record cannot be persisted
- **THEN** no network attempt occurs and the command returns a sanitized failure

#### Scenario: Crash or completion failure
- **WHEN** a process leaves a start without end, or finalization fails after commit
- **THEN** the former is reported unverified and the latter reports uncertainty while preserving the committed event cursor

#### Scenario: Q1 mismatch retained
- **WHEN** a synthetic Q1 citation consumer rejects a proposal after M1 integration
- **THEN** the safe citation failure reaches the run ledger and prior audit events remain append-only
