## MODIFIED Requirements

### Requirement: Generated CLI keeps one envelope
Commander subcommands SHALL dispatch through the registry. JSON mode SHALL print exactly one envelope on stdout with diagnostics on stderr. Owner-only commands SHALL require a trusted owner interaction. Autonomy settings (policy, course default level, overrides, confirm-before-submit) and submit confirmations SHALL be accepted only from the frontend's owner session over HTTP (#122). Other owner commands (planning settings, owner annotations and verdicts, estimates, start times, manual tasks, actual time, conversation deletion) SHALL be accepted from the frontend's owner session or a TTY. Every other call, including every MCP call and every call from the chat agent, SHALL get a safe refusal and SHALL never prompt for credentials or invent approval.

#### Scenario: Agent attempts an owner command
- **WHEN** a non-TTY caller without the owner session invokes the course level command
- **THEN** it receives a safe refusal and nothing is stored

#### Scenario: TTY cannot change levels
- **WHEN** the owner runs the course level command in a terminal
- **THEN** it is refused with a message pointing to the frontend

## ADDED Requirements

### Requirement: The chat agent gets agent commands only
The registry SHALL be able to build an in-process MCP tool set for the chat agent that contains the L0 reads, the validated agent writes, `source.fetch`, `sync.run` and the browser tools, and no owner-only command. Calls through it SHALL run with an agent context that can never carry owner authority, whatever the input says.

#### Scenario: Tool list
- **WHEN** the chat agent's tool list is built
- **THEN** it contains `autonomy.check` and `browser.submit` and does not contain any autonomy settings, confirmation or planning settings command
