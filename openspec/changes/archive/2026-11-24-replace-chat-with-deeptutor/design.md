## Context

StudyOrbit today: `npm run dev` (`scripts/dev.mjs`) starts the local API server and Vite; the Agent page (`web/src/Agent.tsx`) streams chats through `/api/local/chats*`, where a bounded tool loop calls the six read-only tools of `shared/course-tools.ts`; the same tools are served over stdio by `scripts/mcp-server.mjs`. Tasks, availability, target bands and the course selection live in the browser's localStorage, so the page sends a planning snapshot with every chat message.

DeepTutor 1.7.4 (released 2026-11-20; this is the version that installed) is a Python application with a FastAPI server, a packaged Next.js web app, sessions in SQLite, memory, question generation and an MCP client. Everything below marked "measured" was run on 2026-11-24 on the owner's machine with two synthetic courses, a throw-away DeepTutor home and the real `deepseek-flash` model; raw output is outside the repository (the evidence folder of the overnight run). 54 model calls, 403,882 tokens in total.

What the installed code does, where it differs from what the task assumed:

| Topic | Finding (file in the installed package) |
| --- | --- |
| `api_key_env` | `deeptutor config apply` reads the variable once and writes the key itself into `data/user/settings/model_catalog.json` (`deeptutor_cli/setup_config.py`; the guide says "resolved keys are saved"). There is no setting that keeps only the variable name. |
| Binding | `deeptutor start` starts uvicorn with `--host 0.0.0.0` and the web server with `HOSTNAME=0.0.0.0`, both hard-coded (`runtime/launcher.py`). `deeptutor serve --host` is configurable. |
| Authentication | Off by default. With it off the API answers anyone, CORS echoes any origin with credentials (`api/main.py`), and no `Host` check exists. Measured: a request with `Origin: https://evil.example` got `access-control-allow-origin: https://evil.example`; a request with `Host: evil.example` got 200. `PUT /api/settings/mcp` registers a stdio command, so a web page that reaches the port can run a program as the owner. |
| MCP | Registered in `data/user/settings/mcp.json` (`services/mcp/config.py`): `servers.<name>` with `command`, `args`, `env`, `cwd` for stdio, or `url` for HTTP. Also editable in the web UI and through `/api/settings/mcp`. MCP tools are "deferred": the model first calls `load_tools`, then `mcp_<server>_<tool>`. The child gets a minimal environment (no model key). |
| Capabilities | Capabilities are separate wheels. `deep_solve` exists only when `deeptutor-solve` is installed. |
| House rules | A skill whose front matter has `always: true` is put into every chat prompt (`services/skill/runtime.py`). User skills live under `data/user/workspaces/<workspace id>/skills/`, not under `data/user/workspace/skills/` as the module's own comment says; `POST /api/skills/create` writes to the right place. |
| Tools | `web_search` is a user toggle (off when no search provider is set). `web_fetch` and `github` are always mounted for the chat capability (`agents/_shared/tool_composition.py`); no setting removes them. `exec` (local code execution in a sandbox) is mounted when the sandbox is available. |
| Initial context | The web UI reads only `?agent`, `?capability`, `?tool`, `?session` and `?workspace`. There is no way to prefill a message or pick a persona by URL. A session is created by the first `start_turn` message on the WebSocket `/ws` (protocol version `2.0`); `/chat/<session id>` then shows it. |
| Framing | The web server sends no `X-Frame-Options` and no `Content-Security-Policy`. Measured: the chat page renders inside a frame on the StudyOrbit page (same host name, other port). |
| Usage accounting | Every turn ends with a `usage_summary` (tokens, cache hits, calls); the UI shows it under each reply. |

## Goals / Non-Goals

**Goals:**
- One double-click (the Desktop shortcut, which runs `npm run dev`) brings up StudyOrbit and DeepTutor; closing it stops both.
- Grades, targets, deadlines and the weekly plan are still computed by StudyOrbit's code; DeepTutor only calls it.
- The model key is in no file that DeepTutor writes, and in no file of the repository.
- The rest of StudyOrbit works when DeepTutor is missing, stopped or broken.
- The assistant explains, plans and quizzes; it does not write, do or submit assessed work.

**Non-Goals:**
- Rebuilding any DeepTutor feature (chat UI, memory, question generation, notebooks) in StudyOrbit.
- Knowledge bases, embeddings, document parsing.
- Hard technical enforcement of the "no doing the work" rule inside the model. The rule is a prompt rule plus the absence of the solve module.
- Protecting against other programs running as the owner on this machine.

