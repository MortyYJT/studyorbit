# Detailed agent guidelines

This document expands the root `AGENTS.md`. Read only the section you need; do not load it for routine changes. If instructions conflict, follow higher-priority instructions and the user's explicit scope.

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
- Verification evidence belongs in the PR description, not in repository files. Keep notes concise and free of private identity details.
- Delivery report, in this order: (1) 你要做什么 - the single action required from the user, or "nothing"; (2) 我完成了什么 - one line per item with its evidence; (3) 我遇到什么问题 - what went wrong and how it was resolved; (4) 还没完成什么 - what is unfinished or unverified.
- Open every section with a one-line summary. Lead with the user's action. One idea per line. Report code, tests, CI, local run, and deployment separately. Write "not run" or "not verified" plainly.

## Scope and implementation

- **Product layer.** `note/product/vision.md` says what we build and what we do not. `roadmap.md` orders the work. `backlog.md` holds raw ideas. A new idea goes into the backlog first; it becomes work only when promoted.
- Do not add approval gates for routine, reversible, already-authorized work.
- Keep the first version focused. Prefer small, reusable pieces. Add APIs, persistence, authentication, services, or dependencies only for a concrete requirement, and ask first before adding a dependency. Confirm dependency versions and APIs against current documentation.
- Types do not replace runtime validation of untrusted input.
- Keep read commands free of side effects: a read that clears or rewrites state lets any caller (another agent, a CLI run, a different query range) silently change the owner's data.
- The first full consumer of an API (usually the frontend) exposes missing reads and side-effecting reads. Fix them in the backend rather than with client workarounds.
- Check licensing before importing third-party code or assets, and preserve required notices. Do not redistribute purchased or licensed course material in a public repository.

## Git and changes

- Inspect status, branch, HEAD, and remotes before changing repository state. Preserve unrelated user work.
- Use `<agent>/<topic>` branches (your agent's prefix, per CONTRIBUTING.md) and pull requests merged into `main` once CI passes. Bootstrapping a brand-new repository on `main` requires explicit authorization.
- Commit format, branch naming, and PR rules are in `CONTRIBUTING.md`. Run `git diff --cached --check` before committing.
- Treat committing, pushing, releasing, merging, and irreversible deletion as separate actions. Proceed when the session clearly authorizes the action; otherwise prepare a reviewable result and name the specific missing authorization. Do not ask for the same permission twice.
- GitHub closes an issue for any closing keyword in a PR body, including "partially closes #N". Use "Refs #N" for partial work.
- When a tool reports an outward action (push, comment, PR edit) as rejected or failed, check the remote state before reporting; it may already have run.
- Check `git log --format='%ae' main..HEAD` before pushing; every commit must use the public handle and noreply address.
- Ignore rules meant for one root folder need a leading slash (`/archive/`): a bare `archive/` also hides nested folders with the same name. Directory rules (`name/`) do not match symlinks, so a worktree that symlinks `node_modules` or a data folder must stage files by name.

## Verification and deployment

- Verify behavior with checks appropriate to the change. Use meaningful tests for logic, data handling, and server behavior; avoid tests that merely restate the implementation. Validate visual changes in a real browser, including narrow and wide layouts, keyboard access, theme, and reduced motion where applicable.
- Run the project check command (lint, typecheck, relevant tests, production build) before declaring product code ready. Report skipped or unavailable checks and their practical limits. Document-only changes need content and diff checks, not application tests.
- Evidence over assertion: show the test output, the command run and what it returned, or a screenshot. "Looks done" is not a signal.
- Before changing any deployment state, confirm the account, project, repository, branch, and environment. A local build, a manual deploy, or a green CI run alone does not prove automatic deployment works; verify a real Git-triggered deployment and the resulting URL before claiming it is fixed.
- For destructive actions, confirm the exact target at the final step. Prefer the reversible action that satisfies the request.
- Judge a check by its exit code. `check | grep summary && commit` commits even when the check failed.
- After a merge, also check CI on the base branch. A green PR run does not prove the merged result passes.
- Before deleting "unused" CSS, remember that one unknown class inside an `:is()` / `:where()` list does not void the rule. Prove a style cleanup by comparing every element's computed style under the old and new stylesheet, in each UI state and each root mode (theme, palette, background), and first confirm the comparison catches a deliberately broken version.
- When tests that pass alone time out under parallel load, raise the suite's default timeout once, with a bound that still fails a hung test, instead of patching tests one by one.
- For UI work, first build a synthetic data harness: invented data in a temporary data directory, served by the real host. Then every UI branch can be checked in a real browser without real data.
