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
- Proportion (#156): TDD is for logic and business rules. Docs, comments, config, renames, copy and other small changes that add no behaviour skip TDD and need only the check command. Write one test per spec scenario or reproduced bug; do not duplicate existing coverage or test library behaviour.

**Pure interface work** (pages, styling; logic is NOT included):

```
design in chat -> build -> verify in a real browser -> screenshots
```

OpenSpec owns *what* we build and the current-truth specs. Do not write a second spec; the OpenSpec change is the spec.

## Agents and human gates

- Development speed comes first; agents run most of the work. One gate blocks and is always human: when Claude asks, the user picks between design options (architecture, tech selection, data model, anything an interviewer would ask "why" about) and states why. Never automate that choice; record the user's picks and reasons in `note/decisions.md`. Claude merges every PR, including design PRs (`openspec/changes/**`, design docs), after a fresh-context review says "ready to merge" and, for code PRs, CI passes, without user review or confirmation; doc-only PRs merge after review without waiting for CI (#156). After two review rounds, Claude fixes any remaining gaps and decides whether to merge itself, without handing over to the user. See decisions #40, #42, #48 and #240. Users do not write code in development; learning is asynchronous through dsh quizzes in `note/interview/` and never blocks development; quizzes are deferred until development is complete (#159).
- Record every user decision with its reason in the OpenSpec change or `note/decisions.md`.
- Hand off through files and GitHub (issue -> PR -> review), never through chat memory. Formats are in the guidelines, "Multi-agent collaboration".

## Git

- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for branches, commits, and pull requests.
- Implementing agents work on `<agent>/<topic>` branches (your agent's prefix, per [CONTRIBUTING.md](CONTRIBUTING.md)); Claude pushes and opens the pull request into `main` and merges per "Agents and human gates". Never push to `main`, force-push, or rewrite pushed history.

## Session continuity

- At the start of a session, read `note/handoff.md` if it exists, and check it against `git status` and `git log` before trusting it.
- Before ending a session, or when the user asks for a handoff, overwrite `note/handoff.md` (format in the guidelines, "Communication and documentation").
- Bounded delegation: give each subagent one issue-sized task with a self-contained prompt and have it report back; read only the report and the lines you need, never whole logs.
- Session hygiene: after each milestone, when the context window is getting heavy, or when the work moves to an unrelated task, the agent updates `note/handoff.md` (current state, next steps, open questions, conventions); Claude commits it on the current `<agent>/<topic>` branch (never on `main`). Then offer the user a fresh session whose opening prompt points to that file, and archive the old session once the user has started the new one. Tell the user in one line at most.

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

- **What this is:** StudyOrbit (repository `MortyYJT/studyorbit`, package `study-orbit`), a local-first University of Melbourne coursework prototype. It discovers Canvas courses through the owner's signed-in Edge, collects Canvas, Ed and Handbook data with scripts in `scripts/`, has a model analyse them into structured course JSON validated by `shared/course-data.ts`, and the web app (`web/src/`) shows grades (`shared/course-calculations.ts`), plans the week and runs syncs through a loopback-only local API in `vite.config.ts`.
- **Stack and commands:** Node 24, strict TypeScript, React 19, Vite 8, zod, vitest. Install `npm ci`, run `npm run dev` (Vite dev server; the local API exists only there), check `bash .claude/check.sh` (= `npm run check` = type check + tests, the same command CI runs). Tests live in `test/`.
- **Where data lives:** run data, collected raw material, model settings, chats and revision notes in `.local/` (git-ignored); course JSON in the owner's Desktop course folder (`~/Desktop/墨尔本大学 <year> S<n>/<code>/`), outside the repo; course selection, corrections, tasks and preferences in browser localStorage (keys keep the `coursework.` prefix); the background image in IndexedDB.
- **Domain red lines:**
  - No self-issued Canvas tokens (forbidden by the university). A model never sees or types passwords; sign-in and MFA stay with the owner.
  - Real course data, grades, cookies, browser profiles and API keys never enter the repo, docs or test fixtures; tests use synthetic data.
  - Every extracted claim cites its source text. Resume or README numbers come only from real recorded metrics.
  - No code that completes or submits assessments in this public repository.
  - Code from unlicensed repos: ideas only, no copying. Copied Apache-2.0/MIT code keeps its notice and attribution.
- **Ask first before:** adding a dependency, a design choice not already recorded in `note/decisions.md` or an OpenSpec change, touching CI or deployment, deleting files, changing the course JSON contract in `shared/course-data.ts`, or any write action on Canvas or Ed.
