## Why

The Agent chat (decision #230) puts a Chinese text rendering of every selected course into the system prompt and asks the model to "write out the formula" when it calculates. The model then does grade arithmetic itself: it adds weights, applies parent/child scoring rules and works out the final-needed average in free text, so a wrong sum or a misread `points`/`weighted` rule reaches the student as a confident number. The same deterministic functions that the course page uses (`calculateGrades`, `finalNeeded`, `schedulePlan`) already exist and are tested. The owner decided that chat moves to tool calling for DeepSeek, OpenAI-compatible endpoints and Anthropic while Codex keeps the current way (#251), and that the tools are also exposed over MCP with the official SDK (#250). There is no measurement today of how often chat answers are right, so the change also adds a question set with gold answers and measures accuracy before and after.

## What Changes

- **Shared tool registry.** A new pure module, `shared/course-tools.ts`, defines six read-only tools over the display documents (`toDisplayDocument`) and an optional planning snapshot: `list_courses`, `get_assessments`, `calculate_grades`, `final_needed`, `upcoming_deadlines`, `plan_schedule`. Inputs are zod schemas; JSON Schemas for providers and MCP are generated from them. Tools never write, sync or use the network (#230, #238). Each result has a size limit.
- **Tool-calling chat for three providers.** DeepSeek (Responses API, which the chat already uses), OpenAI-compatible (chat completions) and Anthropic (Messages) run a bounded tool loop: stream a step, run the requested tools in-process, send results back, repeat until the model answers or the step limit is reached. Text deltas still stream to the page during every step.
- **Prompt.** In tool mode the system prompt carries a short course index instead of the full course data, drops "write out the formula" and requires every grade, weight total and final-needed figure to come from a tool result. Codex, and an OpenAI-compatible endpoint that rejects tools, keep the current prompt and context unchanged ("context mode").
- **Planning inputs.** Tasks, availability and target bands live in browser localStorage (#290 keeps them there). The page sends a bounded planning snapshot with each chat message; the server uses it for that reply only and never stores it. Without a snapshot (MCP), `plan_schedule` needs tasks passed as arguments and otherwise reports that planning data is not available.
- **UI and storage.** Tool calls appear in the conversation as a collapsible list of steps, live while the reply runs and from storage afterwards. Stored chat messages gain optional `mode`, `steps` and `reasoning` fields; existing chat files stay valid.
- **Q&A evaluation.** `test/fixtures/qa/` holds synthetic courses, a planning snapshot, a fixed date and at least 24 questions with gold answers (lookups, weights, grade calculation, final-needed, scheduling, refusals, missing data). A deterministic grader checks numbers within tolerance and required facts. A runner asks the configured model each question N times in context mode (before) and tool mode (after) and writes raw results to `.local/eval/qa/`; summary numbers go to `docs/eval-results.md`.
- **MCP server.** `scripts/mcp-server.mjs` serves the same registry over stdio with `@modelcontextprotocol/sdk`, reading the same course files as the app, with an optional course filter. The README explains how to connect Claude Code and Claude Desktop.
- Out of scope: owner corrections in chat or tools (#297 keeps chat on synced data), any write tool, Codex tool calling, MCP over HTTP, `node:sqlite`.

## Capabilities

### New Capabilities

- `course-tools`: the shared read-only tool registry, its six tools, input validation, planning inputs and output limits.
- `agent-chat`: tool-calling chat for the three HTTP providers, context mode for Codex and fallback, the bounded loop, the planning snapshot, stored steps and the collapsible step display.
- `chat-qa-eval`: the synthetic question set, the deterministic grader, the before/after runner and where results are recorded.
- `course-mcp-server`: the stdio MCP server over the same registry, its course filter and connection instructions.

### Modified Capabilities

None. No current spec covers the chat (`openspec/specs/` has `grade-target`, `revision` and `weekly-plan`). `grade-target` and `weekly-plan` are reused unchanged: the tools call `finalNeeded` and `schedulePlan` as specified there.

## Impact

- New: `shared/course-tools.ts` (registry, grading inputs from a document), `scripts/lib/chat-tool-loop.mjs` (+ `.d.mts`), `scripts/mcp-server.mjs`, `scripts/lib/course-mcp.mjs` (+ `.d.mts`), `scripts/eval-chat-qa.mjs`, `scripts/lib/qa-grade.mjs` (+ `.d.mts`), `test/fixtures/qa/`, `docs/eval-chat-qa.md`.
- Changed: `scripts/lib/llm-providers.mjs` (tool-aware request builders and stream parsers), `scripts/lib/chat-context.mjs` (course index, tool-mode prompt; grading inputs move to the registry), `scripts/lib/chat-store.mjs` (optional message fields), `vite.config.ts` (planning snapshot, `step` events, body limit), `web/src/Agent.tsx` (snapshot, step display), `web/src/LocalPlanning.tsx` (export the snapshot readers), `README.md`, `docs/eval-results.md`, `package.json`.
- New runtime dependency: `@modelcontextprotocol/sdk` 1.32.x (MIT; checked 2026-10-30, latest 1.32.2), used only by the MCP server. The app and chat do not import it.
- Data flow: tool results contain grades and go to the configured chat provider, as the course context does today; the MCP server sends them to whatever model the connected client uses. Nothing new leaves the machine otherwise.
- Existing chat files, browser storage and course files stay valid. Codex chat is unchanged.
