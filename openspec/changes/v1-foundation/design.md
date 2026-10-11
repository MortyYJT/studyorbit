## Context

The repository has rules, hooks, an approved prototype (`design/prototype/index.html`), and decisions #1–#32 in `note/decisions.md`, but no code. Version 1 is split into milestones M0–M4 (`note/product/roadmap.md`) with a 10/15 target. This change is M0: it lays down what the three later tracks (sync core, agent protocol, UI) share, plus the snapshot tool that must run while courses are still open.

Constraints: Node 24 LTS and `node:sqlite` (decisions #17, #18); external agents do all reasoning and our code never calls a model (#13); agent writes pass a validation gate (#14); data stays in `.local/` (red lines in `AGENTS.md`); the repository is public, so fixtures are synthetic.

## Goals / Non-Goals

**Goals:**
- One set of zod schemas that every track imports, with TypeScript types inferred from them.
- A storage layer that later code cannot bypass, with migrations from day one.
- The `coursework.agent/v1` envelope and error codes, before any command exists.
- A capture tool the user can run today to save real Canvas and Ed pages locally.
- `check.sh` and CI that run the same command, so the Stop hook and the PR gate agree.

**Non-Goals:**
- Parsing snapshots, syncing, change detection, or redaction (M1, `v1-sync`).
- Any agent command, CLI subcommand other than `capture`, or MCP transport (M2, `v1-protocol`).
- UI, scheduling, Hermes, Notion (M3, M4).

## Decisions

### Layout
```
src/
  domain/      zod schemas, inferred types, pure functions (progress, grade projection)
  store/       repository interface, node:sqlite implementation, migrations  (only place that imports node:sqlite)
  protocol/    envelope builder, error codes, size bound
  capture/     headed Playwright capture and the profile lock
  cli.ts       commander entry point (`coursework`)
test/          mirrors src/; fixtures are synthetic
```
Alternative considered: a monorepo with packages per track. Rejected: three tracks in one package with clear folders is enough for one person and avoids workspace tooling.

### zod schemas are the single source of types
Types are `z.infer<typeof Schema>`, never hand-written interfaces. The protocol (M2) will reuse the same schemas for input validation, and the MCP transport can derive JSON Schema from them. Alternative: TypeScript interfaces plus a separate validator. Rejected: two definitions drift.

### Synchronous `node:sqlite` behind a small repository
`DatabaseSync` is synchronous, which keeps the repository simple and makes batch writes atomic with one `BEGIN … COMMIT`. Each entity has a table with typed columns for fields we query on and a `json` column for the rest, validated by zod on the way in and out. Alternative: an ORM (Drizzle, Prisma). Rejected for M0: a dependency and a code generator for seven tables; the repository interface keeps the door open (decision #20).

### Migrations as ordered TypeScript modules
`src/store/migrations/NNN-name.ts`, each exporting `up(db)`. The applied version lives in `PRAGMA user_version`. A database with a higher version than the code knows is refused untouched.

### Grade projection is a pure domain function
`projectGrade(course, assessments, band)` lives in `src/domain/grade.ts` with no I/O, so the UI, the protocol, and tests use the same logic. Assumption for ungraded non-final items: they score the current average (shown to the user in the UI). The hurdle floor is applied after the weighted need is computed.

### Envelope helpers return values, never throw across the boundary
`ok(command, data)` and `fail(command, code, message, next?)` build envelopes; a `run(command, fn)` wrapper times the call, assigns a `runId`, maps known errors to codes, maps anything else to `INTERNAL` with a scrubbed message, and enforces the 64 KiB bound. Error codes are a TypeScript union plus a const table holding each code's `retryable` value, so an unknown code fails the build.

### Capture: persistent context, terminal-driven saves
`chromium.launchPersistentContext('<data dir>/profiles/default', { headless: false, channel })` reuses an installed browser, detected rather than chosen (decision #45): Edge, then Chrome, overridable with `COURSEWORK_BROWSER`. The profile records which browser created it, and a different browser refuses to open it, because Chrome and Edge profile formats differ, which avoids downloading a browser; it falls back to Playwright's bundled Chromium only if neither Edge nor Chrome is installed, and only after asking. The terminal reads commands: `s` saves the active tab, `c` crawls Canvas (decision #43: same-origin GET page loads in a hidden tab, rules in `specs/page-capture`), `q` quits. The crawl summary goes to `<data dir>/crawls/`, outside `snapshots/`, so snapshot listings never see it. The tool never touches form fields. The lock is a file created with the `wx` flag holding the process id; a lock whose process no longer exists (`process.kill(pid, 0)` throws `ESRCH`) is removed.

### Checks
`npm run check` = `tsc --noEmit && vitest run`. `.claude/check.sh` calls it, and the GitHub Actions workflow runs `npm ci && npm run check` on Node 24. A linter is deferred: strict TypeScript catches most issues, and adding ESLint later is cheap.

## Risks / Trade-offs

- [`node:sqlite` is a release candidate (stability 1.2)] → All SQL stays in `src/store/`, enforced by a test, so swapping to `better-sqlite3` touches one folder.
- [Raw snapshots contain classmates' names and posts] → They stay in `.local/` (git-ignored, test-enforced); redaction runs when M1 parses them; nothing from them enters fixtures.
- [University SSO may change or require MFA on every login] → Capture is manual, so MFA is the user's own step; how long a session lasts will be measured during capture and recorded for M1.
- [Playwright with an installed channel (`msedge` or `chrome`) depends on the user's browser version] → Detection prefers Edge, then Chrome, then asks for bundled Chromium; the profile records which browser created it (decision #45).
- [Fast schedule, three tracks start right after this] → This change ships types and contracts first (tasks 1–3) so tracks can branch before capture is finished.

## Migration Plan

Not applicable: no existing data. Rollback is deleting `.local/coursework.db`.

## Open Questions

- Does the university session survive a browser restart on a persistent profile, and for how long? (Measured during capture; feeds M1.)
- Does Ed load lesson content through an API the page calls, which M1 could read from the same logged-in context instead of parsing HTML? (Observed during capture; no code depends on it yet.)
