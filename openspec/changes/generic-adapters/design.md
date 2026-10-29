## Context

**Collectors today.** Three scripts run as detached child processes, one course at a time:

- `scripts/canvas-background.mjs <courseId|discover> <out>` refuses anything but macOS, drives **Microsoft Edge** through `osascript`: it opens a background tab at `https://canvas.lms.unimelb.edu.au/api/v1/...#coursework-<uuid>`, restores the previously active tab, polls `loading` and the URL prefix (redirect = signed out) every 250 ms for up to 20 s, then runs `execute t javascript` with a fixed expression that repeats the page's own URL as a synchronous same-origin `XMLHttpRequest` to get the body and the `Link` header, follows `rel="next"` only within the same origin and path (at most 100 pages), closes the tab and writes the JSON atomically (0600). Course URLs in `normalizeCourses` (`course-list.mjs`) are also built on the UniMelb host.
- `scripts/collect-handbook.mjs <CODE> <year> <out>` uses the same Edge AppleScript to read `document.body.innerText` of `https://handbook.unimelb.edu.au/<year>/subjects/<code>/assessment`.
- `scripts/collect-ed-course.mjs <CODE> <term> <out>` uses the `edstem` CLI: it parses year and "Semester 1/2" from the Canvas term, matches the Ed unit by code prefix, year and session, lists lessons, builds lesson URLs on `https://edstem.org/au/...`, fetches up to two introduction lessons' slides and calls `scripts/edstem-scores.mjs`, which requires `auth.region === 'au'` and calls `https://edstem.org/api/` with the CLI's own token.

No collector reads cookies; the browser sends its own session with same-origin requests. The macOS Automation permission and Edge's "Allow JavaScript from Apple Events" are required (README).

**UniMelb assumptions outside the collectors.** The subject-code pattern `^[A-Z]{4}[1-9]\d{4}` (`course-list.mjs` `subjectCode`, `course-sync-runner.mjs`, `course-reports.mjs`, both collectors); term labels `<year> S<n>` and folders `~/Desktop/墨尔本大学 <label>/<CODE>/` (`course-sync-runner.mjs`, `course-reports.mjs`); Handbook parsing and the Handbook-specific prompt rule 1 and rule 6 (`course-analysis.mjs`, `course-refs.mjs`, `course-quotes.mjs`); 「Handbook 数据未能读取」-style reasons (`course-validation.mjs`); 「你是一名墨尔本大学学生的学习助手」 and 「墨尔本时间」 (`chat-context.mjs`, `chat-tools-prompt.mjs`); `Australia/Melbourne` days (`shared/corrections.ts`, `shared/course-tools.ts`, `web/src/LocalPlanning.tsx`, `server/routes/chats.ts`, `scripts/lib/course-mcp.mjs`); grade bands H1 … P (`shared/course-calculations.ts`).

**Staged sync (`local-server-sync-pipeline`, PR 3 in progress).** `createSyncPipeline({ store, projectDir, desktopDir, runCollector, callModel, resolveModel, clock, limiters, hooks })` runs collect → analyse → validate → merge per course. Collect's inputs (hashed) are course ID, subject code, term and `COLLECT_VERSION`; it runs the three collectors serially with today's arguments, the 120 s limit and `unavailable` placeholders, and checkpoints after each source as `{ sources: { canvas | ed | handbook: { file, sha256, exitCode } } }`. Collectors exit **75** for temporary failures, which the per-platform limiter retries; a shared browser mutex keeps Canvas and Handbook from overlapping. This change is designed on that interface; it does not change the analyse, validate or merge stages beyond their wording inputs.

**Earlier decisions.** #219–#222 chose an MV3 browser extension talking to `127.0.0.1:47613` over WebSocket for the course list, for Windows and macOS; it was never built and the Apple Events collectors replaced it. #241 sets the workflow (OpenSpec, TDD, review). #250 `node:sqlite`. #252: generalisation comes last in P2. The owner is unavailable; the lead made the design choices below (decisions #440–#449, to be reviewed by MortyYJT).

## Goals / Non-Goals

**Goals:**
- Any Canvas instance and any institution can be used without editing code; UniMelb specifics live in one plugin directory.
- The owner's current setup (UniMelb, macOS Edge) behaves byte-for-byte as today, proven by tests, and stays the default.
- Chrome works on macOS with the same mechanism as Edge.
- Windows and Linux have a documented, tested-in-isolation path, honestly labelled experimental and unverified.
- No collector or bridge reads cookies, local storage or tokens of a browser, or runs arbitrary JavaScript.

