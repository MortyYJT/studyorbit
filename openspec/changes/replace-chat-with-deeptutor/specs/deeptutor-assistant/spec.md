## ADDED Requirements

### Requirement: DeepTutor is installed outside the repository
DeepTutor SHALL be installed in a Python virtual environment in the user's home directory (default `~/.local/share/studyorbit/deeptutor/venv`, overridable with `STUDYORBIT_DEEPTUTOR_BIN`), with the modules `server`, `web`, `memory`, `questions` and `notebook` and without the `solve` module. No file of the installation SHALL be inside the repository. `docs/setup.md` SHALL give the exact install and upgrade commands and the pinned version.

#### Scenario: Not installed
- **WHEN** `npm run dev` runs on a machine without the virtual environment
- **THEN** StudyOrbit starts as before and the assistant's status is `not-installed`

#### Scenario: Solve module present
- **WHEN** the installed DeepTutor reports the `solve` module as installed
- **THEN** the Agent page shows a warning that names the module and the command that removes it

### Requirement: The launcher starts and stops DeepTutor on loopback
After the local API server is listening, `npm run dev` SHALL check the DeepTutor API port. If `/health/ready` answers there, it SHALL start nothing and stop nothing, and SHALL use what answers only when the guard on that port reports this project's instance id; otherwise the status SHALL be `failed` and name the port. Every process it starts SHALL be recorded as soon as it is launched, so that a later start can stop processes left by a server that was killed. Otherwise it SHALL start DeepTutor's API server and web server bound to `127.0.0.1` on the instance's fixed ports, with `DEEPTUTOR_HOME` set to `.local/deeptutor/home` of the project. A failure at any step SHALL be recorded as the assistant's status and SHALL NOT stop or fail StudyOrbit. When the launcher stops, it SHALL stop the DeepTutor processes it started and no others. A port that is taken SHALL be reported, not replaced by another port.

#### Scenario: One command
- **WHEN** the owner runs `npm run dev` with DeepTutor installed
- **THEN** the StudyOrbit page and DeepTutor's page both answer on their ports, and neither DeepTutor port accepts a connection from another machine

#### Scenario: Already running
- **WHEN** this project's guarded DeepTutor, not started by this launcher, is healthy on the API port
- **THEN** the launcher starts no DeepTutor process and leaves that one running when it exits

#### Scenario: Port taken by another DeepTutor
- **WHEN** a DeepTutor of another checkout, or one without the guard, is healthy on the API port
- **THEN** it is neither used nor stopped, and the Agent page says that the port is in use and how to choose another

#### Scenario: Ctrl-C
- **WHEN** the owner presses Ctrl-C
- **THEN** the DeepTutor processes started by the launcher exit, including the MCP server they spawned

#### Scenario: DeepTutor fails to start
- **WHEN** DeepTutor's API server exits during start-up
- **THEN** the StudyOrbit page works, and the Agent page shows the reason and the command to start DeepTutor by hand

### Requirement: Separate ports and data for the owner's and test instances
The owner's instance SHALL use ports 5175 (DeepTutor web), 5195 (DeepTutor API) and 5197 (model proxy); the test instance 5185, 5196 and 5199. Each project directory SHALL have its own DeepTutor home under its own `.local/`, so a test run cannot write into the owner's sessions or memory.

#### Scenario: Test run in a worktree
- **WHEN** a synthetic instance runs from a worktree on the test ports and a chat is held
- **THEN** the session is stored under that worktree's `.local/deeptutor/home` and the main checkout's home is unchanged

### Requirement: The model key is never written by or for DeepTutor
The local server SHALL run a model proxy on `127.0.0.1` that forwards allow-listed model API paths to the configured provider and adds the key resolved by StudyOrbit's model settings. The key SHALL be added only while StudyOrbit's model settings name the supported provider; after a switch to another provider the proxy SHALL answer 503 and send nothing. The proxy SHALL refuse a request that does not come from a loopback peer, whose `Host` is not the proxy's own, that carries an `Origin` header, or whose bearer token is not the token created for this launch. DeepTutor SHALL be configured with the proxy's address and that token. No file generated for DeepTutor, no command-line argument and no log line SHALL contain the key.

#### Scenario: Key not on disk
- **WHEN** DeepTutor has been configured and has answered a question
- **THEN** no file under the DeepTutor home contains the key

#### Scenario: Provider changed while running
- **WHEN** the owner saves another provider and key in the model settings while DeepTutor is running
- **THEN** the proxy answers 503 and that provider's key is not sent anywhere

#### Scenario: Wrong token
- **WHEN** a local process calls the proxy without this launch's token
- **THEN** the proxy answers 403 and sends nothing to the provider

