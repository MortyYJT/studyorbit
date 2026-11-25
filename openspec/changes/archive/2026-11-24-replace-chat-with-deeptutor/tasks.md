## 0. Before any code (this change)

- [x] 0.1 Read DeepTutor's README, `SKILL.md` and the five developer guides; read the installed code where the guides are silent
- [x] 0.2 Install DeepTutor 1.7.4 natively (uv, Python 3.12, five modules) outside the repository
- [x] 0.3 Smoke test with the real DeepSeek model through a registered MCP service on a synthetic instance; record tokens
- [x] 0.4 Write this change; coordinator review

## 1. Integration PR (`claude/deeptutor`)

- [x] 1.1 The ASGI guard (`scripts/deeptutor/guard_app.py`, design decision 14): unit tests of the pure check, then a real test against the running instance (foreign Origin and Host refused for HTTP and WebSocket, framed page and server-side `start_turn` still work). Merge condition
- [x] 1.2 Tests then `scripts/lib/deeptutor.mjs`: locate the install (default path, `STUDYORBIT_DEEPTUTOR_BIN`), version check, port set for real and test instances, status values (`not-installed`, `external`, `running`, `failed`, `unsupported-provider`)
- [x] 1.3 Tests then configuration generation: the setup JSON (DeepSeek only, `openai_responses`, proxy address, ports, search `none`), `exec` off, `mcp.json` merge that keeps other servers, `main.yaml` and `system.json` switches; a test that no generated file or argument contains the key (a sentinel key is searched for in every output)
- [x] 1.4 Tests then `server/llm-proxy.ts`: loopback peer, exact `Host`, no `Origin`, launch token (constant-time), path allow-list, upstream origin fixed, streaming pass-through, key never logged; fake upstream only
- [x] 1.5 Tests then the launcher (`scripts/dev.mjs`): DeepTutor missing does not fail the start; an already healthy DeepTutor is neither started nor stopped; started processes are stopped on SIGINT, SIGTERM and when StudyOrbit exits; a failed start is reported and StudyOrbit keeps running (stub programs, as the existing launcher tests do)
- [x] 1.6 Tests then `PUT /api/local/agent-context` and `scripts/lib/agent-context.mjs` (validation, size limit, atomic write, mode 600, refused foreign origin)
- [x] 1.7 Tests then the MCP server reading the context file: scope from the selection, `plan_schedule` from the snapshot with `snapshotSavedAt`, `list_courses` focus with the 30-minute limit, missing or invalid file behaves as today, still no writes
- [x] 1.8 Tests then `GET /api/local/deeptutor/status` and `POST /api/local/deeptutor/turns` (fake WebSocket server: protocol version, session id returned, socket closed, errors mapped)
- [x] 1.9 The house-rules skill (`scripts/deeptutor/skill/SKILL.md`) and its installation after health; test that the installer sends the file unchanged and updates an existing skill
- [x] 1.10 `web/src/AgentFrame.tsx`, `App.tsx`, `LocalPlanning.tsx`, `agent-request.ts`, `i18n.ts`: the frame, the four states with exact commands, "open in a new tab", context hand-off on entry and on change, presets through the turns route, "save to revision" removed from the new path, old chat kept behind a link; Chinese and English; motion rules of `docs/motion.md`
- [x] 1.11 Screenshots (synthetic data; light and dark; 1440 and 390): DeepTutor running, not installed, not running
- [x] 1.12 `docs/setup.md` (install, upgrade, ports, data directory, embedding note, where old chats are), `docs/overview.md`, `README.md`, `note/decisions.md` (#540 onwards)
- [x] 1.13 `NODE_DEBUG= bash .claude/check.sh`; diff scan for score-like strings and local paths; PR; coordinator review

## 2. Real validation (after the integration PR is merged)

- [x] 2.1 Synthetic instance and DeepTutor on the test ports: "Ask Agent" from a course page carries the course; several rounds with the real model (grades, what-if, final needed, deadlines, weekly plan from the snapshot, revision quiz, three "write my assignment" refusals); numbers compared with the course page
- [x] 2.2 Memory across turns and sessions as DeepTutor provides it; DeepTutor stopped in the middle of a session
- [x] 2.3 Token table per call in `docs/deeptutor.md`
- [x] 2.4 The owner's instance: real ports, real home, MCP pointing at the main checkout; `npm run dev` brings both up; health checks only, no page opened, no model call; stop by PID; the Desktop shortcut read and dry-run

- [x] 2.5 Found in 2.1 and fixed before going on: a typed message was never sent because DeepTutor's page needs the knowledge-base list route; the guard now answers an empty list when that route is missing

## 3. Deletion PR (`claude/remove-own-agent`)

- [x] 3.1 Delete the chat page, tool loop, chat storage, chat routes, chat evaluation, their tests and chat-only provider code; keep what `tsc` and the tests show is still used
- [x] 3.2 Mark `docs/eval-chat-qa.md` "superseded by DeepTutor" at the top; update README, `docs/overview.md`, `docs/setup.md`, `note/product.md`
- [x] 3.3 Archive this change; sync `openspec/specs/` (remove `agent-chat` and `chat-qa-eval`)
- [x] 3.4 `NODE_DEBUG= bash .claude/check.sh`; PR; coordinator review
