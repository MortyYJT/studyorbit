## MODIFIED Requirements

### Requirement: Shared dispatch preserves the agent envelope
Dispatch SHALL validate input, enforce authorization, invoke a handler at most once, validate output before returning the bounded `coursework.agent/v1` envelope with command, ok, data or safe error, runId and durationMs. Error codes and retry semantics SHALL follow `agent-envelope`, and the 64 KiB limit SHALL apply. Raw exceptions MUST NOT escape on success or failure; output is not redacted (#191); validation failures SHALL be safely audited where applicable.

#### Scenario: Equivalent request across transports
- **WHEN** the same authorized synthetic input is sent by CLI, MCP and HTTP
- **THEN** command data, failure semantics and action counts agree, apart from run/timing and transport framing

#### Scenario: Handler output is invalid or oversized
- **WHEN** a handler returns invalid data or an envelope exceeding 64 KiB
- **THEN** a safe failure replaces it, no raw output escapes and no false successful receipt is returned