## Decisions

**1. Native install with `uv`, not Docker.**
The MCP server is a stdio program that needs Node 24, the repository, `.local/` and the Desktop course folders. A containerised DeepTutor could spawn it only if all of that were mounted into the image and Node installed there, or if the MCP server were rewritten to HTTP and exposed to the container. Docker Desktop would also have to be running before the double-click (its start-up time was not measured; the native start measured 6 s for the API and 1 s for the web server). The native install is a virtual environment at `~/.local/share/studyorbit/deeptutor/venv` (523 MB) with `uv`-managed CPython 3.12 (145 MB); `uv` itself is two binaries in `~/.local/bin`. Upgrade is `uv pip install --python <venv> "deeptutor[server,web,memory,questions,notebook]==<version>"`; the version is pinned in `docs/setup.md` and checked by the launcher. Alternative considered: Docker with the published image; rejected for the reasons above.
The system Python is 3.9 and cannot run DeepTutor (it needs 3.11 to 3.14).

**2. Only five modules; the solve module is left out.**
`deeptutor[server,web,memory,questions,notebook]` gives the capabilities `chat`, `ask_questions` and `deep_question`. `deep_solve`, `deep_research`, `visualize`, `mastery_path`, books, partners and knowledge bases are not installed, so they cannot be selected in the UI or by the model. The launcher reports a warning on the Agent page if `deeptutor module list` shows `solve` installed.

**3. StudyOrbit starts the two DeepTutor processes itself, bound to loopback.**
`deeptutor start` cannot be used (it binds every interface). The local server runs DeepTutor's API with the venv's interpreter as `python -m uvicorn guard_app:app --app-dir scripts/deeptutor --host 127.0.0.1 --port <api port>` (the guard of decision 14 wrapped around `deeptutor.api.main:app`) and the packaged web server (`node <home>/data/user/runtime/web/server.js` with `HOSTNAME=127.0.0.1`, `PORT`, `DEEPTUTOR_API_BASE_URL`). The web files are prepared by DeepTutor's own `_resolve_frontend` helper, called from `scripts/deeptutor/prepare_web.py`, a few lines run with the venv's interpreter, so the copy and the placeholder patching stay DeepTutor's code. That helper is private; if a later version renames it the launcher reports "DeepTutor web files could not be prepared" and the Agent page shows it. Alternative considered: wrap `deeptutor start` and patch its arguments; rejected as more fragile.

**4. Ports.**
| Instance | StudyOrbit page | StudyOrbit API | DeepTutor web | DeepTutor API | Model proxy |
| --- | --- | --- | --- | --- | --- |
| Owner's | 5173 | 5190 | 5175 | 5195 | 5197 |
| Test | 5181 | 5191 | 5185 | 5196 | 5199 |
Overridable with `STUDYORBIT_DEEPTUTOR_WEB_PORT`, `STUDYORBIT_DEEPTUTOR_API_PORT`, `STUDYORBIT_LLM_PROXY_PORT`; the test set is selected the same way the second StudyOrbit port set is. 5174 is avoided (another local program uses it). A taken port is an error shown on the Agent page, never a silent move to another port.

**5. Data directory: `.local/deeptutor/home` in the checkout.**
`DEEPTUTOR_HOME` is `<project>/.local/deeptutor/home` (git-ignored, mode 700). Sessions, memory and DeepTutor's settings then sit next to the other personal data, and a worktree used for tests gets its own empty home, so test chats can never land in the owner's. Cost: each home holds its own 123 MB copy of the web files. Alternative considered: one home under `~/.local/share`; rejected because real and test instances would share it unless every caller remembered to override it.

