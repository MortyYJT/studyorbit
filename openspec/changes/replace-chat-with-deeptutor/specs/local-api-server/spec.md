## MODIFIED Requirements

### Requirement: One command starts both processes
`npm run dev` SHALL run a launcher that creates a random 32-byte token, starts the API server with its standard output piped and echoed line by line, starts Vite (inherited output) once the server's listening line has appeared, gives both the token and both ports in their environment, forwards `SIGINT` and `SIGTERM` to both, stops the other process when one exits, and exits with the first non-zero exit code. If the server exits or prints no listening line within 15 seconds, the launcher SHALL NOT start Vite and SHALL exit with a non-zero code. After the server is listening the launcher SHALL also check for the assistant and start it as specified in `deeptutor-assistant`; the assistant being absent, failing to start or exiting SHALL NOT stop the two processes or change the launcher's exit code. The launcher SHALL NOT add a dependency. Serving the built page from the API server is out of scope.

#### Scenario: Normal start
- **WHEN** the owner runs `npm run dev`
- **THEN** the page is served on port 5173 and its `/api/local` requests succeed

#### Scenario: Server fails to start
- **WHEN** the API server exits during startup
- **THEN** Vite is not started (or is stopped) and the launcher exits with a non-zero code

#### Scenario: Ctrl-C
- **WHEN** the owner presses Ctrl-C
- **THEN** both processes stop and a running sync job is marked `interrupted`

#### Scenario: Assistant exits on its own
- **WHEN** the assistant's API server exits while StudyOrbit is running
- **THEN** the API server and Vite keep running and the launcher does not exit

## ADDED Requirements

### Requirement: Page context is stored through a guarded route
`PUT /api/local/agent-context` SHALL, behind the same access checks and write rules as every other route, validate and store the page context (save time, selected course IDs, course in focus, planning snapshot) in `.local/agent-context.json` with owner-only permissions, replacing the previous file atomically. It SHALL refuse a body over 200,000 bytes and any body that fails validation, storing nothing.

#### Scenario: Stored
- **WHEN** the page sends a valid context
- **THEN** the file holds it and a later MCP tool call uses it

#### Scenario: Invalid snapshot
- **WHEN** the planning snapshot in the body fails validation
- **THEN** the route answers 400 and the previous file is unchanged

### Requirement: Assistant status and session start
`GET /api/local/deeptutor/status` SHALL report the assistant's status (`not-installed`, `running`, `external`, `failed` with a reason, `unsupported-provider`) and the address of its page, without calling the model. `POST /api/local/deeptutor/turns` SHALL start one DeepTutor session with the given prompt and language and answer with the session id, and SHALL answer 503 when the assistant is not running.

#### Scenario: Status while stopped
- **WHEN** DeepTutor is installed but not running
- **THEN** the status is `failed` with the reason, and no request is sent to the model provider

#### Scenario: Turn started
- **WHEN** the page posts a preset prompt while the assistant is running
- **THEN** the answer carries a session id that DeepTutor's page can open
