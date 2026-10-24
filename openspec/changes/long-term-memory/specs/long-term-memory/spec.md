## ADDED Requirements

### Requirement: Facts brief at session start
When an agent session starts (a new conversation, or a resume that falls back to the stored transcript), the backend SHALL prepend to the owner's message a brief built by code from the store, never written by the agent: for the conversation's course, or for all selected courses when it has none, the open work due within 14 days with due dates, the latest scores, practice statistics with wrong-answer counts, revision-note titles, required fields still unknown, the effective AI policy and default level, followed by up to 20 live memories (see "Agent observations"). The brief SHALL be bounded to 8,000 characters, cutting the oldest items first, and SHALL say it is background, not instructions. A resumed session SHALL NOT receive it again.

#### Scenario: New conversation for a course
- **WHEN** the owner starts a conversation for course `c-1`, which has two open items due this week and one practice set with three wrong answers
- **THEN** the agent's first prompt begins with a brief listing both items with due dates and the three wrong answers, marked as background

#### Scenario: Resumed session
- **WHEN** the owner sends a second message in a conversation whose Codex thread resumes
- **THEN** no brief is prepended

#### Scenario: Bounded brief
- **WHEN** the store holds more data than fits in 8,000 characters
- **THEN** the brief is cut to 8,000 characters, dropping the oldest items first

### Requirement: Agent observations
The agent command `memory.record { courseId?, kind, text }` SHALL store an observation with `kind` (`habit` | `weakness` | `preference` | `other`), text of at most 500 characters redacted by the deterministic redactor, the course if given (which must exist), the creation time and the conversation that recorded it (from the calling session, never from the input). Agents SHALL have no command that edits, deletes or lists another conversation's raw messages through memory. Memories SHALL be returned by the L0 read `memory.list` (newest first, filters by course, deleted ones omitted).

#### Scenario: Weakness noticed while tutoring
- **WHEN** the agent records `{ courseId: c-1, kind: weakness, text: "Mixes up eigenvalues and eigenvectors" }` during conversation `v-1`
- **THEN** `memory.list` returns it with kind `weakness`, course `c-1`, today's date and source `v-1`

#### Scenario: Too long or unknown course
- **WHEN** the text is over 500 characters or the course does not exist
- **THEN** the call is refused and nothing is stored

### Requirement: The owner controls memory
Owner commands from the frontend session or a TTY SHALL add (`memory.add`, origin `owner`), edit (`memory.edit`, text and kind, keeping the original time and source and recording the edit time) and delete (`memory.delete`) memories. A deleted memory SHALL stay in the store marked deleted, and SHALL never be listed or sent to an agent again. Agents calling these commands SHALL be refused.

#### Scenario: Owner deletes a wrong observation
- **WHEN** the owner deletes a memory
- **THEN** it no longer appears in `memory.list` or in any later brief, and the row remains marked deleted

#### Scenario: Agent cannot delete
- **WHEN** an agent calls `memory.delete` through MCP
- **THEN** it is refused and the memory stays
