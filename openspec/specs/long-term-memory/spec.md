# long-term-memory Specification

## Purpose
Long-term memory for the chat agent (C-4): a code-built facts brief added to new agent threads, agent-recorded observations, and owner control (view, add, edit, soft-delete) in the Memory panel (#178, #188).
## Requirements
### Requirement: Facts brief at session start
When an agent session starts (a new conversation, or a resume that falls back to the stored transcript), the agent SHALL receive a brief built by code from the store, never written by the agent. The brief SHALL be passed to the adapter as its own input, separate from the owner's message; the adapter SHALL place it before the owner's text only when it starts a new agent session (a new thread or a fallback), and SHALL NOT include it when it resumes an existing session. The brief SHALL NOT be stored in the conversation or shown as part of the owner's message. It SHALL cover the conversation's course, or all selected courses when the conversation has none, in this priority order: the effective AI policy and default level; open work due within 14 days with due dates; required fields still unknown; the latest scores; practice statistics with wrong-answer counts; revision notes as counts per teaching week (notes without a week counted together); then up to 20 live memories (see "Agent observations"), course-specific first. It SHALL hold only titles, dates, numbers and memory texts, never page text or quotes, SHALL say it is background, not instructions, and SHALL be bounded to 8,000 characters: when over, whole sections are dropped from the lowest priority upward, and within the section that crosses the bound the least relevant items are dropped first (for due work the latest due date, for the other sections the oldest date).

#### Scenario: New conversation for a course
- **WHEN** the owner starts a conversation for course `c-1`, which has two open items due this week and one practice set with three wrong answers
- **THEN** the agent's first prompt contains, before the owner's text, a brief listing both items with due dates and the three wrong answers, marked as background, and the stored owner message contains only the owner's text

#### Scenario: Resumed session
- **WHEN** the owner sends a second message in a conversation whose Codex thread resumes
- **THEN** no brief is included

#### Scenario: Resume falls back
- **WHEN** the stored thread cannot be resumed and the adapter starts a new thread from the transcript
- **THEN** the new thread's prompt contains the brief once, and no earlier brief appears in the transcript

#### Scenario: All selected courses
- **WHEN** a conversation has no course and two courses are selected
- **THEN** the brief covers both courses

#### Scenario: Bounded brief
- **WHEN** the store holds more data than fits in 8,000 characters
- **THEN** the brief is at most 8,000 characters, memories are dropped before practice statistics, and within the cut section the least relevant items go first

### Requirement: Agent observations
The agent command `memory.record { courseId?, kind, text }` SHALL store an observation with `kind` (`habit` | `weakness` | `preference` | `other`), text of at most 500 characters stored as given (not redacted; #191), the course if given (which must exist), the creation time and the conversation that recorded it, taken from the calling session and never from the command input; a call without a session id (for example from a shell) is stored without a source. In the chat backend the session passes the conversation id to its tools; for Codex the adapter passes it to the `coursework mcp` server it configures for that session. Because Codex keeps a shell (#150, #154), this attribution is best effort: an agent that starts its own MCP server could set another id. Memories SHALL be returned by the L0 read `memory.list` (newest first, filter by course, deleted ones omitted), each with its source conversation when it still exists.

#### Scenario: Weakness noticed while tutoring
- **WHEN** the agent records `{ courseId: c-1, kind: weakness, text: "Mixes up eigenvalues and eigenvectors" }` during conversation `v-1`
- **THEN** `memory.list` returns it with kind `weakness`, course `c-1`, today's date and source `v-1`

#### Scenario: Too long or unknown course
- **WHEN** the text is over 500 characters or the course does not exist
- **THEN** the call is refused and nothing is stored

### Requirement: The owner controls memory as written
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

