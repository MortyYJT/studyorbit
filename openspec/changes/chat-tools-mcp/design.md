## Context

**Chat today** (decision #230). `POST /api/local/chats/:id/messages` in `vite.config.ts` loads course documents with `loadCourseReports`, builds `chatSystemPrompt(language)` plus `buildChatContext(documents, { today, courseIds, courses })` (a Chinese rendering of every assessment and the graded totals, capped at 24 000 characters), keeps the newest turns within a 60 000-character budget, and calls `chat(config, { system, messages }, { signal, onDelta })` in `scripts/lib/llm-providers.mjs`. That function streams one reply:

- `deepseek`: `POST https://api.deepseek.com/responses` (Responses API) with `instructions` and `input`;
- `openai-compatible`: chat completions at the configured full URL, `stream_options.include_usage`;
- `anthropic`: Messages API, `anthropic-version: 2023-06-01`, the system block carries the cache breakpoint, no thinking parameter;
- `codex`: `codex exec --sandbox read-only`, one prompt, final message only.

Deltas go to the page as SSE `delta` events; the reply is saved by `appendMessages` with `usage`, `model` and `status` (`stopped` / `error`). `web/src/Agent.tsx` renders messages with `RichText`. The prompt says 「计算时写出算式」 / "show the arithmetic when you calculate", so the model does grade arithmetic in free text.

**Deterministic functions that already exist.** `shared/course-calculations.ts`: `calculateGrades(assessments, parents)`, `parentGrade(group)`, `finalNeeded(grades, target)`, `bandTargets`. `shared/planning.ts`: `schedulePlan(tasks, availability, today)`, `parseAvailability`. `shared/course-data.ts`: `toDisplayDocument` (v1/v2 → one display shape). `scripts/lib/chat-context.mjs` has a private `totals(doc)` that builds grading inputs from an uncorrected document the same way the course page does.

**Where planning inputs live.** Tasks (`coursework.local-planning.work.v1`), availability (`…availability.v1`) and target bands (`…targets.v1`) are in browser localStorage, and decision #290 keeps them there. The server cannot read them.

**Owner and lead decisions.** #229 (model settings), #230 (L0 chat), #238 (no L1/L2), #245 (evaluation with DeepSeek Flash, N = 5), #250 (MCP with the official `@modelcontextprotocol/sdk`), #251 (tool calling for DeepSeek, OpenAI-compatible and Anthropic; Codex unchanged), #297 (chat stays on synced data, no corrections). Lead choices for this change are #320–#332.

**External APIs, checked 2026-10-30.**

- DeepSeek Responses API (`api-docs.deepseek.com/api/create-response`, `/guides/responses_api`, `/guides/thinking_mode`): `tools[]` entries `{ type: 'function', name, description, parameters }`; `tool_choice` `none | auto | required | { type: 'function', name }`; `parallel_tool_calls` ignored (always parallel); output items `reasoning` (`content: [{ type: 'reasoning_text', text }]`), `message`, `function_call` (`call_id`, `name`, `arguments` JSON string, "not always valid JSON"); input items `function_call` and `function_call_output` (`call_id`, `output` string); streaming events include `response.output_item.added` / `.done`, `response.function_call_arguments.delta` / `.done`, `response.reasoning_text.delta`, `response.output_text.delta`, `response.completed`; the API is stateless (no `previous_response_id`, no `store`); thinking is on by default (`reasoning.effort: 'none'` turns it off). The thinking-mode guide says that when `tools` are sent, earlier reasoning "must be fully passed back … in all subsequent requests", else HTTP 400. Open DeepSeek issue #740 (awesome-deepseek-integration) reports HTTP 400 when anything sits between a `function_call` and its `function_call_output`.
- OpenAI-compatible chat completions: `tools: [{ type: 'function', function: { name, description, parameters } }]`, `tool_choice: 'auto' | 'none'`; streamed `choices[0].delta.tool_calls[{ index, id, type, function: { name, arguments } }]` fragments; `finish_reason: 'tool_calls'`; results as `{ role: 'tool', tool_call_id, content }` after the assistant message that carries the full `tool_calls` array.
- Anthropic Messages (`platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools`, `/handle-tool-calls`): tools `{ name (^[a-zA-Z0-9_-]{1,128}$), description, input_schema }`; response blocks `tool_use { id, name, input }` with `stop_reason: 'tool_use'`; reply with a user message whose content starts with `tool_result { tool_use_id, content, is_error? }` blocks, immediately after the assistant message; `tool_choice` `auto | any | tool | none`, and Claude Sonnet 5.5 / Opus 5.5 reject `any` and `tool` (HTTP 400), so only `auto` and `none` are used; streamed tool input arrives as `input_json_delta.partial_json`.
- MCP TypeScript SDK: `@modelcontextprotocol/sdk` latest 1.32.2 (npm, modified 2026-10-23), the v1.x maintenance line implementing MCP spec 2025-11-25, peer dependency `zod ^3.25 || ^4.0`, Node ≥ 18; `McpServer.registerTool(name, { title, description, inputSchema, outputSchema, annotations }, cb)` (`@modelcontextprotocol/sdk/server/mcp.js`), `StdioServerTransport` (`…/server/stdio.js`), `Client` (`…/client/index.js`), `StdioClientTransport` (`…/client/stdio.js`), `InMemoryTransport.createLinkedPair()` (`…/inMemory.js`). The README says v2 is the current stable line, shipped as `@modelcontextprotocol/server` / `@modelcontextprotocol/client` (2.4.0, Node ≥ 20), and v1.x gets fixes for at least six months after the v2 release on 2026-07-27.

## Goals / Non-Goals

**Goals:**
- Every grade, weight total, final-needed figure and schedule in a tool-mode answer comes from a deterministic function, not model arithmetic.
- One tool implementation serves the chat and MCP, so both give the same answer for the same data.
- The page still streams text, shows what the model looked up, and keeps working with existing chat files.
- Accuracy before and after is measured on a synthetic course with gold answers, reproducibly.

**Non-Goals:**
- Write tools (creating tasks, saving notes, syncing) or any network access from tools (#230, #238).
- Owner corrections in the tools or chat (#297, decision #321); a later change can pass corrected documents into the same tool context.
- Tool calling for Codex (#251).
- MCP over HTTP, MCP resources or prompts, or authentication.
- Changing `calculateGrades`, `finalNeeded` or `schedulePlan` results.

## Decisions

### 1. One registry in `shared/course-tools.ts` (decision #320)

A pure module (no I/O, no clock reads) shared by the Vite chat route, the Q&A runner and the MCP server. `scripts/*.mjs` already import `shared/*.ts` directly under Node 24.

```ts
type PlanningSnapshot = {
  tasks: { key: string; title: string; courseId: string; courseCode: string; due: string; minutes: number; spent?: number; done?: boolean }[];  // the page's own task keys
  availability: number[];                       // 7 values, Monday first
  targets: Record<string, Band>;                // courseId -> saved band
};
type ToolContext = {
  documents: DisplayDocument[];                 // already passed through toDisplayDocument
  courses: { id: string; code?: string; name?: string }[];  // known courses, for ones without data
  scope: string[];                              // course IDs the tools may read
  today: string;                                // YYYY-MM-DD, Australia/Melbourne
  planning: PlanningSnapshot | null;
};
type CourseTool = { name: string; title: string; description: string; input: z.ZodObject; run(input, ctx): object };
export const courseTools: readonly CourseTool[];
export function toolDefinitions(): { name: string; description: string; parameters: JSONSchema }[];  // z.toJSONSchema, `$schema` removed
export function runTool(name: string, args: unknown, ctx: ToolContext): { ok: boolean; text: string; value: object };
export function gradingInputs(doc: DisplayDocument): { assessments: GradingItem[]; parents: GradingGroup[] };
```

- `gradingInputs` moves the body of `totals()` from `chat-context.mjs` unchanged; `buildChatContext` then calls it, so context mode output stays byte-identical.
- `runTool` looks the tool up, parses `args` with the tool's zod schema, runs it, rounds every number to two decimals for output, serialises with `JSON.stringify`, and applies the size limit (§5). Failures return `ok: false` with `{ error: { code, message } }`; codes: `UNKNOWN_TOOL`, `INVALID_ARGUMENTS` (zod issues as `path: message`), `COURSE_NOT_IN_SCOPE` (lists the allowed IDs), `COURSE_NOT_SYNCED`, `UNKNOWN_ASSESSMENT`, `RESULT_TOO_LARGE`. Messages are English and say what to try next.
- Tool names match `^[a-z_]{1,64}$`, valid for all three providers and MCP.
- The same `today` and documents are used for every call within one reply, so repeated calls agree.

### 2. The six tools (decision #320)

| Tool | Input | Returns |
| --- | --- | --- |
| `list_courses` | `{}` | `today`, and for each scope course: `id`, `code`, `name`, `term`, `synced`, `version`, `assessmentCount`, `identifiedWeight` (sum of top-level weights that count) |
| `get_assessments` | `courseId`, optional `ids` (≤ 50), optional `kind` | per assessment: `id`, `parentId`, `name`, `kind`, `nature`, `weight`, `weightUnsourced`, `score`, `maxScore`, `due` (Melbourne `YYYY-MM-DD HH:mm`, or the date), `status`, `scoring`, `rule`, `ruleUnsourced` |
| `calculate_grades` | `courseId`, optional `whatIf: [{ assessmentId, percent 0–100 }]` (≤ 20) | `gradedWeight`, `earned`, `average` (null when nothing is graded), `remainingWeight` (100 − graded), `identifiedWeight`, `counted: [{ id, name, weight, earned }]`, `excluded: [{ id, name, reason }]`, `whatIfApplied: [{ assessmentId, percent, effect, reason? }]` |
| `final_needed` | `courseId`, optional `target` (band name or 0–100), optional `whatIf` | `target: { band?, percent, source: 'argument' \| 'saved' \| 'default' }`, `status` (`secured` / `reachable` / `unreachable`), `neededAverage` (reachable only), `earned`, `gradedWeight`, `remainingWeight`, `unidentifiedWeight` |
| `upcoming_deadlines` | optional `days` (1–120, default 14), optional `courseIds`, optional `includeDone` (default false) | items due from `today` to `today + days − 1` across scope courses, sorted by due: `courseId`, `code`, `id`, `name`, `due`, `weight`, `status` (≤ 50) |
| `plan_schedule` | optional `from` (≥ today, default today), optional `days` (1–28, default 7), optional `courseIds` (output filter), optional `tasks` (≤ 500, same fields as the snapshot; `key` optional), optional `availability` | `available: false` with a reason, or `tasksSource`, `availabilitySource`, `days: { date: [{ key, title, courseCode, minutes }] }` within the window, `overflow: [{ key, title, minutes, overdue }]` |

- **Grades.** `counted` and `excluded` come from a new `gradeBreakdown(assessments, parents)` in `shared/course-calculations.ts`; `calculateGrades` is rewritten to sum that breakdown, and its existing tests must pass unchanged (a property test also checks that breakdown sums equal the totals). Exclusion reasons: `bonus`, `ungraded`, `alternative`, `zero-weight`, `no-mark`, `incomplete-group`.
- **What-if.** `percent` on an assessment with `maxScore` sets `score = percent / 100 × maxScore`; without `maxScore` it sets `score = percent, maxScore = 100`. On a parent it sets the parent's own score (which `parentGrade` already prefers). An unknown ID is `UNKNOWN_ASSESSMENT`; a bonus, ungraded or alternative item is `INVALID_ARGUMENTS`. A what-if that cannot change the total is never silent: every entry is reported in `whatIfApplied` with `effect: 'counted'` (the item, or the group it belongs to, is in `counted` after applying) or `effect: 'none'` and a `reason`: `no-weight` (neither the item nor its group has a weight), `parent-score-overrides` (a child whose parent has its own score, which `parentGrade` uses first), `group-incomplete` (other children of the group still have no mark), or the item's exclusion reason. The tool-mode prompt tells the model to mention any `effect: 'none'` entry. Nothing is written anywhere.
- **Final needed** wraps `finalNeeded(calculateGrades(...), target)` (spec `grade-target`). Without `target`, it uses the band saved for that course in the planning snapshot, else H1, matching the course page default; `source` says which.
- **Schedule** maps tasks to `PlanTask` keeping each task's own `key` (argument tasks without a key get `arg:1…n`), calls `schedulePlan(tasks, availability, today)` (spec `weekly-plan`) always from `today` over every task it was given, and only filters the output to the window and the optional `courseIds`. `schedulePlan` breaks due-date ties by key and fills days in deadline order, so keeping the page's keys and the page's full task set is what makes the result equal to the weekly page's plan. Task source: `tasks` argument, else the snapshot's tasks, else `available: false, reason: 'Planning tasks live in the StudyOrbit page and were not provided; pass tasks to plan with them.'`. Availability: argument, else snapshot, else `defaultAvailability` (`availabilitySource: 'default'`).
- Unsourced weights and rules (`unsourced`, contract v2) are returned as `null` with the `…Unsourced: true` flag so the model can say "no source" instead of guessing.

### 3. Planning inputs: the page sends a snapshot (decision #322)

Two options were considered: the page sends the planning data with each message, or `plan_schedule` reports "not available" in chat too. The second would make every scheduling question in the chat fail, so the page sends a snapshot, and only the MCP path (which has no page) reports "not available" unless tasks are passed as arguments.

- `Agent.tsx` reads the same keys as `LocalPlanning.tsx` through readers exported from it (`readWork`, `readAvailability`, `readTargets`) and sends `planning: { tasks, availability, targets }` in the message body. `tasks` is exactly the set the weekly page plans with (the page's `work.filter(inScope)`: every task of the loaded, selected courses plus personal tasks with `courseId: ''`), not limited to the chat scope, each with its real `key`; done tasks are left out (`schedulePlan` skips them anyway); titles are cut to 200 characters. If there are more than 500 unfinished tasks, the first 500 in `schedulePlan` order (due, then key) are sent: earliest-deadline-first never lets a later task change an earlier task's placement, so the plan for the tasks sent is unchanged, and the course index says the list was cut. Targets of all loaded courses are sent. The chat scope only filters what `plan_schedule` returns (its `courseIds` argument), never its input.
- The route validates it with a zod schema (strict; dates `YYYY-MM-DD`; `0 < minutes ≤ 100000`; availability through `parseAvailability`); an invalid snapshot is `400 INVALID_PLANNING`. A missing snapshot means `planning: null`. The body limit rises from 40 000 to 200 000 characters.
- The snapshot is used for that reply only. It is not written to the chat file; tool results that quote task titles are, as part of `steps` in `.local/chat/`.

### 4. Two modes and the prompt (decisions #323, #328)

- **Tool mode** (`deepseek`, `openai-compatible`, `anthropic`). The system prompt is `chatSystemPrompt(language, 'tools')`: the same role, scope and refusal lines as today; the line 「只根据下面的课程数据回答…计算时写出算式」 is replaced by: course facts must be looked up with the tools before answering; every grade, weight total, final-needed figure and schedule must come from a tool result; do not do the arithmetic yourself or present a formula you computed; if a tool shows missing or unsourced data, say you are not sure. It is followed by a **course index** from `buildCourseIndex(...)`: today's date, whether a planning snapshot is attached (number of tasks), and per scope course one line with ID, code, name, term and whether synced data exists. The full course rendering is not sent.
- **Context mode** (`codex`, and the fallback below). `chatSystemPrompt(language)` and `buildChatContext(...)` stay byte-identical to today (a snapshot test pins them), so the Q&A "before" numbers can be reproduced at any later commit.
- **Fallback.** If the first request of a tool-mode reply to an `openai-compatible` endpoint returns HTTP 400, 404 or 422 **and** the (redacted) error body is clearly about tools (it mentions `tool`, `tools`, `tool_choice`, `function_call` or `function calling`, and does not mention `reasoning`), the reply is retried once in context mode, saved with `mode: 'context', fallback: true`, and the page notes 「这个模型接口不支持工具调用，本条未用工具」. Every other error (a 400 about missing reasoning, any DeepSeek or Anthropic error, any error on a later step) is shown as today and never falls back, so a wrong 「不支持工具调用」 note cannot appear.

### 5. The tool loop (decision #324)

`runChatWithTools(config, { system, history, tools, runTool }, { signal, onDelta, onStep })` in `scripts/lib/chat-tool-loop.mjs`, using per-provider wire adapters added to `llm-providers.mjs` (`buildToolRequest`, a streaming parser that yields `{ text, reasoning, calls, usage, stop }`, and `appendToolRound`).

- Up to **8 model requests** per reply and **16 tool calls** in total. Parallel calls within one step are run in order. Calls beyond the budget get an error result (`TOOL_BUDGET_EXHAUSTED`: answer with what you have). The request that reaches the 8-request limit, or the first one after the budget is spent, is sent with tool choice `none`. If the model still asks for tools then, the reply ends with error 「模型没有在步数内给出回答。」 and keeps the text so far.
- **Output limits.** One tool result is at most 8 000 characters: the largest array in the result is cut and `truncated: { field, shown, total, hint }` is added; if it still does not fit the result is `RESULT_TOO_LARGE`. All tool results in one reply are at most 40 000 characters; beyond that, calls get `TOOL_BUDGET_EXHAUSTED`.
- Empty arguments mean `{}`: an empty or whitespace-only `arguments` string (chat-completions fragments or DeepSeek for a no-argument call), and an Anthropic `tool_use` with no `input_json_delta` (its `input` from `content_block_start`, normally `{}`). Arguments that are otherwise not valid JSON, or fail the schema, are returned to the model as `INVALID_ARGUMENTS` (counted against the budget), so it can correct itself.
- **Streaming.** Every step streams; text deltas are forwarded with `onDelta` as they arrive (some models write a sentence before calling a tool). The saved `content` is the text of all steps joined by a blank line. `onStep` reports `{ index, name, args }` when a call starts and `{ index, ok, preview }` when it finishes.
- **Limits that stay.** The 5-minute timeout covers the whole loop; stop, closing the tab and errors keep the partial text and the steps run so far (`status: 'stopped' | 'error'`), as today. Usage is summed over the steps that reported it (null only when none did).
- Tools run in-process on documents loaded once before the loop; no tool call can block on I/O.

### 6. Wire formats (decision #325)

| | DeepSeek (Responses) | OpenAI-compatible (chat completions) | Anthropic (Messages) |
| --- | --- | --- | --- |
| Tools | `tools: [{ type: 'function', name, description, parameters }]` | `tools: [{ type: 'function', function: { name, description, parameters } }]` | `tools: [{ name, description, input_schema }]` |
| Choice | `tool_choice: 'auto'`, last step `'none'` | same | `{ type: 'auto' }`, last step `{ type: 'none' }` |
| Calls read from | `response.output_item.done` items of type `function_call` (`call_id`, `name`, `arguments`) | `delta.tool_calls` fragments merged by `index`; a step with calls is a tool step even if `finish_reason` is `stop` | `content_block_start` `tool_use` + `input_json_delta` fragments; `stop_reason: 'tool_use'` |
| Reasoning | `response.reasoning_text.delta` collected | `delta.reasoning_content` collected when present | `thinking` blocks (with `signature`) kept verbatim when present |
| Round appended | `reasoning` item, the step's `message` item (if text), then each `function_call` immediately followed by its `function_call_output` | `{ role: 'assistant', content, tool_calls, reasoning_content? }` then one `{ role: 'tool', tool_call_id, content }` per call | assistant message with all blocks as received, then a user message with only `tool_result` blocks (`is_error: true` on failures) |
| Earlier turns | user text; assistant: `reasoning` item from the stored `reasoning`, then the final text; reasoning-less turns handled as below | user text; assistant text with `reasoning_content` from the stored `reasoning` when present | user and assistant text, as today |

- No `parallel_tool_calls` and no `strict` flag are sent (not all compatible servers accept them).
- The Anthropic system block keeps its cache breakpoint; tool definitions come before the system block in the cache prefix, so they are cached with it.
- Earlier turns do not replay earlier tool calls; the model calls tools again when needed (cheap and deterministic).
- **Reasoning across turns.** DeepSeek's thinking-mode rule (when `tools` are sent, earlier reasoning must be passed back in every later request, else HTTP 400) means a plain-text history breaks turn 2. So every tool-mode reply from `deepseek` and `openai-compatible` stores the reasoning it streamed (`response.reasoning_text.delta`, or `delta.reasoning_content`) in `reasoning`, and later turns replay it: as a `reasoning` input item before the assistant message for DeepSeek, as `reasoning_content` on the assistant message for chat completions. For DeepSeek, assistant turns with no stored reasoning (chats from before this change, replies that streamed no reasoning) are not sent as assistant messages: every turn up to and including the last reasoning-less assistant turn is folded into one quoted transcript (「之前的对话」, user and assistant lines as in the Codex prompt) at the top of the first user message sent; later turns are sent natively. PR 2 checks a new two-turn chat and a chat with older history against the live API.

### 7. Stored format, events and display (decisions #326, #327)

`ChatMessageSchema` gains three optional fields; old files parse unchanged, and an older build reading a new file drops them (zod strips unknown keys):

```
mode?: 'tools' | 'context'          // absent = context (written before this change)
fallback?: true                     // context mode because the endpoint rejected tools
steps?: { name: string, args: string /* JSON, ≤ 2000 chars */, ok: boolean,
          result: string /* exact text sent to the model, ≤ 8000 chars */, ms: number }[]   // ≤ 16
reasoning?: string                  // deepseek / openai-compatible tool mode, ≤ 30000 chars; replayed, never shown
```

- The 60 000-character history budget counts `reasoning` too. Reasoning longer than 30 000 characters is not cut (a partial replay could be rejected): the message is stored without it and counts as reasoning-less in later turns.
- SSE gains `event: step` with `{ index, name, args, state: 'running' }` and `{ index, state: 'done', ok, preview }` (preview ≤ 200 characters). `done` carries the saved message including `steps`.
- `Agent.tsx` shows the steps above the reply text as a native `<details>` element, closed by default, summary 「用了 N 个工具」 / "Used N tools" (with 「，1 个出错」 when some failed); each step shows a localised tool label, the arguments and the result in a scrollable `<pre>`. While a reply runs, the current call is shown as 「正在查询：<label>…」. `RichText` and the 「存到复习」 button are unchanged and save only `content`.

### 8. Q&A evaluation (decision #329)

- **Fixtures** in `test/fixtures/qa/`: two synthetic v2 course documents (`SYNT10001`: points and weighted groups, a bonus item, an alternative item, a hurdle, an unsourced weight, some graded items; `SYNT20002`: nothing graded yet), `planning.json` (snapshot with personal and course tasks, availability with a day off, a saved target), `context.json` (`today: '2026-09-14'`, course list, scope), and `questions.json`.
- **Questions** (≥ 24, Chinese and English): lookup (due date, status, rule), weight (single, group total, unsourced), grade calculation (current total, average, a what-if), final-needed (saved target, explicit band, unreachable, secured), scheduling (what to do on a day, overflow), refusal (write an assignment, submit for me, answer quiz questions), out of scope (another student's grade, unrelated question), missing data (course with no grades).
- **Gold** per question: `answer` (reference text, not graded), `numbers: [{ value, tolerance = 0.1, source: { tool, args, path } }]` (the registry call that must produce `value`, and a dot/bracket path into its result value such as `neededAverage` or `counted[0].earned`), `facts: string[][]` (every group must match one alternative), `forbidden: string[]`, `refusal: boolean`, `expectTools: string[]` (reported, not graded). Gold values are computed once by hand; a fixture test runs every `source` call against the fixture context and checks that the value at `path` equals `value`, so a gold error or a registry change cannot hide.
- **Grader** (`scripts/lib/qa-grade.mjs`, pure): normalise (NFKC, lower case, thousands separators removed); extract numbers; each gold number must be within tolerance of some number in the answer; each fact group must be present; no forbidden string; refusal questions also need a refusal marker from a fixed bilingual list. Result: pass/fail with per-check details. A failed or stopped call counts as a failed answer and is also reported separately.
- **Runner** (`scripts/eval-chat-qa.mjs`): `--mode context|tools|both` (default both), `--n` (default 5, as #245; max 20), `--only <ids>`, `--provider` / `--model` (same rules as `eval-course-analysis.mjs`), `--fake <dir>` (scripted provider streams, for tests), `--out` (default `.local/eval/qa/<start time>/`, refused inside the Desktop). Each question is a fresh one-message conversation built exactly like the chat route for that mode, with the fixture documents, date and snapshot, through the same `chat` / `runChatWithTools` functions (no HTTP server). Outputs: per-answer JSON (text, steps, usage, time, grade), `summary.json`, `summary.md`, files mode 600.
- **Metrics** per mode: accuracy (passed ÷ answers), by category; per-question pass rate over N; tool use (answers with ≥ 1 step; grade and final-needed answers that called `calculate_grades` / `final_needed`); fallbacks; call failures; tokens and time.
- **Cost.** Every live run makes real model calls: 24 questions × N 5 × 2 modes = 240 conversations, tool mode with 2–4 requests each. The runner prints the planned conversation count before starting; the first run records actual tokens in `docs/eval-results.md`, so later estimates use measured numbers.
- **Recording.** Fixtures are synthetic, so per-category tables and per-question pass rates can be committed in `docs/eval-results.md`; raw answers stay in `.local/eval/qa/`. Format and limits go in `docs/eval-chat-qa.md`.

### 9. MCP server (decisions #330, #331)

- `scripts/lib/course-mcp.mjs` exports `createCourseMcpServer({ loadContext, version })`: an `McpServer` (`name: 'studyorbit'`) with one `registerTool` per registry tool (`inputSchema` = the tool's zod object, `annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }`). Each call awaits `loadContext()`, runs `runTool`, and returns `{ content: [{ type: 'text', text }], isError: !ok }`.
- SDK 1.32.2 behaviour to design around: `McpServer` validates arguments against `inputSchema` before calling the callback and answers invalid arguments itself with `isError: true` and its own message text, and it converts the zod schema to the JSON Schema shown in `tools/list`. So for invalid arguments the MCP text differs from the registry's `INVALID_ARGUMENTS` text, and the listed schema need not be byte-identical to `toolDefinitions()`. Tests assert `isError: true` for bad arguments (not the text), identical text for valid arguments, and for schemas only the same property names and required list.
- `scripts/mcp-server.mjs` (`npm run mcp`): parses `--project <dir>` (default: the repository containing the script), `--desktop <dir>` (default `~/Desktop`, as the app), `--courses <id,id>` or `STUDYORBIT_COURSES`; `loadContext` calls `loadCourseReports` on every tool call (files can change after a sync), converts with `toDisplayDocument`, sets the scope to the filter (or every listed course), `today` in Melbourne time and `planning: null`; connects `StdioServerTransport`. A missing course list becomes a tool error, not a crash. Nothing is written to stdout except protocol messages; diagnostics go to stderr. It needs no model key and makes no network requests.
- **SDK line.** #250 names `@modelcontextprotocol/sdk`, so the change uses 1.32.x. v2 (`@modelcontextprotocol/server`) is the current stable line with a smaller dependency tree; all SDK use sits in `course-mcp.mjs` and the test, so moving later is a small change. This is recorded for the owner to review (#330).
- README (Chinese, like the rest): `claude mcp add studyorbit -- node <仓库绝对路径>/scripts/mcp-server.mjs [--courses …]`; Claude Desktop `claude_desktop_config.json` `mcpServers.studyorbit = { command: "node", args: ["<仓库绝对路径>/scripts/mcp-server.mjs"] }`; Node ≥ 24 must be the `node` on PATH (or give its absolute path); a note that tool results contain grades and go to the model the client uses. Placeholders only, no real paths.

### 10. Delivery in four PRs (decision #332)

1. Registry and tests (`shared/course-tools.ts`, `gradeBreakdown`, `gradingInputs` moved, context-mode snapshot test).
2. Tool loop for the three providers, prompt and index, planning snapshot, storage fields, `step` events, step display, fallback; tests with scripted provider streams; Codex untouched.
3. Q&A fixtures, grader, runner, `docs/eval-chat-qa.md`, before/after numbers in `docs/eval-results.md`.
4. MCP server, README, in-memory and stdio tests, dependency.

PR 3 can start after PR 1 (its context mode needs only today's code); its "after" run needs PR 2. PR 4 needs only PR 1.

## Risks / Trade-offs

- [The model answers from the course index without calling a tool] → the prompt requires lookups; the Q&A tool-use metric shows how often it happens; the index holds no assessment facts to answer from.
- [DeepSeek rejects history whose earlier assistant turns have no reasoning] → reasoning is stored and replayed for DeepSeek and chat-completions replies, and reasoning-less DeepSeek turns are folded into a transcript (§6). Not verified against the live API yet (PR 2 task).
- [An OpenAI-compatible endpoint that is really a thinking model rejects reasoning-less older turns] → the 400 is shown as an error, not turned into a fallback; replies from then on carry stored reasoning.
- [DeepSeek call/output adjacency (#740)] → outputs are appended immediately after their calls; a test checks the order.
- [OpenAI-compatible servers differ (missing ids in fragments, `finish_reason: 'stop'` with calls, no tool support)] → calls merged by `index` with a generated ID when missing; calls detected by presence; empty arguments read as `{}`; one-time fallback to context mode only for errors clearly about tools.
- [Anthropic thinking blocks on by default on some models] → blocks are passed back unchanged within the loop; across turns only text is sent, as today.
- [More latency and tokens per reply (2–4 requests instead of 1)] → the index prompt is much shorter than the full context; the Anthropic cache covers tools and system; the Q&A run measures both.
- [A tool result exposes grades to the provider] → the same data is in the context today; MCP sends it to whatever the client uses, stated in the README.
- [Number matching passes an answer that mentions the right number by chance] → gold values chosen to be distinctive (two decimals), tight tolerance, plus fact groups; listed as a limitation.
- [The MCP SDK v1 line ends support some time after 2027-01-27, and it pulls in express/hono] → isolated in one module; dependency added only for the MCP server; owner review #330.
- [Planning snapshot can be stale if another tab edits tasks during a reply] → the reply uses the snapshot sent with the message, as the page itself would.

## Migration Plan

No data migration. Chat files gain optional fields; existing chats continue in tool mode with their text history (DeepSeek caveat above). Rollback: revert PR 2; files with the new fields still parse in the old code (fields dropped). The MCP server and Q&A runner are separate entry points and can be removed independently.

## Open Questions

- Should tools later read the owner's corrections (`.local/corrections/`, #290–#297)? Left to a later change; `ToolContext.documents` is the only place that would change.
- Move the MCP server to SDK v2 (`@modelcontextprotocol/server`)? Owner review (#330).
