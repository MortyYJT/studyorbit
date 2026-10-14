## Context

`main` has the foundation (domain model, SQLite repository, redaction, Ed transport), the command registry with CLI, MCP and HTTP, the citation service, the resident browser with status and highlight-then-click, and `autonomy.check` / `audit.record` (archived `v1-rescope` issues A–C). Development paused on 2026-10-15 (#114) until a PRD existed. The PRD (`note/product/prd.md`) and the prototype (`design/prototype/index.html`) now define v1 from the user's side, and decisions #114–#146 change four things the old plan assumed: the frontend is the only entry point and hosts the agent chat (#116, #144); our code may start the owner's signed-in agent but never call a model API (#123); autonomy levels are per type of work and set from the frontend (#117, #120–#126); planning works per day (#145).

On 2026-10-15 the owner chose: the Claude Agent SDK as a new dependency; Vite + React for the frontend; our own browser tools rather than a generic browser MCP; and full built-in agent tools rather than an allow-list. These choices are recorded in `note/decisions.md` (#147–#150); Claude's own choices in this change are #151–#153, pending owner review.

The PRD's acceptance lists (US-1, US-2, US-3, US-5, US-6, US-7) are the acceptance criteria for this change. The archived `v1-rescope` design still explains sync, merging, annotations and revision sources; where this file repeats a decision, it says so.

## Goals / Non-Goals

**Goals:**
- Every acceptance item of US-1, US-2, US-3, US-5, US-6 and US-7 is met on real data and checked by the owner.
- One frontend: week view, course pages, assessment drawer, Agent page and avatar menu, on real data only.
- A chat backend with an agent-neutral adapter interface and one Claude Agent SDK adapter.
- Guardrails enforced in code wherever code can enforce them: autonomy check, highlight, audit and submit confirmation inside our browser tools; owner-only settings behind a session the agent cannot obtain through our tools.
- The four PRD metrics computed from recorded data.

**Non-Goals:**
- Email intake (US-4), automatic sync on email (#128, #129), Notion, other agent adapters (PRD §4).
- A scheduled revision stage (#127); revision runs from chat presets.
- Change detection or keeping old values (#101, #130).
- Calling model APIs, storing API keys, or computing cost ourselves (#123).
- Embedding a live browser view in the frontend (#137 keeps "view in Edge").
- Multi-user hosting; anything listening beyond `127.0.0.1`.

## Decisions

### 1. Close `v1-rescope` by archiving only what `main` implements
`v1-rescope` was archived in this change's PR with the deltas that issues A–C implemented. Its unimplemented deltas (sync, annotations, planning, UI, revision, Ed scope, the new-entity parts of the domain model, materials, new reads, annotation writes) moved here and were rewritten against the PRD. The `course-selection` spec, whose every requirement `v1-rescope` removed, was deleted from current truth (OpenSpec cannot write an empty spec). Alternative rejected: archiving `v1-rescope` whole, which would put unimplemented requirements into current truth; or keeping two open v1 changes that both modify `domain-model`.

### 2. Agent adapters and the Claude Agent SDK (owner choice)
`src/agent/adapter.ts` defines `AgentAdapter { id; start(input): AgentRun }`, where `AgentRun` is an async iterable of `AgentEvent` (`text`, `tool_step`, `confirmation`, `result {turns, costUsd?}`, `error`) plus `interrupt()`. The conversation service, storage, SSE stream and frontend depend only on these events. `src/agent/claude.ts` wraps the SDK's `query()`: it passes our tools as an in-process MCP server (`createSdkMcpServer`) built from the registry's agent tool set, sets `cwd` to `<data dir>/agent-workspace/`, resumes with the stored session id, maps SDK messages to `AgentEvent`s and reads `total_cost_usd` and `num_turns` from the result. Project skills (`skills/assessment`, `skills/revision`) are injected into the system prompt by preset, so the agent does not depend on the owner's personal Claude settings. Alternative rejected by the owner: running the `claude` CLI as a subprocess and parsing its stream (no dependency, but weaker tool interception and a fragile output format).

The SDK is version 0.x and changes often: pin the exact version, keep all SDK types inside `claude.ts`, and test the rest against a fake adapter. Its licence is Anthropic's commercial terms ("SEE LICENSE IN README.md"), not MIT; the repository is private and only uses it locally (#78).

### 3. Full built-in tools with a best-effort policy hook (owner choice)
The owner chose to keep the agent's built-in tools (shell, file read and write, web fetch) instead of an allow-list. A `PreToolUse` policy in `src/agent/policy.ts` denies: file access in the data directory outside `agent-workspace/`; reading `browser.json` or connecting to the debugging port; requests to `127.0.0.1`/`localhost` on the UI port; shell commands that run `coursework` owner subcommands, `script`/`expect`/`unbuffer` or other pseudo-terminal wrappers, or list other processes' arguments (`ps`); and opening the frontend's origin. Denials are stored as conversation steps. This blocks the obvious paths, but a shell can always find another (for example writing its own script that connects to the browser). The design therefore puts the hard guarantees where an agent with a shell still cannot reach them: the owner session secret exists only in server memory and in the owner's system browser (Decision 5), and owner-only commands, including all autonomy settings and submit confirmations, are accepted only with that secret. What stays best effort: an agent operating the browser outside our tools (no highlight, check or audit), and reading course data directly from the SQLite file. Alternative recommended by Claude and not chosen: allow-list only our MCP tools and read-only file tools, which would make the remaining two paths impossible.

### 4. Our own browser tools enforce the rules (owner choice)
`src/browser/tools/` implements the tools in `agent-browser-tools` on the existing attach helper and `highlightThenClick`. Each write tool runs, in order: target assessment lookup → course/platform check of the tab's URL → `autonomy.check` (which also proves the audit writer works) → highlight and act once → screenshot → audit append. `browser.submit` additionally creates a `PendingConfirmation`, emits a `confirmation` event, and awaits the owner's decision through an in-memory promise keyed by the confirmation id, with a 15-minute timeout; on restart, pending confirmations become `expired`. Confirmation decisions are owner-only commands. The agent-supplied answer summary is shown but not trusted; the screenshot and "view in Edge" let the owner check the page itself. Alternative rejected by the owner: `@playwright/mcp`, where all of this would depend on the agent following the skill.

### 5. Owner session: an in-memory secret passed in the URL fragment
`coursework ui` creates a 32-byte secret, opens `http://127.0.0.1:<port>/#s=<secret>` in the system browser, and the page moves it to memory and calls `history.replaceState` to remove it. The fragment is never sent in requests, so it does not appear in server logs or `Referer` headers. Owner commands send it in a header; the server compares in constant time. The existing capability-file token (#86) is no longer accepted for owner commands, because a file under `.local/` is readable by an agent with a shell. Reloading the page keeps the secret in `sessionStorage` for that tab only; a restart invalidates it. The resident browser's tools refuse the frontend origin, so even a copied URL cannot be opened there. Residual risk: the secret is briefly visible in the process arguments of the browser-opening command; the window is short and the policy hook denies `ps`-style process listing.

### 6. Streaming with server-sent events on `node:http`
`POST /api/agent/send` stores the owner message and starts the adapter; `GET /api/agent/stream?conversation=<id>` is an SSE stream whose event ids are `<message seq>:<part index>`, so `Last-Event-ID` resumes without duplicates. Events are written to the database as they arrive and fanned out to listeners, so a closed tab loses nothing. Alternative rejected: WebSocket, which needs a new dependency or a hand-written framing layer, for a one-way stream.

### 7. Frontend: Vite + React in `web/` (owner choice)
Source in `web/src/`, built by Vite into `dist/ui`, served as static files by the HTTP host with a fixed allow-list and no directory traversal. The prototype's CSS variables, layout and string table (Chinese and English) are reused; components follow its pages. Data access goes through one typed client that validates every envelope with the shared zod schemas. Non-layout logic (week ordering, ring geometry, view models, owner-session handling) lives in plain TypeScript modules with vitest tests. Real-browser checks use the already-installed `playwright` library against a synthetic data directory, producing the screenshots for the PR; no `@playwright/test` or Testing Library is added. TypeScript needs `@types/react` and `@types/react-dom`, which are not on the pre-approved list (see Open Questions). Alternative rejected by the owner: keeping the single HTML file with plain JavaScript.

### 8. Levels follow the kind of work (#120)
`required(kind)`: `quiz`, `ongoing` → L1; `assignment`, `exam`, unknown → L2. `effective = min(override ?? course.defaultLevel, cap)`, `cap = prohibited ? 0 : 2`. A new `quiz` kind is added because L1 is defined by quizzes and the current kinds (`ongoing`, `assignment`, `exam`) cannot express it. Exams get no exam-specific rule (#126); requiring L2 for them is Claude's reading of "no separate check" (an exam is graded work like an assignment), and unknown kind requiring L2 keeps the old "unknown is treated cautiously" rule without naming exams. Both are recorded as #152, pending the owner's review. Old L0–L4 grants stay in their table unread; the owner sets levels again in the frontend.

### 9. Day-granular planning (#145)
The planner keeps the archived `v1-rescope` EDF rules (overdue first, undated last, stable ties, overflow kept, unestimated listed) but its output is `{ date, items: [{ workId, minutes }] }[]` plus `overflow` and `unestimated`. Start times are owner data stored separately and only reorder a day's list; they never feed the planner, so the plan stays a pure function of settings, work and estimates. Exams are deadlines only. Alternative proposed by Claude and not chosen by the owner: time slots with automatic placement.

### 10. Sync, merging and annotations (carried from `v1-rescope`)
Unchanged from the archived design, Decisions 3–5: sync stores platform facts and creates assessments only for weighted Canvas groups; courses merge by a single exact course-code match (#104); latest state with soft removal (#101); annotations are append-only with precedence owner > agent > sync (#103). New here: `sync.run` is a registry command so the frontend button and the agent use the same path, guarded by the profile lock's sibling `sync.lock`; owner verdicts on agent values are append-only rows used by metrics.

### 11. Data model and migrations
Issue A adds one additive migration with every new table and column: course sources; assessment origin, optional kind and weight, `quiz`; source facts and removal; assessment links; annotations and verdicts; planning settings, estimates, start times, time logs, manual-task `done`; course autonomy; study records and practice attempts; conversations, messages, pending confirmations, and run `conversationId`/`turns`. Later issues only add repository methods, so parallel lines never race on migration numbers. Nothing is dropped or rewritten.

### 12. Metrics are computed on read
`metrics.read` aggregates existing rows (sync runs, verdicts, estimates with time logs, agent runs). No metric table, so nothing can drift from the source records.

### 13. Issue order and parallelism
A (schema) blocks everything. Then up to three Codex lines (#76): {B owner session and HTTP, C autonomy, F planning}, {D sync, E annotations}, {G revision, H chat backend}. I (Claude adapter) after H; J (browser tools) after C and H; frontend issues K1–K4 after B, each also waiting for the reads it shows; L (metrics) after D, E, F, I; M (acceptance) last. Each issue lists the PRD acceptance items it covers so the owner can check it against the PRD.

## Risks / Trade-offs

- [Agent with a shell bypasses our browser tools or reads the database] → policy hook denies the obvious paths; owner-only actions need the in-memory session; the owner sees every tool step in the conversation. Accepted by the owner's choice of full tools; an allow-list would remove it.
- [Claude Agent SDK is 0.x and proprietary-licensed] → exact version pin, SDK types confined to one file, fake-adapter tests; the adapter interface allows replacing it.
- [Agent's answer summary differs from what it typed] → screenshot and "view in Edge" before confirming; audit records the action, not the content.
- [Resident browser sign-in lifetime is still unmeasured (owner task R-B 3.5)] → sync and tools return `AUTH_EXPIRED` and the frontend shows it; the owner measurement stays a task here.
- [Course with no recorded policy is uncapped (#125)] → the frontend shows "no policy recorded" next to the level on the course page; Claude's warning from #125 stands: no record does not mean allowed.
- [Exams can be completed at L2 (#126)] → the frontend offers no entry (#146), but a free-form chat request could still lead there; the course default level and overrides are the only limit.
- [Cost and steps depend on what the SDK reports] → unknown cost is stored as unknown, never zero.
- [Large scope for one change] → thirteen issue-sized groups with explicit dependencies; each merges on its own.

## Migration Plan

1. This PR: archive `v1-rescope` (A–C specs only), delete the empty `course-selection` spec, add this change, record decisions #147–#153, update `note/handoff.md` and `note/product/roadmap.md`.
2. Dispatch: create one GitHub issue per task group with its PRD acceptance items; close superseded open issues (#31, #44, #46, #55, #77, #79, #92) with a pointer to this change.
3. Implement in the order of Decision 13. Migrations are additive; rollback is reverting a PR. No local data is deleted.
4. Owner acceptance against the PRD lists, then archive this change.

## Open Questions

- Install `@types/react` and `@types/react-dom` (needed to type-check the React frontend; not on the pre-approved list)? Needed before issue K1.
- Owner review of Claude's reading in Decision 8: exams and unknown kinds need L2.
- Reasons still to be supplied for #125, #127, #129, #132, #145 and the full-tools choice (#150).
- R-B 3.5: actual sign-in lifetime of the resident browser on the managed profile.
