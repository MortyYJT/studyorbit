## ADDED Requirements

### Requirement: One registry defines all command contracts
Each command SHALL have one registry entry `{ name, input: zod, output: zod, handler, level }`. Exported zod schemas and inferred types SHALL define strict bounded inputs, outputs, target/revision references, errors and schema-valid synthetic examples before production handlers merge. All transports SHALL derive command discovery and dispatch from this registry. Runtime zod validation SHALL remain authoritative, including refinements not expressible in MCP input schemas. Transport metadata and legacy aliases MUST NOT duplicate business handlers.

#### Scenario: Contracts unblock fake-data clients
- **WHEN** issue A merges with synthetic handlers and repositories
- **THEN** M3 can validate fake requests/responses against the exported contracts without waiting for M1 ingestion or browser actions

#### Scenario: Invalid registration or input
- **WHEN** a duplicate command name, unknown command or schema-invalid request is supplied
- **THEN** registration or dispatch fails safely and no business mutation occurs

### Requirement: Shared dispatch preserves the agent envelope
Dispatch SHALL validate input, enforce authorization, invoke a handler at most once, validate output and apply redaction before returning the bounded `coursework.agent/v1` envelope with command, ok, data or safe error, runId and durationMs. Existing Q1 error codes/retry semantics and the 64 KiB limit SHALL remain compatible. Envelope-returning legacy handlers SHALL be adapted without double wrapping. Raw exceptions, unsafe output and credentials MUST NOT escape on success or failure; validation failures SHALL be safely audited where applicable.

#### Scenario: Equivalent request across transports
- **WHEN** the same authorized synthetic input is sent by CLI, MCP and HTTP
- **THEN** command data, failure semantics and action counts agree, apart from run/timing and transport framing

#### Scenario: Handler output is invalid or oversized
- **WHEN** a handler returns invalid data or an envelope exceeding 64 KiB
- **THEN** a safe failure replaces it, no raw output escapes and no false successful receipt is returned

### Requirement: Generated CLI preserves Q1 syntax
Commander subcommands SHALL dispatch through the registry. JSON mode SHALL print exactly one envelope on stdout with diagnostics on stderr. Existing `quiz read`, `quiz policy`, `quiz grant`, `quiz prerequisites`, `quiz propose` file-input syntax and `quiz review` assessment/revision/page/attempt syntax SHALL remain compatible. Owner recording/review SHALL retain trusted-terminal constraints; non-TTY calls SHALL never prompt for credentials or invent approval.

#### Scenario: Legacy quiz proposal invocation
- **WHEN** a valid synthetic Q1 proposal file is passed using existing CLI syntax
- **THEN** the shared handler validates it and returns the existing `quiz.propose` receipt without a second registry or envelope

#### Scenario: Agent attempts terminal approval
- **WHEN** a non-TTY caller invokes an owner recording or review command
- **THEN** it receives a safe refusal without policy/grant/approval changes

### Requirement: Official SDK provides stdio MCP
`coursework mcp` SHALL use only pre-approved `@modelcontextprotocol/sdk` for MCP stdio. Registered tools SHALL advertise input schemas derived from zod and invoke the shared dispatcher. Stdout SHALL contain only MCP frames; diagnostics SHALL use stderr. MCP calls MUST NOT acquire owner interaction authority from input arguments.

#### Scenario: MCP discovery and validation
- **WHEN** a synthetic MCP client lists tools and calls one with an input failing a zod refinement
- **THEN** discovery reflects the registry and runtime dispatch rejects the input without executing the handler or corrupting stdio framing

### Requirement: Generated HTTP routes remain local and protected
`node:http` SHALL bind only to `127.0.0.1` and dispatch registered `/api/<name>` routes through the shared boundary. Before activation, the HTTP method, limits, status mapping and local authorization convention SHALL be recorded as specified in design Open choice O5. Routes SHALL reject unsafe Host/Origin requests, unsupported methods, malformed/oversized bodies and unauthorized mutations before execution; wildcard CORS, arbitrary file/SQL access and client-asserted owner authority MUST NOT be enabled.

#### Scenario: Local registered request
- **WHEN** a permitted synthetic local client sends valid input to a registered route using the selected convention
- **THEN** the shared command executes once and returns its envelope without exposing raw paths or credentials

#### Scenario: Hostile browser request
- **WHEN** a cross-origin browser or forged owner flag attempts a write
- **THEN** it is rejected before mutation or grant issuance, even though the server is loopback-bound
