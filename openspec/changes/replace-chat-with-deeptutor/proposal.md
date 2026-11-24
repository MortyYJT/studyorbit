## Why

The owner has decided (2026-11-24) that chat, tool calling, memory and question generation come from DeepTutor (HKUDS/DeepTutor, Apache-2.0) and that StudyOrbit only feeds it course data. StudyOrbit's own chat (the tool loop, four provider adapters for chat, chat storage, the chat page and the chat evaluation) duplicates what DeepTutor already ships and has to be maintained alone. What StudyOrbit has and DeepTutor does not is the course data and the code that computes grades, targets, deadlines and the weekly plan; that part already exists as a read-only MCP server.

A smoke test on 2026-11-24 with DeepTutor 1.7.4, the real DeepSeek model and two synthetic courses showed that DeepTutor calls StudyOrbit's MCP tools and repeats their numbers, and it showed four things the design has to deal with: DeepTutor stores a resolved API key in its settings file, its own launcher binds every interface with no authentication, DeepSeek's chat-completions format fails on the second tool round, and without the page's planning data the model invents tasks for the weekly plan. The measurements are in `design.md`.

## What Changes

- **DeepTutor becomes the assistant.** The Agent page shows DeepTutor's own web interface in a frame, with a link that opens it in a new tab. StudyOrbit does not render chat messages, run a tool loop or store chats any more.
- **Install outside the repository.** DeepTutor runs natively from a Python 3.12 virtual environment in the user's home (created with `uv`; no Docker), with only the modules the assistant needs: `server`, `web`, `memory`, `questions`, `notebook`. The `solve` module (the `deep_solve` capability) is not installed.
- **`npm run dev` also brings DeepTutor up.** The launcher checks whether DeepTutor is installed and already healthy, otherwise starts its API server and its web server bound to `127.0.0.1` on fixed ports, and stops only what it started. A missing or broken DeepTutor never fails `npm run dev`; the Agent page then says how to install or start it.
- **The model key never reaches DeepTutor's files.** StudyOrbit's local server gains a loopback model proxy that adds the key resolved by `scripts/lib/llm-config.mjs`. DeepTutor is configured with the proxy address and a random token created per launch.
- **Course data through MCP.** `npm run dev` registers `scripts/mcp-server.mjs` as a stdio MCP service in DeepTutor's settings, pointing at the same project directory as the page.
- **Page context hand-off.** The page saves the planning snapshot (tasks, availability, target bands), the selected courses and the course the owner is asking about to `.local/agent-context.json` through a new guarded route. The MCP server reads it on every call: `plan_schedule` plans the page's tasks, the scope is the page's course selection, and `list_courses` names the course in focus.
- **House rules as a DeepTutor skill.** An always-on skill tells the model to take course facts from the StudyOrbit tools and never to write, do or submit assessed work. Web search is switched off; knowledge bases are not built (there is no embedding service).
- **Entry points.** "Ask Agent" on a course page and the revision presets open the Agent page; a preset starts a DeepTutor session with the prompt and the frame opens that session. "Save to revision" on a reply is removed (DeepTutor's own notebook replaces it); notes saved earlier stay readable and deletable.
- **Second PR, after real validation:** delete the self-built chat (page, tool loop, chat storage, chat routes, chat evaluation, chat-only provider code). **BREAKING** for the owner's stored chats: the code that reads `.local/chat/` goes away; the files are not touched.
- Out of scope: knowledge bases and embeddings, any write tool, DeepTutor's partner bots and research capabilities, running DeepTutor in CI, Windows and Linux.

## Capabilities

### New Capabilities

- `deeptutor-assistant`: installing and starting DeepTutor next to StudyOrbit, ports and data directories, the model proxy and key handling, MCP registration, the house-rules skill, tool defaults, the Agent page (frame, not-installed and not-running states) and how course context reaches DeepTutor.

### Modified Capabilities

- `course-mcp-server`: reads the page-context file (planning snapshot, course selection, course in focus) instead of having no planning data.
- `course-tools`: `plan_schedule` reports the age of the snapshot it used; `list_courses` can name a course in focus.
- `revision`: presets start a DeepTutor session; saving a reply as a note is removed; stored notes stay.
- `local-api-server`: the launcher also checks, starts and stops DeepTutor; a new route stores the page context; the model proxy listens on its own loopback port.
- `agent-chat`: removed (second PR).
- `chat-qa-eval`: removed (second PR); `docs/eval-chat-qa.md` stays as the old system's record, marked superseded.

## Impact

- New: `scripts/lib/deeptutor.mjs` (detection, health check, configuration that never contains the key, start and stop), `server/llm-proxy.ts`, `server/routes/agent-context.ts`, `scripts/lib/agent-context.mjs`, `scripts/deeptutor/skill/SKILL.md` (the house rules), `web/src/AgentFrame.tsx`, `docs/deeptutor.md`.
- Changed: `scripts/dev.mjs`, `scripts/mcp-server.mjs`, `scripts/lib/course-mcp.mjs`, `shared/course-tools.ts`, `server/main.ts`, `server/app.ts`, `web/src/App.tsx`, `web/src/LocalPlanning.tsx`, `web/src/agent-request.ts`, `web/src/i18n.ts`, `docs/setup.md`, `docs/overview.md`, `README.md`.
- Deleted in the second PR: `web/src/Agent.tsx`, `scripts/lib/chat-*.mjs`, the chat routes, `scripts/eval-chat-qa.mjs`, `scripts/lib/qa-grade.mjs`, their tests, and the chat-only paths of `scripts/lib/llm-providers.mjs`. Kept: `shared/course-tools.ts`, `shared/planning-snapshot.ts`, the MCP server, `scripts/lib/llm-config.mjs` and the analysis paths of the provider adapters, `test/fixtures/qa/` where the tool tests use it, the revision notes store.
- New external dependency on the machine, not in `package.json`: DeepTutor 1.7.4 (113 Python packages, about 520 MB, plus a 145 MB managed Python) and `uv`. CI has neither; tests use stubs.
- Data flow: unchanged in kind. Tool results (grades) go to the model provider the owner chose, now through DeepTutor. DeepTutor keeps its own sessions and memory on this machine in a git-ignored directory. Its `web_fetch` and `github` tools can reach the internet when the model calls them and cannot be switched off in this version (see `design.md`, risks).
- Cost: a question that needs four to six tool calls used 41,000 to 53,000 tokens in the smoke test, a weekly plan 128,000, mostly cache hits. The old tool-mode chat averaged 6,748 input tokens per question on its own question set (`docs/eval-chat-qa.md`); the two were not run on the same questions. Opening DeepTutor's chat page costs about 1,900 tokens by itself.
