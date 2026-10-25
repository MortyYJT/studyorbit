# coursework

A local tool layer and (planned) web UI that syncs University of Melbourne coursework from Canvas and Ed into
one model, reports changes, plans the week, prepares revision material, and lets an external agent assist with
assessments under graded, audited autonomy (L0–L4). Our code never calls a model; reasoning lives in the external
agent (Hermes, Claude Code), which talks to `coursework` through one command registry exposed as CLI, MCP and HTTP.

Private, single-user, local-first: course data and the agent workspace stay in `.local/` and never enter git.

## Status

Version 1 is in progress; see [the roadmap](note/product/roadmap.md) for milestone status and what each one is
waiting on. Implemented today: agent course reading (Codex in the owner's Edge), the domain model and SQLite
store, Ed normalization, change detection, Q1 quiz read/propose/review, and the M2 protocol
(registry, reads, citations, authorization, CLI/HTTP/MCP transports). Production wiring of the protocol, the
Canvas adapter, PDF materials and the UI are not done yet.

## Commands

```bash
npm ci
```

```bash
npm run check
```

```bash
npm run build
```

`npm run check` (`tsc --noEmit && vitest run`) is what CI and `.claude/check.sh` run. After a build:

- `node dist/cli.js quiz …`: Q1 quiz assist commands.
- `node dist/cli.js mcp`: stdio MCP server.
- `node dist/cli.js <group> <command> --json`: generated protocol commands (for example `courses list`).

## Layout

| Path | What it holds |
| --- | --- |
| `src/domain/` | zod domain schemas, progress and grade projection |
| `src/store/` | repository interface, `node:sqlite` implementation, migrations (only place that opens SQLite) |
| `src/sync/` | normalization, field diff and change events |
| `src/protocol/` | command registry, contracts, reads, writes, authorization, CLI/HTTP/MCP transports |
| `src/citations/` | exact citation validation shared by protocol and quiz |
| `src/quiz/` | Q1 Ed quiz assist (read, propose, review, policy and grants) |
| `test/` | vitest suites; fixtures are synthetic only |
| `openspec/changes/` | one OpenSpec change per milestone: proposal, design, spec deltas, tasks |
| `docs/engineering/` | engineering reference (below) |
| `note/` | Chinese planning notes: product, decisions, handoff, interview quizzes |
| `design/prototype/` | static UI prototype on synthetic data |

## Documents

| Document | Purpose |
| --- | --- |
| [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md) | Rules for agents and contributors |
| [docs/engineering/v1-technical-design.md](docs/engineering/v1-technical-design.md) | Standing v1 design: architecture, stack, autonomy, milestones |
| [docs/engineering/protocol.md](docs/engineering/protocol.md) | How the implemented M2 protocol seams fit together |
| [docs/engineering/canvas-student-session-spike.md](docs/engineering/canvas-student-session-spike.md) | Canvas student-session spike and the pending live check |
| [docs/engineering/agent-guidelines.md](docs/engineering/agent-guidelines.md) | Detailed agent guidelines, read per task |
| [note/product/](note/product/) | Vision, roadmap (progress), backlog, Ed findings |
| [note/decisions.md](note/decisions.md) | Every decision with who made it and why |
| [note/handoff.md](note/handoff.md) | Current state for the next session |