**6. The key stays in StudyOrbit: a loopback model proxy (coordinator's decision, 2026-11-24; a deviation from the owner's wording).**
The owner asked for two things: the key read through DeepTutor's `api_key_env`, and the key never written to any file. In 1.7.4 they conflict: `deeptutor config apply` resolves the variable named by `api_key_env` and saves the value in clear in `data/user/settings/model_catalog.json` (`_api_key` and the profile writer in `deeptutor_cli/setup_config.py`; the runtime reads `profile["api_key"]` in `services/config/provider_runtime.py`). The no-file rule wins. `api_key_env` is still the mechanism used, but the variable it names holds a per-launch token, not the key. So the local server opens a second listener, `127.0.0.1:<proxy port>`, that accepts a request only from a loopback peer, with the exact `Host`, without an `Origin` header and with `Authorization: Bearer <launch token>`; it then replaces the header with the key from `resolveAnalysisConfig` (settings file or `DEEPSEEK_API_KEY`) and forwards the body unchanged to the provider, streaming the reply back. The launch token is 32 random bytes created by `scripts/dev.mjs` on every start and given to DeepTutor through `deeptutor config apply` (`api_key_env` names a variable that holds the token, not the key). DeepTutor's settings file therefore contains a token that is useless after StudyOrbit exits. The proxy forwards only to the configured provider's base address and only `POST /responses`, `POST /chat/completions` and `GET /models`; it logs neither headers nor bodies (one line per refused request with the reason only).
This was the arrangement used in the smoke test: after six real turns no file under the DeepTutor home contained the key.
Providers: only DeepSeek is supported in this change, because it is the provider the owner uses and the only one that could be tried for real. With OpenAI-compatible, Anthropic or Codex selected in the model settings the assistant's status is `unsupported-provider` and the Agent page says so; adding the first two is a mapping in `scripts/lib/deeptutor.mjs` plus a real trial.
Alternative considered and rejected: let DeepTutor store the key (its design; file mode 600, outside the repository). Simpler, but it puts the key in a second file.
A double-clicked `.command` file gets `DEEPSEEK_API_KEY`: the variable is exported from `~/.zshenv`, which every zsh reads (checked with an empty environment, value not printed).

**7. DeepSeek uses the Responses format.**
Measured: with the chat-completions format the second tool round failed with HTTP 400 ("the `reasoning_content` in the thinking mode must be passed back"). DeepTutor replays the reasoning only when it is non-empty (`runtime/agentic/messages.py`), and the first round had produced none. With `api_format: openai_responses` the same question ran six rounds without error. The launcher writes `openai_responses` for DeepSeek. This is an upstream bug; it has not been reported (listed for the owner).

**8. MCP registration by file, per instance.**
Before starting DeepTutor the launcher writes `servers.studyorbit` into `<home>/data/user/settings/mcp.json`: `command` is the Node binary that runs the launcher (`process.execPath`), `args` are `scripts/mcp-server.mjs --project <project>` plus `--desktop <dir>` when `HOME` was overridden, `cwd` is the project. Other servers in the file are kept. The page and the MCP server of one instance therefore read the same `.local/` and the same course folders.

