## 0. Before any code (this change)

- [x] 0.1 Read DeepTutor's README, `SKILL.md` and the five developer guides; read the installed code where the guides are silent
- [x] 0.2 Install DeepTutor 1.7.4 natively (uv, Python 3.12, five modules) outside the repository
- [x] 0.3 Smoke test with the real DeepSeek model through a registered MCP service on a synthetic instance; record tokens
- [x] 0.4 Write this change; coordinator review

## 1. Integration PR (`claude/deeptutor`)

- [ ] 1.1 Spike, no merge: DeepTutor's authentication with a generated password and a session handed to the frame (design decision 14). Record what works; choose it or the ASGI wrapper
- [ ] 1.2 Tests then `scripts/lib/deeptutor.mjs`: locate the install (default path, `STUDYORBIT_DEEPTUTOR_BIN`), version check, port set for real and test instances, status values (`not-installed`, `external`, `running`, `failed`, `unsupported-provider`)
- [ ] 1.3 Tests then configuration generation: the setup JSON (provider mapping, `openai_responses` for DeepSeek, proxy address, ports, search `none`), `mcp.json` merge that keeps other servers, `main.yaml` and `system.json` switches; a test that no generated file or argument contains the key (a sentinel key is searched for in every output)
- [ ] 1.4 Tests then `server/llm-proxy.ts`: loopback peer, exact `Host`, no `Origin`, launch token (constant-time), path allow-list, upstream origin fixed, streaming pass-through, key never logged; fake upstream only
- [ ] 1.5 Tests then the launcher (`scripts/dev.mjs`): DeepTutor missing does not fail the start; an already healthy DeepTutor is neither started nor stopped; started processes are stopped on SIGINT, SIGTERM and when StudyOrbit exits; a failed start is reported and StudyOrbit keeps running (stub programs, as the existing launcher tests do)
- [ ] 1.6 Tests then `PUT /api/local/agent-context` and `scripts/lib/agent-context.mjs` (validation, size limit, atomic write, mode 600, refused foreign origin)
- [ ] 1.7 Tests then the MCP server reading the context file: scope from the selection, `plan_schedule` from the snapshot with `snapshotSavedAt`, `list_courses` focus with the 30-minute limit, missing or invalid file behaves as today, still no writes
- [ ] 1.8 Tests then `GET /api/local/deeptutor/status` and `POST /api/local/deeptutor/turns` (fake WebSocket server: protocol version, session id returned, socket closed, errors mapped)
- [ ] 1.9 The house-rules skill (`scripts/deeptutor/skill/SKILL.md`) and its installation after health; test that the installer sends the file unchanged and updates an existing skill
- [ ] 1.10 `web/src/AgentFrame.tsx`, `App.tsx`, `LocalPlanning.tsx`, `agent-request.ts`, `i18n.ts`: the frame, the four states with exact commands, "open in a new tab", context hand-off on entry and on change, presets through the turns route, "save to revision" removed from the new path, old chat kept behind a link; Chinese and English; motion rules of `docs/motion.md`
- [ ] 1.11 Screenshots (synthetic data; light and dark; 1440 and 390): DeepTutor running, not installed, not running
- [ ] 1.12 `docs/setup.md` (install, upgrade, ports, data directory, embedding note, where old chats are), `docs/overview.md`, `README.md`, `note/decisions.md` (#540 onwards)
- [ ] 1.13 `NODE_DEBUG= bash .claude/check.sh`; diff scan for score-like strings and local paths; PR; coordinator review

## 2. Real validation (after the integration PR is merged)

- [ ] 2.1 Synthetic instance and DeepTutor on the test ports: "Ask Agent" from a course page carries the course; several rounds with the real model (grades, what-if, final needed, deadlines, weekly plan from the snapshot, revision quiz, three "write my assignment" refusals); numbers compared with the course page
- [ ] 2.2 Memory across turns and sessions as DeepTutor provides it; DeepTutor stopped in the middle of a session
- [ ] 2.3 Token table per call in `docs/deeptutor.md`
- [ ] 2.4 The owner's instance: real ports, real home, MCP pointing at the main checkout; `npm run dev` brings both up; health checks only, no page opened, no model call; stop by PID; the Desktop shortcut read and dry-run

## 3. Deletion PR (`claude/remove-own-agent`)

- [ ] 3.1 Delete the chat page, tool loop, chat storage, chat routes, chat evaluation, their tests and chat-only provider code; keep what `tsc` and the tests show is still used
- [ ] 3.2 Mark `docs/eval-chat-qa.md` "superseded by DeepTutor" at the top; update README, `docs/overview.md`, `docs/setup.md`, `note/product.md`
- [ ] 3.3 Archive this change; sync `openspec/specs/` (remove `agent-chat` and `chat-qa-eval`)
- [ ] 3.4 `NODE_DEBUG= bash .claude/check.sh`; PR; coordinator review
