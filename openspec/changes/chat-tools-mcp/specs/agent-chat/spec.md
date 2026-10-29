## ADDED Requirements

### Requirement: Tool-calling chat for DeepSeek, OpenAI-compatible and Anthropic
When the configured provider is `deepseek`, `openai-compatible` or `anthropic`, the chat SHALL send the registry's tools with every model request in that provider's native format (DeepSeek Responses `function` tools, chat-completions `tools`, Messages `tools`), run each requested call in-process with the registry, return the results in the provider's format (`function_call_output` immediately after its `function_call`; `role: tool` messages after the assistant message with `tool_calls`; a user message of `tool_result` blocks, with `is_error` on failures, immediately after the assistant message) and repeat until the model answers. Tool choice SHALL be `auto`, or `none` on the forced last request.

#### Scenario: Grade question on Anthropic
- **WHEN** the model's first streamed step ends with `stop_reason: tool_use` and a `calculate_grades` call
- **THEN** the chat runs the tool, sends the assistant blocks and a `tool_result` for that call, and streams the second step's text as the answer

#### Scenario: Parallel calls on DeepSeek
- **WHEN** one DeepSeek step returns two `function_call` items
- **THEN** both run and the next request's input has each `function_call_output` directly after its own `function_call`

#### Scenario: Fragmented calls on an OpenAI-compatible endpoint
- **WHEN** a call's name and arguments arrive split across several `delta.tool_calls` fragments with the same `index`
- **THEN** they are merged into one call before it runs

### Requirement: Grade arithmetic comes from tools
In tool mode the system prompt SHALL NOT ask the model to write out formulas; it SHALL require that course facts are looked up with tools and that every grade, weight total, final-needed figure and schedule comes from a tool result, and that missing or unsourced data is reported as uncertain. Instead of the full course data, the prompt SHALL carry a course index: today's date, whether a planning snapshot is attached, and per scope course its ID, code, name, term and whether synced data exists.

#### Scenario: Tool-mode prompt
- **WHEN** the tool-mode system prompt is built for two scope courses
- **THEN** it contains each course's ID and code, does not contain 「写出算式」 or "show the arithmetic", and contains no assessment names or scores

### Requirement: Codex keeps context mode
When the provider is `codex`, the chat SHALL use the existing prompt and full course context unchanged and SHALL NOT send tools. The context-mode prompt and context text MUST stay byte-identical to the version before this change.

#### Scenario: Codex reply
- **WHEN** the provider is `codex`
- **THEN** the prompt sent to `codex exec` equals the prompt built before this change for the same inputs, and the saved message has no `steps`

### Requirement: Fallback when an OpenAI-compatible endpoint rejects tools
When the first request of a tool-mode reply to an `openai-compatible` endpoint returns HTTP 400, 404 or 422 and the error body is clearly about tools (it mentions `tool`, `tools`, `tool_choice`, `function_call` or `function calling`, and does not mention `reasoning`), the chat SHALL retry that reply once in context mode, save it with `mode: 'context'` and `fallback: true`, and the page SHALL say that this reply did not use tools. Any other error, other providers and later steps SHALL NOT fall back; the error is shown as before.

#### Scenario: Local model without tool support
- **WHEN** the endpoint answers the first tool request with HTTP 400 and the body `tools is not supported for this model`
- **THEN** a context-mode request is sent, its streamed answer is saved with `fallback: true`, and the page shows 「这个模型接口不支持工具调用，本条未用工具」

#### Scenario: Error not about tools
- **WHEN** the endpoint answers the first tool request with HTTP 400 whose body mentions `reasoning_content`
- **THEN** the reply ends with that error, no context-mode request is sent, and no 「不支持工具调用」 note is shown

### Requirement: Bounded tool loop
A reply SHALL make at most 8 model requests and at most 16 tool calls, and its tool results together SHALL be at most 40 000 characters. Calls beyond a budget SHALL get a `TOOL_BUDGET_EXHAUSTED` result. The last allowed request SHALL be sent with tool choice `none`; if the model still requests tools, the reply SHALL end with an error and keep its text. Empty arguments (an empty or whitespace-only arguments string, or an Anthropic `tool_use` with no streamed input) SHALL be treated as `{}`. Other arguments that are not valid JSON or fail the schema SHALL be returned to the model as `INVALID_ARGUMENTS` and count against the budget. The 5-minute timeout SHALL cover the whole loop, and usage SHALL be summed over the steps that reported it.

