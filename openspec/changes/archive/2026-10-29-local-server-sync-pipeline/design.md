## Context

**Local API today.** `vite.config.ts` registers a Vite plugin whose `configureServer` hook mounts every local route on the dev server: `sync-usage`, `llm-config` (+ `/test`), `course-reports`, `revision-notes`, `chats` (SSE replies), `course-sync` (GET status, POST start, DELETE cancel), `sync-courses` (course discovery, POST/DELETE) and `course-candidates`. A shared guard refuses any request whose `Origin` is not exactly `http://<Host>` (`foreignOrigin`, `scripts/lib/local-origin.mjs`); each route also checks that the peer address is loopback; write methods require an exact same-origin `Origin` and `Content-Type: application/json` (`sync-courses` requires `Origin` on every method). There is no `Host` check of our own; Vite's `server.allowedHosts` default only protects the dev server. The API exists only while `vite` runs; `vite build` output has no API.

**Sync today** (after `course-contract-v2` PR 2, #262, which this change is designed against). `createCourseSyncRunner(projectDir)` keeps one in-memory `state`. `start(ids)` resolves the model settings, checks the selection against `.local/lms/courses.json`, writes the output JSON Schema, creates a `runId` and appends a `batch_start` line to `.local/lms/course-sync-usage.jsonl`. Per course, serially: three collectors run as detached child processes (`canvas-background.mjs`, `collect-ed-course.mjs`, `collect-handbook.mjs`) into `.local/lms/runs/<runId>/<courseId>/{canvas,ed,handbook}.json`; a failed collector is replaced by an `unavailable` placeholder. Each course's analysis then starts without waiting for the next course's collection: `buildAnalysisPrompt` → `analyseWithRepair` (model call, `validateAnalysis`, at most one repair call) → `settleCourse` (status, reason, `buildStoredDocument` with the newest valid earlier Desktop document for `legacyIds`) → the course file is written with `flag: 'wx'` to `~/Desktop/墨尔本大学 <term>/<CODE>/分数结构.json`, or `分数结构-<runId>.json` when that exists → a usage line. Cancel sets a flag, marks pending rows cancelled and kills child process groups; API model calls are aborted through `registerStop`. Nothing survives a restart. A model HTTP 429 or 5xx fails the course (`llm-providers.mjs` turns it into `exitCode: 1` and an error string); collectors have small internal waits but no backoff.

**Node.** The installed runtime is v24.19.0; CI uses `node-version: 24` (the newest 24.x). `scripts/*.mjs` already import `shared/*.ts` directly through Node's type stripping.

**Owner decisions.** #250 (database is `node:sqlite`), #223 (the v2 desktop prototype is the baseline), #241 (OpenSpec for large changes, TDD, fresh-context review), #245 (DeepSeek Flash for evaluation, five runs per course), #253 (Claude makes the remaining design choices during the task list). Choices made under #253 for this change are #340–#358.

## Goals / Non-Goals

**Goals:**
- The local API runs as its own process; Vite restarts no longer touch a running sync.
- A sync that stops for any reason (fault, cancel, crash, restart) can continue without collecting again or paying again for finished analyses.
- Re-running any part of a sync never produces a second course file, a duplicate log line or a different result.
- Temporary throttling or server errors from any platform are retried within fixed bounds instead of failing the course.
- Every stage boundary has a test that crashes there and proves the resumed result equals an uninterrupted run.
- The saving is measured and reported honestly.

**Non-Goals:**
- Serving the built page from the server (§4).
- Moving corrections, chats, revision notes, model settings or the usage log into SQLite.
- Collecting in parallel (the Edge browser still does one thing at a time).
- Reusing analyses across separate user-started syncs (§7).
- Changing the course document contract, the prompt or validation rules.

## Decisions

### 1. `node:sqlite` in Node 24 (decision #340)

Checked on 2026-10-30:

- `process.version` is `v24.19.0`; `node -e "require('node:sqlite')"` exits 0 and prints no warning (also with a `process.on('warning')` listener); the bundled SQLite is 3.53.3; exports are `DatabaseSync`, `StatementSync`, `Session`, `constants`, `backup`.
- The Node 24 documentation (`nodejs.org/docs/latest-v24.x/api/sqlite.html`, page for v24.22.2) marks the module **Stability: 1.2 – Release candidate**. History: added in v22.5.0; no longer behind `--experimental-sqlite` in v22.13.0 / v23.4.0 ("but still experimental"); "SQLite is now a release candidate" in **v24.15.0**. It is not Stability 2 (Stable) in Node 24.
- Useful API facts: `new DatabaseSync(path, { timeout, enableForeignKeyConstraints (default true), defensive (default true since v24.14.0), readOnly })`; named parameters (`$x`, `:x`, `@x`); `database.isTransaction`; no transaction helper (use `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`); `backup()` for online copies.

Consequences: `package.json` `engines.node` becomes `>=24.15.0` (CI already runs a newer 24.x). All SQL and every `node:sqlite` call live in one module, `scripts/lib/sync-store.mjs`, so an API change before the module reaches Stable is a one-file fix; tests run the store against a real database file in a temporary directory. Type stripping, used by `server/`, is Stability 2 (Stable) since v24.12.0 and has emitted no warning since v24.3.0.

### 2. Server layout and runtime (decision #341)

- `server/` holds TypeScript modules run directly by Node (type stripping; erasable syntax only, `.ts` extensions in imports, `import type` for types). `web/tsconfig.json` adds `../server` to `include` and sets `allowImportingTsExtensions` and `erasableSyntaxOnly`, so `npm run check` type-checks the routes as it does today in `vite.config.ts`. Sync logic stays in `scripts/lib/*.mjs` with `.d.mts`, like the other libraries.
- `server/app.ts` exports `createLocalApi(options)` returning a Node `(req, res)` handler plus `close()`; it owns the guard (§3), the route table and the sync service. `options` = `{ projectDir, desktopDir, token, webPort, apiPort, store?, pipelineDeps? }`, so tests can run it on an ephemeral port with a temporary project directory and fakes.
- `server/routes/<name>.ts`, one per existing route, moved with their behaviour unchanged (paths, methods, status codes, bodies, error codes, body limits, SSE events). `server/main.ts` parses the environment, takes the single-instance lock (§5), opens the store, marks interrupted jobs (§8), listens, prints one line `StudyOrbit local API listening on http://127.0.0.1:<port>` and handles `SIGINT`/`SIGTERM` (§8).
- Bind address `127.0.0.1` only. Port: `STUDYORBIT_API_PORT`, default **5190**. 5180 was the suggested default, but on the owner's machine a second Vite dev server of another checkout already listens there; 5190 is free. The server never falls back to another port: `EADDRINUSE` exits with a message naming the variable.
- `npm run server` = `node server/main.ts`.

### 3. Access checks (decision #342)

The server is no longer the page's origin, so the checks are tightened. A request is served only when all of these hold, in this order (each failure is `403` with an empty body, as today):

1. The peer address is loopback (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`), checked once for every route instead of per route. Proxied requests always arrive from the Vite process on `127.0.0.1`, so this check no longer covers the browser; the proxy enforces it for the browser instead (§4).
2. **Token.** Header `x-studyorbit-token` equals the per-launch token (constant-time comparison, `crypto.timingSafeEqual` on equal-length buffers).
3. **Host allowlist.** `Host` is `localhost`, `127.0.0.1` or `[::1]` with the web port. Through the proxy (`changeOrigin: false`) the forwarded `Host` is the page's host, so the existing comparison of `Origin` with `http://<Host>` keeps working; any other host name (DNS rebinding: `evil.example:5173`) or port is refused.
4. **Origin.** The existing `foreignOrigin` rule: an `Origin`, when present, must equal `http://<Host>`.
5. Per route, unchanged: write methods need an exact `Origin` and `Content-Type: application/json`; `sync-courses` needs `Origin` on every method.

The token is 32 random bytes (hex) created by the launcher (§4) and given to both processes in the environment variable `STUDYORBIT_API_TOKEN`. It is never written to disk, logged, put in a response or sent to the browser: the Vite proxy sets the header on the server side and overwrites any value the browser sent. The name deliberately lacks the `VITE_` prefix, so Vite never exposes it to client code. `server/main.ts` refuses to start without a token of at least 32 hex characters. A direct request to the API port from a browser therefore fails even if the `Origin`/`Host` logic had a bug; curl users can pass the header themselves.

Alternatives: token only (relies on the proxy for everything) or `Host`/`Origin` only (no defence in depth for an API that returns grades, chats and model settings). Both checks together cost a few lines.

### 4. Proxy, launcher and production build (decisions #341, #343)

- `server/proxy.ts` exports `localApiProxy({ apiPort, token })` returning the Vite `server.proxy` entry for `/api/local`: target `http://127.0.0.1:<apiPort>`, `changeOrigin: false`, `ws: false`, `headers: { 'x-studyorbit-token': token }`, and a `bypass` hook that answers `403` itself, before anything is forwarded, when the browser's client address (`req.socket.remoteAddress`) is not loopback. Without that hook, `vite --host` would let a LAN client send `Host: localhost:5173` and be proxied with the token (decision #358). SSE responses stream through unbuffered; when the browser closes a chat request, the proxy closes the upstream request and the server's existing `res.on('close')` abort fires.
- `vite.config.ts` keeps the React plugin, `root: 'web'`, `server: { cors: false, host: 'localhost', port: <STUDYORBIT_WEB_PORT or 5173>, strictPort: true, proxy }`, `preview: { proxy: {} }` and the build options, and nothing else. `host` is pinned to `localhost` (Vite's loopback-only default, so the page origin `http://localhost:5173` and the owner's browser data are unchanged); the proxy's client-address check above still refuses LAN clients if someone overrides it with `--host`. In `serve` mode (not preview) without `STUDYORBIT_API_TOKEN` it throws 「请用 npm run dev 启动（需要本地接口服务）」, and the proxy entry is built only when the token is defined, so no request ever carries an undefined token header. `vite build` and `vite preview` do not need the token; preview has an explicitly empty proxy (Vite would otherwise inherit `server.proxy`), so its `/api/local` requests get `404` like the static build (decision #357).
- `scripts/dev.mjs` (`npm run dev`): creates the token, spawns `node server/main.ts` with stdout **piped** (each line is echoed to the launcher's stdout as it arrives, so the launcher can see the listening line; an inherited stdout could not be read) and stderr inherited, then Vite (`node node_modules/vite/bin/vite.js`) with inherited stdio, both with the token and both ports in their environment; it starts Vite only after the server's listening line appeared (and exits instead if the server exits first or prints no listening line within 15 s), forwards `SIGINT`/`SIGTERM` to both, stops the other process when one exits, and exits with the first non-zero code. `npm run dev:web` = `vite` (fails fast without a token, by design). No file watching: restarting the server mid-sync would interrupt it.
- **Production serving is out of scope (#343).** The owner runs `npm run dev`; serving `dist/` would add static-file handling (path traversal, MIME types, caching) and a second origin rule set for no current use. The allowlist takes the page port as a parameter, so a later change can add it.

### 5. Store (decision #344)

**File.** `.local/studyorbit.db`. `.local/` is created `0700`; the database file is created `0600` before SQLite opens it (`open(path, 'a', 0o600)` then `chmod 0600`, which also repairs a looser existing file); SQLite gives the `-wal` and `-shm` files the database file's permissions. Opened with `{ timeout: 5000 }`, then `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`; foreign keys are on by default. Only the server process opens it.

**Single instance.** `server/main.ts` creates `.local/server.lock` with `flag: 'wx'` holding its PID. An existing lock whose PID is alive (`process.kill(pid, 0)` succeeds) stops startup with 「另一个 StudyOrbit 本地服务正在运行」; a stale lock is replaced. This prevents a second server from marking the first one's running job as interrupted. The lock is removed on exit.

**Schema (migration 1).**

| Table | Columns (main) | Purpose |
| --- | --- | --- |
| `jobs` | `id` TEXT PK (the run ID, UUID), `kind` (`'course-sync'`), `status` (`running`, `finished`, `failed`, `cancelled`, `interrupted`), `provider`, `model`, `resumed_from` → `jobs.id` (unique; plain foreign key), `created_at`, `started_at`, `finished_at`, `error` | One row per sync. |
| `job_courses` | (`job_id`, `course_id`) PK, `position`, `previous` (artifact hash of the captured earlier document, or null), `code`, `term`, `status` (`pending`, `running`, `completed`, `partial`, `failed`, `cancelled`, `interrupted`), `phase`, `reason`, `file`, `stopped_stage` (stage that failed, or null), `reused` (0/1) | Per-course state and outcome; the `GET` status is built from it. |
| `stages` | (`job_id`, `course_id`, `stage`) PK, `stage` ∈ `collect`/`analyse`/`validate`/`merge`, `input_hash`, `status` (`running`, `succeeded`, `failed`, `cancelled`, `interrupted`), `checkpoint` (JSON), `output_hash` → `artifacts.hash`, `reused_from` (job ID or null), `attempts`, `usage` (JSON), `started_at`, `finished_at`, `duration_ms`, `error_code`, `error` | Checkpoints. Index on (`course_id`, `stage`, `input_hash`) where `status = 'succeeded'`. |
| `artifacts` | `hash` TEXT PK (sha256 of `content`), `content` TEXT, `created_at` | Content-addressed stage outputs (analysis attempts, validated results); inserted with `INSERT OR IGNORE`. |
| `course_snapshots` | `id` PK, `job_id`, `course_id`, `content_hash`, `version`, `document` TEXT, `status`, `reason`, `file`, `created_at`; unique (`job_id`, `course_id`) | The stored document written for a course in a job, with its hash. |

Collected platform data stays in files under `.local/lms/runs/<runId>/<courseId>/` (the evaluation harness reads them); checkpoints reference them by path and sha256. The Desktop course files remain the user-facing output, and `loadCourseReports`, the chat and the corrections store keep reading the Desktop; snapshots are an audit copy and the merge stage's idempotency record. The usage log `.local/lms/course-sync-usage.jsonl` keeps its lines (§12) because the status panel reads it.

**Migrations.** An ordered list of SQL steps in `sync-store.mjs`; `PRAGMA user_version` is the number applied. Each step and its `PRAGMA user_version = n` run inside one `BEGIN IMMEDIATE … COMMIT`, so a crash leaves the old version. Before migrating a database whose `user_version` is at least 1, the store copies it with `backup()` to `.local/studyorbit.db.v<old>.bak` (0600, replacing an older copy of that name). A `user_version` higher than the code knows, a file that is not a database (`SQLITE_NOTADB`), or a failed migration makes the store **unavailable**: sync routes answer `503 { error: 'SYNC_STORE_UNAVAILABLE' }`, every other route works, and the file is never deleted, truncated or overwritten.

**Retention** (decision #356). On startup the store prunes **whole lineages** (a root job and its chain of resumed children), never a single job: it keeps the 50 lineages with the newest jobs and deletes the others, all jobs of a lineage in one `DELETE` statement (foreign keys are checked at the end of the statement, so a parent and its child go together; deleting a parent whose child is kept fails with `FOREIGN KEY constraint failed`, reproduced on v24.19.0), with their course, stage and snapshot rows (`ON DELETE CASCADE`), then artifacts no remaining row references. A lineage containing a running job is never pruned. Run directories are not deleted (unchanged behaviour).

### 6. Stages and checkpoints (decision #345)

Each course of a job runs four stages. A stage's **input hash** is sha256 over a canonical JSON of its inputs; its **checkpoint** is the `stages` row. The hash constants `COLLECT_VERSION`, `ANALYSE_VERSION`, `VALIDATE_VERSION`, `MERGE_VERSION` are bumped whenever a stage's code changes meaning.

| Stage | Inputs (hashed) | Work | Output and checkpoint |
| --- | --- | --- | --- |
| **collect** | course ID, subject code, term, `COLLECT_VERSION` | The three collectors, serially, as today (same arguments, same `unavailable` placeholders on failure, same 120 s limit). | Files in the job's run directory. The checkpoint is updated after **each source**: `{ sources: { canvas \| ed \| handbook: { file, sha256, exitCode } } }`. Collection flags (`canvasFailed`, `edPartial`, …) are derived from it. |
| **analyse** | the prompt text (it embeds the collected data and the output schema), provider, model, base URL (never the key), `ANALYSE_VERSION` | `analyseWithRepair` with the model caller wrapped by the model limiter (§9). | Artifact `{ attempts: [{ exitCode, raw, issues, usage, httpStatus }], final: { exitCode, lastMessage, error, threadId }, usage }`; checkpoint `{ artifact }`, `usage` = combined usage (plus Codex subagent usage as today). |
| **validate** | analyse artifact hash, the collected files' sha256, the course's captured earlier document hash (or `none`, see below), `VALIDATE_VERSION` | `validateAnalysis` on the final output, quote verification (when `course-contract-v2` PR 3 is merged), `settleCourse` with the collection flags and the captured earlier document. Writes the diagnostic files as today. Pure apart from those files. | Artifact `{ accepted, status, reason, document, diagnostic, previous }` (`previous` = the captured document's artifact hash); checkpoint `{ artifact }`. |
| **merge** | validate artifact hash, course folder path, `MERGE_VERSION` | Choose the output path, write the course file, insert the snapshot, append change-log lines (§13). | Checkpoint `{ plannedPath, contentHash, validateArtifact, changeLog: boolean }`, written before the file (see below). |

Rules:

- **The earlier document is captured once per course per lineage** (decision #354). When a course first starts in a lineage, before collect, the pipeline reads the newest valid earlier Desktop document of the course (as `newestCourseDocument` does today), stores it as an artifact (content and hash) and records the hash in `job_courses.previous` (`null` when there is none). A resumed job copies `previous` from its parent's course row and never reads the Desktop for it again. Validate (for `legacyIds`) and the change log (§13) use only this captured document. Otherwise, after a crash between the course file write and the merge commit, a resume would read the lineage's own new file as the "earlier" document, changing `legacyIds`, the validate and merge input hashes, and the change-log diff.
- **A stage fails only on errors**: an exception, a collector/model failure left after retries (§9), a timeout, an I/O error, cancellation or interruption. A model reply that is still invalid after the repair, or a model that returns `failed`, is a **succeeded** analyse/validate stage whose result is a `failed` course, exactly as today. Collector failures inside collect are not stage failures (they become placeholders, as today) unless the failure is temporary and retries ran out (§9), in which case the stage fails and the source is retried on resume.
- An analyse attempt whose final call ended with `exitCode ≠ 0` (after retries) fails the stage with the provider's error as the course reason (unchanged wording). The whole analyse stage is atomic: a failure during the repair call re-runs both calls on resume.
- **Merge is write-ahead** (decision #353). It first stores `{ plannedPath, contentHash, validateArtifact }` in the checkpoint (path chosen as today: `分数结构.json` if absent, else `分数结构-<runId>.json`) and commits, then writes with `flag: 'wx'`, then inserts the snapshot, appends the change log and commits `succeeded`. Before choosing a path, merge looks for **any** merge row of the lineage for this course, **whatever its status** (`running`, `failed`, `cancelled`, `interrupted` as well as `succeeded`), that has a `plannedPath`, newest first:
  - its file exists with the row's `contentHash` → that write happened: merge completes the bookkeeping from that row (snapshot, change log) without writing, and the course result is that row's document, even if the current validate output differs (the owner already has that file);
  - its file does not exist and the row has the same input hash → write to that `plannedPath`;
  - its file exists with different content → stage failed `MERGE_TARGET_CHANGED`, nothing overwritten.
  Only when no such row exists does merge choose a new path. Looking only at `succeeded` rows would miss the crash between the file write and the commit (that row is `interrupted`), see `分数结构.json` present and write a duplicate `分数结构-<newRunId>.json`. A validated result without a document (failed course) only records the outcome.
- The pipeline's *merge* stage is not the corrections three-way merge: corrections are still reconciled when the corrections store is read (#291), and the pipeline never touches them.
- Ordering is unchanged: collect runs course by course; each course's analyse → validate → merge starts as soon as its collect succeeds, limited by the model limiter.

### 7. Resume and idempotency (decision #346)

- **Resume creates a new job** with `resumed_from` set to the stopped job (at most one child per job; resuming a job that already has a child answers `409 ALREADY_RESUMED`). The new job has its own run ID, run directory, usage lines and output file name, so every finished job stays as it was.
- **Lineage.** The new job's lineage is itself plus its chain of `resumed_from` ancestors (at most 20). Checkpoints are looked up only within the lineage, by the idempotency key **(course ID, stage, input hash)** and `status = 'succeeded'`. A user-started sync has a lineage of one, so it never reuses anything: re-syncing exists to fetch fresh data, and the owner may re-sync precisely because the last analysis was wrong.
- **Reuse.** For each course in order:
  1. If merge succeeded in the lineage, the course is done: its status, reason and file are copied (`reused = 1`), nothing runs.
  2. Otherwise each stage computes its input hash and reuses a matching checkpoint when its outputs still verify (collected files exist with the recorded sha256; artifacts exist). A reused stage gets `reused_from` and costs no tokens. Collect also reuses verified sources one by one from a partially collected checkpoint.
  3. Anything else runs, writing into the new job's run directory.
  Because each hash covers the previous stage's output, a changed upstream result re-runs everything after it; changing the model between failure and resume re-runs analysis (and later stages) for courses not yet merged.
- **Resumable jobs**: status `failed`, `cancelled` or `interrupted`, no child, the lineage's **root** job created less than 24 hours ago, and at least one course not done. The age is taken from the root because a resume of a resume can reuse checkpoints (collected data) from any ancestor, and the root's are the oldest. Otherwise `409 RESUME_EXPIRED` (collected data would be stale; start a new sync). Courses no longer present as candidates in `.local/lms/courses.json` are reported `failed` with 「课程已不在课程列表中」.
- **Idempotent jobs.** At most one course-sync job runs (`409 SYNC_RUNNING`, unchanged); a resume while any job runs gets the same `409`. Re-executing a stage with the same inputs has the same effects: collectors write temp-file-and-rename; artifacts are content-addressed; merge is write-ahead (§6); change-log lines are not appended twice for a course within a lineage (§13); one usage line per course per job.

### 8. Cancellation, interruption and shutdown (decision #347)

- `DELETE /api/local/course-sync` keeps today's behaviour (pending and running courses become `cancelled`, every registered stop is called: child process groups get `SIGTERM` then `SIGKILL` after 5 s, model requests are aborted) and additionally aborts limiter waits immediately, marks running stages `cancelled` and the job `cancelled` once its tasks settle. Finished checkpoints are kept, so a cancelled job is resumable.
- **Startup.** Any job still `running` (the server died) becomes `interrupted`, with its running stages and pending/running courses `interrupted`. Child processes recorded by a dead server are not killed (their PIDs may have been reused); an orphaned collector can only write into the old job's run directory, which a resumed job never writes into and only reuses after verifying sha256.
- **Shutdown** (`SIGINT`/`SIGTERM`): stop as for cancel, but mark the job and its stages `interrupted`; wait up to 5 s for tasks to settle; close the database; remove the lock; exit.

### 9. Rate limiting and retry (decision #348)

`scripts/lib/rate-limit.mjs` exports `createLimiter({ concurrency, minIntervalMs, maxAttempts, baseDelayMs, maxDelayMs, maxTotalWaitMs, clock, random })` with `run(task, { signal })`. `task(attempt)` returns `{ ok: true, value }` or `{ ok: false, retryable, retryAfterMs?, error }`.

| Platform | Limiter | Retryable failures |
| --- | --- | --- |
| Canvas, Ed, Handbook | concurrency 1, at least 500 ms between starts; a shared browser mutex keeps Canvas and Handbook from overlapping | collector exit code **75** (`EX_TEMPFAIL`), which the collectors use for HTTP 429, HTTP 5xx and network errors on their final attempt |
| Model provider (one limiter per provider) | concurrency **4** (today unbounded), no interval | HTTP 429, HTTP 5xx, connection errors before a response; `analyse` results gain `httpStatus` and `retryAfterMs` (from `Retry-After`, seconds or HTTP date) |

Bounds for all: at most **3 attempts**; delay before attempt *n* (n ≥ 2) = `max(retryAfterMs, 2 s × 4^(n−2))`, capped at 30 s, ±20 % jitter; a `Retry-After` above 60 s is not waited for (the stage fails retryably); total waiting per stage at most 2 minutes. Not retried: other 4xx, timeouts (a model timeout has already consumed its budget), aborted requests, DeepSeek `status ≠ completed`, Codex CLI failures, invalid replies (those go through the existing repair loop). Usage of failed attempts is added to the stage's usage when the provider reported it. Cancellation rejects waiting tasks at once.

### 10. Testing and fault injection (decision #349)

`createSyncPipeline({ store, projectDir, desktopDir, runCollector, callModel, resolveModel, clock, limiters, hooks })` takes every side effect as a dependency. The server passes the real ones; tests pass fakes:

- **Fake collectors** write synthetic Canvas / Ed / Handbook fixtures (the synthetic course of `test/fixtures/synthetic-course/` and copies with other synthetic IDs) and can be scripted to exit 0, 1 or 75, or to hang until stopped.
- **Fake model** returns the fixture outputs by call number (as the evaluation harness does) with deterministic usage (`input` = prompt length ÷ 4 rounded up, `output` = reply length ÷ 4 rounded up, `cached` and `reasoning` 0), and can be scripted to return HTTP 429/500 or hang.
- **Hooks** `beforeStage(stage, courseId)`, `afterCheckpoint(stage, courseId)` and `afterMergeWrite(courseId)` may throw a `SimulatedCrash`. The pipeline treats it like a process death: it sets a `crashed` flag on the pipeline instance and calls every registered stop (fake collectors and the fake model abort); from then on every store write and every file write of that instance throws before doing anything, so courses whose analyse, validate or merge tasks are still in flight cannot write while the test re-opens the store and resumes; it then closes its database handle. `run()` resolves only after all of the instance's tasks have settled, so the test never resumes while an old task is alive. No catch-and-continue: the job stays `running` in the database until the test opens a new store instance, which marks it `interrupted` (§8). Hooks exist only as a constructor parameter; no route, environment variable or command-line flag can set them.

**One test per stage boundary**, each with four synthetic courses and an injected clock:

| Boundary | Crash point | After resume, besides equality |
| --- | --- | --- |
| collect → analyse | `afterCheckpoint('collect')` for course 2 | no collector call for course 1 or course 2 |
| analyse → validate | `afterCheckpoint('analyse')` for course 2 | no model call for course 1 or course 2 |
| validate → merge | `afterCheckpoint('validate')` for course 2 | no model or collector call for course 2 |
| merge → done | `afterMergeWrite` for course 2 (file written, checkpoint not committed) | exactly one course file for course 2, no duplicate change-log line |

"Equality" means: the Desktop files' bytes, the snapshot hashes, the course statuses and reasons, and the change-log lines (ignoring `runId` and `at`) are identical to those of an uninterrupted run with the same fakes; the total collector and model calls across the failed and resumed jobs equal those of the uninterrupted run. Further tests cover a stage failing inside its work, cancellation during a model call and during a backoff wait, `RESUME_EXPIRED`, `ALREADY_RESUMED`, a changed model between failure and resume, a collected file modified between failure and resume (re-collected), and `MERGE_TARGET_CHANGED`.

### 11. Measurement (decision #350)

> Changed in PR 4 (decision #435): no separate script and no simulated-latency run. The fault-injection test `test/sync-faults.test.ts` prints the per-boundary figures (fake-model tokens, call counts, wall time with zero latency), and the documentation relates them to the real 2026-10-28 per-stage figures as a labelled estimate. The rest of this section is the original plan.

`scripts/measure-sync-resume.mjs` runs the pipeline in-process with the fake collectors and fake model on four synthetic courses, without the HTTP server. For each boundary of §10 it runs: (a) an uninterrupted job; (b) a job crashed at that boundary, then a **resume**; (c) the same crash, then a **fresh full job** (restart from scratch). It reports, per boundary, the tokens (input, cached, output, reasoning) and wall-clock duration of the failed job, the resumed job and the fresh job, and the totals "failed + resume" and "failed + restart". It runs twice: with zero collector/model latency (the measured time is the pipeline's own overhead: hashing, SQLite writes, file checks) and with simulated latencies equal to the per-phase durations of the 2026-10-28 real run in `docs/sync-optimization.md` (stage 3 table). Results go to `.local/measure/<time>/` (0600) and a summary is copied by hand into a new section of `docs/sync-optimization.md`.

**Fake, not real.** The section states that every number comes from fake collectors and a fake model: token counts are the fake model's units, not provider tokens, and the second set of durations is simulated, not measured on the network. A real measurement is not run because #245 authorises DeepSeek spending for the evaluation only, and a real resume measurement also needs live collection through the owner's signed-in Edge and real course data, which cannot happen unattended. The fake numbers still show what fraction of model work and wall time a resume saves, because the fake model is called exactly when the real one would be. Whether to run a real measurement is an open question for the owner.

### 12. Job API and page (decision #351)

- `GET /api/local/course-sync`: unchanged shape `{ running, courses: [{ id, code, status, reason, phase?, file? }], error }`, now built from the newest job in the store (so it survives a restart), plus `jobId`, `resumedFrom`, `resumable` and per course `stage` (`collect` | `analyse` | `validate` | `merge`) and `reused`. `phase` keeps today's values. With no job: `{ running: false, courses: [], error: null, jobId: null, resumable: false }`.
- `POST /api/local/course-sync` and `DELETE /api/local/course-sync`: unchanged requests and responses.
- `GET /api/local/sync-jobs`: the newest 20 jobs `{ id, status, createdAt, finishedAt, resumedFrom, resumable, courses: [{ id, code, status }] }`.
- `POST /api/local/sync-jobs/<jobId>/resume` (JSON body `{}`; same write checks as other routes): `202` with the new job's status; `404 JOB_NOT_FOUND`; `409` `SYNC_RUNNING`, `NOT_RESUMABLE`, `ALREADY_RESUMED`, `RESUME_EXPIRED`; `400` for a model configuration problem (same codes as start).
- Usage log: one `batch_start` (with optional `resumedFrom`), one line per course with only this job's usage and an optional `reused` list of stages, one `batch_end`. The status panel ignores unknown fields.
- Page (`web/src/App.tsx`): both course status maps (sync dialog and the status panel's `statusNames`) gain `interrupted` → 「已中断」 / "Interrupted", shown with the problem marker like `failed` and `cancelled`; when the status says `resumable`, the sync dialog shows 「继续上次同步」 (resume) next to the usual start; the course list in the dialog marks reused courses 「沿用上次结果」.

### 13. Ordering with other changes (decision #352)

- PR 1 of this change can start now; it moves the routes on `main` at that time. Routes that `local-corrections-merge` (`/api/local/corrections`, `/api/local/course-changes`) or `chat-tools-mcp` (chat route changes) add later go into `server/routes/`; those changes' task lists name `vite.config.ts` and must be read as `server/routes/` once PR 1 is merged. If one of them merges first, PR 1 moves its routes too.
- The change-log append of `local-corrections-merge` PR 3 runs in the merge stage after the snapshot insert. It is skipped when the change log already has a line for the course ID with the `runId` of **any job in the lineage** (decision #355; a crash after the append but before the commit leaves the old job's `runId` in the log, and the resumed job has a new one), and the checkpoint records `changeLog: true`. The diff uses the captured earlier document (§6), not a fresh Desktop read; an append failure keeps that change's rule (status unchanged, 「变更记录写入失败。」 added to the reason).
- PR 3 here is built on the runner of `course-contract-v2` PR 2 (#262). Quote verification from that change's PR 3 belongs to the validate stage.
- The MCP server of `chat-tools-mcp` is a separate stdio process that reads Desktop files; it does not use this server or the database.

### PR split

1. Standalone server, guard, proxy, launcher, moved routes, tests (`test/local-server.test.ts`: guard matrix and every route through `createLocalApi`; `test/local-proxy.test.ts`: a Vite dev server created with `localApiProxy` forwards a request with the token, the forwarded `Host`, and an SSE stream). The runner is used unchanged.
2. SQLite store, migrations, permissions, lock, retention, tests; `engines` bump.
3. Staged pipeline with checkpoints, resume, idempotency, cancellation, limiters and retry; provider and collector changes; job API and resume button; fault-injection tests. `course-sync-runner.mjs` is removed once the server uses the pipeline.
4. Measurement script, `docs/sync-optimization.md` section, `docs/overview.md`, READMEs.

## Risks / Trade-offs

- [`node:sqlite` is a release candidate, not stable, in Node 24] → all calls in one module with real-file tests; `engines` pinned to the first release-candidate release; owner decision #250 accepted the built-in module.
- [Two processes instead of one] → one launcher command starts and stops both; a missing token fails fast with a clear message instead of a page with broken data.
- [The proxy changes SSE behaviour (buffering, abort)] → covered by `test/local-proxy.test.ts`; the server keeps the existing close handling.
- [A resumed job uses collected data up to 24 hours old] → the limit is checked against the lineage's root job on resume and the page labels reused courses; a fresh sync is always available.
- [Analyse is atomic, so a failure in the repair call repeats the first call on resume] → accepted; the repair call is rare and splitting would complicate the repair prompt's dependency on the first reply.
- [Model concurrency drops from unbounded to 4] → four courses is the usual selection; the limit is a constant that can be raised.
- [Orphaned child processes after a server crash] → they write only to the old run directory and time out on their own (collector limits of 15–60 s per call); reuse requires a matching sha256.
- [The database holds grades and model outputs] → `.local/` (0700), file 0600, git-ignored (`.local/` and `*.db`); tests use synthetic data.
- [Measurement uses fakes] → stated next to every number; real measurement left to the owner.

## Migration Plan

PR 1: `npm run dev` changes from `vite` to the launcher; nothing else changes for the owner (same URL and port 5173; browser data unaffected). PR 2 creates `.local/studyorbit.db` on first start; deleting it only loses job history and resumability. PR 3 starts writing jobs; existing run directories and Desktop files are untouched. Rollback: revert the PRs in reverse order; the database file can stay (it is ignored) or be deleted.

## Open Questions

- Run a real resume measurement with DeepSeek on replayed collected data (about two extra four-course analyses, roughly 90 000 input tokens)? Not authorised by #245; owner to decide (§11).
- Serve the built page from the server for daily use without Vite (§4, #343)?
- Move the usage log into the database and drop the directory-time recovery in `sync-usage`? Not needed for this change.
