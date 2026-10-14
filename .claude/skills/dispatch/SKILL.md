---
name: dispatch
description: Use when an approved OpenSpec change and scheduled plan exist and work should be handed to Codex, reviewed, turned into a PR, and queued for an async dsh quiz. Runs the multi-agent loop from AGENTS.md without automating the blocking human gate (design option selection). Claude merges reviewed, green PRs.
---

# Dispatch loop (Claude Code as coordinator)

Read `AGENTS.md` ("Agents and human gates") and the guidelines section "Multi-agent collaboration" first. Never automate gate 1 (design option selection). Merging is delegated to Claude (`note/decisions.md` #48). Learning quizzes are queued, never awaited.

## Preconditions

- The user picked the design option and stated why (gate 1) in this session or in `note/handoff.md`, and the OpenSpec change id is known.
- The repository-local Git identity (`git config --local user.name/user.email`) is the public handle and noreply address. Placeholder identities left by rehearsals have leaked into pushed history before; check, and pass `-c user.name=... -c user.email=...` if it is wrong.
- `gh auth status` succeeds, and `codex` and `dsh` are on PATH. If one is missing, stop and tell the user.

## Steps

1. **Issues.** For each group of related plan steps, open an issue with `.github/ISSUE_TEMPLATE/task.md` (`gh issue create --template task.md ...`). Fill in scope and acceptance criteria.
2. **Workspace.** Give Codex a standalone clone, not a linked worktree: `git clone <origin-url> ../<repo>-<topic> && git -C ../<repo>-<topic> switch -c codex/<topic>`, then copy the repository-local Git identity into it. A linked worktree keeps its Git metadata in the main checkout's `.git/`, outside the `workspace-write` sandbox, so it is the wrong base. Even in a clone, the `workspace-write` sandbox keeps `.git/` read-only, so Codex cannot commit at all (issues #8–#10). The sandbox has no network: install approved dependencies in the clone yourself before dispatching.
3. **Dispatch.** `codex exec --cd ../<repo>-<topic> --sandbox workspace-write -o <scratch>/codex-<issue>.md "<issue body> Follow AGENTS.md. Use TDD for logic; small non-behaviour changes skip it (AGENTS.md, Proportion). Do not commit (the sandbox keeps .git read-only); leave changes in the working tree. End with a report: files changed, tests run with results, one proposed commit message per plan step, open questions."` Verify the flags with `codex exec --help` for the installed version. When running it in the background or from a script, redirect stdin (`< /dev/null`): otherwise `codex exec` waits on "Reading additional input from stdin..." and never starts. Run it as a background Bash call and wait for its completion notice; do not poll with shell loops or the Monitor tool (each triggers permission prompts). Tell Codex not to edit `note/handoff.md` and not to add evidence files to the repository; its report file is the evidence.
4. **Check the delivery yourself.** In the clone, run the project check command and read the diff against the issue's scope. Do not trust the report alone. Then commit for Codex, one commit per plan step, using its proposed messages and grouping files by step.
5. **Review.** Use Codex in fresh context: `codex exec --cd <clone> --sandbox read-only -o <report> "<review prompt: correctness and requirement gaps only, file:line, verdict ready to merge or changes needed>" < /dev/null`.
   - Changes needed: send the findings back with `codex exec resume --last` (or a new `codex exec` in the same clone). After two review rounds, Claude fixes the remaining gaps and decides whether to merge itself; do not hand over to the user.
   - Ready: push the branch (your guard hook applies), then `gh pr create` using the PR template, with `Closes #N`. Post the review summary as a PR comment.
6. **Merge.** Claude merges every PR, including design PRs (`openspec/changes/**`, design docs), without user review or confirmation (#48), only when the review verdict is "ready to merge" and, for code PRs, `gh pr checks <n> --watch` passes. Doc-only PRs merge after review without waiting for CI (#156). Keep the user's design option picks and reasons recorded in `note/decisions.md`. Then `gh pr merge <n> --squash --delete-branch` and fast-forward the local `main`. Before merging, delete any per-issue evidence file the branch added (CONTRIBUTING.md, Pull requests). Tell the user in one line; do not wait for them.
7. **Queue a quiz (after the merge; non-blocking).** Follow the guidelines, "Multi-agent collaboration", Quiz. In short: in the main checkout, branch `dsh/quiz-<pr>` from the updated `main`, run `dsh headless` with a prompt that starts with `【<repo> · Stage <n>：<short title>】`, take the newest session id from `~/.dsh/sessions/<encoded-path>/`, file it under the app project with `node scripts/dsh-attach-session.mjs <session-id>` (if the app is open, ask the user to quit it and run that command; see the guideline), and check that only `note/interview/<pr>.md` changed. Commit it for a docs PR, tell the user in one line that it is queued, and continue with the next issue. Do not wait.
8. **When the user answers (any time).** Mark each answer ✅/⚠️/❌ and add misses to the review list in the same file.
9. **Handoff.** Update `note/handoff.md`: issues and PRs in flight, the last verified state, and the next step.

## Record for the resume

Keep counts in `note/handoff.md` or the stage log: issues dispatched, PRs merged, review findings, rework rounds, and dispatch-to-merge time. These are the evidence behind any "multi-agent workflow" claim.

## Known pitfalls

- The Codex sandbox cannot listen on 127.0.0.1 (`EPERM`). Tests that open sockets fail there; rerun the project check on the host before trusting a Codex report.
- A pushed branch that falls behind `main` is updated with `git merge origin/main`, never rebased (that would need a force-push). A PR shown as CONFLICTING runs no CI.
- `codex exec resume --last` can attach to the wrong session; for rework start a new `codex exec` and paste the findings.
- Codex usage limits: an error with a reset time under five hours means wait (or use a read-only Claude subagent for reviews); only a weekly limit justifies a reset.
- The owner's global Git identity is not the public handle. Set the repository-local identity in every new clone and check `git log --format='%an %ae' -1` before pushing.
- Remove a Codex clone once its branch is merged; idle clones go stale and get reused by mistake.
