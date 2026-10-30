# Overview: structure and data flow

Updated 2026-10-30. StudyOrbit is a local prototype. `npm run dev` starts two processes: the local API server (`server/`) and the Vite dev server that serves the React page. A static build has no local API.

## Processes, ports and token

| Process | Address | Notes |
| --- | --- | --- |
| Local API server (`node server/main.ts`, `npm run server`) | `http://127.0.0.1:5190` (`STUDYORBIT_API_PORT`) | Serves every `/api/local/*` route; binds only `127.0.0.1`; exits with an error if the port is taken instead of picking another |
| Vite dev server (`npm run dev:web`) | `http://localhost:5173` (`STUDYORBIT_WEB_PORT`, strict port) | Serves the page only and proxies `/api/local` to the local API server |

- **Start-up:** `scripts/dev.mjs` generates a random 32-byte token on every start and passes it to both processes in `STUDYORBIT_API_TOKEN` (never written to disk, printed, or put in front-end code). It starts the API server first and starts Vite once it sees the line `StudyOrbit local API listening on …` (if that line does not appear within 15 seconds, or the server exits first, everything exits). Ctrl-C is forwarded to both; when one exits the other is stopped. Extra arguments go to Vite (`npm run dev -- --open`). Change the page port with `STUDYORBIT_WEB_PORT`, not `--port`: the API only accepts the page's own port.
- **Access checks** (`server/guard.ts`, in order; any failure is a 403 with an empty body): the peer is loopback; the `x-studyorbit-token` header equals this launch's token (constant-time comparison); `Host` is `localhost`, `127.0.0.1` or `[::1]` with the page port (DNS-rebinding defence); an `Origin`, when present, equals `http://<Host>`. Per-route write rules (same-origin `Origin` plus `Content-Type: application/json`) still apply.
- **Proxy** (`server/proxy.ts`): keeps `Host`, adds the token on the server side and overwrites any value the browser sent; a non-loopback browser gets a 403 and nothing is forwarded; SSE is not buffered and the upstream request closes when the browser disconnects. Running `vite` directly (`npm run dev:web`) without a token refuses to start; `vite preview` has no proxy, so `/api/local` returns 404.
- **Single instance:** at start-up the server takes `.local/server.lock` (`scripts/lib/server-lock.mjs`); if another server for the same project is running it exits with 「另一个 StudyOrbit 本地服务正在运行」 ("another StudyOrbit local server is running") and removes the lock on exit. It then opens `.local/studyorbit.db` (`scripts/lib/sync-store.mjs`); if the database is unavailable, sync routes return `503 SYNC_STORE_UNAVAILABLE` and other routes keep working.

## Main flow

