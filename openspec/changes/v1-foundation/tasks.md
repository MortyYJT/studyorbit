Issue mapping for dispatch: groups 1–2 are issue A (blocks the rest); groups 3, 4, and 5 are issues B, C, and D and run in parallel workspaces (standalone clones) once A is merged. Every task is TDD: the failing test comes first, built from the scenarios in `specs/`.

## 1. Project scaffold and checks (issue A)

- [ ] 1.1 Add `package.json` (type module, Node >= 24, bin `coursework` → `dist/cli.js`) and `tsconfig.json` (strict, NodeNext); install `typescript`, `vitest`, `zod`, `commander`, `@types/node`
- [ ] 1.2 Add `npm run check` = `tsc --noEmit && vitest run`; make `.claude/check.sh` run it
- [ ] 1.3 Add `.github/workflows/ci.yml` running `npm ci && npm run check` on Node 24 for pull requests and pushes to `main`
- [ ] 1.4 Add `src/cli.ts` with commander and a `--version` flag; test that it prints the package version

## 2. Domain model (issue A)

- [ ] 2.1 `src/domain/schemas.ts`: zod schemas for Module, Course, Assessment, SourceItem, Citation, Step, Task, Change, Run with inferred types; tests for each scenario in `specs/domain-model` that covers parsing and invariants
- [ ] 2.2 Course invariants: weights sum to 100 when `assessmentsComplete` (message names the course and the sum); at most one final
- [ ] 2.3 `src/domain/progress.ts`: module progress (non-recurring steps only, 0 when empty)
- [ ] 2.4 `src/domain/grade.ts`: `projectGrade()` per `specs/domain-model` "Grade projection", including hurdle floor, `unreachable`, `secured`, and the nothing-graded case — **TODO(human) (decision #34): implementer writes the tests and a stub that throws; the user writes the body**
- [ ] 2.5 Synthetic fixtures in `test/fixtures/` (fake course codes; no real course data)

## 3. Local store (issue B)

- [ ] 3.1 `src/store/repository.ts`: repository interface (save and load per entity, batch save, list changes since a sequence number, record run)
- [ ] 3.2 `src/store/sqlite.ts`: `node:sqlite` implementation with an in-memory option; batch saves in one transaction; zod parse on write and read
- [ ] 3.3 `src/store/migrations/`: migration runner on `PRAGMA user_version`; first migration creates all tables; refuse newer databases untouched
- [ ] 3.4 Data directory: `COURSEWORK_HOME` or `<package root>/.local`, holding `coursework.db`, `snapshots/`, `profiles/`; create if missing
- [ ] 3.6 Change `seq` assignment inside the write transaction; list changes since a `seq` in ascending order
- [ ] 3.5 Guard tests: no file outside `src/store/` imports `node:sqlite`; `git check-ignore` succeeds for `.local/coursework.db`

## 4. Agent envelope (issue C)

- [ ] 4.1 `src/protocol/errors.ts`: error code union, the const `retryable` table from the spec, `CourseworkError` class; `AUTH_EXPIRED` default `next` hint
- [ ] 4.2 `src/protocol/envelope.ts`: `ok()`, `fail()`, and `run()` (timing, `runId`, error mapping, `INTERNAL` with scrubbed message)
- [ ] 4.3 64 KiB bound: oversized data becomes `LIMIT_EXCEEDED` with a narrowing hint; tests for every scenario in `specs/agent-envelope`

## 5. Page capture (issue D)

- [ ] 5.1 Install `playwright`; `src/capture/lock.ts`: lock file `<data dir>/profiles/default.lock` created with `wx`, pid holder, stale-lock cleanup, throws `CourseworkError(LOCKED)`; `capture` exits with status 3 on a held lock; tests for both lock scenarios
- [ ] 5.2 `src/capture/snapshot.ts`: write `page.html`, `page.png`, `meta.json` under `<data dir>/snapshots/<host>/<timestamp>-<slug>/` (data directory from task 3.4, honouring `COURSEWORK_HOME`); strip query and fragment from the URL; unit-test the path and URL logic without a browser
- [ ] 5.3 `coursework capture`: persistent context on `<data dir>/profiles/default` with `channel: 'chrome'` (group 6 replaces this with detection), fallback to bundled Chromium only after asking; terminal commands `s` (save active tab) and `q` (quit); never touch form fields (also during the group 6 crawl)
- [ ] 5.4 Guard test: `git check-ignore` succeeds for `.local/snapshots/` and `.local/profiles/`
- [ ] 5.5 Manual run by the user (not automatable): sign in to Canvas and Ed, save assignment, announcement, grades, and Ed lesson pages for each course; note in the PR how long the session lasted and whether MFA was asked

## 6. Browser detection and Canvas crawl (issue E, decisions #43–#46)

- [ ] 6.1 Browser detection per the spec: Edge, then Chrome, then ask for bundled Chromium; `COURSEWORK_BROWSER` override (bad value exits 2); record the browser in `profiles/default/coursework-browser.json` and refuse a different one; injectable "is installed" check so tests need no real browser
- [ ] 6.2 `src/capture/crawl.ts`: pure planning functions per the spec's link rules and order (start condition, course / assignment / announcement links, same-origin filter, 300-load cap, signed-out detection), unit-tested on synthetic HTML fixtures with fake course ids
- [ ] 6.3 Crawl runner: hidden tab, `load` + `networkidle` with a 30 s timeout, GET loads only, ≥1 s between loads (injectable clock), failure rules, summary in `<data dir>/crawls/`; tested with a fake page object, no real browser
- [ ] 6.4 Capture session: command `c`, refuse a second `c`, `s` still works, `q` / close / signals abort after the current load; updated start message; tests for each scenario
- [ ] 6.5 Manual run by the user: `coursework capture`, sign in, open a Canvas course page, enter `c`; record saved, failed, and duration from the summary. Ed is not crawled; save Ed pages with `s` (feeds 5.5)
