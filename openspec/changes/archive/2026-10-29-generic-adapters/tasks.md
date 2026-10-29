## 1. Interfaces and moves, no behaviour change (PR 1; after local-server-sync-pipeline PR 3 is merged)

- [x] 1.1 Golden tests first, from the synthetic course fixture and synthetic Canvas/Ed/Handbook responses: analysis prompt, repair prompt, both chat system prompts, chat tool descriptions, validation and settle reasons for every collection-flag combination, Desktop folder paths, `normalizeCourses` and discovery output with an injected clock, collector argument lists of the collect stage (PR #280)
- [x] 1.2 `scripts/sources/types.d.mts`, `scripts/institutions/types.d.mts`, `scripts/browser/bridge.mjs` (+ `.d.mts`) with `withPage`; tests of `withPage` with a fake bridge (load limit, polling, two read attempts, close in `finally`, redirect, abort) (PR #280)
- [x] 1.3 Tests then `scripts/browser/applescript.mjs` for Edge only: generated scripts equal today's; read kinds map to the two constant expressions; origin allowlist refuses other origins before any `osascript` call (PR #280)
- [x] 1.4 Move the Canvas collector to `scripts/sources/canvas/collect.mjs` on the bridge (shim at `scripts/canvas-background.mjs`); `normalizeCourses(items, origin)`; Canvas source object with discovery and collect commands; `STUDYORBIT_SOURCE_CONFIG` parsing with zod (fixed UniMelb values in this PR) (PR #280)
- [x] 1.5 Move Ed to `scripts/sources/ed/collect.mjs` and `scores.mjs` (shims stay); Ed source object; term and session matching through the institution; code regex-escaped and matched case-insensitively on both sides (PR #280)
- [x] 1.6 `scripts/institutions/unimelb/`: subject code, term key and label, folders, time zone, wording, Handbook framework source (collector moved to `handbook-collect.mjs`, `parseHandbookRows`/`parseHandbookComponents` moved to `handbook-parse.mjs` and re-exported from `course-refs.mjs` for now) (PR #280)
- [x] 1.7 `resolveSources`; resolved source ids stored with the job; `SOURCES`, `SOURCE_LABELS`, `PLACEHOLDERS` and `collectorCommand` removed from `sync-stages.mjs`, and `collectStage`, `reusableSources`, `readCollected`, `validateInputHash`, `collectionFlags` iterate `ctx.sources` (two-fake-source test through collect → validate → settle); `runCollector` receives `env` and `spawnCollector` passes it to the child (test); collectors default to UniMelb + Edge without `STUDYORBIT_SOURCE_CONFIG`; the pipeline's collect stage iterates sources (checkpoint keys and file names unchanged, browser mutex from `usesBrowser`, limiter from `limiter`); per-source collection flags; `settleCourse` reasons from labels; collect input hash unchanged; `server/routes/sync-courses.ts` and course reports use the Canvas source and the institution; pipeline fault-injection tests still pass with fake sources (PR #280; `settleCourse` still receives the named flags, now derived from per-source flags; building its reasons from source labels is PR 3 as design §1 says)
- [x] 1.8 Golden tests from 1.1 pass unchanged; `bash .claude/check.sh`; fresh-context review; record the PR number here: PR #280

## 2. Chrome on macOS (PR 2)

- [x] 2.1 Tests then `chrome-applescript` in `applescript.mjs`: app name from the fixed map only; every script addresses the chosen app; the bridge is refused off macOS (PR #281)
- [x] 2.2 Tests then the "is running" check for both AppleScript bridges and the not-open message; error text for disabled Apple Events JavaScript names the chosen browser and menu path (PR #281)
- [x] 2.3 Temporary environment override `STUDYORBIT_BROWSER=chrome-applescript` until PR 3 adds settings (removed in PR 3) (PR #281)
- [x] 2.4 README: Chrome on macOS setup (Apple Events toggle, Automation permission) marked 「未实测」 until the owner runs one discovery (PR #281)
- [x] 2.5 `bash .claude/check.sh`; fresh-context review; record the PR number here; owner-run check of one Chrome discovery listed in `note/handoff.md`: PR #281

## 3. Settings, generic institution and generic Canvas (PR 3)

- [x] 3.1 Tests then `scripts/lib/source-settings.mjs` (+ `.d.mts`): defaults when missing, every validation rule, atomic 0600 write, platform availability (PR #282)
- [x] 3.2 Tests then `server/routes/source-settings.ts`: `GET` shape, `PUT` validation errors, `409 SYNC_RUNNING`, access checks; remove the PR 2 environment override (PR #282)
- [x] 3.3 Tests then `scripts/institutions/generic.mjs`: default and custom code pattern, term key, folder sanitisation (reserved names, trailing dots, `.`/`..`), time zone, neutral wording, no framework (PR #282)
- [x] 3.4 Canvas origin from settings; discovery writes `canvasOrigin` and `institution`; `COURSE_LIST_STALE` in sync and course reports; old lists read as UniMelb; tests with synthetic responses from another origin, including a foreign `rel="next"` (PR #282)
- [x] 3.5 Ed region `auto`/`au`/`us`/`eu` with the CLI region check; tests with synthetic `auth status` output (PR #282)
- [x] 3.6 Wording: analysis prompt rules from the plugin and framework source, framework clauses omitted without one; English and Chinese chat intros from `wording`; chat tool descriptions from `wording.timeLabel.en` (UniMelb unchanged); chat-context due-date formatting, MCP and chat "today" with the institution time zone; `timeZone` parameter in `shared/corrections.ts` and `shared/course-tools.ts`; page reads the time zone from the settings route; golden tests still pass for `unimelb` (PR #282)
- [x] 3.7 Collect input hash adds institution, Canvas origin, Ed region and source ids; bump `COLLECT_VERSION`; resume test across a browser change reuses collected data (PR #282)
- [x] 3.8 `test/no-institution-literals.test.ts` with its allowlist and reasons (including the `shared/course-data.ts` schema descriptions); rename remaining generic identifiers and comments (`handbookFailed` → per-source flags, Handbook comments in `course-refs.mjs`, `course-quotes.mjs`, `shared/course-data.ts`) (PR #282)
- [x] 3.9 Settings page 「数据来源」 section; browser check on synthetic `.local` data without a real sync (PR #282)
- [x] 3.10 README, `docs/overview.md`, `scripts/README.md`, `openspec/config.yaml` context: supported setups with verified/unverified labels (decisions #460–#469; PR #282)
- [x] 3.11 `bash .claude/check.sh`; fresh-context review; record the PR number here: PR #282

## 4. CDP bridge for Windows and Linux, experimental (PR 4)

- [x] 4.1 Tests then pipe transport: NUL-separated JSON framing, request IDs, responses out of order, closed pipe, timeouts (PR #283)
- [x] 4.2 Tests then the method allowlist and the three constant expressions (state uses `document.readyState`); `Network.*`, `Storage.*` and any other method throw before writing (PR #283; four constants since #451 added `navigation-status`, decision #471)
- [x] 4.3 Tests then `cdp-launch.mjs`: executable lookup with a fake file system (Windows and Linux paths, `browserPath`), launch arguments (pipe, dedicated `--user-data-dir`, never a port), profile directory 0700, handover detection, close then kill after 5 s (PR #283; unverified on Windows/Linux, decision #479)
- [x] 4.4 Tests then `scripts/browser/cdp-host.mjs` in the server: one long-lived browser launched on demand, kept across collectors and jobs, relaunched after the window closed, closed on setting change and shutdown; IPC requests from collector children (`spawnCollector` adds the IPC channel for `cdp-*`); stopping a collector closes its tabs only (PR #283)
- [x] 4.5 `cdp-chrome` and `cdp-edge` bridges behind `withPage` over IPC; `POST /api/local/browser/open` and the 「打开专用浏览器」 button; redirect message 「请在专用浏览器里登录后继续同步」 (PR #283; exit 77 keeps the job resumable, decision #474)
- [x] 4.6 Docs: Windows/Linux setup marked experimental and not verified; settings page label (PR #283)
- [x] 4.7 `bash .claude/check.sh`; fresh-context review; record the PR number here: PR #283 (not verified on Windows or Linux; one macOS smoke test of the pipe with a temporary profile and `about:blank`)
