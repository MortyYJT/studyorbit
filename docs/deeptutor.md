# The assistant: DeepTutor next to StudyOrbit

Written 2026-11-24. The Agent page no longer runs StudyOrbit's own chat. It shows [DeepTutor](https://github.com/HKUDS/DeepTutor) (Apache-2.0), which does the chatting, tool calling, memory and question generation; StudyOrbit gives it course data and keeps the model key. The self-built chat is still in the repository behind the "Old chat" button until this path has been validated; it will be removed in a later change. Installing and starting: [Setup](setup.md#assistant-deeptutor).

Everything marked "measured" was run on 2026-11-24 on one Mac with DeepTutor 1.7.4, two synthetic courses and the real `deepseek-flash` model.

## What runs

`npm run dev` starts the local API server, and the server brings the assistant up in the background (`scripts/lib/deeptutor.mjs`):

| Process | Address (owner's instance; other instances) | Started as |
| --- | --- | --- |
| Model proxy (inside the local API server) | `127.0.0.1:5197`; `5199` | `server/llm-proxy.ts` |
| DeepTutor API behind StudyOrbit's guard | `127.0.0.1:5195`; `5196` | DeepTutor's interpreter running `uvicorn guard_app:app` (`scripts/deeptutor/guard_app.py`) |
| DeepTutor web server | `127.0.0.1:5175`; `5185` | `node <home>/data/user/runtime/web/server.js`, prepared by `scripts/deeptutor/prepare_web.py` |
| StudyOrbit's MCP server | stdio child of DeepTutor's API | `node scripts/mcp-server.mjs --project <this checkout>` |

- "Owner's instance" is the one whose page is on port 5173. Every other page port gets the second set, so a test run cannot reach the owner's DeepTutor. Override with `STUDYORBIT_DEEPTUTOR_WEB_PORT`, `STUDYORBIT_DEEPTUTOR_API_PORT`, `STUDYORBIT_LLM_PROXY_PORT`.
- DeepTutor's data (sessions, memory, settings) is in `.local/deeptutor/home` of the checkout, mode 700, ignored by Git. Each checkout has its own.
- Start-up measured: 6 s for the API and 1 s for the web server; the first start in a checkout also copies 123 MB of web files. `deeptutor start` is not used because it binds every network interface.
- The server stops the processes it started when it stops, and nothing else. If DeepTutor's API already answers on the port, it is used as it is and left running. If the server was killed without cleaning up, the next start stops the two processes recorded in `.local/deeptutor/processes.json`, after checking their command lines.
- Whatever goes wrong becomes a status on the Agent page (`GET /api/local/deeptutor/status`: `starting`, `running`, `external`, `not-installed`, `unsupported-provider`, `failed` with a reason, `off`). StudyOrbit itself starts and runs the same without DeepTutor. Measured: with the API process killed, the web process was stopped, the page showed "not running" with the reason, and the course pages kept working.
- `STUDYORBIT_DEEPTUTOR=off` starts StudyOrbit without the assistant.

## The model key

The owner asked for two things that DeepTutor 1.7.4 cannot give together: the key read through DeepTutor's `api_key_env`, and the key never written to a file. `deeptutor config apply` resolves the variable named by `api_key_env` once and saves the value in clear in `data/user/settings/model_catalog.json` (`deeptutor_cli/setup_config.py`); there is no mode that keeps only the name. The no-file rule was kept:

- DeepTutor is configured with `base_url` = the model proxy and `api_key_env` = a variable that holds a random token created for this launch.
- The proxy accepts a request only from a loopback peer, with its own `Host`, without an `Origin` header and with that token, and only `POST /responses`, `POST /chat/completions` and `GET /models`. It replaces the token with the key from StudyOrbit's model settings (or `DEEPSEEK_API_KEY`) and forwards to `https://api.deepseek.com`. It logs why a request was refused and nothing else: no headers, no bodies.
- DeepTutor's processes get a short environment (`PATH`, `HOME`, locale): no key, no API token, no proxy variables.
- Measured after real turns: no file under `.local/deeptutor` contained the key. A test does the same with a sentinel key over every generated file, argument and child environment.

Only DeepSeek is supported. With another provider chosen in Settings the status is `unsupported-provider`.

DeepSeek is configured with `api_format: openai_responses`. With chat-completions, DeepTutor 1.7.4 drops an empty `reasoning_content` when it replays a tool round (`runtime/agentic/messages.py`) and DeepSeek answers HTTP 400 ("the reasoning_content in the thinking mode must be passed back"). Measured: the same question failed on the second round with chat-completions and ran six rounds with the Responses format. Not reported upstream.

## Who can reach DeepTutor

DeepTutor has no authentication by default, answers any `Host`, echoes any `Origin` in its CORS headers, and its API can register a stdio command. Bound to loopback, it would still be reachable from any web page open in the browser. So its API runs behind `guard_app.py`, which answers 403 (and refuses WebSocket upgrades) unless `Host` is a loopback name with the API or web port, the Host forwarded by DeepTutor's web server passes the same test, `Origin` (when present) is the StudyOrbit page or DeepTutor's page, and the request is not marked `Sec-Fetch-Site: cross-site`.

Measured against the instance started by `npm run dev` (test ports):

| Request | Direct to the API port | Through the web port |
| --- | --- | --- |
| No `Origin`, loopback `Host` | 200 | 200 |
| `Origin: https://evil.example` (GET, PUT, preflight) | 403 | 403 |
| `Host: evil.example` | 403 | 403 (200 before the forwarded-Host check was added) |
| `Sec-Fetch-Site: cross-site` | 403 | 403 |
| WebSocket with a foreign `Origin` or `Host` | 403 | 403 |
| WebSocket without `Origin` (StudyOrbit's server) or from the StudyOrbit page | 101 | not tried |
| From the machine's LAN address | connection refused (ports 5185, 5196, 5199) | |

DeepTutor's page loaded in the frame and showed a streaming reply with the guard in place.

Not covered: a program running as the same user can call DeepTutor's API (it needs no token) and can send any headers; DeepTutor's web port serves its HTML and scripts to any `Host` (they contain no data). DeepTutor's own login was not used: it switches the installation to its multi-user layout.

## Course data

DeepTutor calls StudyOrbit's six read-only tools through MCP (`mcp_studyorbit_list_courses` and so on, after its `load_tools` step). Grades, targets, deadlines and the plan are still computed by `shared/course-tools.ts`.

What the MCP server cannot read from the browser reaches it through a file. The Agent page sends the course selection, the course it was opened from and the planning snapshot (tasks, time estimates, daily hours, target bands) to `PUT /api/local/agent-context`; the server validates it and writes `.local/agent-context.json` (mode 600); the MCP server reads it on every call:

- the scope is the page's course selection (a `--courses` filter still narrows it);
- `plan_schedule` plans the page's tasks and returns `snapshotSavedAt`;
- `list_courses` returns `focus` with the course the page was opened from, for 30 minutes after it was saved.

Without the file the tools behave as before: every listed course, no planning data. Corrections made on the course page are still not included (the MCP server reads the synced files).

Measured:

| Asked | Tools called | Result | Tokens |
| --- | --- | --- | --- |
| Current average and what is needed for an H1 (course named) | `list_courses`, `calculate_grades`, `final_needed`, `get_assessments`, `final_needed` with `whatIf` | 74.8, 33.66 of 45 graded, 84.25 needed: equal to the tools' own output | 53,294 |
| "What do I still need for an H1?" after "Ask Agent" on SYNT10001 (no course named) | `list_courses`, `get_assessments`, `calculate_grades`, `final_needed` | answered for SYNT10001: 84.25 | 34,635 |
| Weekly plan, no page context | `plan_schedule` → `available: false` | before the rule below: the model invented seven tasks with minutes and planned them. With the rule: it said the planning data had not arrived, listed the three deadlines and asked for the tasks | 129,697 before; 35,779 after |
| Weekly plan, page context saved | `plan_schedule` (no arguments), `upcoming_deadlines`, `get_assessments` | the page's five tasks and daily hours, with the overflow the tool returned and the snapshot's save time | 46,439 |

## The rules it is given

An always-on DeepTutor skill (`scripts/deeptutor/skill/SKILL.md`, installed through DeepTutor's API at every start) is part of every chat prompt. It says: course facts come from the StudyOrbit tools; never invent a mark, weight, deadline or requirement; use the grade tools for arithmetic; when `plan_schedule` reports no planning data, say so and do not make up tasks or minutes; never write, complete or submit assessed work, and offer to explain, plan, review the student's own attempt or generate practice questions instead; do not put course data into a web address or a search.

This is a prompt rule, not an enforcement. Two other things back it: DeepTutor's solve module (`deep_solve`) is not installed, and the page warns if it is found. Measured once each: asked to "write my Assignment 2 answer so I can submit it tonight", the model declined in one sentence and offered the alternatives, with the rule present; it also declined before the rule was installed, so one trial does not show how much the rule adds.

## What can leave the machine

| DeepTutor feature | Reaches | Here |
| --- | --- | --- |
| The model (`chat`, `deep_question`, input suggestions) | the model provider, through the proxy | on |
| `web_search` | a search provider | off: no provider configured and the tool disabled in `main.yaml`. Measured: a call returned "no search provider is configured" |
| `web_fetch`, `github` | any URL the model asks for; GitHub's API | **cannot be switched off in 1.7.4**: they are mounted for every chat turn, and the per-turn tool list only selects the eight optional tools. The rules above forbid sending course data |
| `paper_search`, `zotero_search`, `imagegen`, `videogen`, `brainstorm`, `reason`, `geogebra_analysis` | their services or the model | off in sessions StudyOrbit starts (`tools: []`); can be switched on in DeepTutor's composer |
| `exec` (runs model-written code) | this machine | off. On macOS its only backend is a restricted child process, not a system sandbox; it exists only when `sandbox_allow_subprocess` is true, which the launcher sets to false. Measured: offered to the model before, not offered after |
| Update check | PyPI or GitHub | off |
| Knowledge bases | an embedding service | not built: no embedding key is configured, DeepSeek lists no embedding model, no local embedding server is installed |

## The Agent page

- The page shows DeepTutor's chat in a frame, with "Open in a new tab" and "Old chat". DeepTutor sends no `X-Frame-Options` or `Content-Security-Policy`, so framing needs no change on its side.
- "Ask Agent" on a course saves the context with that course in focus and opens a new conversation. Nothing is sent to the model.
- A revision preset (including "10 practice questions") starts one DeepTutor chat session with the prompt through `POST /api/local/deeptutor/turns` and the frame opens that session. Measured: the session id came back at once, the frame showed the reply streaming, and the turn finished after StudyOrbit had closed its own connection. The presets use plain chat: DeepTutor's `deep_question` capability produced two questions only after seven protocol retries and one schema repair with `deepseek-flash` (120,846 tokens).
- The frame is created only while the Agent page is showing. Opening DeepTutor's chat page makes it ask the model for input suggestions (measured: two calls, 1,858 tokens).
- DeepTutor's page follows the system's light or dark setting, not a theme picked in StudyOrbit's settings. Its interface language is its own setting (English by default).
- DeepTutor's page still shows "Solve" and "Research" shortcuts although those modules are not installed. Not tried.

## Token use

One question costs several times what StudyOrbit's own tool-mode chat did: DeepTutor's prompt and tool list are about 6,500 to 8,500 input tokens per model call and each tool round resends the conversation. Measured totals per question are in the tables above (34,635 to 57,390 for a grade or revision question, most of it cache hits); the old tool-mode chat averaged 6,748 input tokens per question on its own question set ([Chat Q&A evaluation](eval-chat-qa.md)). The two were not run on the same questions. All real calls for this change: 54 calls and 403,882 tokens for the first trial (the provider's usage figures), then 24 calls and 178,858 tokens while building the integration (5 calls counted from the provider's figures, 19 from DeepTutor's usage ledger, which includes 5 calls and 4,615 tokens that belong to no chat turn: input suggestions and titles).

## Not verified

- A message typed by hand into the framed page (only sessions started through StudyOrbit's route and through DeepTutor's WebSocket were run; the page was seen rendering them).
- DeepTutor's memory across sessions; a second question in the same session.
- OpenAI-compatible and Anthropic providers; any machine other than this one; Windows and Linux.
- Upgrading DeepTutor: `prepare_web.py` calls a private helper of 1.7.4, and the settings files and WebSocket protocol may change.
- Packages were installed from a PyPI mirror; the `uv` binary and the `deeptutor` wheel matched pypi.org's SHA-256, the other 112 packages were not compared.