0. **Data source settings:** `GET`/`PUT /api/local/source-settings` (`server/routes/source-settings.ts`, `scripts/lib/source-settings.mjs`) read and write `.local/config/sources.json`: the institution (`unimelb` or `generic`), Canvas address, browser, browser path, Ed region, and, for `generic` only, the time zone and course-code regular expression. With no file the settings are UniMelb + macOS Edge (on other systems the default is the dedicated Chrome, experimental). Saving while a sync or course fetch is running returns `409 SYNC_RUNNING`. Each sync and each course fetch reads the settings once and turns them into a collector configuration (`STUDYORBIT_SOURCE_CONFIG`, no credentials) for the collector processes; collectors never read the settings file.
1. **Discover courses:** `POST /api/local/sync-courses` starts the Canvas discovery collector (`scripts/sources/canvas/collect.mjs discover`), which reads every Canvas course in the signed-in browser, saves `.local/lms/courses.json` and records `canvasOrigin` and the institution. Readers (`/api/local/course-candidates`, `scripts/lib/course-reports.mjs`) filter candidates with the current institution plugin's course-code rule. If the course list's Canvas address differs from the settings (an older list without that field counts as UniMelb), sync, the course page and course selection return `409 COURSE_LIST_STALE`, because course IDs of two Canvas instances can collide.
2. **Select and sync:** `web/src/LocalCourseSelect.tsx` stores the selection in the browser and calls `POST /api/local/course-sync` (GET for progress, DELETE to cancel). `scripts/lib/sync-pipeline.mjs` collects each course's configured sources in turn: Canvas, Ed, and the institution's framework source (the Handbook for UniMelb, none for a generic institution). Collection is serial; analysis of collected courses can run alongside later collection. Each course goes through four stages, collect → analyse → validate → merge (`scripts/lib/sync-stages.mjs`), and each stage writes a checkpoint to `.local/studyorbit.db` (`scripts/lib/sync-store.mjs`, `node:sqlite`).
   - **Resume:** a sync that failed, was cancelled or was interrupted by the server exiting can be continued within 24 hours of its first start with `POST /api/local/sync-jobs/<jobId>/resume` ("Continue last sync" 「继续上次同步」 in the page). Stages whose checkpoint and files check out are reused and are not collected or analysed again; a call that was in flight is redone.
   - **Limits:** one collector at a time (Canvas and the Handbook share one browser limiter, Ed has its own; two starts on the same limiter are at least 500 ms apart); at most 4 concurrent requests per model provider; transient failures (model HTTP 429, 5xx and connection errors; collector exit code 75) are tried at most 3 times (`scripts/lib/rate-limit.mjs`).
   - **Preflight:** before collecting, `scripts/sources/canvas/preflight.mjs` and `scripts/sources/ed/preflight.mjs` run. If the browser has no window, Apple Events JavaScript is off or the Canvas sign-in has expired, the whole job stops at once, every course gets the reason, no model is called and nothing is written to the Desktop. An Ed sign-in problem is only a warning.
   - **Failures:** when a collector fails, its reason (with paths, URL parameters, cookies and tokens removed) goes into the placeholder file and the course's reason (`shared/sync-reasons.ts`). For a course that already has a file, a failed Canvas, Handbook or Ed collection makes the result "incomplete": the analysis is kept only for diagnosis (`.local/lms/sync-errors/<runId>-<courseId>-incomplete.json` and a database snapshot), nothing is written to the Desktop or the change log, and the page keeps showing the previous file with the reason under "Needs you" (「需要你处理」). A first sync is saved as usual (at most "partial").
3. **Model analysis:** `scripts/lib/course-analysis.mjs` builds the shared prompt and output schema (source rules, framework references and quote rules come from the institution plugin; the framework section is omitted when there is no framework source), and `scripts/lib/llm-providers.mjs` calls the configured model (DeepSeek, OpenAI-compatible, Anthropic, Codex CLI). The result is validated against `shared/course-data.ts`, repaired once if needed, and a valid JSON is saved in the Desktop course folder. What the model fills in and what code fills in is in [Course JSON](course-json.md).
4. **Display and corrections:** `GET /api/local/course-reports` reads each course's newest valid JSON; `web/src/LocalPlanning.tsx` renders the course page and the week view. Your corrections, additions, ordering and hidden items are saved in `.local/corrections/<courseId>.json` (`/api/local/corrections`, `scripts/lib/corrections-store.mjs`) and never change the synced file. When a sync changes the data, a three-way merge keeps your edits, and fields that both sides changed differently show as "Sync conflicts" (「同步冲突」, `shared/corrections.ts`). Corrections previously in browser localStorage are kept there only as a backup after migration.
5. **Change reminders:** after a sync saves a course file, `scripts/lib/course-changes-log.mjs` compares it with the previous valid file by stable ID using `diffSnapshots` in `shared/course-changes.ts`. Changed deadlines or weights are appended to `.local/lms/changes.jsonl` (scores are not logged; first syncs and incomplete syncs log nothing). The page reads the latest 200 entries from `GET /api/local/course-changes` and shows them under "Needs you" and at the top of the course page until you click "Got it" (「知道了」).
6. **Calculation:** grades and the final-needed target are in `shared/course-calculations.ts`, the weekly plan in `shared/planning.ts`; both are pure functions with unit tests.
7. **Chat and revision:** `web/src/Agent.tsx` streams chats through `/api/local/chats*`. DeepSeek, OpenAI-compatible and Anthropic answer with the read-only course tools (the 6 tools in `shared/course-tools.ts`, loop in `scripts/lib/chat-tool-loop.mjs`; an OpenAI-compatible service that rejects tools on the first request falls back to the full context). Codex still gets the selected courses' synced data in full in its context (`scripts/lib/chat-context.mjs`). Neither includes page corrections. The revision tab can send preset prompts; a finished reply in a single-course chat can be saved to revision (`/api/local/revision-notes`).

