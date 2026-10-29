## 1. Interfaces and moves, no behaviour change (PR 1; after local-server-sync-pipeline PR 3 is merged)

- [ ] 1.1 Golden tests first, from the synthetic course fixture and synthetic Canvas/Ed/Handbook responses: analysis prompt, repair prompt, both chat system prompts, validation and settle reasons for every collection-flag combination, Desktop folder paths, discovery output, collector argument lists of the collect stage
- [ ] 1.2 `scripts/sources/types.d.mts`, `scripts/institutions/types.d.mts`, `scripts/browser/bridge.mjs` (+ `.d.mts`) with `withPage`; tests of `withPage` with a fake bridge (load limit, polling, two read attempts, close in `finally`, redirect, abort)
- [ ] 1.3 Tests then `scripts/browser/applescript.mjs` for Edge only: generated scripts equal today's; read kinds map to the two constant expressions; origin allowlist refuses other origins before any `osascript` call
- [ ] 1.4 Move the Canvas collector to `scripts/sources/canvas/collect.mjs` on the bridge (shim at `scripts/canvas-background.mjs`); `normalizeCourses(items, origin)`; Canvas source object with discovery and collect commands; `STUDYORBIT_SOURCE_CONFIG` parsing with zod (fixed UniMelb values in this PR)
- [ ] 1.5 Move Ed to `scripts/sources/ed/collect.mjs` and `scores.mjs` (shims stay); Ed source object; term and session matching through the institution; code regex-escaped
- [ ] 1.6 `scripts/institutions/unimelb/`: subject code, term key and label, folders, time zone, wording, Handbook framework source (collector moved to `handbook-collect.mjs`, `parseHandbookRows`/`parseHandbookComponents` moved to `handbook-parse.mjs` and re-exported from `course-refs.mjs` for now)
- [ ] 1.7 `resolveSources`; the pipeline's collect stage iterates sources (checkpoint keys and file names unchanged, browser mutex from `usesBrowser`, limiter from `limiter`); per-source collection flags; `settleCourse` reasons from labels; collect input hash unchanged; `server/routes/sync-courses.ts` and course reports use the Canvas source and the institution; pipeline fault-injection tests still pass with fake sources
- [ ] 1.8 Golden tests from 1.1 pass unchanged; `bash .claude/check.sh`; fresh-context review; record the PR number here

## 2. Chrome on macOS (PR 2)

- [ ] 2.1 Tests then `chrome-applescript` in `applescript.mjs`: app name from the fixed map only; every script addresses the chosen app; the bridge is refused off macOS
- [ ] 2.2 Tests then the "is running" check for both AppleScript bridges and the not-open message; error text for disabled Apple Events JavaScript names the chosen browser and menu path
- [ ] 2.3 Temporary environment override `STUDYORBIT_BROWSER=chrome-applescript` until PR 3 adds settings (removed in PR 3)
- [ ] 2.4 README: Chrome on macOS setup (Apple Events toggle, Automation permission) marked 「未实测」 until the owner runs one discovery
- [ ] 2.5 `bash .claude/check.sh`; fresh-context review; record the PR number here; owner-run check of one Chrome discovery listed in `note/handoff.md`

## 3. Settings, generic institution and generic Canvas (PR 3)

- [ ] 3.1 Tests then `scripts/lib/source-settings.mjs` (+ `.d.mts`): defaults when missing, every validation rule, atomic 0600 write, platform availability
- [ ] 3.2 Tests then `server/routes/source-settings.ts`: `GET` shape, `PUT` validation errors, `409 SYNC_RUNNING`, access checks; remove the PR 2 environment override
- [ ] 3.3 Tests then `scripts/institutions/generic.mjs`: default and custom code pattern, term key, folder sanitisation (reserved names, trailing dots, `.`/`..`), time zone, neutral wording, no framework
- [ ] 3.4 Canvas origin from settings; discovery writes `canvasOrigin` and `institution`; `COURSE_LIST_STALE` in sync and course reports; old lists read as UniMelb; tests with synthetic responses from another origin, including a foreign `rel="next"`
- [ ] 3.5 Ed region `auto`/`au`/`us`/`eu` with the CLI region check; tests with synthetic `auth status` output
- [ ] 3.6 Wording: analysis prompt rules from the plugin and framework source, framework clauses omitted without one; chat prompts, MCP and chat "today" with the institution time zone; `timeZone` parameter in `shared/corrections.ts` and `shared/course-tools.ts`; page reads the time zone from the settings route; golden tests still pass for `unimelb`
- [ ] 3.7 Collect input hash adds institution, Canvas origin, Ed region and source ids; bump `COLLECT_VERSION`; resume test across a browser change reuses collected data
- [ ] 3.8 `test/no-institution-literals.test.ts` with its allowlist and reasons; rename remaining generic identifiers and comments (`handbookFailed` → per-source flags, Handbook comments in `course-refs.mjs`, `course-quotes.mjs`, `shared/course-data.ts`)
- [ ] 3.9 Settings page 「数据来源」 section; browser check on synthetic `.local` data without a real sync
- [ ] 3.10 README, `docs/overview.md`, `scripts/README.md`, `openspec/config.yaml` context: supported setups with verified/unverified labels
- [ ] 3.11 `bash .claude/check.sh`; fresh-context review; record the PR number here

## 4. CDP bridge for Windows and Linux, experimental (PR 4)

- [ ] 4.1 Tests then pipe transport: NUL-separated JSON framing, request IDs, responses out of order, closed pipe, timeouts
- [ ] 4.2 Tests then the method allowlist and constant expressions; `Network.*`, `Storage.*` and any other method throw before writing
- [ ] 4.3 Tests then `cdp-launch.mjs`: executable lookup with a fake file system (Windows and Linux paths, `browserPath`), launch arguments (pipe, dedicated `--user-data-dir`, never a port), profile directory 0700, handover detection, close then kill after 5 s
- [ ] 4.4 `cdp-chrome` and `cdp-edge` bridges behind `withPage`; redirect message pointing to `npm run browser:login`
- [ ] 4.5 `scripts/browser-login.mjs` and `npm run browser:login`; argument tests only
- [ ] 4.6 Docs: Windows/Linux setup marked experimental and not verified; settings page label
- [ ] 4.7 `bash .claude/check.sh`; fresh-context review; record the PR number here