**Non-Goals:**
- Grade bands per institution (H1 … P stay; the `grade-target` spec is unchanged; percentage targets already work in the chat tools).
- Other LMSs, Safari, Firefox, Chromium forks other than Chrome and Edge.
- A browser extension (§7), parallel collection, multi-profile support.
- Changing the course document contract, the model output schema or the validation rules.

## Decisions

### 1. `CourseSource` interface and registry (decision #440)

`scripts/sources/types.d.mts` declares:

```ts
type SourceId = 'canvas' | 'ed' | string;           // also the institution framework source id, e.g. 'handbook'
interface CourseSource {
  id: SourceId;
  label: string;                                      // shown in reasons and the page: 'Canvas', 'Ed', 'Handbook'
  usesBrowser: boolean;                               // joins the shared browser mutex
  limiter: string;                                    // per-platform limiter key of the pipeline
  platforms: RefPlatform[];                           // reference platforms it provides: canvas + canvas-group, ed, handbook
  discover?(ctx: SourceContext, out: string): CollectorCommand;            // Canvas only
  collect(course: CourseCandidate, ctx: SourceContext, out: string): CollectorCommand | null; // null = not applicable
  placeholder(reason: string): object;               // today's `unavailable` objects, unchanged
}
type CollectorCommand = { script: string; args: string[]; env: Record<string, string> };
```

- Collection stays **out of process**: each `collect` returns a command run by the pipeline's existing `runCollector` (process group, `SIGTERM` then `SIGKILL`, 120 s, exit code 75 for retryable failures). Only the command's construction moves into the source. This keeps cancellation and the fake collectors of the pipeline tests unchanged.
- Configuration reaches the child through one environment variable, `STUDYORBIT_SOURCE_CONFIG`: a JSON object `{ version: 1, institution, canvasOrigin, browser, browserPath, edRegion, profileDir }` validated with zod in the child. It holds no secret. Argument shapes stay as today (`<courseId> <out>`, `<CODE> <term> <out>`, `<CODE> <year> <out>`), so a collector can still be run by hand.
- `resolveSources(settings, institution)` returns the ordered list `[canvas, ed, ...institution.frameworkSource ? [framework] : []]`. The collect stage iterates this list instead of three named collectors; checkpoint keys are source ids, so UniMelb keeps `canvas`, `ed`, `handbook` and the run directory keeps `canvas.json`, `ed.json`, `handbook.json` (the evaluation harness reads these names).
- `createSyncPipeline` gains a `sources` dependency (default: resolved from settings by the server). Tests pass fake sources.
- Collection flags become per source: `{ [id]: { failed, partial, unpaginated } }`. `settleCourse` builds today's reason from them in today's order (Canvas, Ed, framework) with each source's `label`, so UniMelb reasons are unchanged.
- **Hash inputs.** PR 1 keeps collect's input hash exactly as specified by the pipeline (course ID, subject code, term, `COLLECT_VERSION`). PR 3 adds `institution`, `canvasOrigin`, `edRegion` and the source id list, and bumps `COLLECT_VERSION`; the browser is not hashed (it does not change the data). A resume across that upgrade simply re-collects (resumes are limited to 24 hours anyway).

### 2. Generic Canvas source (decision #442)

