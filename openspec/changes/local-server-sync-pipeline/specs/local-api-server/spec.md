## ADDED Requirements

### Requirement: Local API runs as a standalone loopback server
The system SHALL serve every `/api/local/*` route from a standalone Node server started by `node server/main.ts` (`npm run server`), not from the Vite dev server. The server SHALL listen on `127.0.0.1` only, on the port given by `STUDYORBIT_API_PORT` or 5190 by default, and SHALL exit with an error naming `STUDYORBIT_API_PORT` instead of choosing another port when the port is in use. Each moved route SHALL keep its path, methods, status codes, response bodies, error codes, body limits and Server-Sent Events. `vite.config.ts` SHALL NOT handle any `/api/local` request itself.

#### Scenario: Route behaviour is unchanged
- **WHEN** the page requests `GET /api/local/course-candidates` and the course list file is missing
- **THEN** the response is `404` with `{ "error": "COURSES_NOT_FOUND" }`, as before the move

#### Scenario: Port in use
- **WHEN** the server starts and another process already listens on its port
- **THEN** it exits with a non-zero code and a message naming `STUDYORBIT_API_PORT`, and does not listen on any other port

#### Scenario: Not reachable from the network
- **WHEN** the server is running
- **THEN** it accepts connections on `127.0.0.1` only

### Requirement: Requests carry the per-launch token
The server SHALL require a header `x-studyorbit-token` equal to the token in `STUDYORBIT_API_TOKEN` on every request, compared in constant time, and SHALL answer `403` otherwise. The server SHALL refuse to start without a token of at least 32 hexadecimal characters. The token MUST NOT be written to disk, logged, included in any response or exposed to client code.

#### Scenario: Direct browser request without the token
- **WHEN** a request reaches the API port directly without `x-studyorbit-token`
- **THEN** the server answers `403` and runs no route

#### Scenario: Wrong token
- **WHEN** a request carries a token of the right length that differs from the launch token
- **THEN** the server answers `403`

#### Scenario: Missing token at startup
- **WHEN** `STUDYORBIT_API_TOKEN` is unset or shorter than 32 hexadecimal characters
- **THEN** the server exits with an error before listening

### Requirement: Loopback, Host and Origin checks
Before any route runs, the server SHALL answer `403` unless the peer address is loopback (`127.0.0.1`, `::1` or `::ffff:127.0.0.1`), the `Host` header is `localhost`, `127.0.0.1` or `[::1]` with the web port (`STUDYORBIT_WEB_PORT`, default 5173), and an `Origin` header, when present, equals `http://` followed by the `Host` value. The existing per-route rules SHALL still apply: write methods require an exact same-origin `Origin` and `Content-Type: application/json`, and `/api/local/sync-courses` requires `Origin` on every method.

#### Scenario: DNS rebinding
- **WHEN** a request with a valid token has `Host: evil.example:5173` and `Origin: http://evil.example:5173`
- **THEN** the server answers `403`

#### Scenario: Another local origin
- **WHEN** a request with a valid token has `Host: localhost:5173` and `Origin: http://localhost:3000`
- **THEN** the server answers `403`

#### Scenario: Write without Origin
- **WHEN** a `PUT /api/local/llm-config` with a valid token and an allowed `Host` has no `Origin`
- **THEN** the server answers `403` and saves nothing

### Requirement: Vite proxies the local API
The Vite dev server SHALL proxy `/api/local` to `http://127.0.0.1:<api port>` without changing the `Host` header, SHALL set `x-studyorbit-token` on every proxied request, replacing any value sent by the browser, and SHALL pass Server-Sent Events through unbuffered. When the browser aborts a proxied request, the server SHALL see the request closed. In `serve` mode other than preview, Vite SHALL refuse to start without `STUDYORBIT_API_TOKEN`, with a message telling the user to run `npm run dev`; `vite build` SHALL NOT require it. Vite SHALL use a strict port.

#### Scenario: Page request through the proxy
- **WHEN** the page at `http://localhost:5173` sends `GET /api/local/course-sync`
- **THEN** the server receives it with `Host: localhost:5173` and the launch token, and the page gets the server's response

#### Scenario: Browser tries to set the token
- **WHEN** a page request carries its own `x-studyorbit-token` header
- **THEN** the proxied request carries the launch token instead

#### Scenario: Chat reply streams and stops
- **WHEN** the page streams a chat reply through the proxy and closes the request midway
- **THEN** delta events arrive as they are produced, and the server aborts the model request

### Requirement: One command starts both processes
`npm run dev` SHALL run a launcher that creates a random 32-byte token, starts the API server and then Vite with the token and both ports in their environment, forwards `SIGINT` and `SIGTERM` to both, stops the other process when one exits, and exits with the first non-zero exit code. Vite SHALL start only after the server reports that it is listening. The launcher SHALL NOT add a dependency. Serving the built page from the API server is out of scope.

#### Scenario: Normal start
- **WHEN** the owner runs `npm run dev`
- **THEN** the page is served on port 5173 and its `/api/local` requests succeed

#### Scenario: Server fails to start
- **WHEN** the API server exits during startup
- **THEN** Vite is not started (or is stopped) and the launcher exits with a non-zero code

#### Scenario: Ctrl-C
- **WHEN** the owner presses Ctrl-C
- **THEN** both processes stop and a running sync job is marked `interrupted`
