# command-registry Specification

## Purpose
TBD - created by archiving change v1-protocol. Update Purpose after archive.
## Requirements
### Requirement: One registry defines all command contracts
Each command SHALL have one registry entry `{ name, input: zod, output: zod, handler, level }`. Exported zod schemas and inferred types SHALL define strict bounded inputs, outputs, target/revision references, errors and schema-valid synthetic examples before production handlers merge. All transports SHALL derive command discovery and dispatch from this registry. Runtime zod validation SHALL remain authoritative, including refinements not expressible in MCP input schemas. Transport metadata and legacy aliases MUST NOT duplicate business handlers.

#### Scenario: Contracts unblock fake-data clients
- **WHEN** issue A merges with synthetic handlers and repositories
- **THEN** M3 can validate fake requests/responses against the exported contracts without waiting for M1 ingestion or browser actions

#### Scenario: Invalid registration or input
- **WHEN** a duplicate command name, unknown command or schema-invalid request is supplied
- **THEN** registration or dispatch fails safely and no business mutation occurs

### Requirement: Shared dispatch preserves the agent envelope
Dispatch SHALL validate input, enforce authorization, invoke a handler at most once, validate output before returning the bounded `coursework.agent/v1` envelope with command, ok, data or safe error, runId and durationMs. Error codes and retry semantics SHALL follow `agent-envelope`, and the 64 KiB limit SHALL apply. Raw exceptions MUST NOT escape on success or failure; output is not redacted (#191); validation failures SHALL be safely audited where applicable.

#### Scenario: Equivalent request across transports
- **WHEN** the same authorized synthetic input is sent by CLI, MCP and HTTP
- **THEN** command data, failure semantics and action counts agree, apart from run/timing and transport framing

#### Scenario: Handler output is invalid or oversized
- **WHEN** a handler returns invalid data or an envelope exceeding 64 KiB
- **THEN** a safe failure replaces it, no raw output escapes and no false successful receipt is returned

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

### Requirement: Generated CLI keeps one envelope
Commander subcommands SHALL dispatch through the registry. JSON mode SHALL print exactly one envelope on stdout with diagnostics on stderr. Owner-only commands SHALL require a trusted owner interaction. Autonomy settings (policy, course default level, overrides) SHALL be accepted only from the frontend's owner session over HTTP (#122). Other owner commands (course selection `courses.select`, planning settings, owner annotations and verdicts, estimates, start times, manual tasks, actual time, conversation deletion) SHALL be accepted from the frontend's owner session or a TTY. Every other call, including every MCP call and every call from the chat agent, SHALL get a safe refusal and SHALL never prompt for credentials or invent approval.

#### Scenario: Agent attempts an owner command
- **WHEN** a non-TTY caller without the owner session invokes the course level command
- **THEN** it receives a safe refusal and nothing is stored

#### Scenario: TTY cannot change levels
- **WHEN** the owner runs the course level command in a terminal
- **THEN** it is refused with a message pointing to the frontend

### Requirement: The chat agent gets agent commands only
The registry SHALL be able to build an in-process MCP tool set for the chat agent that contains the L0 reads and the validated agent writes (including `source.record`, `courses.offer` and `course.import`), and no owner-only command. It SHALL NOT contain `sync.run` (sync is started only by the owner, #128) or `audit.record`, so an agent cannot record an action or a confirmation. The MCP stdio server SHALL list the same commands. Calls through it SHALL run with an agent context that can never carry owner authority, whatever the input says.

#### Scenario: Tool list
- **WHEN** the chat agent's tool list is built
- **THEN** it contains `autonomy.check` and `source.record` and does not contain `audit.record`, `sync.run`, any `browser.*` command, or any autonomy settings, course selection or planning settings command; MCP stdio lists the same