**9. Page context goes through a file the MCP server reads.**
The MCP server cannot see localStorage. Measured without it: `plan_schedule` answered `available: false`, and the model then invented seven tasks with minutes and an availability of its own and planned those. New route `PUT /api/local/agent-context` (same guard as every route; JSON; at most 200,000 bytes) stores `{ savedAt, selectedCourseIds, focusCourseId, planning }` in `.local/agent-context.json` (mode 600, atomic write), validated with `parsePlanningSnapshot`. The page sends it when the Agent page opens and when "Ask Agent" or a preset is clicked (tasks cannot change while the Agent page is showing: the planning pages are hidden behind it). Only the MCP server registered for DeepTutor reads the file (the launcher adds `--page-context` to its arguments), so other MCP clients keep their behaviour. It reads the file on every call: scope is `selectedCourseIds` when it names at least one listed course (the `--courses` filter still narrows it); `plan_schedule` uses `planning` and returns `snapshotSavedAt`; `list_courses` returns `focus: { courseId, code }` when `focusCourseId` is in scope and was saved less than 30 minutes ago. A missing or invalid file means what it means today: no planning data. The house rules tell the model to say so instead of inventing tasks.
Alternative considered: put the course into the first message. It works only when StudyOrbit sends the first message, and not for the plain "Ask Agent" button.
Corrections made on the page are still not included (decision #297 stands; the MCP server reads synced files).

**10. The "no doing the work" rule.**
Three layers, none of them a hard guarantee: the solve module is absent (decision 2); an always-on skill `studyorbit` (source in `scripts/deeptutor/skill/SKILL.md`, installed through `POST /api/skills/create` or updated in place after the API is healthy) carries the rule; `docs/deeptutor.md` says the rule is a prompt rule. Measured with the skill active (the proxy saw the rule text in all four tool-loop requests): asked to write an assignment answer for submission, the model declined in one sentence and offered to explain, plan, review the student's own attempt or generate practice questions. The same request before the skill was installed was also declined, in the model's own words, so one test does not show how much the rule adds.
The skill also says: course facts come from the `mcp_studyorbit_*` tools, never invent a mark, weight or deadline, use `calculate_grades` and `final_needed` for arithmetic, say when planning data is missing.

**11. Tools that can send data out, and their defaults.**
| Tool | Reaches | Default here |
| --- | --- | --- |
| The model itself (`chat`, `brainstorm`, `reason`, `deep_question`) | the provider the owner chose | on |
| `web_search` | a search provider | off (`search.provider: none`, `tools.web_search.enabled: false`); measured: a call returns "no search provider is configured" |
| `web_fetch` | any URL the model asks for | cannot be removed in 1.7.4: it is mounted for every chat turn and the per-turn `tools` list (also `?tool=`) only selects the eight optional tools (`agents/_shared/tool_composition.py`). The house rules forbid putting course data into a URL. Listed for the owner |
| `github` | GitHub's API | cannot be removed in 1.7.4, same reason. Listed for the owner |
| `paper_search`, `zotero_search`, `imagegen`, `videogen`, `brainstorm`, `reason`, `geogebra_analysis` | their services or the model | off in sessions StudyOrbit starts (`tools: []` in `start_turn`); the owner can switch them on in DeepTutor's composer |
| `exec` | nothing remote; runs model-written code on this machine | off. On macOS the only backend is `RestrictedSubprocessBackend`, a child process with resource limits and what the code calls application-level isolation, not a system sandbox (`services/sandbox/config.py`). It exists only when `sandbox_allow_subprocess` is true, so the launcher writes `false` to `system.json` and sets `DEEPTUTOR_SANDBOX_ALLOW_SUBPROCESS=0`. Measured: `exec` was offered to the model before and is not offered after |
| Update check | PyPI or GitHub | off (`version_check_enabled: false`) |
| Knowledge bases | an embedding service | not built: no embedding key is set, DeepSeek lists two chat models and no embedding model, and no local embedding server is installed. Waiting for the owner |

**12. Entry: DeepTutor's own page in a frame, plus "open in a new tab".**
Least code with the full DeepTutor experience (history, memory, notebook, token counts), and the StudyOrbit sidebar stays. `LocalPlanning` stays mounted behind it as today; the frame follows the motion rules (appears in the frame of the click; a placeholder after 150 ms while the health check runs; no View Transition). The frame's `src` is `http://localhost:<web port>/chat` or `/chat/<session id>`.
- "Ask Agent" on a course: the page saves the context (decision 9) with that course in focus and opens the frame on a new conversation. Nothing is sent to the model.
- A revision preset: after the owner's click the page calls `POST /api/local/deeptutor/turns` with the prompt; the server opens DeepTutor's WebSocket, sends one `start_turn`, returns the session id as soon as DeepTutor reports it and closes its socket; the frame opens that session and shows the reply as it streams. Not verified: that DeepTutor keeps the turn running after the starting socket closes (its documentation says a disconnect does not end a turn).
- "Save to revision" on a reply is removed: StudyOrbit no longer renders replies. Notes saved earlier stay in the revision tab, readable and deletable; the tab says that new notes are kept in DeepTutor's notebook.
- States: not installed (the install command), installed but not running (the start command and the last launcher error), unsupported provider (Codex), running. Checked through `GET /api/local/deeptutor/status`, which the server answers from the launcher's knowledge and a health request to `/health/ready`; no model call.
DeepTutor's page asks the model for input suggestions when it opens (measured: two calls, about 1,900 tokens). The frame is therefore created only when the owner opens the Agent page, never in the background.

**13. Start, stop and failure.**
The local API server owns the assistant (it already holds the model settings and answers the status route), so `npm run dev` brings it up through `server/main.ts`; `scripts/dev.mjs` only passes the ports. After the API server is listening, in the background: (a) no venv at the expected path (or `STUDYORBIT_DEEPTUTOR_BIN`) means status `not-installed`, continue; (b) `/health/ready` already answers on the API port: when the guard there reports this checkout's instance id the status is `external` (start nothing, stop nothing), otherwise `failed` with "port in use"; (c) otherwise initialise the home (`deeptutor init --non-interactive`), apply the configuration, write `mcp.json`, start the API server, wait for health (30 s), prepare and start the web server, install the skill. Any failure sets status `failed` with the reason and is logged; StudyOrbit keeps running. When the server stops (SIGINT or SIGTERM, forwarded by the launcher) it stops the DeepTutor processes it started (SIGTERM, then SIGKILL after 5 s) and nothing else. Their PIDs are kept in `.local/deeptutor/processes.json`; a later start that finds them still alive with the same command line (the server was killed without cleanup) stops them first, because their proxy token is stale. Measured: stopping the API server also ended its MCP child. The Desktop shortcut needs no change: it runs `npm run dev`.

**14. Protecting DeepTutor's ports: an ASGI guard in front of the API (coordinator's decision; a merge condition).**
Binding to loopback keeps other machines out. It does not keep out a web page open in the owner's browser (see Context), and the API can register a stdio command, so that is remote code execution. `scripts/deeptutor/guard_app.py` wraps DeepTutor's ASGI app and answers 403 to HTTP requests, and refuses WebSocket upgrades, unless: `Host` is `localhost`, `127.0.0.1` or `[::1]` with the API or the web port; the Host that DeepTutor's web server forwards (`x-forwarded-host`, `x-deeptutor-frontend-host`), when present, passes the same test; `Origin`, when present, is the StudyOrbit page or DeepTutor's web page; and the request is not marked `Sec-Fetch-Site: cross-site`. A refused preflight carries no CORS headers, so DeepTutor's permissive CORS never answers a foreign origin. Both DeepTutor processes bind `127.0.0.1`.
Measured against the running test instance: foreign `Origin` 403 (GET, preflight, WebSocket; directly and through the web port); foreign `Host` 403 directly; foreign `Host` through the web port 200 before the forwarded-Host check and 403 after it; `Sec-Fetch-Site: cross-site` 403; DeepTutor's page in a frame on the StudyOrbit page loaded with no refusal; a `start_turn` from a server-side WebSocket (no `Origin`) ran, and the turn finished after that socket was closed.
Not covered, recorded: any program running as the owner can call the API (it sends whatever headers it likes); the HTML and scripts of DeepTutor's web port are served to any Host (they hold no data). DeepTutor's own authentication was not tried: it switches the installation to its multi-user mode, whose data layout differs.

