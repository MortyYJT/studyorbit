## MODIFIED Requirements

### Requirement: Shared dispatch preserves the agent envelope
Dispatch SHALL validate input, enforce authorization, invoke a handler at most once, validate output and apply redaction before returning the bounded `coursework.agent/v1` envelope with command, ok, data or safe error, runId and durationMs. Error codes and retry semantics SHALL follow `agent-envelope`, and the 64 KiB limit SHALL apply. Raw exceptions, unsafe output and credentials MUST NOT escape on success or failure; validation failures SHALL be safely audited where applicable.

#### Scenario: Equivalent request across transports
- **WHEN** the same authorized synthetic input is sent by CLI, MCP and HTTP
- **THEN** command data, failure semantics and action counts agree, apart from run/timing and transport framing

#### Scenario: Handler output is invalid or oversized
- **WHEN** a handler returns invalid data or an envelope exceeding 64 KiB
- **THEN** a safe failure replaces it, no raw output escapes and no false successful receipt is returned

## ADDED Requirements

### Requirement: Generated CLI keeps one envelope
Commander subcommands SHALL dispatch through the registry. JSON mode SHALL print exactly one envelope on stdout with diagnostics on stderr. Owner-only commands (policy, grant, owner annotations, planning settings) SHALL require a trusted owner interaction: a TTY, or for planning settings only, the local HTTP owner-token flow (#86) used by the owner's UI. Other non-TTY calls, including every MCP call, SHALL get a safe refusal and SHALL never prompt for credentials or invent approval.

#### Scenario: Agent attempts an owner command
- **WHEN** a non-TTY caller invokes `grant.record`
- **THEN** it receives a safe refusal and no grant is stored

## REMOVED Requirements

### Requirement: Generated CLI preserves Q1 syntax
**Reason**: Decision #100 removes `src/quiz/`; the `quiz` commands go with it. The non-Q1 parts of this requirement continue as "Generated CLI keeps one envelope".
**Migration**: Quizzes are read and answered by the agent in the resident browser; permission checks and audit use `assessment-autonomy`.
