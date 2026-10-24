## MODIFIED Requirements

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

## REMOVED Requirements

### Requirement: Owner brings resident sign-in to the front
**Reason**: The resident browser is removed; Codex works in the owner's own Edge (#167).
**Migration**: The owner signs in in their own Edge; "needs you" shows platforms the last sync found blocked.
