# Repository instructions

Applies to the whole repository. Higher-priority instructions and the user's explicit scope win over this file.
Keep this file short. Details live in [docs/engineering/agent-guidelines.md](docs/engineering/agent-guidelines.md) and are read on demand.

This file and its companions were installed from a template shared by several agents. **Where a name does
not fit the project or the agent reading it** — a branch prefix, a command, a path to an agent-specific
directory — adapt it and say what you changed. Adapt the form freely; do not drop a rule because it is
inconvenient.

## Always apply

- Check premises, logical gaps, and missing information before acting. Judge independently; separate facts, inferences, predictions, and preferences. Verify numbers, people, and outcomes. Never invent results.
- Never commit secrets, `.env` files, private contact details, the owner's real name, or identifying local paths. Identify the owner only by their public handle (see the user-level rules).
- Talk to the user in Chinese. Write source comments and engineering docs in English. Chinese planning notes go in `note/`.

## Workflow

Pick one track before writing anything, and say which one.

**Product / logic work** (data models, rules, backend, agents, tools, anything with a business rule):

```
OpenSpec change (what & why) -> plan -> TDD (red, then green) -> review -> verification -> archive the change
```

- Review: run it in a fresh-context subagent, or the equivalent review command your agent provides. Report only gaps that affect correctness or the stated requirements, not style.
- Verification: run the project check command and show its output as evidence. Do not claim "done" without it.

**Pure interface work** (pages, styling; logic is NOT included):

```
design in chat -> build -> verify in a real browser -> screenshots
```

Roles: OpenSpec owns *what* we build and the current-truth specs. Superpowers owns *how* we build it correctly (brainstorm, plan, TDD, review, verification). Do not write a second spec; the OpenSpec change is the spec.

## Agents and human gates

- **User** decides at key points (picks from proposed options and states why). **Claude Code** dispatches, commits per plan step, pushes, opens PRs, merges, and handles the few tasks that need judgment, including proposing design options and scheduling milestones with target dates. **Codex** is the first choice for implementation (one issue per standalone clone with TDD), documentation and spec edits, and PR reviews (fresh context, read-only sandbox); it does not commit (its sandbox keeps `.git/` read-only). **dsh** writes learning quizzes on merged work and may also implement.
- Development speed comes first; agents run most of the work. One gate blocks and is always human: when Claude asks, the user picks between design options (architecture, tech selection, data model, anything an interviewer would ask "why" about) and states why. Never automate that choice; record the user's picks and reasons in `note/decisions.md`. Claude merges every PR, including design PRs (`openspec/changes/**`, design docs), after a fresh-context review says "ready to merge" and CI passes, without user review or confirmation; until CI exists, doc-only PRs may merge after review and code PRs wait. After two review rounds, Claude fixes any remaining gaps and decides whether to merge itself, without handing over to the user. See decisions #40, #42, #48 and #49. Users do not write code in development; learning is asynchronous through dsh quizzes in `note/interview/` and never blocks development.
- Record every user decision with its reason in the OpenSpec change or `note/decisions.md`.
- Hand off through files and GitHub (issue -> PR -> review), never through chat memory. Formats are in the guidelines, "Multi-agent collaboration".

## Git

- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for branches, commits, and pull requests.
- Implementing agents work on `<agent>/<topic>` branches (your agent's prefix, per [CONTRIBUTING.md](CONTRIBUTING.md)); Claude pushes and opens the pull request into `main` and merges per "Agents and human gates". Never push to `main`, force-push, or rewrite pushed history.

## Session continuity

- At the start of a session, read `note/handoff.md` if it exists, and check it against `git status` and `git log` before trusting it.
- Before ending a session, or when the user asks for a handoff, overwrite `note/handoff.md` (format in the guidelines, "Communication and documentation").
- Session hygiene: after each milestone, when the context window is getting heavy, or when the work moves to an unrelated task, the agent updates `note/handoff.md` (current state, next steps, open questions, conventions); Claude commits it on the current `<agent>/<topic>` branch (never on `main`; Codex never commits, decision #40). Then offer the user a fresh session whose opening prompt points to that file, and archive the old session once the user has started the new one. Tell the user in one line at most.

## Read before the relevant task

Do not load the whole guidelines file for small edits. Read only the listed sections.

| Task | Sections in [agent guidelines](docs/engineering/agent-guidelines.md) |
| --- | --- |
| Resolving uncertainty, preparing factual content | Judgment and evidence |
| Importing content, assets, or profile data | Identity and privacy |
| Planning, implementing, or verifying a change | Scope and implementation; Verification and deployment |
| Git state, commits, pushes, pull requests | Git and changes; Identity and privacy |
| Deploying or releasing | Verification and deployment; Git and changes |
| Writing docs or reporting milestones | Communication and documentation |
| Dispatching, reviewing, or handing work between agents | Multi-agent collaboration; Git and changes |

## Project-specific (fill in per project)

- **What this is:** `coursework`, a local tool layer and web UI that syncs University of Melbourne coursework from Canvas and Ed into one model, reports changes, plans the week, prepares revision material, and lets an external agent assist with or complete assessments under graded, audited autonomy.
- **Stack and commands:** Node 24 + strict TypeScript, npm, vitest, zod, commander, Playwright, `node:sqlite`; full stack and pre-approved dependencies in [docs/engineering/v1-technical-design.md](docs/engineering/v1-technical-design.md) (the standing v1 reference; read it before any milestone work). install `npm ci`, build `npm run build`, check `bash .claude/check.sh` (= `npm run check`, the same command CI runs).
- **Domain red lines:**
  - Data access: no self-issued Canvas tokens (forbidden by the university). Use a logged-in Playwright profile or manual PDF upload (iCal dropped, #77). A model never sees or types passwords. The user may type their password into a masked, TTY-only `coursework login` prompt; deterministic code fills it into the university sign-in page on the managed profile, keeps it only in memory, and never logs, stores, or returns it. Without a TTY (agent calls), nothing prompts and the command returns `AUTH_EXPIRED`. MFA stays with the user.
  - Privacy: strip classmates' personal data before anything reaches a model. Exception (#112): the agent may read quiz and workshop pages unredacted, since they normally carry no classmates' data (if one does, such as peer answers, redact that part); discussion threads and anything else with classmates' data are redacted first. Browser profiles, API keys, and course data never enter the repo or test fixtures unredacted.
  - Autonomy (decision #120 overrides #56): L0 read (information, planning, revision) / L1 complete quizzes / L2 complete assignments and essays; higher levels include lower ones. Courses whose policy prohibits AI are locked at L0 (#124); courses with no recorded policy are not capped (#125); exams have no separate code check (#126). Each course has a default level with per-assessment overrides, set only by the user in the UI; agents have no command to change grants (#117, #122). Every agent browser write is audited; submission waits for the user's confirmation in the UI by default, switchable per course (#121). Code that answers or submits assessments is pushed only after the repository is private (#57).
  - Every extracted claim cites its source text. Resume or README numbers come only from real recorded metrics (sync time, steps, cost, estimate vs actual, extraction accuracy).
  - Code from unlicensed repos: ideas only, no copying. Copied Apache-2.0/MIT code keeps its notice and attribution.
- **Ask first before:** adding a dependency not pre-approved in the v1 technical design, a design choice that document does not cover, touching CI or deployment, deleting files, any write action on Canvas or Ed outside an L1/L2 grant (#120). Changing the data model or storage schema beyond what that document and the current OpenSpec change describe also needs the owner first.
