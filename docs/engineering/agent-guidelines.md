# Detailed agent guidelines

This document expands the root `AGENTS.md`. Read only the sections listed there for the task at hand; do not load unrelated sections for routine changes. If instructions conflict, follow higher-priority instructions and the user's explicit scope.

## Judgment and evidence

- Before acting, check for false premises, logical gaps, and missing information. Resolve what you can from reliable sources; ask only when the missing answer materially affects correctness, scope, or an irreversible choice. Continue independent work while waiting.
- Exercise independent judgment. Distinguish verified facts, inferences, predictions, and subjective preferences when the distinction matters. Do not agree merely to please the user.
- Verify material claims about numbers, people, and outcomes against primary sources where practical. Prefer current source code, tests, logs, and live pages over README claims, memory, or search snippets. State uncertainty and verification limits. Never invent metrics, credentials, experience, or results.
- If a user premise is wrong, say so directly and respectfully: give the evidence, the practical risk, and a better interpretation. Call out overlooked variables, costs, tradeoffs, and biases that could change the decision.

## Identity and privacy

- Identify the owner only by their public handle (`MortyYJT` / `谷鱼Y`). Do not put the owner's real name in repository files, UI, metadata, assets, filenames, sample data, docs, commit messages, or author/committer fields.
- Use a repository-local Git identity with the public handle and the verified GitHub noreply address. Check author/committer attribution before publishing. Do not change global Git settings, and do not rewrite pushed history to repair attribution.
- Before creating a repository with server-side commits (`gh repo create --add-readme`, web merges, web edits), confirm the GitHub account keeps its email private; otherwise those commits carry the account's primary email.
- Review imported resumes, screenshots, documents, and generated artifacts for identity leaks before committing them.
- Never commit secrets, `.env` files, API keys, tokens, private contact details (phone, personal email, address), or local filesystem paths that reveal who or where the owner is. Never print a token in output.
- Use public profile details only within the approved scope.

## Communication and documentation

- Talk to the user in Chinese. Keep this file, the README, engineering docs, source comments, and docstrings in English. Put Chinese planning and learning records in `note/`. Preserve intended Chinese UI copy.
- Record meaningful decisions in `note/decisions.md` and open questions in `note/handoff.md` as work progresses. Per-issue implementation and verification evidence belongs in the PR description, not in repository files; durable knowledge about how the code works goes into a module doc under `docs/engineering/`. Keep notes concise and free of private identity details.
- Delivery report, in this order: (1) 你要做什么 - the single action required from the user, or "nothing"; (2) 我完成了什么 - one line per item with its evidence; (3) 我遇到什么问题 - what went wrong and how it was resolved; (4) 还没完成什么 - what is unfinished or unverified.
- Open every section with a one-line summary. Lead with the user's action. One idea per line. Report code, tests, CI, local run, and deployment separately. Write "not run" or "not verified" plainly.
- Put reasoning, tradeoffs, and history in `note/`, not in the report.
- **Handoff.** `note/handoff.md` is a single file holding the current state for the next session or the next agent (for example after `/clear`, or when work moves between Claude and Codex). Overwrite it; never append, because history is in git. It states: date, commit and branch; the goal; the OpenSpec change id; what is done, each with evidence; what is in progress, including uncommitted or unpushed state; ordered next steps; decisions and why; open questions for the user; how to run and verify; traps. Keep it under about 60 lines. It must not contain secrets, private contact details, or identifying local paths. Treat it as a claim to verify against git, not as truth.

## Scope and implementation

