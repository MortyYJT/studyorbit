## MODIFIED Requirements

### Requirement: Agent adapters behind one interface
The chat backend SHALL talk to agents only through an adapter interface that is independent of any one agent: start or resume a conversation with a prompt and a tool set, stream events (text, tool step, confirmation request, result with steps and cost, error) and interrupt. The default adapter SHALL start the owner's signed-in Codex CLI as a child process in non-interactive JSON mode, resuming its stored session id for later messages (#167); the Claude Agent SDK adapter SHALL remain available only when the owner selects it with `COURSEWORK_AGENT=claude`. The stored conversation in our database is the conversation's memory (#177); an adapter's own session reference is only an accelerator: when resuming it fails, the adapter SHALL continue from the stored transcript in a new session without an error. A conversation started under a different adapter SHALL likewise continue under the current one from its stored transcript: the other adapter's session reference SHALL NOT be passed on, and the conversation's stored adapter id and session reference SHALL be replaced by the new ones. Adding another agent SHALL need a new adapter only, not changes to conversation storage, streaming or the frontend. Our code SHALL NOT call a model API directly, read or store an API key, or handle model billing; it SHALL start the agent the owner has already signed in to (#123). When the agent is not signed in or not installed, the backend SHALL return a safe error the frontend can show, without asking for credentials. An adapter that reports no money cost SHALL leave the cost unknown.

#### Scenario: Fake adapter
- **WHEN** the conversation service runs with a synthetic adapter that emits two text chunks, one tool step and a result
- **THEN** the stored conversation and the streamed events are the same as with any other adapter emitting those events

#### Scenario: Agent not signed in
- **WHEN** the `codex` executable is missing, or exits reporting that no signed-in session is available
- **THEN** the frontend receives an `AGENT_UNAVAILABLE` error with a sign-in hint and nothing prompts for a key

#### Scenario: Codex events
- **WHEN** a fake `codex` executable prints a thread start with id `t-1`, an agent message, one MCP tool call that completes and one that fails, and a completed turn with token usage only
- **THEN** the adapter streams the text, an `ok` and an `error` tool step, and a result with 1 turn, session reference `t-1` and no cost

#### Scenario: Resume
- **WHEN** a conversation whose stored session reference is `t-1` receives a second owner message
- **THEN** the adapter runs `codex exec resume t-1` with that message instead of starting a new thread

#### Scenario: Resume fails
- **WHEN** `codex exec resume t-1` exits reporting that the session cannot be found
- **THEN** the adapter starts a new thread with the stored transcript, the reply streams normally, and the new thread id replaces `t-1`

#### Scenario: Stop a Codex reply
- **WHEN** the owner presses stop while the Codex child is running
- **THEN** the child process is terminated and the stored message ends with a stopped marker

#### Scenario: Claude on request
- **WHEN** the host starts with `COURSEWORK_AGENT=claude`
- **THEN** conversations use the Claude Agent SDK adapter and the Codex executable is never started

#### Scenario: Conversation from another adapter
- **WHEN** the owner sends a message in a stored conversation whose adapter is `claude` while the host uses Codex
- **THEN** the message is accepted, Codex starts a new thread with the stored transcript and without the Claude session reference, and the conversation's adapter becomes `codex` with the new thread id

### Requirement: Agent tool policy
Each Codex session SHALL reach our tools only through the `coursework mcp` stdio server, started with the host's resolved data directory, which exposes agent commands (L0 reads, validated writes, `source.fetch`) and never owner commands; our resident-browser tools (`browser.*`) SHALL NOT be offered to Codex, which acts in the owner's own Edge through its own computer-use feature (#167). The session SHALL run in a dedicated workspace outside any Git working tree, so that no repository instruction file applies to it, with Codex's `workspace-write` sandbox and never its approval or sandbox bypass flags; that sandbox, which keeps shell writes inside the workspace, is the code-side protection for our data, including owner commands an agent might start through a pseudo-terminal. At each session start the adapter SHALL write an `AGENTS.md` into the workspace instructing Codex to: never press a final submit button and instead stop and ask the owner to submit (#173); stop at any sign-in page and ask the owner, never typing a password or code; stay read-only on courses whose recorded AI policy prohibits AI (#124); act on an assessment only at or below the level the owner granted; and not open the owner's other sites or tabs beyond the task. These rules are instructions, not enforcement (#168): our code cannot block an agent acting on the screen. The owner session secret SHALL stay only in server memory, so no file the agent can read contains it. Tool calls that Codex reports as failed or declined SHALL be stored in the conversation as tool steps.

#### Scenario: Owner command through the shell
- **WHEN** a Codex session is started
- **THEN** the child runs with `sandbox_mode="workspace-write"`, its working directory is the workspace, and it runs without approval or sandbox bypass flags, so an owner command started from its shell, with or without a pseudo-terminal, cannot write our data directory (checked live in the owner check)

#### Scenario: Reading the owner session
- **WHEN** the agent reads files in the data directory
- **THEN** no file contains the owner session secret, because it exists only in server memory

#### Scenario: No resident-browser tools
- **WHEN** a Codex session lists the tools of the `coursework` MCP server
- **THEN** no `browser.*` command and no owner command is listed

#### Scenario: Same data directory
- **WHEN** the host runs with `COURSEWORK_HOME` set to a temporary directory and starts a Codex session
- **THEN** the MCP server entry passed to Codex carries that directory, so its reads and writes use the host's store

#### Scenario: Workspace instructions
- **WHEN** a Codex session starts
- **THEN** the workspace has no Git working tree above it, and its `AGENTS.md` contains the no-final-submit, stop-at-sign-in, prohibited-course, granted-level and no-other-sites rules before the child process is started
