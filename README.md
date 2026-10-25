# coursework

A local tool layer and web UI for University of Melbourne coursework. An agent (Codex, through its computer use
in the owner's own signed-in Microsoft Edge) reads Canvas and Ed pages; fixed code validates what it reads, stores
it in one model, reports changes, plans the week, keeps revision material and long-term memory, and limits what the
agent may do under graded autonomy (L0 read, L1 quizzes, L2 assignments and essays). Our code calls no model API
directly and holds no API key or Canvas token: it starts the owner's signed-in agent (Codex by default, or Claude
through the Agent SDK with `COURSEWORK_AGENT=claude`, #123) and talks to it through one command registry exposed
as CLI, MCP and HTTP.

Private, single-user, local-first: course data and the agent workspace stay in `.local/` and never enter git.

## Status

Version 1 is in owner acceptance on real data; see [the roadmap](note/product/roadmap.md) for milestone status and
what each one is waiting on. Implemented: the domain model and SQLite store; agent course reading with format,
sanity and completeness checks; the command registry with reads, cited writes and autonomy checks over CLI, HTTP
and MCP; week planning with estimates and actual time; revision records; long-term memory; metrics; and the web UI
(week view, course pages, agent chat, memory panel). Later: email as a source.

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

`npm run check` (type checks for the CLI and the web UI, then `vitest run`) is what CI and `.claude/check.sh` run.
After a build:

- `node dist/cli.js ui`: open the local owner frontend.
- `node dist/cli.js mcp`: stdio MCP server for the agent.
- `node dist/cli.js http`: local HTTP host.
- `node dist/cli.js <group> <command> --json`: generated protocol commands (for example `courses list`).

## Layout

| Path | What it holds |
| --- | --- |
| `src/domain/` | zod domain schemas, progress and grade projection |
| `src/store/` | repository interface, `node:sqlite` implementation, migrations (only place that opens SQLite) |
| `src/sync/` | course JSON contract, import and sync jobs |
| `src/protocol/` | command registry, contracts, reads, writes, autonomy, audit, CLI/HTTP/MCP transports |
| `src/agent/` | Codex and Claude adapters, conversations, and the agent's reading and workspace instructions |
| `src/planning/`, `src/revision/`, `src/memory/`, `src/metrics/` | week planning, revision records, long-term memory, metrics |
| `src/citations/` | exact citation validation |
| `web/` | React frontend served by `coursework ui` |
| `skills/` | agent skills for assessments and revision |
| `test/` | vitest suites; fixtures are synthetic only |
| `openspec/` | current specs and in-progress changes: proposal, design, spec deltas, tasks |
| `docs/engineering/` | engineering reference (below) |
| `note/` | Chinese planning notes: product, decisions, handoff, interview quizzes |
| `design/prototype/` | static UI prototype on synthetic data |

## Documents

| Document | Purpose |
| --- | --- |
| [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md) | Rules for agents and contributors |
| [docs/engineering/v1-technical-design.md](docs/engineering/v1-technical-design.md) | Standing v1 design: architecture, stack, autonomy, milestones |
| [docs/engineering/protocol.md](docs/engineering/protocol.md) | How the protocol seams fit together |
| [docs/engineering/canvas-student-session-spike.md](docs/engineering/canvas-student-session-spike.md) | Historical Canvas student-session spike (its Playwright harness was removed in C-3) |
| [docs/engineering/agent-guidelines.md](docs/engineering/agent-guidelines.md) | Detailed agent guidelines, read per task |
| [note/product/](note/product/) | Vision, roadmap (progress), backlog, Ed findings |
| [note/decisions.md](note/decisions.md) | Every decision with who made it and why |
| [note/handoff.md](note/handoff.md) | Current state for the next session |
