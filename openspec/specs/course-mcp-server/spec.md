# course-mcp-server Specification

## Purpose
A local stdio MCP server, built on the official SDK, offers the same read-only course tools as the chat over the same course files, with an optional course filter.
## Requirements
### Requirement: Stdio MCP server built on the official SDK
The repository SHALL provide an MCP server started by `node scripts/mcp-server.mjs` (and `npm run mcp`) that uses `@modelcontextprotocol/sdk` (`McpServer`, `StdioServerTransport`) and communicates over stdio. Nothing other than protocol messages SHALL be written to stdout; diagnostics SHALL go to stderr.

#### Scenario: Client connects
- **WHEN** an MCP client starts the server over stdio and lists tools
- **THEN** the server answers with name `studyorbit` and the registry's tools

### Requirement: Same tools as the chat
The server SHALL register every tool of the shared registry with the same name and description and the tool's zod input schema (converted to JSON Schema by the SDK, so the listed schema has the same properties and required list but need not be byte-identical to the registry's), annotated `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` and `openWorldHint: false`. Each call with valid arguments SHALL run the registry's `runTool` and return its text as one text content item, with `isError: true` when the registry result is an error. Arguments that fail the schema are rejected by the SDK before the tool runs; the result SHALL have `isError: true`, and its text is the SDK's.

#### Scenario: Same answer as the chat tool
- **WHEN** `calculate_grades` is called over MCP and through the registry with the same document, scope and arguments
- **THEN** both return the same text

#### Scenario: Invalid arguments
- **WHEN** a client calls `final_needed` without `courseId`
- **THEN** the call returns a result with `isError: true` (whatever its text) and the server keeps running

### Requirement: Reads the same course files, with an optional filter
On every tool call the server SHALL load courses with the same loader the app uses (`.local/lms/courses.json` in the project and the newest valid course document per course in the Desktop course folders), convert them to display documents and use today's date in Melbourne time. The project and Desktop directories SHALL default to the repository containing the script and the user's Desktop and MAY be overridden with `--project` and `--desktop`. A comma-separated course ID filter from `--courses` or `STUDYORBIT_COURSES` SHALL limit the scope; without it every listed course is in scope. The server SHALL have no planning snapshot, so `plan_schedule` works only with tasks passed as arguments. A missing course list SHALL produce tool errors, not a crash.

#### Scenario: Course filter
- **WHEN** the server starts with `--courses 101` and the course list has courses 101 and 202
- **THEN** `list_courses` returns only course 101 and `get_assessments` for 202 returns `COURSE_NOT_IN_SCOPE`

#### Scenario: File changed after a sync
- **WHEN** a newer valid course document is written while the server is running
- **THEN** the next tool call uses the newer document

### Requirement: Read-only and local
The server MUST NOT write files, start syncs, read model settings or keys, or make network requests. Tool inputs MUST NOT accept file paths.

#### Scenario: No writes
- **WHEN** every tool is called once against a temporary project and Desktop directory
- **THEN** no file in either directory is created or modified

### Requirement: Connection instructions
The README SHALL explain how to connect the server from Claude Code (`claude mcp add`) and Claude Desktop (`claude_desktop_config.json`), with placeholder paths only, the Node 24 requirement, the course filter, and a note that tool results contain grades and are sent to the model the client uses.

#### Scenario: README section
- **WHEN** the MCP PR is merged
- **THEN** the README has a section with both configurations and the data-flow note, and contains no real local path

