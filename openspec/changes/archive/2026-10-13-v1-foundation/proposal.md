## Why

Version 1 is built on three parallel tracks (sync core, agent protocol, UI), and they can only run in parallel once they share one data model, one storage layer, and one protocol envelope. Separately, the semester is in week 11: real Canvas and Ed pages must be captured locally now, before courses close, or the sync work will have nothing real to test against.

## What Changes

- Scaffold the TypeScript project on Node 24 (strict TypeScript, Vitest, zod, commander) with a single `coursework` CLI entry point.
- Make `.claude/check.sh` run lint-free typecheck and tests, and add a GitHub Actions workflow that runs the same command.
- Define the domain model as zod schemas: modules, courses, assessments (weight, score, hurdle floor), source items, tasks (steps, citations, recurrence), changes, and runs.
- Add a storage layer: a repository interface with a `node:sqlite` implementation, versioned migrations, and a database file under `.local/`.
- Define the agent protocol envelope (`coursework.agent/v1`), its error codes, and helpers, so CLI and MCP transports added later share one contract.
- Add `coursework capture`: a headed Playwright browser on a persistent local profile where the user signs in by hand and saves page snapshots to `.local/snapshots/`, guarded by a profile lock.

## Capabilities

### New Capabilities
- `domain-model`: the validated shapes of every stored entity and the invariants between them (weights, citations, recurrence).
- `local-store`: durable local storage behind a repository interface, with migrations and a fixed on-disk location outside version control.
- `agent-envelope`: the response envelope, error codes, and size bounds every agent-facing command returns.
- `page-capture`: manual, user-driven capture of logged-in Canvas and Ed pages into local snapshots, with a single-process profile lock.

### Modified Capabilities
- none

## Impact

- New dependencies (decision #35): `typescript`, `vitest`, `zod`, `commander`, `playwright`, `@types/node`. MCP SDK is deferred to `v1-protocol`.
- New directories: `src/`, `test/`, `.github/workflows/`; `.local/` stays git-ignored and holds the database, snapshots, and browser profile.
- `.claude/check.sh` stops being a no-op, so the Stop hook starts enforcing checks.
- No network calls except the user-driven capture browser; no model calls anywhere.
