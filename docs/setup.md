# Setup

Everything needed to run StudyOrbit and sync real courses: the local servers, the browser bridges, the Ed CLI, the model and the environment variables. The short version is in the [README](../README.md#quick-start); how the pieces fit together is in the [overview](overview.md).

The interface defaults to Chinese; choose English under Settings → Language. Labels below are those of the English interface. Some messages from the local server and the command-line scripts are in Chinese only.

## Requirements

- **Node.js 24.15 or later** (`engines` in `package.json`). Nothing else is needed to view data you have already synced.
- **To sync courses:** a supported browser signed in to Canvas, the `edstem` CLI signed in to Ed, and a model. Each is described below.

## Run it

```bash
npm ci
npm run dev
```

Open `http://localhost:5173/`. `npm run dev` (`scripts/dev.mjs`) starts the local API server on `127.0.0.1:5190` first and then the page on `localhost:5173`, which proxies `/api/local` to the API.

- Change the ports with `STUDYORBIT_API_PORT` and `STUDYORBIT_WEB_PORT`, not with `--port`: the API accepts requests only from the page's own port. A port that is already in use is an error, not a reason to pick another one.
- Extra arguments go to Vite, for example `npm run dev -- --open`.
- Every start generates a new random token that only the page server's proxy sends to the API; it is never written to disk or sent to the browser.
- Only one local server can run per project folder (`.local/server.lock`).
- `npm run build` builds the static page only. **A static build has no sync, chat or revision-note API**; those live in the local API server, which only `npm run dev` connects.

## Data sources

Settings → Data sources chooses the institution, Canvas address, browser and Ed region; they are saved in `.local/config/sources.json` (mode 600; delete the file to return to the defaults). With no changes you get the University of Melbourne with Microsoft Edge on macOS (on Windows and Linux the default is the dedicated Chrome, which is experimental). See [Platform support](../README.md#platform-support) for what has actually been run.

### Microsoft Edge on macOS (default)

1. Sign in to Canvas in Edge (UniMelb Canvas by default) and keep a browser window open.
2. In Edge, turn on View → Developer → Allow JavaScript from Apple Events. On the first collection macOS asks whether your terminal may control "Microsoft Edge"; allow it.

The browser must already be running with a window. Otherwise the sync stops before collecting anything and asks you to open the browser and sign in; StudyOrbit never starts Edge for you.

### Google Chrome on macOS (implemented, not run on a real setup)

In Settings → Data sources choose Google Chrome and save. In Chrome, tick View → Developer → Allow JavaScript from Apple Events; on the first collection macOS asks whether the terminal may control "Google Chrome". Chrome uses the same Apple Events script dictionary as Edge, but no real Chrome run has been done.

### Windows and Linux: dedicated browser (experimental, not run on Windows or Linux)

In Settings → Data sources choose "Google Chrome (dedicated browser)" or "Microsoft Edge (dedicated browser)".

- **Finding the browser:** on Windows StudyOrbit looks under Program Files, Program Files (x86) and the local AppData; on Linux it looks for `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `microsoft-edge` and `microsoft-edge-stable` in the absolute directories on `PATH`. Otherwise enter the full program path in settings.
- **Its own profile:** the browser is started with the profile directory `.local/browser/<browser>` (readable only by you) and `--remote-debugging-pipe`, so no debugging port is opened and your everyday browser profile is not touched.
- **Signing in:** click "Open dedicated browser" in settings and sign in to Canvas in that window. Single sign-on and two-factor authentication are done by you; StudyOrbit never types a password.
- **Keep the window open during a sync.** The local server keeps the browser across courses and syncs, so the sign-in is lost only when the browser closes: when you close the window, change the browser setting or stop the server. Deleting `.local/browser/` signs you out.
- **What it may do:** collection may open only the Canvas address and the institution's framework source, and reads only page text or same-origin JSON, never cookies, local storage or passwords. The server sends only an allow-list of DevTools commands.
- **Expired sign-in:** if the Canvas sign-in expires during a sync, the course stops with a message asking you to sign in in the dedicated browser. Sign in there and click "Resume last sync"; that course's Canvas data is collected again.
- **Already running:** if a dedicated browser is already running on the same profile directory (for example after the server crashed), you are asked to close it first.

### Other institutions (implemented, not run on a real setup)

Choose "Other institution (any Canvas)" and enter your Canvas address (`https://` plus the domain) and time zone. If needed, add a course-code regular expression with exactly one capture group, for example `^([A-Z]+\d+)_`; the group is the course code.

- There is no official assessment framework like the UniMelb Handbook, so analysis uses Canvas and Ed only.
- After changing the institution or the Canvas address, click "Sync now" again to fetch your courses. While the course list still comes from the other Canvas, the sync and the course page ask you to fetch the courses again (course IDs of two Canvas instances can collide).
- Course files go to `~/Desktop/StudyOrbit <semester>/<course code>/` (only letters, digits, spaces, dots, underscores and hyphens are kept).

## Ed: the `edstem` CLI

Ed is read through the separate [`edstem` CLI](https://github.com/bunizao/edstem-cli), which is not distributed with this repository. Install it and sign in; Ed uses its own sign-in, not the browser's. UniMelb is in the Australian region.

The Ed region in Settings → Data sources defaults to "Auto": scores follow the CLI's sign-in region and course links use the Australian format. In the US or EU region choose `us` or `eu`. If the setting and the CLI's region differ, no Ed request is sent and that course's Ed data is recorded as not read. Before a sync StudyOrbit runs `edstem auth status --json`; if Ed is not signed in you get a warning and the sync continues without Ed data.

The US and EU API addresses come from the CLI's region table; the course link format is confirmed only for Australia.

## Model

In Settings → Analysis model choose a provider, enter its key and click "Test connection". Sync analysis and chat share this setting.

| Provider | Notes |
| --- | --- |
| DeepSeek | The default (`deepseek-flash`) |
| OpenAI-compatible API | Any base URL: OpenAI, Qwen, Kimi, a local Ollama and others |
| Anthropic Claude | |
| Codex CLI | Uses the installed Codex CLI; in chat it gets the course data in its context instead of the course tools |

Settings are saved in `.local/config/llm.json` (mode 600); keys are write-only and never shown again. Settings win over environment variables, which win over the defaults. If the API address points to a local model, course data stays on your machine.

## Environment variables

| Variable | Effect |
| --- | --- |
| `STUDYORBIT_WEB_PORT`, `STUDYORBIT_API_PORT` | Page and local API ports (defaults 5173 and 5190) |
| `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY` | Key for that provider when none is saved in settings |
| `COURSE_ANALYSIS_PROVIDER` | `deepseek` (default), `openai-compatible`, `anthropic` or `codex`; an unknown value stops the sync with a message |
| `COURSE_ANALYSIS_MODEL`, `COURSE_ANALYSIS_URL`, `COURSE_ANALYSIS_API_KEY` | Model, base URL and key; used only for the provider named by `COURSE_ANALYSIS_PROVIDER`. For `openai-compatible` the key is sent only to the origin of `COURSE_ANALYSIS_URL` |
| `STUDYORBIT_COURSES` | MCP server only: expose only these Canvas course IDs ([MCP](../README.md#use-from-an-mcp-client)) |
| `CANVAS_PAGE_SIZE` | Canvas API page size, 1–100 (default 100) |
| `EDSTEM_TOKEN` | Ed token for reading scores; by default the `edstem` CLI's own saved token is used |

`STUDYORBIT_API_TOKEN` is set by `npm run dev` on every start; do not set it yourself.

## Start a sync

Click "Sync now", tick your courses and save. **Saving the course selection starts a sync at once**, which uses the browser, Ed and model credit. The revision presets and the chat also use model credit. To collect only the course list, run `npm run sync:courses`.

Before collecting, StudyOrbit checks the browser and the Canvas sign-in; if either fails, the whole sync stops before any model call and nothing is written. A sync that fails, is cancelled or is interrupted can be continued within 24 hours with "Resume last sync"; finished stages are reused. When a course's collection is incomplete and an earlier file exists, the earlier file stays in use and the reason is shown under "Needs you". Problems are also recorded in `.local/lms/sync-errors/`.

Check the result of a sync by hand; do not treat it as correct by default. Corrections you make on the course page are kept separately in `.local/corrections/` and survive later syncs.