#### Scenario: Model keeps calling tools
- **WHEN** a model requests a tool on every step
- **THEN** the eighth request is sent with tool choice `none`, and if it still returns a call the reply ends with 「模型没有在步数内给出回答。」 and its partial text is saved with `status: 'error'`

#### Scenario: Call without arguments
- **WHEN** a chat-completions stream sends a `list_courses` call whose `arguments` fragments are all empty
- **THEN** the tool runs with `{}` and returns the course list

#### Scenario: Malformed arguments
- **WHEN** a call's arguments are `{"courseId": `
- **THEN** the model receives an `INVALID_ARGUMENTS` result for that call and the loop continues

### Requirement: Planning snapshot sent with each message
The page SHALL send, with each chat message, a planning snapshot from browser storage: the unfinished tasks the weekly page plans with (every task of the loaded courses and personal tasks, not limited to the chat scope), each with its own key, titles at most 200 characters, at most 500 taken in due-then-key order; the daily availability; and the saved target bands of the loaded courses. The server SHALL validate it strictly, answer `400 INVALID_PLANNING` when it is invalid, use it for that reply only and SHALL NOT store it. A message without a snapshot SHALL run with no planning data. The request body limit SHALL be 200 000 characters.

#### Scenario: Scheduling question
- **WHEN** the page sends a message with a snapshot of three tasks and the model calls `plan_schedule` without arguments
- **THEN** the tool plans those three tasks with the sent availability, and the chat file does not contain the snapshot itself

#### Scenario: Chat scoped to one course
- **WHEN** the chat scope is one course and the page also plans tasks of another selected course and a personal task
- **THEN** the snapshot contains all of those tasks with their page keys, and `plan_schedule` places the scoped course's tasks exactly as the weekly page does

#### Scenario: Invalid snapshot
- **WHEN** a snapshot task has `due: "next week"`
- **THEN** the server answers `400 INVALID_PLANNING` and no user message is saved

### Requirement: Tool steps are streamed, stored and shown
The chat SHALL send an SSE `step` event when a call starts (`index`, `name`, `args`) and when it ends (`index`, `ok`, a preview of at most 200 characters), and SHALL keep streaming text deltas during every step. The saved assistant message SHALL have `mode: 'tools'`, `content` equal to the text of all steps joined by a blank line, and `steps` with each call's name, arguments, success, the exact result text sent to the model and its duration. The page SHALL show the steps of a message as a collapsible element, closed by default, summarised as 「用了 N 个工具」 / "Used N tools", and SHALL show the running call while a reply is in progress. For `deepseek` and `openai-compatible` tool-mode replies, the streamed reasoning text SHALL be stored in `reasoning` and never shown.

#### Scenario: Reopening a chat
- **WHEN** a saved reply used `calculate_grades` and `final_needed`
- **THEN** the reopened chat shows 「用了 2 个工具」 collapsed above the reply, and expanding it shows both calls with their arguments and results

#### Scenario: Stopped mid-loop
- **WHEN** the owner stops a reply after one tool call has finished
- **THEN** the saved message has `status: 'stopped'`, the text so far and that one step

### Requirement: Stored chat format stays compatible
Chat messages SHALL accept the optional fields `mode` (`tools` or `context`), `fallback`, `steps` (at most 16; arguments at most 2 000 and results at most 8 000 characters each) and `reasoning` (at most 30 000 characters). Chat files written before this change SHALL load unchanged, and a message without `mode` SHALL be treated as context mode. Later turns SHALL send earlier messages as text without replaying earlier tool calls, and SHALL replay stored reasoning: as a `reasoning` input item before the assistant message for DeepSeek, as `reasoning_content` on the assistant message for chat completions. For DeepSeek and chat completions, every turn up to and including the last assistant turn without stored reasoning SHALL be sent as one quoted transcript at the top of the first user message instead of as separate messages. The history budget SHALL count stored reasoning.

#### Scenario: Old chat file
- **WHEN** a chat file has assistant messages with only `role`, `content`, `at`, `usage` and `model`
- **THEN** it loads, is listed, and can be continued in tool mode

#### Scenario: Second DeepSeek turn
- **WHEN** a DeepSeek tool-mode reply stored reasoning and the owner sends a second message
- **THEN** the second request's input has that reasoning as a `reasoning` item before the first assistant message

#### Scenario: DeepSeek chat started before this change
- **WHEN** a chat has two earlier assistant messages without `reasoning` and the provider is DeepSeek
- **THEN** those turns are sent as a quoted transcript in the new user message, and no assistant message without reasoning is sent
