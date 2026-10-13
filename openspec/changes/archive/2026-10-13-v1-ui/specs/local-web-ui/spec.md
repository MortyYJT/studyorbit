## ADDED Requirements

### Requirement: Same-process loopback SPA host
`coursework ui` SHALL serve the Vite + React build from `dist/ui` on IPv4 `127.0.0.1` in the same process as the M2 HTTP command transport and open the owner's browser. Hosting SHALL preserve M2 API routing/security and restrict static files to the built UI tree. No wildcard CORS or network-wide bind SHALL be introduced. Browser launch failure SHALL produce safe local access guidance without claiming the browser opened.

#### Scenario: Synthetic UI launch
- **WHEN** the owner starts the synthetic UI host
- **THEN** the browser receives the built SPA from the loopback origin, the UI identifies synthetic mode and no real profile/action adapter is mounted

#### Scenario: Unsafe asset path or foreign origin
- **WHEN** a request attempts static path traversal or an API call from a foreign Origin
- **THEN** the host refuses it without exposing private files or executing a command

### Requirement: Consume only validated M2 HTTP commands
The browser SHALL obtain authoritative data and invoke actions only via M2 JSON POST `/api/<command>` contracts. It SHALL validate inputs and matching success/failure envelopes at runtime, retain M2 bounds, opaque list cursors and exclusive numeric changes cursors, and display coverage gaps. It SHALL NOT call registry dispatch, storage, private files, Q1/CLI handlers, Canvas/Ed or Hermes directly. Synthetic server fixtures SHALL use the same HTTP boundary and independently invented data; their success SHALL NOT imply real integration or permission.

#### Scenario: Paged filtered read
- **WHEN** a list returns a next cursor and incomplete coverage
- **THEN** the client echoes the cursor unchanged with its original filters and displays gaps; a filter change discards that paging state

#### Scenario: Invalid or stale response
- **WHEN** a response fails envelope validation, repeats a continuation cursor or arrives for an obsolete selection
- **THEN** the client withholds invalid/stale data and exposes a safe failure or partial-read state rather than looping indefinitely

#### Scenario: Missing protocol feature
- **WHEN** a UI feature requires a command not yet delivered at the registry boundary
- **THEN** it is visibly unavailable and its implementation/acceptance remains pending; no side-channel persistence or action is substituted

### Requirement: Protected owner session and safe rendering
Owner/mutation requests SHALL use the existing transport capability gate through a separately selected, tested browser bootstrap. Secrets SHALL NOT enter model context, logs, URLs retained after bootstrap, browser persistent storage or public assets. UI content SHALL render untrusted text safely and distinguish transport failures, command failures and unavailable/uncertain action data, including under HTTP 200. No mutation or action SHALL be replayed automatically after an ambiguous result.

#### Scenario: Read session lacks owner capability
- **WHEN** an unbootstrapped browser attempts an owner command or mutation
- **THEN** the server refuses it and the UI cannot gain authority from request booleans or fake fixtures

#### Scenario: Ambiguous action response
- **WHEN** a command returns uncertain data or the connection drops after dispatch
- **THEN** the UI shows reconciliation guidance and does not resend the action automatically

### Requirement: Prototype shell and verifiable status
The UI SHALL reuse the prototype CSS variables and approved month-first/week-toggle shell, teaching-week labels, module rail, task drawer and avatar status/metrics/settings menu. Theme and Chinese/English preferences SHALL be available. Narrow/wide layouts, keyboard operation, visible focus, drawer focus return and reduced motion SHALL be verified in a real browser. Identity SHALL use only the public handle/presets; avatar upload SHALL await selected safe handling. Status/metrics SHALL use actual run/change/coverage data and label synthetic examples.

#### Scenario: Keyboard drawer and responsive calendar
- **WHEN** the owner navigates on narrow and wide layouts using only the keyboard
- **THEN** views, filters, task drawer and settings remain usable and closing the drawer restores focus to its trigger

#### Scenario: Metrics or sync unavailable
- **WHEN** no recorded measurement or sync-trigger contract exists
- **THEN** the UI reports unavailable data/action instead of invented metrics or a simulated real sync
