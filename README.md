# StudyOrbit

**UniMelb coursework assistant** · 墨大课业助手

A local-first coursework assistant for University of Melbourne students. It reads your courses from the Canvas, Ed and Handbook sessions you are already signed in to, has a model of your choice turn them into one structured course JSON per course, validates that JSON in code, and then shows your grades, the average you still need for a target grade, an automatic weekly plan, revision help, and a chat that answers questions about your courses. Everything is stored on your machine; during analysis and chat, course data is sent to the model provider you choose.

> Still a prototype. It has only been run for real on macOS + Microsoft Edge + UniMelb Canvas; see [Supported setups](#supported-setups). Check the result of a sync by hand; do not treat it as correct by default.

The interface is in Chinese. Below, interface labels are given in English with the Chinese label in brackets.

## Supported setups

Choose the institution, Canvas address, browser and Ed region in Settings → Data sources (「设置 → 数据来源」). With no changes you get the first row.

| Setup | Status |
| --- | --- |
| macOS + Microsoft Edge + University of Melbourne (Canvas, Ed Australia, Handbook) | Run for real |
| macOS + Google Chrome (same Apple Events script) | Not run: only the script dictionary was checked |
| Another institution's Canvas (institution "Other (generic Canvas)" 「其他学校（通用 Canvas）」) | Not run: tested only with synthetic API responses for another Canvas address; there is no official assessment framework like the Handbook, so analysis uses Canvas and Ed only |
| Ed US and EU regions (`us`, `eu`) | Not run: API addresses copied from the `edstem` CLI's region table; the course link format is confirmed only for Australia |
| Windows, Linux (dedicated browser over CDP) | Experimental, not run: unit tests only (fake pipe, fake file system, fake browser); never run on Windows or Linux, and how long single sign-on lasts in the dedicated browser is unknown |

## Features

- **Course sync:** discovers your Canvas courses; after you tick the ones you want, it collects Canvas (assignments, groups, your submissions), Ed (via the `edstem` CLI) and the Handbook (assessment structure) one course at a time, then a model merges them into one course JSON. If the format or relationships are wrong it repairs once. Results are saved per course in a course folder on your Desktop.
- **Grades:** the course page shows marks earned, the current average, the share of the course already marked and each item's weight. Pick a target band (H1 80 / H2A 75 / H2B 70 / H3 65 / P 50) to see the average you need on what is still unmarked; it says so when the target is already secured or out of reach.
- **Assessments:** one row per item, with expandable sub-items. You can correct, merge, add or hide items. Corrections are saved in `.local/corrections/` and never change the synced file. Your corrections survive a resync; when both the sync and you changed the same field, you choose which value to keep under "Sync conflicts" (「同步冲突」) at the top of the course page.
- **Weekly plan:** after you set the hours you have each day, tasks are spread over the days before their deadlines, earliest deadline first (the same input always gives the same plan). Work that does not fit, overdue work, graded items due within 7 days that are not planned yet, courses whose sync failed, and deadlines or weights that changed in a resync are listed under "Needs you" (「需要你处理」) at the top; "Got it" (「知道了」) hides a change. Week and month views show synced deadlines. You can add tasks outside your courses and record actual time against the estimate.
- **Revision:** the course page's revision tab lists exam dates, weights and rules; one click asks the agent to revise with you, write practice questions or summarise notes. A finished reply in a single-course chat can be saved to revision and is still there next time.
- **Agent chat:** answers questions from the synced data of the selected courses, for example explaining weights, working out what you need in the final, planning this week or writing revision questions. It explains and plans only. **It never writes, completes or submits any assessment.**
- **MCP:** a local stdio MCP server exposes the chat's read-only course tools (course list, assessments, grades, final needed, upcoming deadlines, schedule) to clients such as Claude Code and Claude Desktop; see [Use from an MCP client](#use-from-an-mcp-client).
- **Model choice:** in Settings → Analysis model (「设置 → 分析模型」) pick DeepSeek, an OpenAI-compatible API (OpenAI, Qwen, Kimi, local Ollama and others), Anthropic Claude or the Codex CLI. Sync analysis and chat share this setting.
- **Appearance:** light, dark or system; five palettes; a gradient, solid colour or uploaded image as background (visibility, blur and card opacity adjustable); animations turn off when the system asks for reduced motion.

## Getting started

Requires Node.js **24 or later**. In the project folder:

```bash
npm ci
npm run dev
```

Open `http://localhost:5173/`. `npm run dev` starts the local API server (`127.0.0.1:5190`) first and then the page (`localhost:5173`). Change the ports with `STUDYORBIT_API_PORT` and `STUDYORBIT_WEB_PORT`; a port that is already in use is an error, not a reason to pick another one. Viewing data you have already synced needs nothing else. To sync courses you also need:

1. **Microsoft Edge on macOS**, signed in to Canvas (UniMelb Canvas by default), with a browser window open. Canvas and Handbook collection rely on Edge's "Allow JavaScript from Apple Events" and the system automation permission. The browser must already be open; otherwise you get "Please open Microsoft Edge and sign in first" (「请先打开 Microsoft Edge 并登录」) and StudyOrbit does not start it for you.
   - **Google Chrome on macOS (not run):** in Settings → Data sources choose Google Chrome and save. In Chrome, tick View → Developer → Allow JavaScript from Apple Events; on the first collection macOS also asks whether the terminal may control "Google Chrome". Chrome uses the same script dictionary as Edge, but no real Chrome run has been done.
   - **Windows, Linux: dedicated browser (experimental, not run on Windows or Linux):** in Settings → Data sources choose "Google Chrome (dedicated browser)" or "Microsoft Edge (dedicated browser)" (Chrome is the default on these systems). StudyOrbit looks for an installed Chrome or Edge (on Windows under Program Files, Program Files (x86) and the local AppData; on Linux `google-chrome`, `chromium`, `microsoft-edge` and similar on `PATH`; otherwise enter the full program path in settings) and starts it with its own profile directory `.local/browser/<browser>` (readable only by you) and `--remote-debugging-pipe`: no debugging port is opened and your everyday browser profile is not touched. Click "Open dedicated browser" (「打开专用浏览器」) in settings and sign in to Canvas in that window (single sign-on and two-factor authentication are done by you; StudyOrbit never types a password). Keep the window open during a sync. The local server holds this browser across courses and syncs, so you only lose the sign-in when the browser closes: when you close the window, change the browser setting or stop the server. Collection may open only the Canvas address and the institution's framework source, and reads only page text or same-origin JSON, never cookies, local storage or passwords. If the sign-in expires during a sync you see "Canvas: sign in in the dedicated browser, then continue the sync" (「Canvas：请在专用浏览器里登录后继续同步。」); sign in and click "Continue last sync" (「继续上次同步」). If a dedicated browser is already running on the same profile directory (for example after the server crashed) you see "The StudyOrbit dedicated browser is already running; close it first" (「StudyOrbit 专用浏览器已在运行，请先关闭它」). Deleting `.local/browser/` signs you out.
   - **Other institutions (not run):** choose "Other (generic Canvas)", enter your Canvas address (`https://` plus the domain) and time zone, and if needed a course-code regular expression with exactly one capture group (for example `^([A-Z]+\d+)_`; the group is the course code). After changing the institution or Canvas address, click "Sync now" (「立即同步」) again to fetch your courses; while the course list still comes from another Canvas, sync and the course page say "Canvas address changed, fetch your courses again" (「Canvas 地址已更改，请重新获取课程」).
2. **The `edstem` CLI**, installed and signed in (Ed uses its own sign-in, not the browser's; UniMelb is in the Australian region). The Ed region defaults to "Auto": grades follow the CLI's sign-in region and course links use the Australian format. In the US or EU region choose `us` or `eu` in settings; if the setting and the CLI's region differ, Ed data for that course is recorded as not read.
3. **A model:** in Settings → Analysis model choose a model, enter its key and click "Test connection" (「测试连接」). Environment variables also work (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, or `COURSE_ANALYSIS_PROVIDER` / `_MODEL` / `_URL` / `_API_KEY`); settings win over environment variables, which win over the default (DeepSeek `deepseek-flash`).

Then click "Sync now", tick your courses and save. **Saving the course selection starts a sync at once**, which uses the browser, Ed and model credit; the revision presets and the chat also use model credit. To collect only the course list, run `npm run sync:courses`.

## Try it without a UniMelb account

The repository ships a synthetic course (`test/fixtures/synthetic-course/`, course code `SYNT10001`, all data made up). Without signing in or a model key you can run the whole path "model output → local validation → rejection and repair → scoring against the gold answer":

```bash
node scripts/eval-course-analysis.mjs --fixture test/fixtures/synthetic-course
```

The first fixed output cites a Canvas assignment that does not exist, so validation rejects it and triggers one repair; a later one passes validation but misses a hurdle and has a wrong type, which only the comparison with the gold answer catches. The terminal prints accuracy, consistency and rejection counts; full results go to `.local/eval/results/`. Add `--live` to call your configured model instead. The gold format, the metrics and how to evaluate real collected data are in [Course analysis evaluation](docs/eval-course-analysis.md).

## Use from an MCP client

`scripts/mcp-server.mjs` is a local stdio MCP server (name `studyorbit`) with the same 6 read-only tools as the Agent chat: `list_courses`, `get_assessments`, `calculate_grades`, `final_needed`, `upcoming_deadlines`, `plan_schedule`. Given the same data and arguments it returns the same results as the chat in the page.

- **Read-only and local:** every call re-reads `.local/lms/courses.json` and the newest valid course JSON in the Desktop course folders (the same data as the page, so no restart is needed after a sync). It does not sync, write files, call a model, read model settings or keys, or use the network. It does not apply the corrections you made in the page.
- **No planning data:** weekly-plan tasks live in the page and MCP cannot read them; `plan_schedule` is useful only when the tasks are passed in as arguments, as the chat does.
- **Node.js 24 or later:** the `node` your client starts must be 24+. If a client (especially Claude Desktop) does not find the right `node`, replace `node` below with its absolute path (`which node`).
- **Start it with `node`, not `npm run mcp`:** npm prints a header line on standard output, which breaks the protocol. `npm run --silent mcp` is fine for trying it by hand.

Replace `<repo>` below with the absolute path of this repository on your machine.

**Claude Code:**

```bash
claude mcp add studyorbit -- node <repo>/scripts/mcp-server.mjs
```

**Claude Desktop:** edit `claude_desktop_config.json` (on macOS in `~/Library/Application Support/Claude/`, or via Settings → Developer → Edit Config), add the server and restart Claude Desktop:

```json
{
  "mcpServers": {
    "studyorbit": {
      "command": "node",
      "args": ["<repo>/scripts/mcp-server.mjs"]
    }
  }
}
```

**Other MCP clients:** configure a stdio server with command `node` and arguments `["<repo>/scripts/mcp-server.mjs"]`. No key or environment variable is needed.

**Optional arguments:**

| Argument | Effect |
| --- | --- |
| `--courses <id,id>` or the `STUDYORBIT_COURSES` environment variable | Expose only these courses (Canvas course IDs; call `list_courses` without a filter to see them). `--courses` wins when both are given; IDs not in the course list are ignored |
| `--project <dir>` | Which project's `.local/` to read; defaults to the repository the script is in |
| `--desktop <dir>` | Where the course folders are; defaults to `~/Desktop`, like the page |

For example, to expose two courses in Claude Code: `claude mcp add --env STUDYORBIT_COURSES=<id>,<id> studyorbit -- node <repo>/scripts/mcp-server.mjs`; in Claude Desktop add `"env": { "STUDYORBIT_COURSES": "<id>,<id>" }` to the configuration above.

> **Where data goes:** tool results contain your grades and assessments and are sent to the model you use in that client (Claude Desktop and Claude Code send them to Anthropic), under that provider's terms. Use `--courses` to keep a course out. Diagnostics (course counts, why a read failed) go to standard error only and show up in the client's MCP log; they contain no course content.

## Data and privacy

| What | Where |
| --- | --- |
| Collected snapshots, sync records and usage, the deadline and weight change log, corrections, model settings, data source settings (`.local/config/sources.json`), chats, revision notes | `.local/` in the project (ignored by Git; settings files have mode 600 and keys are write-only) |
| Each course's course JSON | UniMelb: `~/Desktop/墨尔本大学 <year> S<semester>/<course code>/`; other institutions: `~/Desktop/StudyOrbit <semester>/<course code>/` (only letters, digits, spaces, dots, underscores and hyphens are kept) |
| Course selection, tasks and time spent, daily availability, appearance, seen-change markers, background image (corrections from before the move are kept as a backup) | Browser localStorage and IndexedDB (the background image is never uploaded) |

- Storage stays on your machine. During analysis and chat, course data (including grades) is sent to the model provider you chose, under that provider's terms, and model calls may cost money. If the API address points to a local model (for example Ollama), the data stays on your machine.
- The local API accepts only same-machine, same-origin requests that carry this launch's token. `npm run dev` generates a random token on every start and only the page server's proxy adds it; it is never sent to the browser. Other websites, pages on other local ports and devices on your network cannot read your data.
- No self-issued Canvas token is used (the university does not allow it). You always sign in and complete multi-factor authentication yourself; the model never sees a password.

## Development

- `npm run check`: type check plus the vitest tests under `test/`, the same as CI. Grades, the final-needed target and the weekly plan are pure functions in `shared/`; tests use synthetic data only.
- `npm run build`: builds the static assets. **The static build has no sync, chat or revision-note API**: those live in the local API server (`server/`), and only `npm run dev` connects the page to it.
- Code structure, data flow and every script: [Overview](docs/overview.md). Course JSON contract and what the model fills in versus code: [docs/course-json.md](docs/course-json.md). Evaluations: [course analysis](docs/eval-course-analysis.md) and [chat Q&A](docs/eval-chat-qa.md). Current specifications: `openspec/specs/`.
- Working rules: [CLAUDE.md](CLAUDE.md). Decisions: `note/decisions.md`; product positioning and future ideas: [note/product.md](note/product.md); current handoff: [note/handoff.md](note/handoff.md) (these notes are in Chinese).

## Measurements

[Sync optimisation](docs/sync-optimization.md) records the time and tokens of real sync runs, with the raw run records in its appendix. They describe those four courses at that time only, not a general result. Personal grades have been removed from these records; model comparisons and hybrid-sync experiments that contain grades are kept only on the owner's machine.

## Repository history

Since 2026-10-29 this repository follows the local prototype v2; the v2 development history was merged into the main branch after removing personal grades. The earlier v1 implementation (Codex reading pages, a CLI, SQLite storage, the v1 OpenSpec specs) was removed from the main branch and remains in the Git history.

## Licence

[MIT](LICENSE) © 2026 MortyYJT. Dependencies keep their own licences; the external `edstem` CLI is not distributed with this repository.
