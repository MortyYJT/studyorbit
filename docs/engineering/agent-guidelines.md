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
- Record meaningful decisions, milestone evidence, and unresolved issues in `note/` as work progresses. Keep notes concise and free of private identity details.
- Delivery report, in this order: (1) 你要做什么 - the single action required from the user, or "nothing"; (2) 我完成了什么 - one line per item with its evidence; (3) 我遇到什么问题 - what went wrong and how it was resolved; (4) 还没完成什么 - what is unfinished or unverified.
- Open every section with a one-line summary. Lead with the user's action. One idea per line. Report code, tests, CI, local run, and deployment separately. Write "not run" or "not verified" plainly.
- Put reasoning, tradeoffs, and history in `note/`, not in the report.
- **Handoff.** `note/handoff.md` is a single file holding the current state for the next session or the next agent (for example after `/clear`, or when work moves between Claude and Codex). Overwrite it; never append, because history is in git. It states: date, commit and branch; the goal; the OpenSpec change id; what is done, each with evidence; what is in progress, including uncommitted or unpushed state; ordered next steps; decisions and why; open questions for the user; how to run and verify; traps. Keep it under about 60 lines. It must not contain secrets, private contact details, or identifying local paths. Treat it as a claim to verify against git, not as truth.

## Scope and implementation

- **Product layer.** `note/product/vision.md` says what we build and what we do not. `roadmap.md` orders the work. `backlog.md` holds raw ideas. A new idea goes into the backlog first; it becomes work only when promoted.
- **OpenSpec.** Behavior changes go through OpenSpec: current-truth specs live in `openspec/specs/`, each proposed change in `openspec/changes/<id>/` (proposal, spec deltas, tasks), and finished changes are archived. Install and use the official CLI (`@fission-ai/openspec`); follow the commands it generates for this tool rather than older tutorials. Do not write a parallel spec elsewhere.
- **Superpowers.** Use it for execution quality: brainstorming when the idea is unclear, a plan only for large changes (reference the OpenSpec change id), TDD, code review, and verification-before-completion.
- Follow the agreed design, spec, plan, and review stages. Respect explicit exceptions the user grants; do not infer new ones, and do not add approval gates for routine, reversible, already-authorized work.
- Keep the first version focused. Prefer small, reusable pieces. Add APIs, persistence, authentication, services, or dependencies only for a concrete requirement, and ask first before adding a dependency. Confirm dependency versions and APIs against current documentation.
- Types do not replace runtime validation of untrusted input.
- Check licensing before importing third-party code or assets, and preserve required notices. Do not redistribute purchased or licensed course material in a public repository.

## Git and changes

