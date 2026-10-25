## MODIFIED Requirements

### Requirement: Agent observations
The agent command `memory.record { courseId?, kind, text }` SHALL store an observation with `kind` (`habit` | `weakness` | `preference` | `other`), text of at most 500 characters stored as given (not redacted; #191), the course if given (which must exist), the creation time and the conversation that recorded it, taken from the calling session and never from the command input; a call without a session id (for example from a shell) is stored without a source. In the chat backend the session passes the conversation id to its tools; for Codex the adapter passes it to the `coursework mcp` server it configures for that session. Because Codex keeps a shell (#150, #154), this attribution is best effort: an agent that starts its own MCP server could set another id. Memories SHALL be returned by the L0 read `memory.list` (newest first, filter by course, deleted ones omitted), each with its source conversation when it still exists.

#### Scenario: Weakness noticed while tutoring
- **WHEN** the agent records `{ courseId: c-1, kind: weakness, text: "Mixes up eigenvalues and eigenvectors" }` during conversation `v-1`
- **THEN** `memory.list` returns it with kind `weakness`, course `c-1`, today's date and source `v-1`

#### Scenario: Too long or unknown course
- **WHEN** the text is over 500 characters or the course does not exist
- **THEN** the call is refused and nothing is stored

### Requirement: The owner controls memory
Owner commands from the frontend session or a TTY SHALL add (`memory.add`, origin `owner`), edit (`memory.edit`, text and kind, keeping the original time and source and recording the edit time) and delete (`memory.delete`) memories; owner text is stored as given. A deleted memory SHALL stay in the store marked deleted, and SHALL never be listed or sent to an agent again. Agents calling these commands SHALL be refused.

#### Scenario: Owner adds a memory
- **WHEN** the owner adds `{ kind: preference, text: "Explain with an example first" }`
- **THEN** `memory.list` returns it with origin `owner` and no source conversation

#### Scenario: Owner edits an observation
- **WHEN** the owner edits an agent memory's text
- **THEN** the text changes, the creation time and source conversation stay, and the edit time is recorded

#### Scenario: Owner text is stored as given
- **WHEN** the owner adds a memory containing a synthetic classmate's email address
- **THEN** the stored text and later briefs contain it unchanged

#### Scenario: Owner deletes a wrong observation
- **WHEN** the owner deletes a memory
- **THEN** it no longer appears in `memory.list` or in any later brief, and the row remains marked deleted

#### Scenario: Agent cannot delete
- **WHEN** an agent calls `memory.delete`, `memory.edit` or `memory.add` through MCP
- **THEN** it is refused and memories are unchanged

