## Why

StudyOrbit only works for one student at one university on one setup. The Canvas collector hard-codes `https://canvas.lms.unimelb.edu.au`; the Handbook, the subject-code pattern `[A-Z]{4}[1-9]\d{4}`, the "Semester 1/2" term parsing, the `墨尔本大学 <term>` Desktop folders, the `Australia/Melbourne` day and the 「墨尔本大学学生」 prompt text are spread through generic code (`course-list.mjs`, `course-sync-runner.mjs`, `collect-ed-course.mjs`, `course-reports.mjs`, `course-analysis.mjs`, `course-validation.mjs`, `chat-context.mjs`, `chat-tools-prompt.mjs`, `shared/`, `web/`). The Canvas and Handbook collectors drive only Microsoft Edge on macOS through Apple Events, and the Ed adapter accepts only the `au` region. The task list asks for generalisation: Canvas becomes a generic adapter for any Canvas instance, the Handbook becomes a UniMelb-specific plugin, and Chrome and Windows are supported. The owner placed this last in P2 (#252); it builds on the staged sync of `local-server-sync-pipeline` (its collect stage and injectable collectors).

## What Changes

- **Course sources.** A `CourseSource` interface (discover courses, collect one course, declare the reference platforms it provides and how to link them) with two generic implementations: **Canvas** (any instance; base URL from settings; no UniMelb assumptions) and **Ed** (the `edstem` CLI; region follows the CLI: `au`, `us` or `eu`). The pipeline's collect stage runs the sources from a registry instead of three hard-coded collector scripts.
- **Institution plugins.** An `Institution` interface holding everything institution-specific: subject-code extraction (the course filter), term parsing and labels, Desktop folder naming, time zone, prompt and message wording, and an optional **framework source** (the official assessment framework). `unimelb` provides the Handbook framework source, the UniMelb code pattern, "Semester 1/2" terms and `墨尔本大学 <term>` folders, reproducing today's behaviour exactly. `generic` works with any Canvas: every course with a usable `course_code` is a candidate (owner-overridable pattern), no framework source, folders `StudyOrbit <term>/<code>`.
- **Browser bridges.** A narrow `BrowserBridge` interface (open an allowed URL in a background tab, report its state, read the page as same-origin JSON or as body text, close it) with `edge-applescript` and `chrome-applescript` for macOS and an experimental `cdp` bridge (Chrome or Edge over the DevTools Protocol on a pipe, with a dedicated profile) for Windows and Linux. No bridge reads cookies, storage or tokens, or runs arbitrary JavaScript.
- **Settings.** `.local/config/sources.json` and `GET`/`PUT /api/local/source-settings` with a 「数据来源」 section in the settings page: institution, Canvas address, browser, Ed region, time zone (generic only), code pattern (generic only). A missing file means today's setup (UniMelb, Edge via Apple Events), so nothing changes for the owner until they choose.
- **Prompts parameterised.** The analysis prompt, validation reasons, chat prompts and the "today" date take their institution wording and time zone from the plugin. A test forbids UniMelb literals in generic modules; golden tests prove UniMelb prompts and outputs are byte-identical to today's.
- **Docs.** README and `docs/overview.md` describe supported setups and say plainly which are verified (macOS Edge) and which are not (macOS Chrome live run, Windows, Linux, non-UniMelb Canvas, Ed `us`/`eu`).
- Out of scope: grade bands (H1 … P stay UniMelb bands; percentage targets already work in the tools) and the `grade-target` spec; other LMSs (Moodle, Blackboard); Safari and Firefox; a browser extension (§ design 7); collecting in parallel; changing the course document contract (the `handbook` reference platform keeps its value and now means "the institution's framework source").

## Capabilities

### New Capabilities

- `course-source-adapters`: the `CourseSource` interface and registry, the generic Canvas and Ed sources, how the collect stage runs them, and the discovered course list.
- `institution-plugins`: the `Institution` interface, the `unimelb` and `generic` plugins, the framework source, parameterised prompts and folders, and the no-literal guard.
- `browser-bridge`: the `BrowserBridge` interface, its security limits, the AppleScript bridges for Edge and Chrome, and the experimental CDP bridge.
- `source-settings`: the settings file, route, page section and defaults.

### Modified Capabilities

- `course-analysis`: adds one requirement that Handbook references, parsing and wording come from the active institution's framework source; the existing Handbook requirements become the `unimelb` framework source's behaviour, unchanged.

## Impact

- New: `scripts/sources/` (registry, `canvas/`, `ed/`), `scripts/institutions/` (registry, `generic.mjs`, `unimelb/`), `scripts/browser/` (`bridge.mjs`, `applescript.mjs`, `cdp.mjs`, `cdp-launch.mjs`), `scripts/lib/source-settings.mjs`, `server/routes/source-settings.ts`, `scripts/browser-login.mjs`, `.d.mts` files and tests.
- Moved behind the interfaces: `scripts/canvas-background.mjs`, `scripts/collect-ed-course.mjs`, `scripts/edstem-scores.mjs`, `scripts/collect-handbook.mjs`, the subject filter of `scripts/lib/course-list.mjs`, Handbook parsing of `scripts/lib/course-refs.mjs`, the folder logic of `scripts/lib/course-reports.mjs`.
- Changed: the collect stage of `scripts/lib/sync-stages.mjs` (from `local-server-sync-pipeline` PR 3), `server/routes/sync-courses.ts`, `buildAnalysisPrompt`, `validateAnalysis`/`settleCourse` reasons, `chat-context.mjs`, `chat-tools-prompt.mjs`, `course-mcp.mjs`, the time-zone uses in `shared/corrections.ts`, `shared/course-tools.ts`, `web/src/LocalPlanning.tsx`, `server/routes/chats.ts`; settings page in `web/src/App.tsx`.
- Data: `.local/lms/courses.json` gains `canvasOrigin` and `institution`; `.local/browser/` (CDP only) holds a dedicated browser profile with its own sign-in cookies, owner-only and git-ignored. Course documents, corrections, chats and the database are unchanged.
- No new runtime dependency (the CDP bridge uses Node's child process pipes).
- Prerequisite: `local-server-sync-pipeline` PR 3 (staged pipeline) merged before PR 1 here.