- Inspect status, branch, HEAD, and remotes before changing repository state. Preserve unrelated user work.
- Use `<agent>/<topic>` branches (your agent's prefix, per CONTRIBUTING.md) and reviewable pull requests merged into `main` per `AGENTS.md`, "Agents and human gates". Bootstrapping a brand-new repository on `main` requires explicit authorization.
- Commit format, branch naming, and PR rules are in `CONTRIBUTING.md`. Run `git diff --cached --check` before committing.
- Treat committing, pushing, releasing, merging, and irreversible deletion as separate actions. Proceed when the session clearly authorizes the action; otherwise prepare a reviewable result and name the specific missing authorization. Do not ask for the same permission twice.

## Multi-agent collaboration

The user picks design options and states why, Claude Code dispatches, commits, pushes, merges, and handles the few tasks that need judgment, Codex is the first choice for implementation, documentation and spec edits, and PR reviews, and dsh (DeepSeek Harness) teaches. Agents talk only through repository files and GitHub. Adapt the commands below to the versions installed, and verify flags against current docs.

- **Flow.** User request -> Claude researches and proposes options -> **gate 1: when Claude asks, the user picks and states why; record the pick and reason in `note/decisions.md`** -> Codex writes the OpenSpec change and plan under Claude's direction, then Claude opens one GitHub issue per group of related plan steps -> Claude dispatches each issue to Codex -> Codex implements in its own clone -> Codex reviews in fresh context with a read-only sandbox, then Claude pushes and opens the PR -> Codex fixes review findings (after two rounds, Claude fixes remaining gaps and decides itself; no user handover) -> Claude merges every PR, including design PRs (`openspec/changes/**`, design docs), once the review says "ready to merge" and CI passes, without user review or confirmation (pre-CI rules in `AGENTS.md`, "Agents and human gates") -> Claude asks dsh to queue a quiz on the merged PR (non-blocking; the user answers whenever they have time).
- **Plan and schedule.** Spec-driven: the OpenSpec change says what; the plan orders the issues into milestones with target dates. When a date slips, re-plan and record why; do not silently move it.
- **Issue (task order).** Background (OpenSpec change id and plan steps), what to do, acceptance criteria mapped to spec scenarios, scope (paths it may change and paths it must not touch). Use `.github/ISSUE_TEMPLATE/task.md`.
- **Dispatch to Codex.** Create a standalone clone on `codex/<topic>` from an up-to-date `main` (a linked worktree keeps Git metadata outside the Codex sandbox), then run, for example, `codex exec --cd <clone> --sandbox workspace-write -o <report-file> "<issue text plus: follow AGENTS.md, TDD, do not commit, propose one commit message per plan step>"`. The sandbox keeps `.git/` read-only, so Claude checks the work and commits it per plan step. Codex never commits, pushes, or opens PRs. The workspace-write sandbox has no network by default, and Claude's guard hook covers every remote action.
- **PR (delivery).** `Closes #N`; what changed; verification evidence (baseline on `main` first, then the check command's key output, and the new tests); what is not done or unclear; out-of-scope findings, recorded but not fixed. Keep one commit per plan step and about 400 changed lines per PR, excluding tests and lockfiles; split anything larger.
- **Review (quality gate).** Use Codex in fresh context with a read-only sandbox: `codex exec --cd <clone> --sandbox read-only -o <report> "<review prompt: correctness and requirement gaps only, file:line, verdict ready to merge or changes needed>" < /dev/null`. Report only correctness and requirement gaps, each with file:line, the problem, its consequence, and a suggested fix. The verdict is "ready to merge" or "changes needed". Post the review on the PR with `gh`.
- **Quiz (learning).** After a merge, run dsh non-interactively from the main checkout on a new `dsh/quiz-<pr>` branch, for example `dsh headless "【<repo> · Stage <n>：<short title>】<quiz prompt naming the PR and files>"`. Always start the prompt with that bracketed label so the auto-generated session title names the stage. Then file the session under the project in the DeepSeek Harness app with `node scripts/dsh-attach-session.mjs <session-id>`: the app attaches only sessions it creates itself, so headless sessions otherwise land in the ungrouped list (decision #51). The script refuses while the app is open, because the app rewrites its registry from memory; in that case tell the user in one line to quit the app and run that command, and list the id under open items in `note/handoff.md` until it is filed. Never edit the app's files by hand. Ask half design questions ("why this, what alternatives") and half code-reading questions ("when does this return empty"). Also summarize what the stage built and why, in plain Chinese, so the user can catch up later. Write it to `note/interview/<pr-or-stage>.md`, with the session id at the top. When the user answers (at any time), mark each answer ✅, ⚠️ (incomplete), or ❌, and add misses to a review list. Never wait on answers to continue development. Requires `DEEPSEEK_API_KEY` in the environment (the headless profile cannot see the app's managed key); never print it.
- **Guards.** One shared rule set with a thin adapter per agent. Claude's hooks are required. Codex and dsh hooks (Codex `PreToolUse`/`Stop`, dsh `tools/pre-execute`) are optional until added. Server-side CI and branch protection are the backstop for everyone, and separate clones keep local damage contained.

## Verification and deployment

- Verify behavior with checks appropriate to the change. Use meaningful tests for logic, data handling, and server behavior; avoid tests that merely restate the implementation. Validate visual changes in a real browser, including narrow and wide layouts, keyboard access, theme, and reduced motion where applicable.
- Run the project check command (lint, typecheck, relevant tests, production build) before declaring product code ready. Report skipped or unavailable checks and their practical limits. Document-only changes need content and diff checks, not application tests.
- Evidence over assertion: show the test output, the command run and what it returned, or a screenshot. "Looks done" is not a signal.
- Independent review for non-trivial changes: have a fresh-context subagent review the diff against the OpenSpec change or plan. Tell it to flag only gaps that affect correctness or the stated requirements; chasing every finding leads to over-engineering.
- Before changing any deployment state, confirm the account, project, repository, branch, and environment. A local build, a manual deploy, or a green CI run alone does not prove automatic deployment works; verify a real Git-triggered deployment and the resulting URL before claiming it is fixed.
- For destructive actions, confirm the exact target at the final step. Prefer the reversible action that satisfies the request.
