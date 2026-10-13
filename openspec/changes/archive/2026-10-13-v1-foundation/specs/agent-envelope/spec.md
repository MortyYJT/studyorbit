## ADDED Requirements

### Requirement: One envelope for every agent-facing response
Every agent-facing command SHALL return exactly one JSON envelope: `{ "protocol": "coursework.agent/v1", "ok": boolean, "command": string, "data"?: unknown, "error"?: { "code", "message", "retryable", "next"? }, "meta": { "runId", "durationMs" } }`. `data` is present only when `ok` is true; `error` only when `ok` is false.

#### Scenario: Success envelope
- **WHEN** a command succeeds
- **THEN** the envelope has `ok: true`, a `data` field, no `error` field, and a `runId`

#### Scenario: Failure envelope
- **WHEN** a command fails
- **THEN** the envelope has `ok: false`, an `error` with a known code, and no `data` field

### Requirement: Closed set of error codes
Error codes and their fixed `retryable` values SHALL be:

| code | retryable | meaning |
| --- | --- | --- |
| `INVALID_INPUT` | false | input failed schema validation |
| `NOT_FOUND` | false | the referenced entity does not exist |
| `CONFLICT` | true | the state changed underneath the caller; re-read and retry |
| `AUTH_EXPIRED` | false | the user must sign in again |
| `SOURCE_UNAVAILABLE` | true | a source could not be reached |
| `LOCKED` | true | another process holds a needed lock |
| `CITATION_MISMATCH` | false | a quote is not found verbatim in its source |
| `LIMIT_EXCEEDED` | false | the result exceeds a size bound; narrow the request |
| `INTERNAL` | false | an unexpected error |

Code SHALL signal a known failure by throwing a typed `CourseworkError` carrying a code, a message, and an optional `next` hint; `run()` maps it to the envelope. `AUTH_EXPIRED` SHALL carry a `next` hint telling the caller to ask the user to sign in, never to sign in itself.

#### Scenario: Unknown code
- **WHEN** code tries to build an error envelope with a code outside the set
- **THEN** the TypeScript build fails

#### Scenario: Typed error is mapped
- **WHEN** a command throws `CourseworkError` with code `NOT_FOUND`
- **THEN** the envelope has `ok: false`, code `NOT_FOUND`, and `retryable: false`

#### Scenario: Expired login
- **WHEN** an `AUTH_EXPIRED` envelope is built
- **THEN** `retryable` is false and `next` tells the caller to ask the user to sign in

### Requirement: Bounded output
An envelope SHALL be at most 64 KiB when serialized. If `data` would exceed the bound, the command MUST return `LIMIT_EXCEEDED` with a `next` hint to narrow the request instead of truncating silently.

#### Scenario: Oversized data
- **WHEN** a command produces data that serializes to 70 KiB
- **THEN** the envelope is a `LIMIT_EXCEEDED` failure under 64 KiB

### Requirement: Unexpected errors fail closed
Any thrown error not mapped to a known code SHALL become an `INTERNAL` envelope whose message contains no stack trace, file path, or secret.

#### Scenario: Thrown error
- **WHEN** a command throws an error whose message contains a local file path
- **THEN** the envelope is `INTERNAL` and the message does not contain that path