## What is collected

- **Canvas:** `scripts/sources/canvas/collect.mjs` uses same-origin requests in the signed-in browser (Edge, Chrome or the dedicated browser, through the browser bridge) to read active courses, assignment groups, assignments and your own submissions. Every address is the configured Canvas address plus a fixed Canvas REST path; Link pagination is followed only on the same address and path. It does not read syllabi, quizzes, announcements or assignment bodies.
- **Ed:** `scripts/sources/ed/collect.mjs` uses the separate `edstem` CLI to read the course's lesson list, at most 50 grade candidates and a few introduction pages; `scripts/sources/ed/scores.mjs` reads your final submission scores from the API of the CLI's sign-in region (`au`/`us`/`eu`). If the settings name an explicit region that differs from the CLI's, no Ed request is sent and that course's Ed data is recorded as not read. The API can return 403; that is not a score of zero.
- **Handbook (UniMelb only):** `scripts/institutions/unimelb/handbook-collect.mjs` reads the assessment page for the right year in a background browser tab.
- **Browser bridge:** on macOS, Apple Events scripts drive Edge or Chrome (`scripts/browser/applescript.mjs`). On Windows and Linux a dedicated browser is used (`cdp-chrome`, `cdp-edge`; experimental, not run on those systems): the local server starts the installed Chrome or Edge with its own profile directory `.local/browser/<browser>` (mode 700) and `--remote-debugging-pipe` (no debugging port), on demand, and keeps it across collections and syncs until you close the window, change the browser setting or the server exits (`Browser.close`, forced after 5 seconds). `POST /api/local/browser/open` ("Open dedicated browser" in settings) opens the Canvas address in it so you can sign in. Collector processes ask the server over Node IPC to open, inspect, read and close tabs; the server checks each request against the collector's address allow-list and sends only allow-listed CDP commands (`Target.createTarget`/`attachToTarget`/`getTargetInfo`/`closeTarget`, `Runtime.evaluate` with fixed expressions only, `Browser.close`). A collector that exits closes only its own tabs. If the dedicated browser's sign-in has expired, the Canvas collector exits with code 77 and the stage fails with 「Canvas：请在专用浏览器里登录后继续同步。」 ("Canvas: sign in in the dedicated browser, then continue the sync"); after signing in you can continue the last sync, which collects that course again.

No course files are downloaded and nothing is submitted. Coverage is not guaranteed to be complete; site changes need re-checking.

## Code map

| Location | Purpose |
| --- | --- |
| `web/src/App.tsx`, `web/src/SourceSettings.tsx` | Shell, sidebar, sync dialog, settings (model, data sources, appearance, background) |
| `web/src/LocalPlanning.tsx` | Course page (grades, assessments, revision) and week / month views (plan, needs you, time spent) |
| `web/src/Agent.tsx`, `agent-request.ts` | Chat page; other pages open a new chat with a course and a preset prompt |
| `web/src/palette.ts`, `background.ts`, `BackgroundLayer.tsx`, `motion.ts` | Palettes, background, animation |
| `server/main.ts`, `server/app.ts`, `server/routes/` | Local API server: start-up, the route table behind the access checks, one file per `/api/local/*` route |
| `server/guard.ts`, `server/proxy.ts` | Access checks (loopback, token, Host, Origin); Vite's `/api/local` proxy |
| `vite.config.ts` | Page, ports and proxy only |
| `shared/` | Course JSON contract, grade calculation, weekly plan, correction merge, change comparison, course tools |
| `test/` | vitest unit tests (synthetic data only); `test/no-institution-literals.test.ts` keeps UniMelb literals out of generic code |