## Risks / Trade-offs

- [The house rule is a prompt rule] → the solve module is absent, the rule is always in the prompt, the docs say what it is; the validation phase repeats the refusal test several times.
- [`web_fetch` and `github` cannot be switched off] → the rule forbids sending course data; listed for the owner; revisit when DeepTutor adds a switch.
- [Programs running as the owner can still reach DeepTutor's API and the model proxy's port] → out of scope (non-goal); the proxy needs the launch token, DeepTutor's API needs nothing.
- [Private helper `_resolve_frontend`] → pinned version, error surfaced on the Agent page, covered by a check in the launcher's start-up.
- [Token use is several times the old chat's] → reported with numbers in `docs/deeptutor.md`; the owner decides whether it is acceptable.
- [`deep_question` was unreliable with `deepseek-flash`: seven protocol retries, one schema repair, 120,604 tokens for two questions] → the revision "quiz" preset uses plain chat; `deep_question` stays available in DeepTutor's own UI.
- [Packages were installed from a PyPI mirror because pypi.org and GitHub were too slow from this network] → the `uv` binary and the `deeptutor` wheel were compared with pypi.org's SHA-256; the other 112 packages were not.
- [Snapshot staleness] → the plan reply carries `snapshotSavedAt`; the page saves a fresh one every time the Agent page is opened.
- [DeepTutor upgrades can change settings files, routes or the WebSocket protocol] → version pinned; the launcher refuses an unknown major or minor version with a clear message.
- [The owner's old chats] → `.local/chat/` is left in place; `docs/setup.md` says where it is and that it can be deleted by hand.

## Migration Plan

1. Integration PR (`claude/deeptutor`): everything in this change except deletions. The old chat stays reachable until the DeepTutor path is verified: the Agent page shows DeepTutor when it is running and a link "old chat" otherwise.
2. Real validation on the merged main with synthetic data and the real model; results in `docs/deeptutor.md`. Then the owner's instance: install check, `npm run dev` from the main checkout, health checks only, stop by PID.
3. Deletion PR (`claude/remove-own-agent`): remove the old chat and its specs, archive this change.
Rollback: revert the deletion PR, then the integration PR; DeepTutor's install and home are outside the repository and can be removed with `rm -r ~/.local/share/studyorbit/deeptutor` and `rm -r .local/deeptutor`.

## Open Questions

- For the owner: an embedding service for knowledge bases; whether `web_fetch` and `github` being always available is acceptable; whether to report the `reasoning_content` bug upstream; the token cost per question.