#### Scenario: Unsupported provider
- **WHEN** StudyOrbit's model settings name a provider other than DeepSeek
- **THEN** DeepTutor is not started and the Agent page says that the assistant works with DeepSeek only

### Requirement: StudyOrbit's MCP server is registered for the same instance
Before starting DeepTutor the launcher SHALL write a stdio server named `studyorbit` into DeepTutor's MCP settings, running `scripts/mcp-server.mjs` of this project with this project's directory, and SHALL keep any other server already in that file.

#### Scenario: Tools reach the model
- **WHEN** the owner asks for the current average of a synced course
- **THEN** the reply's tool calls include `mcp_studyorbit_calculate_grades` and the average in the reply equals the tool's result

### Requirement: House rules are always in the prompt
The launcher SHALL install a DeepTutor skill with `always: true` whose text requires course facts to come from the StudyOrbit tools, forbids inventing marks, weights, deadlines or planning data, and forbids writing, completing or submitting assessed work while allowing explanation, planning, review of the student's own attempt and practice questions.

#### Scenario: Asked to write an assignment
- **WHEN** the owner asks the assistant to write an assignment answer to submit
- **THEN** the reply declines and offers to explain, plan or review instead

### Requirement: Nothing but the model provider is contacted by default
Web search SHALL be off, local code execution (`exec`) SHALL be off, the update check SHALL be off, no search, image, video or embedding provider SHALL be configured, and no knowledge base SHALL be created. `docs/deeptutor.md` SHALL list the DeepTutor tools that can still reach the internet and cannot be switched off.

#### Scenario: Search requested by the model
- **WHEN** the model calls `web_search`
- **THEN** the tool answers that no provider is configured and no request leaves the machine

### Requirement: The Agent page shows DeepTutor or says how to get it
The Agent page SHALL show DeepTutor's own web page in a frame when the assistant's status is `running` or `external`, with a control that opens it in a new tab. For `not-installed`, `failed` and `unsupported-provider` it SHALL show what is wrong and the exact command or setting to fix it, in Chinese and English. The frame SHALL be created only while the Agent page is showing. The status SHALL be read without calling the model.

#### Scenario: Not installed
- **WHEN** DeepTutor is not installed and the owner opens the Agent page
- **THEN** the page shows the install command from `docs/setup.md` and the week view and course pages still work

#### Scenario: Stopped while open
- **WHEN** DeepTutor stops while the Agent page is showing
- **THEN** within one status check the page replaces the frame with the not-running message

### Requirement: Course context reaches the assistant
Opening the Agent page, clicking "Ask Agent" on a course and clicking a revision preset SHALL each save the page context (planning snapshot, selected courses, course in focus) before DeepTutor is shown. A preset SHALL start a DeepTutor session with its prompt only after the owner's click, and the frame SHALL open that session. "Ask Agent" without a preset SHALL send nothing to the model.

#### Scenario: Ask about a course
- **WHEN** the owner clicks "Ask Agent" on SYNT10001 and then asks "what do I need for an H1?"
- **THEN** `list_courses` names SYNT10001 as the course in focus and the reply is about SYNT10001

#### Scenario: Preset
- **WHEN** the owner clicks a revision preset
- **THEN** one session is started in DeepTutor with that prompt and the frame shows its reply

### Requirement: DeepTutor's API refuses requests from other pages
DeepTutor's API SHALL run behind a guard owned by StudyOrbit that refuses, with 403 and before DeepTutor handles them, HTTP requests and WebSocket upgrades whose `Host` (or forwarded Host) is not a loopback name with the API or web port, whose `Origin`, when present, is neither the StudyOrbit page nor DeepTutor's web page, or that carry `Sec-Fetch-Site: cross-site`. Both DeepTutor processes SHALL listen on `127.0.0.1` only.

#### Scenario: Foreign page
- **WHEN** a page of another site sends a request or opens a WebSocket to DeepTutor's API port or web port
- **THEN** the request is refused with 403 and no CORS header allows that origin

#### Scenario: DNS rebinding
- **WHEN** a request arrives with a `Host` that is not a loopback name, directly or through DeepTutor's web server
- **THEN** it is refused with 403

#### Scenario: Typed message without the knowledge module
- **WHEN** the owner types a message into DeepTutor's page and DeepTutor has no knowledge-base route
- **THEN** the guard answers the page's knowledge-base list request with an empty list and the message is sent

#### Scenario: The assistant's own traffic
- **WHEN** DeepTutor's page runs in the frame on the StudyOrbit page, or the StudyOrbit server starts a session
- **THEN** those requests are served