### Scripts (`scripts/`)

Entry points are `npm run dev` (`dev.mjs`) and `npm run sync:courses` (collects the course list only). The `.d.mts` files are TypeScript declarations for the modules next to them. The old top-level entries `canvas-background.mjs`, `collect-ed-course.mjs`, `collect-handbook.mjs` and `edstem-scores.mjs` only forward to their new locations so old commands keep working.

| Script | Purpose |
| --- | --- |
| `dev.mjs` | `npm run dev`: generates the launch token, starts `server/main.ts`, starts Vite after the listening line, forwards Ctrl-C, stops one process when the other exits |
| `sources/canvas/collect.mjs` | Reads the configured Canvas through the browser bridge: the course list (recording `canvasOrigin` and the institution) or one course's assignment groups, assignments and your submissions, following Link pagination |
| `sources/canvas/preflight.mjs` | Pre-sync check: one same-origin request to Canvas `/api/v1/users/self` through the bridge, looking only at the HTTP status (browser window, Apple Events JavaScript, Canvas sign-in); prints and stores nothing from the reply |
| `sources/ed/preflight.mjs` | Pre-sync check: runs only `edstem auth status --json`; not being signed in is a warning |
| `sources/ed/collect.mjs`, `sources/ed/scores.mjs`, `sources/ed/regions.mjs` | Ed lesson list, some grades and selected introductions through the `edstem` CLI; your final submission scores (read-only, region-aware); the Ed region table (`au`/`us`/`eu`, copied from the CLI) and course link format |
| `sources/registry.mjs`, `sources/config.mjs`, `sources/collector-io.mjs` | Source registry (Canvas, Ed, the institution's framework source), command assembly and collector configuration (`STUDYORBIT_SOURCE_CONFIG`; UniMelb + Edge when absent); shared collector I/O |
| `institutions/` | Institution plugins: `unimelb` holds every UniMelb specific (course codes, semesters, Desktop folders, time zone, wording, the Handbook source; `handbook-collect.mjs` reads the Handbook page); `generic.mjs` works with any Canvas (course-code rule, `StudyOrbit <semester>/<code>` folders, configured time zone, neutral wording, no framework source) |
| `browser/bridge.mjs`, `browser/applescript.mjs` | Browser bridge: can only open allowed addresses, check status, read in fixed ways and close; Edge or Chrome via AppleScript on macOS |
| `browser/cdp-pipe.mjs`, `cdp-launch.mjs`, `cdp-host.mjs`, `cdp.mjs` | Dedicated browser (CDP, experimental): pipe transport (NUL-separated JSON) and command allow-list; finding the program and launching with its own profile and `--remote-debugging-pipe`, closing (`Browser.close`, forced after 5 seconds); the long-lived browser held by the server; the collector-side bridge over Node IPC |
| `eval-course-analysis.mjs`, `lib/eval-score.mjs` | Course analysis evaluation and its pure scoring ([details](eval-course-analysis.md)) |
| `eval-chat-qa.mjs`, `lib/qa-grade.mjs` | Chat Q&A evaluation and its pure grader ([details](eval-chat-qa.md)) |
| `mcp-server.mjs`, `lib/course-mcp.mjs` | Local stdio MCP server (`--project`, `--desktop`, `--courses` or `STUDYORBIT_COURSES`; writes nothing, calls no model, no network); one MCP tool per course tool, re-reading course files on every call ([setup](../README.md#use-from-an-mcp-client)) |
| `lib/course-list.mjs` | Canvas course JSON parsing and course-code filtering |
| `lib/course-analysis.mjs`, `lib/course-validation.mjs`, `lib/course-refs.mjs`, `lib/course-quotes.mjs`, `lib/normalise-text.mjs` | Analysis prompt and output schema; validation and the repair round; platform references and Handbook component parsing; quote verification; text normalisation |
| `lib/course-reports.mjs` | Reads the selected courses and each course folder's newest valid course JSON |
| `lib/llm-config.mjs`, `lib/llm-providers.mjs` | Model settings (`.local/config/llm.json`) and the four provider adapters |
| `lib/chat-store.mjs`, `lib/chat-context.mjs`, `lib/chat-replies.mjs`, `lib/chat-reply.mjs`, `lib/chat-tool-loop.mjs`, `lib/chat-tools-prompt.mjs` | Chat storage, context-mode prompt, in-flight replies, one reply end to end, the bounded tool loop, the tool-mode prompt |
| `lib/corrections-store.mjs`, `lib/course-changes-log.mjs`, `lib/revision-store.mjs`, `lib/source-settings.mjs` | Corrections store, change log, revision notes (`.local/revision/notes.json`), data source settings (`.local/config/sources.json`, atomic write, mode 600) |
| `lib/local-origin.mjs`, `lib/server-lock.mjs`, `lib/sync-store.mjs` | Same-origin check; single-instance lock (`.local/server.lock`); sync database (`.local/studyorbit.db`: jobs, stage checkpoints, course snapshots) |
| `lib/sync-pipeline.mjs`, `lib/sync-stages.mjs` | Staged sync per course (collect → analyse → validate → merge) with checkpoints, resume after failure, cancellation or interruption, usage records |
| `lib/rate-limit.mjs`, `lib/collector-exit.mjs` | Per-platform limits and bounded retries (one collector at a time, at most 4 per model provider, at most 3 tries for HTTP 429/5xx and network errors); the collector's transient-failure exit code 75 |

## Where data lives

| What | Where |
| --- | --- |
| Course candidates, collected snapshots, sync records and usage | `.local/lms/` |
| Sync jobs, stage checkpoints, course snapshots (SQLite, mode 600) | `.local/studyorbit.db` |
| Local server lock (removed on exit) | `.local/server.lock` |
| Deadline and weight change log (one line per change: `{ at, runId, courseId, assessmentId, name, field, before, after }`; mode 600; safe to delete) | `.local/lms/changes.jsonl` |
| Corrections, manual assessments, ordering, merge base and open conflicts (one file per course; file mode 600, folder 700) | `.local/corrections/<courseId>.json` |
| Model settings (mode 600, keys write-only) | `.local/config/llm.json` |
| Data source settings (mode 600, folder 700; delete to return to UniMelb + Edge) | `.local/config/sources.json` |
| Chats, revision notes | `.local/chat/`, `.local/revision/notes.json` |
| Each course's course JSON | UniMelb `~/Desktop/墨尔本大学 <year> S<semester>/<code>/分数结构*.json`; other institutions `~/Desktop/StudyOrbit <semester>/<code>/分数结构*.json` (new files never overwrite old ones; the newest valid file is read) |
| Course selection, tasks, availability, target band, appearance, seen-change markers (`coursework.course-changes-seen.v1`); corrections from before the move (backup only) | Browser localStorage (per browser and port; keys keep the `coursework.` prefix so existing data survives) |
| Background image | Browser IndexedDB `coursework` |

`.local/` and `.local-backups/` are ignored by Git but contain personal data.

Storage stays on this machine; during analysis and chat, course data is sent to the model provider you chose (`scripts/lib/llm-config.mjs` decides which).

## Current limits

Node.js 24+. Only macOS + Edge + UniMelb Canvas has been run for real. macOS Chrome, other institutions' Canvas and the Ed US and EU regions have synthetic tests only; the Windows and Linux dedicated browser (CDP) is experimental with unit tests only. "Today" and deadlines use the institution's time zone (Melbourne for UniMelb, the configured zone for a generic institution). `edstem` and model keys are external dependencies. Sync state lives in the database, so restarting Vite or the server loses nothing; a sync running when the server exits is marked interrupted and can be continued. The staged sync has not been run against real courses (only fake collectors and a fake model); the chat's tool mode has been tried for real only with DeepSeek; other providers' real calls have not been re-verified since v2; MCP has not been connected from Claude Code or Claude Desktop.