- **Product layer.** `note/product/vision.md` says what we build and what we do not. `roadmap.md` orders the work. `backlog.md` holds raw ideas. A new idea goes into the backlog first; it becomes work only when promoted.
- **OpenSpec.** Behavior changes go through OpenSpec: current-truth specs live in `openspec/specs/`, each proposed change in `openspec/changes/<id>/` (proposal, spec deltas, tasks), and finished changes are archived. Install and use the official CLI (`@fission-ai/openspec`); follow the commands it generates for this tool rather than older tutorials. Do not write a parallel spec elsewhere.
- Follow the agreed design, spec, plan, and review stages. Respect explicit exceptions the user grants; do not infer new ones, and do not add approval gates for routine, reversible, already-authorized work.
- Keep the first version focused. Prefer small, reusable pieces. Add APIs, persistence, authentication, services, or dependencies only for a concrete requirement, and ask first before adding a dependency. Confirm dependency versions and APIs against current documentation.
- Types do not replace runtime validation of untrusted input.
- Keep read commands free of side effects: a read that clears or rewrites state lets any caller (another agent, a CLI run, a different query range) silently change the owner's data.
- The first full consumer of an API (usually the frontend) exposes missing reads and side-effecting reads. Fix them in the backend against the spec rather than with client workarounds, but first check whether the gap is already queued as an owner decision.
- Check licensing before importing third-party code or assets, and preserve required notices. Do not redistribute purchased or licensed course material in a public repository.

## Git and changes