- `scripts/sources/canvas/collect.mjs` (moved from `canvas-background.mjs`, which stays as a two-line shim calling it so old commands keep working) takes the origin from the config. Every URL it opens is built from `canvasOrigin` + a fixed API path; the `rel="next"` check compares against `canvasOrigin` and the initial path, as today. It uses only documented Canvas REST endpoints (`/api/v1/courses?enrollment_state=active&include[]=term`, `assignment_groups`, `assignments?include[]=submission`), which are standard Canvas, not UniMelb.
- `canvasOrigin` validation: `https:` only, no user info, no path other than `/`, no query or fragment, host not an IP literal, normalised to `URL.origin`. A UniMelb `https://canvas.lms.unimelb.edu.au` is the `unimelb` default; `generic` has no default and refuses to sync until set (「请先在设置里填写 Canvas 地址」).
- `normalizeCourses(items, origin)` builds course URLs on the configured origin. Discovery writes `canvasOrigin` and `institution` into `.local/lms/courses.json`. Sync and the course reports refuse a course list whose `canvasOrigin` differs from the current setting (`409 COURSE_LIST_STALE`, 「Canvas 地址已更改，请重新获取课程」), because Canvas course IDs of two instances can collide and the Desktop documents, corrections and change log are keyed by course ID. A course list without `canvasOrigin` (written before this change) is treated as the UniMelb origin.
- **Subject filter.** `filterSubjects(courses, institution)` uses `institution.subjectCode(course_code)`; the course candidate keeps the field name `subjectCode` (the contract's `course.code`). Every place that tested `[A-Z]{4}[1-9]\d{4}` calls `institution.isSubjectCode(code)` instead.
- The Canvas-specific `while(1);` prefix handling and JSON checks of `parseCoursePage` are generic and stay.

### 3. Ed source (decision #443)

- `scripts/sources/ed/collect.mjs` and `scores.mjs` (moved from `collect-ed-course.mjs` and `edstem-scores.mjs`; shims stay). The unit match uses `institution.termKey(term)` → `{ year, session | null }` and `institution.edSessionMatches(unit.session, key)`; the code is regex-escaped before building the prefix match (today it is safe only because of the UniMelb pattern).
- **Region.** The `edstem` CLI (checked in the installed `edstem-cli`, 2026-10-30) supports `au`, `us`, `eu` with API bases `https://edstem.org/api/`, `https://us.edstem.org/api/`, `https://eu.edstem.org/api/`. The setting `edRegion` is `auto` (default: use the region `edstem auth status --json` reports) or one of the three; an explicit value that differs from the CLI's region makes Ed `unavailable` with 「Ed 登录区域与设置不一致」. The API base comes from a table that mirrors the CLI's. Lesson links use `https://edstem.org/<region>/courses/<unit>/lessons/<id>`; this pattern is verified for `au` only.
- `scores.mjs` keeps reading the `edstem` CLI's own token as today (it is the CLI's credential for the Ed API, not a browser cookie); this change does not widen that.

### 4. Institution plugins (decisions #441, #448)

`scripts/institutions/types.d.mts`:

```ts
interface Institution {
  id: 'unimelb' | 'generic';
  label: { zh: string; en: string };
  defaults: { canvasOrigin: string | null; timeZone: string | null };
  subjectCode(courseCode: string | null): string | null;      // the course filter
  isSubjectCode(code: string): boolean;
  termKey(term: string | null): { year: string | null; session: string | null };
  termLabel(term: string | null): string;                     // '2026 S2' for UniMelb
  courseFolder(course: { term: string | null; subjectCode: string }): string[]; // path segments under the Desktop
  edSessionMatches(session: unknown, key: { year: string | null; session: string | null }): boolean;
  wording: {
    assistantIntro: string;    // chat system prompt first line
    timeLabel: string;         // e.g. '墨尔本时间'
    sourcesRule: string;       // analysis prompt rule 1
  };
  framework: FrameworkSource | null;
}
interface FrameworkSource extends CourseSource {
  platform: 'handbook';                                // contract value, kept
  origins: string[];                                   // origins its bridge may open
  parseRows(text: string): FrameworkRow[];             // today's parseHandbookRows
  parseComponents(text: string): FrameworkComponent[]; // today's parseHandbookComponents
  promptRules: { refs: string; quote: string };        // the Handbook parts of rules 3 and 6
}
```

