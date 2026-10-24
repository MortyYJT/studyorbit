# agent-chat Specification

## Purpose
TBD - created by archiving change v1-delivery. Update Purpose after archive.
## Requirements
### Requirement: Agent adapters behind one interface
The chat backend SHALL talk to agents only through an adapter interface that is independent of any one agent: start or resume a conversation with a prompt and a tool set, stream events (text, tool step, confirmation request, result with steps and cost, error) and interrupt. The first and only adapter in v1 SHALL use the Claude Agent SDK (#116). Adding another agent SHALL need a new adapter only, not changes to conversation storage, streaming or the frontend. Our code SHALL NOT call a model API directly, read or store an API key, or handle model billing; it SHALL start the agent the owner has already signed in to (#123). When the agent is not signed in or not installed, the backend SHALL return a safe error the frontend can show, without asking for credentials.

#### Scenario: Fake adapter
- **WHEN** the conversation service runs with a synthetic adapter that emits two text chunks, one tool step and a result
- **THEN** the stored conversation and the streamed events are the same as with any other adapter emitting those events

#### Scenario: Agent not signed in
- **WHEN** the Claude adapter reports that no signed-in session is available
- **THEN** the frontend receives an `AGENT_UNAVAILABLE` error with a sign-in hint and nothing prompts for a key

### Requirement: Agent tool policy
Each agent session SHALL receive our tools through an in-process MCP server that exposes only agent commands (L0 reads, validated writes, `source.fetch`, browser tools) and never owner commands. The session SHALL also keep the agent's built-in tools (owner choice, 2026-10-15), with its working directory set to a dedicated workspace under the data directory. Before every tool call, a policy hook SHALL deny calls that: read or write the data directory outside the workspace; read the browser endpoint file or connect to the browser's debugging port; send requests to the local HTTP server; run `coursework` owner commands or start a pseudo-terminal to reach them; or open the frontend's origin. Denials SHALL be stored in the conversation as tool steps. This policy is best effort: it reduces, but cannot guarantee against, an agent with shell access acting outside our tools (see design).

#### Scenario: Owner command through the shell
- **WHEN** the agent asks to run `coursework grant record ...` through its shell tool
- **THEN** the policy hook denies the call and the conversation shows a denied step

#### Scenario: Reading the owner session
- **WHEN** the agent asks to read a file in the data directory outside its workspace
- **THEN** the call is denied and nothing is read

### Requirement: Conversations persist
Conversations and their messages SHALL be stored in the local database: conversation id, title, adapter id, the adapter's resumable session id, optional course and assessment context, the preset that started it, and creation and update times; each message with its role, ordered content parts (text, tool step with name, outcome and optional screenshot reference, confirmation request and its decision) and time. Reopening a conversation SHALL show its stored messages and continue the same agent session when the adapter can resume it, or start a new session with the stored transcript summary otherwise. Conversations SHALL be listable newest first and deletable by the owner.

#### Scenario: Survives restart
- **WHEN** a conversation with three messages is stored and the server restarts
- **THEN** the conversation list shows it and opening it shows the three messages in order

### Requirement: Streaming to the frontend
Sending a message SHALL return at once with a message id; the reply SHALL stream to the frontend as server-sent events on a loopback route protected by the frontend's owner session, in the order the adapter emits them. A dropped stream SHALL be resumable from the last event id, and the stored messages SHALL be complete whether or not a client was listening. The owner SHALL be able to stop a running reply; stopping SHALL interrupt the adapter and store the partial reply marked as stopped.

#### Scenario: Reconnect mid-reply
- **WHEN** the event stream drops after event 5 and the frontend reconnects with last event id 5
- **THEN** it receives events from 6 onward and no event twice

#### Scenario: Stop
- **WHEN** the owner presses stop during a reply
- **THEN** the adapter is interrupted and the stored message ends with a stopped marker

### Requirement: Preset prompts with context
The backend SHALL keep a fixed set of preset prompts, each with an id, a template and the context it needs: complete an assessment, explain an assessment, fill in a course's missing information (annotations), estimate work, prepare revision, tutor revision, practise wrong answers only, and review a pending item from "needs you" (#144). Opening the Agent page from a preset SHALL create a conversation with that context and send the rendered prompt automatically, once. Presets SHALL name courses and assessments by stored id and title, never include page content, and SHALL NOT be offered for exams where #146 removes the entry.

#### Scenario: From an assessment
- **WHEN** the owner clicks "let the agent do it" on assessment `a-1` of course `c-1`
- **THEN** a new conversation with that context starts and its first message is the rendered "complete an assessment" prompt naming `a-1`

#### Scenario: No double send
- **WHEN** the owner reloads the Agent page right after a preset conversation was created
- **THEN** the prompt is not sent a second time

### Requirement: Steps and cost are recorded per conversation
For each agent reply the backend SHALL record the number of tool steps, the number of agent turns and the cost the adapter reports, linked to the conversation and its assessment context, for the metrics in `metrics` (#133). A cost the adapter does not report SHALL be stored as unknown, not zero.

#### Scenario: Reported cost
- **WHEN** the adapter's result reports 14 turns and a cost of 0.42 USD
- **THEN** the conversation's run record holds 14 turns, the counted tool steps and 0.42 USD

