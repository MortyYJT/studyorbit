## MODIFIED Requirements

### Requirement: Agent tool policy
Each Codex session SHALL reach our tools only through the `coursework mcp` stdio server, started with the host's resolved data directory, which exposes agent commands (L0 reads and validated writes, including `source.record`) and never owner commands; Codex acts in the owner's own Edge through its own computer-use feature (#167), and no `browser.*` command exists. The session SHALL run in a dedicated workspace outside any Git working tree, so that no repository instruction file applies to it, with Codex's `workspace-write` sandbox and never its approval or sandbox bypass flags; that sandbox, which keeps shell writes inside the workspace, is the code-side protection for our data, including owner commands an agent might start through a pseudo-terminal. At each session start the adapter SHALL write an `AGENTS.md` into the workspace instructing Codex to: never press a final submit button and instead stop and ask the owner to submit (#173); stop at any sign-in page and ask the owner, never typing a password or code; look up each assessment's effective AI policy before acting on it and stay read-only on assessments whose effective policy prohibits AI (#124, #197); act on an assessment only at or below the level the owner granted; and not open the owner's other sites or tabs beyond the task. These rules are instructions, not enforcement (#168): our code cannot block an agent acting on the screen. The owner session secret SHALL stay only in server memory, so no file the agent can read contains it. Tool calls that Codex reports as failed or declined SHALL be stored in the conversation as tool steps.

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
- **THEN** the workspace has no Git working tree above it, and its `AGENTS.md` contains the no-final-submit, stop-at-sign-in, prohibited-assessment, granted-level and no-other-sites rules before the child process is started