- **`unimelb`** (`scripts/institutions/unimelb/`) contains exactly today's code and strings: the `[A-Z]{4}[1-9]\d{4}` pattern, "Semester 1/2" parsing, `<year> S<n>` labels, `['墨尔本大学 <label>', CODE]` folders, `Australia/Melbourne`, the current prompt sentences, and the Handbook framework source (`collect-handbook.mjs` moved to `unimelb/handbook-collect.mjs`, its parsing moved from `course-refs.mjs` to `unimelb/handbook-parse.mjs`).
- **`generic`**: `subjectCode` returns the trimmed `course_code` when it matches the owner's optional pattern (`codePattern` setting, one capture group) or, without one, when it matches `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$`; `termKey` takes the first `20\d{2}` as year and no session (Ed then matches by code and year; several matches stay an error, as today); `termLabel` is the term name with unsafe characters removed (today's fallback); folders are `['StudyOrbit <label>', <code with characters outside [A-Za-z0-9 ._-] replaced by _>]`, never `.` or `..`; time zone from the setting (default: the system's `Intl` time zone at the time the setting is saved); wording is neutral (「你是一名大学生的学习助手」, 「本地时间」); no framework.
- **The contract keeps `handbook`.** The reference platform value `handbook` and the source platform `handbook` stay in `shared/course-data.ts`; they mean "the institution's framework source". A generic course never has one (no framework, so any `handbook` reference is invalid as "not collected", the existing rule). No contract version bump; old documents stay valid.
- **Wording.** `buildAnalysisPrompt({ ..., institution })` builds rules 1, 3 and 6 from `wording.sourcesRule` and `framework.promptRules`; without a framework, the Handbook clauses and `handbookComponents` are omitted. `validateAnalysis` and `settleCourse` take labels from the sources. Chat prompts, the MCP server's "today" and the chat route's "today" use `wording` and the institution's time zone. `shared/` functions that compute a day (`corrections.ts`, `course-tools.ts`) take a `timeZone` argument; the page gets it from the settings route.
- **Guard test.** `test/no-institution-literals.test.ts` reads every module outside `scripts/institutions/unimelb/`, the test fixtures and docs, and fails on `unimelb`, `UniMelb`, `墨尔本`, `Melbourne`, `Handbook` (case-sensitive; the lowercase contract value `handbook` is allowed) and `[A-Z]{4}[1-9]`. Allowed exceptions are listed in the test with a reason each (the institution registry's id `unimelb`; `shared/course-calculations.ts` grade bands, out of scope). The list of generic modules is the glob `{scripts,server,shared,web/src}/**/*.{mjs,ts,tsx,d.mts}`.
- **Golden tests.** Before PR 1 moves anything, tests capture, from the synthetic course fixture: the analysis prompt, the repair prompt, both chat system prompts, validation and settle reasons, the Desktop folder path and the discovery output. PR 1 and PR 3 must reproduce them byte-for-byte with the `unimelb` plugin.

### 5. `BrowserBridge` interface and security (decision #444)

`scripts/browser/bridge.mjs`:

```ts
interface BrowserBridge {
  id: 'edge-applescript' | 'chrome-applescript' | 'cdp-chrome' | 'cdp-edge';
  open(url: string, expectedPrefix: string): Promise<TabHandle>;  // background tab, previous tab restored
  state(tab: TabHandle, expectedPrefix: string): Promise<'loading' | 'ready' | 'redirect'>;
  read(tab: TabHandle, expectedPrefix: string, kind: 'same-origin-json' | 'body-text'): Promise<string>;
  close(tab: TabHandle): Promise<void>;
  dispose(): Promise<void>;
}
```

and `withPage(bridge, url, prefix, kind, { signal })`, which holds today's loop (20 s load limit, 250 ms poll, two read attempts 500 ms apart, close in `finally`, 「无法关闭…标签页，请手动关闭」 on failure).

- **Fixed expressions only.** `read` maps `kind` to one of two constant expressions: today's synchronous same-origin `XMLHttpRequest` returning `{ status, body, link }`, and `document.body ? document.body.innerText : ''`. No API accepts JavaScript text from a caller.
- **Origin allowlist.** `open` refuses any URL whose origin is not in the allowlist built from settings: `canvasOrigin` plus the framework source's `origins`. URLs carry a random `#coursework-<uuid>` fragment as today.
- **No credentials.** No bridge calls a cookie, storage, network-interception or download API; the CDP bridge enforces a method allowlist (§7). Redirect detection is by URL prefix, so a sign-in page is never read.
- The bridge is chosen by setting, built once per collector process and disposed at exit.

### 6. AppleScript bridges for Edge and Chrome on macOS (decision #445)

- One implementation, `scripts/browser/applescript.mjs`, with the application name taken from a fixed map `{ 'edge-applescript': 'Microsoft Edge', 'chrome-applescript': 'Google Chrome' }`; the name is never taken from settings text. The four scripts (create, status, read, close) are today's, with the app name substituted.
- **Same dictionary.** On 2026-10-30 `sdef` of the installed Google Chrome and Microsoft Edge showed the same scripting classes and codes: `window` (`id` text, `active tab`, `active tab index`), `tab` (`CrTb`; `id` text, `URL`, `loading`) and `execute … javascript` (`CrSuExJa`). Edge's suite is Chromium's, so the scripts should work unchanged in Chrome. **Not verified with a live run**: running them would open tabs in the owner's real browser.
- **Requirements for Chrome.** View → Developer → Allow JavaScript from Apple Events (off by default, a per-profile browser setting), and the macOS Automation permission for the terminal or Node to control "Google Chrome" (asked separately per target app). The collector's error message names the browser chosen in settings and the menu path.
- **Do not launch the browser.** From PR 2, both bridges first check `application "<name>" is running` and fail with 「请先打开 <浏览器> 并登录」 instead of letting `tell application` start it. This changes Edge behaviour slightly (today Edge is launched and then fails with `EDGE_WINDOW_MISSING`); it is intentional and noted in the PR.

### 7. Windows and Linux: CDP bridge, experimental (decision #446)

Options weighed:

| Option | Works on | Login | Security | Install | Chosen |
| --- | --- | --- | --- | --- | --- |
| A. CDP with `--remote-debugging-port` against the owner's everyday browser | — | — | Since Chrome 136 the switch is ignored for the default user data directory (Chrome for Developers, "Changes to remote debugging switches to improve security"); an open port also lets any local process control the browser and read every cookie | none | no |
| B. CDP with `--remote-debugging-pipe` on a **dedicated profile** launched by StudyOrbit | Windows, Linux (and macOS) | once, by the owner, in that profile | No listening port; only the launching process holds the pipe; the profile contains only the sessions the owner signs into there | none (uses the installed Chrome or Edge) | **yes** |
| C. MV3 extension over WebSocket (#219–#221) | Chrome and Edge on all OSs, everyday profile | none extra | Extension needs host permissions per Canvas origin (optional permissions requested at runtime for generic Canvas); the local WebSocket needs its own authentication | manual unpacked install or store publishing; cannot be automated (#220 relied on Codex computer use) | not now |

B is chosen for PR 4 because it needs no install, is plain Node (`child_process` with `stdio` fds 3/4, NUL-separated JSON, the same transport Playwright uses by default), and can be unit-tested with a fake pipe. C remains the better long-term user experience on the everyday profile and is recorded as a follow-up, not rejected; #219–#222 are not overturned by implementation, only left unbuilt.

Details of B:

- `scripts/browser/cdp-launch.mjs` finds the executable (setting `browserPath`, else known install paths: Windows `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LocalAppData%` for `Google\Chrome\Application\chrome.exe` and `Microsoft\Edge\Application\msedge.exe`; Linux `google-chrome`, `google-chrome-stable`, `microsoft-edge`, `chromium` on `PATH`) and starts it with `--remote-debugging-pipe --user-data-dir=<projectDir>/.local/browser/<cdp-chrome|cdp-edge> --no-first-run --no-default-browser-check about:blank`. The profile directory is created 0700 (on Windows, inside the project's ignored `.local/`).
- If a browser with that profile is already running, the new process hands over to it and exits; the bridge then fails with 「StudyOrbit 专用浏览器已在运行，请先关闭它」. One browser per collector process; it is closed (`Browser.close`, then kill after 5 s) on dispose, cancel or exit.
- **Method allowlist**: `Target.createTarget` (with `background: true`), `Target.attachToTarget` (`flatten: true`), `Target.getTargetInfo`, `Target.closeTarget`, `Runtime.evaluate` (only the two constant expressions of §5, `returnByValue: true`), `Browser.close`. Any other method throws before sending. Events other than target info and responses are ignored.
- **Sign-in.** `npm run browser:login` (`scripts/browser-login.mjs`) opens the dedicated profile without the debugging pipe at the Canvas origin (and the framework origins) so the owner signs in, including SSO and MFA. Collection never types credentials. A redirect during collection fails with 「请运行 npm run browser:login 登录后重试」.
- The bridge is **experimental**: the settings page marks it 「实验性，未在 Windows 上验证」; PR 4 has unit tests only (fake pipe, framing, allowlist, launch arguments, executable lookup with a fake file system, handover detection, cleanup). Nothing in this change runs it against a real browser on Windows or Linux.
- The `runCollector` process-group kill already has a Windows branch (`taskkill /t /f`), which also ends the browser it launched.

### 8. Settings (decision #447)

- File `.local/config/sources.json` (0600, directory 0700), zod-validated:
  `{ version: 1, institution: 'unimelb' | 'generic', canvasOrigin: string | null, browser: BridgeId, browserPath: string | null, edRegion: 'auto' | 'au' | 'us' | 'eu', timeZone: string | null, codePattern: string | null }`.
- **Missing file** = `{ institution: 'unimelb', canvasOrigin: <unimelb default>, browser: 'edge-applescript' on macOS, 'cdp-chrome' elsewhere, edRegion: 'auto', timeZone: null (plugin default), codePattern: null }`. The owner's setup therefore changes in nothing until a value is saved.
- Validation: `browser` must be available on the platform (`*-applescript` only on macOS); `timeZone` must be accepted by `Intl.DateTimeFormat`; `codePattern` at most 200 characters, compiles, exactly one capture group, tested only against `course_code` values capped at 100 characters; `browserPath` absolute, existing file, only for `cdp-*`; `codePattern` and `timeZone` only for `generic`.
- Route `server/routes/source-settings.ts`: `GET` returns the effective settings plus `{ platform, available: { browsers, institutions } }`; `PUT` validates, writes atomically and answers the effective settings; errors `400 INVALID_SOURCE_SETTINGS` with the field. Same guard as the other write routes; `409 SYNC_RUNNING` while a sync or discovery runs.
- The settings page gets a 「数据来源」 section next to the model settings; changing institution or Canvas address shows that the course list must be fetched again.
- The resolved settings are read once per sync and once per discovery and passed down; collectors never read the file themselves.

### 9. Order of work and verification (decision #449)

PR 1 interfaces and moves without behaviour change; PR 2 Chrome on macOS; PR 3 settings, generic institution, generic Canvas, wording and docs; PR 4 the CDP bridge. PR 1 starts after `local-server-sync-pipeline` PR 3 is merged, because it rewires that change's collect stage; if PR 3 there is delayed, PR 1 here waits rather than editing `course-sync-runner.mjs`, which that PR removes.

**Cannot be verified on the owner's macOS machine without touching real accounts or not at all:**

| Item | Why | What is done instead |
| --- | --- | --- |
| Chrome AppleScript live run | Would open tabs in the owner's signed-in browser and needs Chrome's Apple Events toggle and an Automation prompt | `sdef` comparison; unit tests of script generation; the owner runs one discovery after PR 2 |
| CDP bridge on Windows and Linux | No Windows or Linux machine; launching the owner's Chrome with a new profile is possible on macOS but proves nothing about Windows paths, handles or process kill | Unit tests with a fake pipe and fake file system; docs say unverified |
| Generic Canvas on another instance | No account at another institution | Synthetic API responses with another origin; origin and pagination checks tested |
| Ed `us` / `eu` | No account there; lesson URL pattern unconfirmed | Region table copied from the CLI; tests with synthetic CLI output |
| Generic folder names on Windows file systems | No Windows | Sanitisation unit tests (reserved characters, trailing dots, `CON`-style names) |

## Risks / Trade-offs

- [PR 1 is a large move; a subtle change could alter prompts or reasons] → golden tests are written first and must stay byte-identical; the analyse input hash covers the prompt, so any drift would also be visible as a cache miss in resume tests.
- [Course IDs collide between Canvas instances] → the course list records its origin; mismatches refuse to sync (§2).
- [A dedicated CDP profile stores session cookies on disk] → same exposure as any browser profile; it is under the ignored `.local/`, owner-only; `npm run browser:login` explains this; deleting `.local/browser/` signs out.
- [The pipe gives the parent full browser control] → method allowlist and constant expressions; the browser holds only sessions the owner created there.
- [Generic subject filter admits non-course Canvas entries (communities)] → the owner still picks courses; an optional pattern narrows the list.
- [Wording for other institutions is untested with real models] → prompts change only in institution-specific sentences; evaluation stays on UniMelb fixtures.
- [Time zone moves from a constant to a parameter in shared code] → defaults to the plugin's zone; UniMelb tests keep `Australia/Melbourne`.

## Migration Plan

No data migration. Old `courses.json` without `canvasOrigin` is read as UniMelb. Old run directories, documents, corrections and checkpoints stay valid. The shims keep the old script paths working for one release; they are removed in a later cleanup. Rollback: revert the PRs in reverse order; `.local/config/sources.json` and `.local/browser/` can be deleted.

## Open Questions

- Should the extension approach (option C) replace the CDP bridge once someone can test on Windows? Left to the owner.
- Grade bands per institution: a later change, touching `grade-target`, the course page and the chat tools.
