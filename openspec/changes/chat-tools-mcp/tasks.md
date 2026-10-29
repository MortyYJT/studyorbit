## 1. Tool registry (PR 1)

- [x] 1.1 Snapshot test pinning today's `chatSystemPrompt('zh' | 'en')` and `buildChatContext` output for a synthetic document (context mode must stay byte-identical)
- [x] 1.2 Tests then `gradeBreakdown` in `shared/course-calculations.ts`; rewrite `calculateGrades` to sum it; existing grade tests unchanged and green; property test: breakdown sums equal totals
- [x] 1.3 Move `totals()` grading inputs from `scripts/lib/chat-context.mjs` to `gradingInputs(doc)` in `shared/course-tools.ts`; chat context calls it; 1.1 stays green
- [x] 1.4 Tests then the registry core: `courseTools`, `toolDefinitions()` (`z.toJSONSchema`, no `$schema`, `type: object`), `runTool` (unknown tool, `INVALID_ARGUMENTS` paths, scope check, unsynced course, two-decimal rounding, deterministic output)
- [x] 1.5 Tests then `list_courses` and `get_assessments` (filters, Melbourne due format, unsourced flags, v1 and v2 documents)
- [x] 1.6 Tests then `calculate_grades` (leaf, points group, weighted group, bonus/ungraded/alternative/zero-weight exclusions, incomplete group, what-if on leaf, parent and item without maximum, what-if on a bonus rejected, `whatIfApplied` effects incl. `no-weight`, `parent-score-overrides` and `group-incomplete`) and `final_needed` (argument, saved, default target; secured, reachable, unreachable; unidentified weight)
- [x] 1.7 Tests then `upcoming_deadlines` (window, done items, cap) and `plan_schedule` (snapshot, argument tasks with and without keys, page keys kept so same-day ties match the weekly page, availability sources, window and `courseIds` output filter that never changes placements, overflow, `available: false`)
- [x] 1.8 Tests then the 8 000-character limit (`truncated` metadata, `RESULT_TOO_LARGE`)
- [ ] 1.9 `bash .claude/check.sh`; fresh-context review; record the PR number here (PR #264; check passes, review pending)

## 2. Tool-calling chat (PR 2)

- [x] 2.1 Tests then `chatSystemPrompt(language, 'tools')` and `buildCourseIndex` (no formula wording, IDs and codes present, no assessment facts, snapshot line)
- [x] 2.2 Tests then wire adapters in `scripts/lib/llm-providers.mjs` for DeepSeek Responses, chat completions and Anthropic: request bodies with tools and tool choice; stream parsing of calls (DeepSeek `output_item.done`, chat-completions fragments by `index` incl. missing IDs and `finish_reason: stop` with calls, Anthropic `tool_use` + `input_json_delta`), empty arguments read as `{}` (empty fragments, `tool_use` without input deltas), reasoning and thinking capture; round appending order (DeepSeek call/output adjacency, Anthropic `tool_result` first and only)
- [x] 2.3 Tests then `runChatWithTools` in `scripts/lib/chat-tool-loop.mjs` (+ `.d.mts`) with scripted streams: one-step answer, tool then answer, parallel calls, 8-request and 16-call limits with tool choice `none`, 40 000-character budget, invalid JSON arguments, stop mid-loop, provider error mid-loop, usage summed, `onStep` events
- [x] 2.4 Tests then the openai-compatible fallback (400/404/422 on the first request only, and only when the body is about tools; a 400 mentioning `reasoning` is shown as an error) and that Codex still gets the pinned context-mode prompt
- [x] 2.5 Tests then `chat-store.mjs` optional fields (`mode`, `fallback`, `steps`, `reasoning`) with limits; old files still load; reasoning stored for DeepSeek and openai-compatible replies (over 30 000 characters dropped, not cut); later turns replay it (DeepSeek `reasoning` item, chat-completions `reasoning_content`); DeepSeek folds turns up to the last reasoning-less assistant turn into a transcript; history budget counts reasoning
- [x] 2.6 Export the planning readers from `web/src/LocalPlanning.tsx`; tests then the snapshot builder (same task set as the weekly page's `work.filter(inScope)` regardless of chat scope, page keys kept, done left out, 500 cap in due-then-key order, title cut) and the server-side snapshot schema (`INVALID_PLANNING`)
- [x] 2.7 `vite.config.ts`: body limit 200 000, snapshot validation, tool mode for the three providers, `step` SSE events, saving `mode`/`steps`/`reasoning`
- [x] 2.8 `Agent.tsx`: send the snapshot, show running steps, `<details>` step list from storage, fallback note; zh/en labels per tool
- [x] 2.9 One live call per provider whose key is available locally (cost: a few cents), including a two-turn DeepSeek tool-mode chat and a DeepSeek chat with an older context-mode history; record results or "not verified" in the PR (DeepSeek only, 3 requests, decision #368: tool round and folded older history verified; replayed `reasoning` item not exercised because turn 1 streamed no reasoning; OpenAI-compatible and Anthropic not verified)
- [ ] 2.10 `bash .claude/check.sh`; real-browser check with synthetic data and an intercepted chat stream; fresh-context review; record the PR number here

## 3. Q&A evaluation (PR 3)

- [ ] 3.1 Synthetic fixtures in `test/fixtures/qa/` (two courses, planning snapshot, context, ≥ 24 questions with gold data); every gold number has `source: { tool, args, path }`; test that each `source` call on the fixture context gives that number at `path`
- [ ] 3.2 Tests then `scripts/lib/qa-grade.mjs` (+ `.d.mts`): normalisation, number tolerance, fact groups, forbidden strings, refusal markers, failed calls
- [ ] 3.3 Tests then `scripts/eval-chat-qa.mjs` with `--fake`: both modes, N, `--only`, output layout and file modes, summary metrics, Desktop output refused
- [ ] 3.4 `docs/eval-chat-qa.md`: question format, grading rules, runner options, cost note, limitations
- [ ] 3.5 Context-mode baseline with DeepSeek Flash, N = 5 (can run before PR 2 merges); after PR 2 merges, tool-mode run with the same settings; record both in `docs/eval-results.md`
- [ ] 3.6 `bash .claude/check.sh`; fresh-context review; record the PR number here

## 4. MCP server (PR 4)

- [ ] 4.1 Add `@modelcontextprotocol/sdk` (1.32.x) to dependencies; `npm audit` result in the PR
- [ ] 4.2 Tests then `createCourseMcpServer` in `scripts/lib/course-mcp.mjs` (+ `.d.mts`) with `InMemoryTransport` and `Client`: tool names, annotations, and same property names and required lists as the registry (not byte-identical schemas); same text as `runTool` for valid arguments; registry errors with `isError: true`; schema-invalid arguments give `isError: true` (SDK text, not asserted); filter
- [ ] 4.3 `scripts/mcp-server.mjs` and `npm run mcp`: options, env filter, load on every call, stderr diagnostics; stdio test with `StdioClientTransport` against a temporary project and Desktop with synthetic files, checking no file is written
- [ ] 4.4 README section: Claude Code and Claude Desktop configuration with placeholders, Node 24, filter, data-flow note
- [ ] 4.5 Manual check: connect from Claude Code to the local server with synthetic data; record "not verified" if not done
- [ ] 4.6 `bash .claude/check.sh`; fresh-context review; update `note/handoff.md`; archive the change after the last PR merges
