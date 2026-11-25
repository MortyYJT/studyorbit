# The assistant: DeepTutor next to StudyOrbit

Written 2026-11-24. The Agent page shows [DeepTutor](https://github.com/HKUDS/DeepTutor) (Apache-2.0), which does the chatting, tool calling, memory and question generation; StudyOrbit gives it course data and keeps the model key. StudyOrbit's own chat, which this replaced, has been deleted (its measured record: [Chat Q&A evaluation](eval-chat-qa.md)). Installing and starting: [Setup](setup.md#assistant-deeptutor).

Everything marked "measured" was run on 2026-11-24 on one Mac with DeepTutor 1.7.4, two synthetic courses and the real `deepseek-flash` model.

## What runs

`npm run dev` starts the local API server, and the server brings the assistant up in the background (`scripts/lib/deeptutor.mjs`):

| Process | Address (owner's instance; other instances) | Started as |
| --- | --- | --- |
| Model proxy (inside the local API server) | `127.0.0.1:5197`; `5199` | `server/llm-proxy.ts` |
| DeepTutor API behind StudyOrbit's guard | `127.0.0.1:5195`; `5196` | DeepTutor's interpreter running `uvicorn guard_app:app` (`scripts/deeptutor/guard_app.py`) |
| DeepTutor web server | `127.0.0.1:5175`; `5185` | `node <home>/data/user/runtime/web/server.js`, prepared by `scripts/deeptutor/prepare_web.py` |
| StudyOrbit's MCP server | stdio child of DeepTutor's API | `node scripts/mcp-server.mjs --project <this checkout> --page-context` |

- "Owner's instance" is the one whose page is on port 5173. Every other page port gets the second set, so a test run cannot reach the owner's DeepTutor. Override with `STUDYORBIT_DEEPTUTOR_WEB_PORT`, `STUDYORBIT_DEEPTUTOR_API_PORT`, `STUDYORBIT_LLM_PROXY_PORT`.
- DeepTutor's data (sessions, memory, settings) is in `.local/deeptutor/home` of the checkout, mode 700, ignored by Git. Each checkout has its own.
- Start-up measured: 6 s for the API and 1 s for the web server; the first start in a checkout also copies 123 MB of web files. `deeptutor start` is not used because it binds every network interface.
- The server stops the processes it started when it stops, and nothing else. Each process is written to `.local/deeptutor/processes.json` the moment it is launched; if the server was killed without cleaning up, the next start stops the recorded processes after checking their command lines.
- If something already answers on the API port, it is used only when it proves to be this checkout's own guarded DeepTutor: the guard answers `/studyorbit-guard/instance` with the id kept in `.local/deeptutor/instance-id`. Another checkout's DeepTutor (other courses) or an unguarded one is not adopted; the status is `failed` with "port … is in use" and the page says to stop it or choose another port. It is never stopped.
- A stop that arrives while the assistant is still starting leaves no process and no open proxy port.
- Whatever goes wrong becomes a status on the Agent page (`GET /api/local/deeptutor/status`: `starting`, `running`, `external`, `not-installed`, `unsupported-provider`, `failed` with a reason, `off`). StudyOrbit itself starts and runs the same without DeepTutor. Measured: with the API process killed, the web process was stopped, the page showed "not running" with the reason, and the course pages kept working.
- `STUDYORBIT_DEEPTUTOR=off` starts StudyOrbit without the assistant.

## The model key

The owner asked for two things that DeepTutor 1.7.4 cannot give together: the key read through DeepTutor's `api_key_env`, and the key never written to a file. `deeptutor config apply` resolves the variable named by `api_key_env` once and saves the value in clear in `data/user/settings/model_catalog.json` (`deeptutor_cli/setup_config.py`); there is no mode that keeps only the name. The no-file rule was kept:

- DeepTutor is configured with `base_url` = the model proxy and `api_key_env` = a variable that holds a random token created for this launch.
- The key is read from StudyOrbit's settings on every request, and only while those settings still name DeepSeek: after a switch to another provider the proxy answers 503, so another provider's key is never sent to DeepSeek's address.
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

The guard answers two things itself: `/studyorbit-guard/instance`, and an empty knowledge-base list when DeepTutor has no such route (see the validation below for why). Whether DeepTutor has the route is decided once, at the first such request, by asking each of its top-level routes the way Starlette does (`matches`), which covers the routers FastAPI includes. Clearly absent: the guard answers `[]` itself. Present: DeepTutor answers, whatever it answers. Anything that does not settle it (no route table, a mount that covers the path, a route that cannot be asked): DeepTutor is asked and only a 404 becomes `[]`, so a real list is never replaced by an empty one. Checked with DeepTutor's own interpreter (FastAPI 0.165, Starlette 1.10): the installed app gives "absent" for this route and "present" for `/api/sessions`; a FastAPI app with the route in an included router gives "present", also when the route is hidden from the schema; the same app under a mount gives "unknown".

## Course data

DeepTutor calls StudyOrbit's six read-only tools through MCP (`mcp_studyorbit_list_courses` and so on, after its `load_tools` step). Grades, targets, deadlines and the plan are still computed by `shared/course-tools.ts`.

What the MCP server cannot read from the browser reaches it through a file, and only the MCP server that DeepTutor starts reads it (it is registered with `--page-context`; Claude Code, Claude Desktop and other MCP clients behave as before). The Agent page sends the course selection, the course it was opened from and the planning snapshot (tasks, time estimates, daily hours, target bands) to `PUT /api/local/agent-context`; the server validates it and writes `.local/agent-context.json` (mode 600); the MCP server reads it on every call:

- the scope is the page's course selection (a `--courses` filter still narrows it; a selection that names none of the listed courses, such as an empty one, narrows nothing);
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
| `web_search` | a search provider | off: no provider configured and the tool disabled in `main.yaml`. The launcher reads the file back and refuses to start DeepTutor (status `failed`) when it cannot confirm `enabled: false`. Measured: a call returned "no search provider is configured" |
| `web_fetch`, `github` | any URL the model asks for; GitHub's API | **cannot be switched off in 1.7.4**: they are mounted for every chat turn, and the per-turn tool list only selects the eight optional tools. The rules above forbid sending course data |
| `paper_search`, `zotero_search`, `imagegen`, `videogen`, `brainstorm`, `reason`, `geogebra_analysis` | their services or the model | off in sessions StudyOrbit starts (`tools: []`); can be switched on in DeepTutor's composer |
| `exec` (runs model-written code) | this machine | off. On macOS its only backend is a restricted child process, not a system sandbox; it exists only when `sandbox_allow_subprocess` is true, which the launcher sets to false. Measured: offered to the model before, not offered after |
| Update check | PyPI or GitHub | off |
| Knowledge bases | an embedding service | not built: no embedding key is configured, DeepSeek lists no embedding model, no local embedding server is installed |

## The Agent page

- The page shows DeepTutor's chat in a frame, with "Open in a new tab". The frame is sandboxed (`allow-scripts allow-same-origin allow-forms allow-popups`) and is given clipboard writing only: no microphone, no downloads, no navigation of the StudyOrbit page. Measured with the sandbox: the page loaded and a preset session streamed. DeepTutor's voice input and file downloads were not tried in the frame; use the new tab for them. DeepTutor sends no `X-Frame-Options` or `Content-Security-Policy`, so framing needs no change on its side.
- "Ask Agent" on a course saves the context with that course in focus and opens a new conversation. Nothing is sent to the model.
- A revision preset (including "10 practice questions") starts one DeepTutor chat session with the prompt through `POST /api/local/deeptutor/turns` and the frame opens that session. Measured: the session id came back at once, the frame showed the reply streaming, and the turn finished after StudyOrbit had closed its own connection. The presets use plain chat: DeepTutor's `deep_question` capability produced two questions only after seven protocol retries and one schema repair with `deepseek-flash` (120,846 tokens).
- A request from another page is acted on once: leaving the Agent page and coming back does not send the prompt again.
- The frame is created only while the Agent page is showing. Opening DeepTutor's chat page makes it ask the model for input suggestions (measured: two calls, 1,858 tokens).
- DeepTutor's page follows the system's light or dark setting, not a theme picked in StudyOrbit's settings. Its interface language is its own setting (English by default).
- DeepTutor's page still shows "Solve" and "Research" shortcuts although those modules are not installed. Not tried.

## Validation on merged main (2026-11-24)

Run after the integration was merged, from a fresh worktree of `main`, on the test ports with two synthetic courses and the real `deepseek-flash`. Every message below was typed into DeepTutor's page inside the frame on the StudyOrbit page by a headless Chrome (real mouse and text-input events) and sent with the page's own Send button; the replies were read back through DeepTutor's API.

**The first attempt failed, and that is the one defect this validation found.** A typed message was never sent: DeepTutor 1.7.4's page asks for `/api/knowledge-bases/list` before it sends, the route belongs to the knowledge module, which is not installed here, and the page gives up on the 404 without saying anything. Sessions started by StudyOrbit (presets) had worked because the server starts those turns. The same happened with the page opened in its own tab and with the frame's sandbox removed, so neither the frame nor the guard was the cause. Fix: the guard answers an empty list for that one route when DeepTutor has no such route (`KB_LIST_PATH` in `guard_app.py`); with the knowledge module installed nothing changes. Installing the module instead would have added 55 packages (llama-index, faiss, litellm, boto3) for a feature that cannot be used without an embedding service. Everything below was run with the fix.

| # | Typed or clicked | Session | Result | Calls | Tokens |
| --- | --- | --- | --- | --- | --- |
| 1 | "Ask Agent" on SYNT10001, then: what is my average in this course and how much is graded? (no course named) | A | Answered for SYNT10001: 74.8% on 45% graded, 33.66 points. The course page shows 74.8%, 45% and 33.7 | 6 | 59,909 |
| 2 | Follow-up: if Assignment 2 gets 85%, what do I need on the rest for an H1? | A, second turn | 83.63% on the remaining 30%, 54.91 earned: equal to `final_needed` with that `whatIf` called directly | 2 | 29,992 |
| 3 | Deadlines of all courses in the next two weeks | A | The three deadlines the tool returns (25 Nov reflection 10%, 27 Nov Assignment 2 25%, 4 Dec essay 30%) | 2 | 32,124 |
| 4 | Weekly plan from my StudyOrbit tasks | A | The page's five tasks and daily hours, the overflow the tool returned, and the snapshot's save time | 2 | 34,242 |
| 5 | Remember: no study on Wednesday evenings | A | Saved to DeepTutor's memory; it also said that the hours on the StudyOrbit page are not changed by this | 2 | 36,373 |
| 6 | New conversation: which evening did I say is not for study? | B | Wednesday evenings: remembered across sessions | 2 | 14,927 |
| 7 | Write Assignment 2 in full, I will submit it tonight | B | Declined ("评分作业，整份或部分代写都不行"), offered to break the task down, explain, review a draft, set practice questions | 4 | 36,408 |
| 8 | Revision preset "10 practice questions" on SYNT10001 | C (new) | Ten questions with answers and explanations in the frame. It said first that StudyOrbit holds the assessment structure only, not the syllabus, so the topics are the standard ones for the course name | 7 | 82,243 |
| 9 | A message in session C, then DeepTutor's API process stopped | C | Within 5 s the frame was replaced by "DeepTutor is not running" with the reason and the command; the course page kept working | 1 | 30,053 |
| | One diagnostic message ("reply with one word") | | Confirmed the fix | 1 | 9,232 |
| | Input suggestions and titles (asked for by the page each time it was opened) | | | 14 | 10,876 |

Total: 43 calls, 376,379 tokens (278,784 of the input were cache hits), from DeepTutor's own usage ledger.

Also seen:

- Tool round trips inside one session work: turns 2 to 5 each needed one tool round and one answer, on top of the tools loaded in turn 1.
- The reply language follows DeepTutor's own interface language, not the language typed: session A answered Chinese questions in English, session B in Chinese.
- Pressing Enter after programmatic text input did not send; the Send button did. Not tried with a physical keyboard.
- DeepTutor's page logs 404s for routes of modules that are not installed (`/api/reading/…`, `/api/partners`); they did not get in the way of anything tried here.

**The owner's instance** (main checkout, page port 5173): `npm run dev`'s launcher brought StudyOrbit and DeepTutor up in about 4 s on 5175, 5195 and 5197, all on `127.0.0.1`; health ready, the MCP server registered for the main checkout and connected with six tools, `exec`, web search and the update check off, the rules installed, a foreign `Origin` refused, no port reachable from the LAN address. No page was opened and no model was called (no usage ledger was created); the data directory `.local/deeptutor` holds no session. Stopped with SIGTERM to the launcher: all five ports closed and the process record was removed. The Desktop shortcut was not run: its script passes `zsh -n`, and a zsh started with an empty environment plus the shortcut's own nvm lines gets Node 24 and `DEEPSEEK_API_KEY`, finds the installed DeepTutor 1.7.4 and resolves DeepSeek with a key. `uv` is not on that shell's `PATH`, which does not matter: the launcher runs the virtual environment's programs by path.

## After the old chat was deleted (2026-11-24)

Run on the branch that removed StudyOrbit's own chat, same set-up as the validation above, English interface:

| Step | Result | Tokens |
| --- | --- | --- |
| Sidebar "Agent" | The frame with DeepTutor; the bar has "Open in a new tab" and nothing else | |
| "Ask Agent" on SYNT10001, then typed: current average, and what is needed for an H1 (no course named) | Answered for SYNT10001: 74.8% on 45% graded, 33.66 points | 54,364 |
| Revision preset "Revision notes" | A new session opened in the frame. DeepTutor did not write notes at once: it asked where the course content should come from, because StudyOrbit holds the assessment structure only | 35,240 |
| Input suggestions and titles | | 2,342 |

12 calls, 91,946 tokens. `GET /api/local/chats` answers 404; the revision tab says where new notes are kept. Screenshots were taken at 1440 and at 390, light and dark; at 390 the StudyOrbit page had no horizontal overflow.

## Token use

One question costs several times what StudyOrbit's own tool-mode chat did: DeepTutor's prompt and tool list are about 6,500 to 8,500 input tokens per model call and each tool round resends the conversation. Measured totals per question are in the tables above (34,635 to 57,390 for a grade or revision question, most of it cache hits); the old tool-mode chat averaged 6,748 input tokens per question on its own question set ([Chat Q&A evaluation](eval-chat-qa.md)). The two were not run on the same questions. All real calls for this change: 54 calls and 403,882 tokens for the first trial (the provider's usage figures), 43 calls and 376,379 tokens for the validation above, 12 calls and 91,946 tokens for the check after the deletion, and 39 calls and 278,562 tokens while building and reviewing the integration (5 calls counted from the provider's figures, 34 from DeepTutor's usage ledger, which includes the calls that belong to no chat turn: input suggestions and titles).

## Not verified

- A message typed on a physical keyboard by a person (the validation used a headless browser's input events and the Send button).
- DeepTutor's memory beyond one remembered fact across two sessions.
- OpenAI-compatible and Anthropic providers; any machine other than this one; Windows and Linux.
- Upgrading DeepTutor: `prepare_web.py` calls a private helper of 1.7.4, and the settings files and WebSocket protocol may change.
- Packages were installed from a PyPI mirror; the `uv` binary and the `deeptutor` wheel matched pypi.org's SHA-256, the other 112 packages were not compared.
