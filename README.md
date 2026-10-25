# coursework

A local-first coursework assistant for University of Melbourne students. An agent reads your Canvas and Ed
courses in your own signed-in browser; fixed code checks what it read, stores it, plans your week, keeps revision
material and memory, and limits what the agent may do for each assessment. Everything runs on your machine and is
used through a local web UI.

It is a single-user project for the owner's own courses: private data stays in `.local/` and never enters git.

## Why it works this way

The university forbids students from issuing their own Canvas API tokens, so there is no token-based sync. Instead,
Codex works through its computer use in the owner's Microsoft Edge, where the owner has already signed in: it
reads course pages, fills one structured course document, and hands it to `coursework`. Our code calls no model API
directly and holds no API key or Canvas token (#123); the agent never sees or types a password. Fixed code does what
must be the same every time: validation, storage, planning, views and guardrails.

## What it does

- **Course reading.** Codex lists your current courses, you pick which to follow, and it reads each one: grading
  components, weights, hurdles, due dates, status, scores and the course's AI policy. Due dates, weights, hurdles
  and policies carry the page quote and URL. Code checks format, common sense (dates in term, weights summing to
  100) and required fields, sends errors back for up to two retries, and marks what stays unread as unknown.
- **Week planning.** A seven-day view with each day's deadlines and planned work, scheduled deadline-first within
  the hours you say you have each day. Estimates, actual time, start times, manual tasks and overflow work are
  shown, and nothing is dropped silently. A month calendar shows deadlines.
- **Course pages.** A score ring by weight, each grading component with its earned share, the current average and
  the final-exam score you still need, with every value marked by origin (platform, agent or you).
- **Revision.** Cited exam scope, study notes, practice statistics, and "tutor me" / "wrong answers only" sessions.
- **Agent chat and memory.** A chat page that runs Codex with course context; long-term memory where code
  summarises facts (progress, mistakes, time) and the agent records observations you can view, edit and delete.
- **Graded autonomy.** L0 read (information, planning, revision), L1 complete quizzes, L2 complete assignments and
  essays (#120). Each course has a default level with per-assessment overrides, set only by you in the UI; courses
  whose policy prohibits AI are locked at L0 (#124). Codex's workspace rules make it stop before any final submit,
  so you press submit yourself (#173). These rules are instructions to Codex, not code-enforced on the screen (#168).
- **One command registry.** The same commands, validation and authorization are exposed as CLI, MCP (for the
  agent) and HTTP (for the web UI).

## Planned

- **Canvas check of exact numbers** (in design, #193–#194): after each course read, Codex opens two fixed Canvas
  `/api/v1` pages in Edge and passes the raw JSON to fixed code, which compares due dates, points, status, scores
  and assignment-group weights with what the agent read; mismatches go to "needs you" for you to decide.
- **Per-assessment AI policy** (in design, #195–#197): policy attaches to each assessment, with the course value as
  a default; a `prohibited` read at any level wins unless you set that assessment yourself.
- **Email as a source** (#99).
- **Second version:** read-only Notion integration (#71); fetch scripts that Codex repairs when validation fails;
  minimal-change re-planning and learning your own pace from estimate-versus-actual time; automatic sign-in that
  still keeps passwords away from the model, for example through a password manager (#179).
- **Third version:** separate planning, execution in a sandbox and three-level acceptance (executable checks,
  rubric coverage, your review) for completing larger assignments.

## Commands

```bash
npm ci
```

```bash
npm run build
```

```bash
node dist/cli.js ui
```

`npm run check` (type checks for the CLI and the web UI, then `vitest run`) is what CI and `.claude/check.sh` run.
Other entry points after a build:

- `node dist/cli.js mcp`: stdio MCP server for the agent.
- `node dist/cli.js http`: local HTTP host.
- `node dist/cli.js <group> <command> --json`: generated protocol commands (for example `courses list`).

To sync, unlock the screen, open Edge signed in to Canvas and Ed, run `node dist/cli.js ui` and press "Sync now".

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

## Progress

Full milestone table: [note/product/roadmap.md](note/product/roadmap.md).

| Stage | State |
| --- | --- |
| Foundation, domain model, SQLite store, command registry (M0, M2) | Done |
| First real assessment: an Ed workshop quiz completed with the agent (Q1) | Done |
| v1 delivery: data model, sync, annotations, planning, revision, agent chat, web UI, metrics (V-A to V-M) | Done |
| Codex rework: Codex chat, agent course reading, browser clean-up, long-term memory (C-1 to C-4) | Code done |
| Owner acceptance on real courses (#186) | In progress: four courses read and stored, week view working |
| Canvas check and per-assessment AI policy (C-5) | In design |
| Email source | Not started |

Known limits from the first real read:

- Course reading needs the screen unlocked and Edge open (#185), so it cannot run unattended overnight.
- Each course took three submissions before it was stored; some fields (one final-exam weight, three assignment
  statuses) were missed, which the planned Canvas check targets.
- Course-level AI policy was read as "allowed" where the restriction applies to specific assessments, which the
  planned per-assessment policy addresses.