- Inspect status, branch, HEAD, and remotes before changing repository state. Preserve unrelated user work.
- Use `<agent>/<topic>` branches (your agent's prefix, per CONTRIBUTING.md) and reviewable pull requests merged into `main` per `AGENTS.md`, "Agents and human gates". Bootstrapping a brand-new repository on `main` requires explicit authorization.
- Commit format, branch naming, and PR rules are in `CONTRIBUTING.md`. Run `git diff --cached --check` before committing.
- Treat committing, pushing, releasing, merging, and irreversible deletion as separate actions. Proceed when the session clearly authorizes the action; otherwise prepare a reviewable result and name the specific missing authorization. Do not ask for the same permission twice.
- GitHub closes an issue for any closing keyword in a PR body, including "partially closes #N". Use "Refs #N" for partial work.
- When a tool reports an outward action (push, comment, PR edit) as rejected or failed, check the remote state before reporting; it may already have run.
- Implementing agents copy the identity of the last commit they see. Give them the exact `-c user.name=... -c user.email=...` to use, and check `git log --format='%ae' main..HEAD` before pushing.
- Ignore rules meant for one root folder need a leading slash (`/archive/`): a bare `archive/` also hides nested folders such as OpenSpec's `changes/archive/`. Directory rules (`name/`) do not match symlinks, so a worktree that symlinks `node_modules` or a data folder must stage files by name.

## Multi-agent collaboration

The user picks design options and states why; Claude coordinates, commits, pushes and merges. Which agent implements or reviews a given change is decided per task; how to hand work to Codex is in the `dispatch` skill. Agents talk only through repository files and GitHub. Adapt the commands below to the versions installed, and verify flags against current docs.

- **Flow.** User request -> Claude researches and proposes options -> **gate 1: when Claude asks, the user picks and states why; record the pick and reason in `note/decisions.md`** -> OpenSpec change and plan -> implementation on an `<agent>/<topic>` branch -> fresh-context review -> fixes (after two rounds, Claude fixes remaining gaps and decides itself; no user handover) -> Claude merges once the review says "ready to merge" and, for code PRs, CI passes (doc-only PRs do not wait for CI, #156), without user review or confirmation -> quizzes are written in one batch after development is complete (#159).
- **Plan and schedule.** Spec-driven: the OpenSpec change says what; the plan orders the work into milestones. When a date slips, re-plan and record why; do not silently move it.
- **Issue (task order).** When work is handed to another agent: background (OpenSpec change id and plan steps), what to do, acceptance criteria mapped to spec scenarios, scope (paths it may change and paths it must not touch). Use `.github/ISSUE_TEMPLATE/task.md`.
- **Check the delivery.** Before committing another agent's work, run `git status` and revert edits outside the task's scope (handoff notes, specs, decision logs), even when the report says it left them alone.
- **PR (delivery).** `Closes #N` when an issue exists; what changed; verification evidence (the check command's key output and the new tests); what is not done or unclear; out-of-scope findings, recorded but not fixed. Keep about 400 changed lines per PR, excluding tests and lockfiles; split anything larger.
- **Review (quality gate).** Fresh context, read-only. Report only correctness and requirement gaps, each with file:line, the problem, its consequence, and a suggested fix. The verdict is "ready to merge" or "changes needed".
- **Quiz (learning).** When development is complete, run dsh non-interactively from the main checkout on a new `dsh/quiz-<pr>` branch, for example `dsh headless "【<repo> · Stage <n>：<short title>】<quiz prompt naming the PR and files>"`. Always start the prompt with that bracketed label so the auto-generated session title names the stage. Then file the session under the project in the DeepSeek Harness app with `node scripts/dsh-attach-session.mjs <session-id>` (decision #51). The script refuses while the app is open, because the app rewrites its registry from memory; in that case tell the user in one line to quit the app and run that command, and list the id under open items in `note/handoff.md` until it is filed. Never edit the app's files by hand. Ask half design questions ("why this, what alternatives") and half code-reading questions ("when does this return empty"). Also summarize what the stage built and why, in plain Chinese. Write it to `note/interview/<pr-or-stage>.md`, with the session id at the top. When the user answers (at any time), mark each answer ✅, ⚠️ (incomplete), or ❌, and add misses to a review list. Never wait on answers to continue development. Requires `DEEPSEEK_API_KEY` in the environment; never print it.
- **Guards.** One shared rule set with a thin adapter per agent. Claude's hooks are required. Server-side CI is the backstop for everyone, and separate checkouts keep local damage contained.
- **Parallel branches on shared files.** Before dispatching parallel work that touches the same shell (navigation state, copy file, stylesheet), write the integration contract into every brief: the shared types, callback names and exported component props. Ask each branch to keep shared-file edits additive in one labelled block.
- **Gaps versus gates.** Before treating a missing piece as an implementation omission, read every handoff for an open owner decision on it. A gap queued as a design choice stays a gate.

## Verification and deployment

- Verify behavior with checks appropriate to the change. Use meaningful tests for logic, data handling, and server behavior; avoid tests that merely restate the implementation. Validate visual changes in a real browser, including narrow and wide layouts, keyboard access, theme, and reduced motion where applicable.
- Run the project check command (lint, typecheck, relevant tests, production build) before declaring product code ready. Report skipped or unavailable checks and their practical limits. Document-only changes need content and diff checks, not application tests.
- Evidence over assertion: show the test output, the command run and what it returned, or a screenshot. "Looks done" is not a signal.
- Independent review for non-trivial changes: have a fresh-context subagent review the diff against the OpenSpec change or plan. Tell it to flag only gaps that affect correctness or the stated requirements; chasing every finding leads to over-engineering.
- Before changing any deployment state, confirm the account, project, repository, branch, and environment. A local build, a manual deploy, or a green CI run alone does not prove automatic deployment works; verify a real Git-triggered deployment and the resulting URL before claiming it is fixed.
- For destructive actions, confirm the exact target at the final step. Prefer the reversible action that satisfies the request.
- Judge a check by its exit code. `check | grep summary && commit` commits even when the check failed.
- After a merge, also check CI on the base branch. A green PR run does not prove the merged result passes.
- Before deleting "unused" CSS, remember that one unknown class inside an `:is()` / `:where()` list does not void the rule. Prove a style cleanup by comparing every element's computed style under the old and new stylesheet, in each UI state and each root mode (theme, palette, background), and first confirm the comparison catches a deliberately broken version.
- When tests that pass alone time out under parallel load, raise the suite's default timeout once, with a bound that still fails a hung test, instead of patching tests one by one.
- For UI work, first build a synthetic data harness: invented data in a temporary data directory, served by the real host. Then every UI branch can be checked in a real browser without real data.
