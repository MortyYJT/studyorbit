## Why

Every local API route lives inside a Vite plugin in `vite.config.ts` (about 300 lines of request handling). The course sync, which runs for minutes and spends model tokens, dies whenever the Vite dev server restarts (any edit to `vite.config.ts` or a module it imports restarts it), and its state exists only in memory: a crash, a closed terminal or one failed model call means the whole sync runs again from the first Canvas request, paying again for analyses that already succeeded. The runner is one long function that mixes collection, model calls, validation and saving, so none of these steps can be tested in isolation or resumed. Nothing limits request rates to Canvas, Ed, the Handbook or the model provider, and a single HTTP 429 or 5xx fails the course. The owner decided to use the built-in `node:sqlite` for local data (#250), and the task list asks for a standalone local server, sync jobs and course snapshots in SQLite, a four-stage pipeline with checkpoints, resume, idempotency, cancellation, per-platform rate limiting and retry, fault-injection tests at every stage boundary, and a measured comparison of resuming against restarting.

## What Changes

- **Standalone local server.** Every `/api/local/*` route moves from `vite.config.ts` into a Node server under `server/` (TypeScript run directly by Node 24 type stripping, no build step), bound to `127.0.0.1` on a fixed, configurable port (default 5190). Routes keep their paths, methods, status codes, bodies and error codes. The Vite dev server only proxies `/api/local` to it. `npm run dev` starts both through a small launcher script; no new dependency.
- **Access checks for a separate origin.** The server keeps the loopback, same-origin and write-method checks, and adds a `Host` allowlist (against DNS rebinding) and a per-launch random token that the Vite proxy adds to every request. The token is never sent to the browser.
- **SQLite store.** `.local/studyorbit.db` (owner-only file) holds sync jobs, per-course stage checkpoints, content-addressed stage outputs and a course snapshot (stored document plus content hash) per course per job. Schema migrations use `PRAGMA user_version`. The Desktop course JSON files stay the user-facing output and the readers keep reading them.
- **Four-stage sync.** Each course goes through collect → analyse → validate → merge. Each stage writes a checkpoint keyed by (course, stage, input hash). A failed, cancelled or interrupted job can be resumed: the resumed job skips every stage whose inputs are unchanged and whose outputs still verify, so collected data and paid model outputs are reused. Re-running any stage never writes a second course file or duplicate log lines.
- **Rate limiting and retry.** Per-platform limiters for Canvas, Ed, the Handbook and the model provider, with bounded retry and backoff on HTTP 429, 5xx and network errors; cancellation interrupts waits.
- **Resume in the page.** The sync dialog offers 「继续上次同步」 for a resumable job; new routes list recent jobs and resume one.
- **Fault-injection tests.** The pipeline takes injectable collectors, model caller, clock and hooks; one test per stage boundary crashes the job there and checks that resuming produces exactly the result of an uninterrupted run without repeating finished work.
- **Measurement.** The fault-injection test (originally planned as a separate script; decision #435) and a new section in `docs/sync-optimization.md` record tokens and duration of resume against restart-from-scratch for a failure at each boundary, labelled with how they were measured (fake collectors and a fake model; see design §11).
- `package.json` `engines.node` becomes `>=24.15.0`, the first Node 24 release in which `node:sqlite` is a release candidate.
- Out of scope: serving the built page from the server (`npm run build` output stays API-less, as today); moving corrections, chats, revision notes or model settings into SQLite; parallel collection; multi-device use; the MCP server of `chat-tools-mcp`.

## Capabilities

### New Capabilities

- `local-api-server`: the standalone loopback server, its access checks, the Vite proxy and the dev launcher.
- `sync-job-store`: the `node:sqlite` store for jobs, checkpoints, stage outputs and course snapshots, its file permissions, migrations and failure handling.
- `staged-course-sync`: the four-stage pipeline, checkpoints, resume, idempotency, cancellation, rate limiting and retry, the job API and the resume button.
- `sync-resume-measurement`: the resume-versus-restart measurement and how it is reported.

### Modified Capabilities

None. No current spec covers the local API or the sync runner (`openspec/specs/` has `grade-target`, `revision` and `weekly-plan`).

## Impact

- New: `server/main.ts`, `server/app.ts`, `server/guard.ts`, `server/routes/*.ts`, `server/proxy.ts`, `scripts/dev.mjs`, `scripts/lib/sync-store.mjs`, `scripts/lib/sync-pipeline.mjs`, `scripts/lib/sync-stages.mjs`, `scripts/lib/rate-limit.mjs` (each `.mjs` with `.d.mts`) (the planned `scripts/measure-sync-resume.mjs` was not built; decision #435).
- Changed: `vite.config.ts` (proxy only), `web/tsconfig.json` (includes `server/`, `allowImportingTsExtensions`, `erasableSyntaxOnly`), `package.json` (`dev`, `dev:web`, `server`, `engines`), `scripts/course-sync-runner.mjs` (becomes a thin adapter over the pipeline, then is removed), `scripts/lib/llm-providers.mjs` (`analyse` results carry `httpStatus` and `retryAfterMs`), the three collectors (exit code 75 for temporary failures), `web/src/App.tsx` (resume button), `docs/overview.md`, `docs/sync-optimization.md`, `scripts/README.md`, `README.md`.
- Tests (synthetic data only): `test/local-server.test.ts`, `test/local-proxy.test.ts`, `test/sync-store.test.ts`, `test/rate-limit.test.ts`, `test/sync-pipeline.test.ts`, `test/sync-faults.test.ts`.
- Interaction with open changes: `local-corrections-merge` adds `/api/local/corrections` and `/api/local/course-changes` and a change-log step after saving; `chat-tools-mcp` changes the chat route. Whichever lands after PR 1 of this change adds or edits those routes in `server/routes/` instead of `vite.config.ts`, and the change-log step runs inside the merge stage (design §13). This change is designed against the runner of `course-contract-v2` PR 2 (#262).
- No new runtime or dev dependencies. Data stays on the machine; the new database lives in git-ignored `.local/` (and `*.db` is already ignored).
