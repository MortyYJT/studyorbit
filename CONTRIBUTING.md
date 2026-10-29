# Contributing

These rules apply to everyone who changes this repository, humans and AI agents alike. They are written once, here.

## Language

- Source comments, docstrings, README, and engineering docs: English.
- Planning and learning records: Chinese, in `note/`.
- Keep intended Chinese UI copy, prompts, public error messages, and test strings.

## Branches

- Never commit directly to `main`.
- Branch from an up-to-date `main` as `<owner>/<topic>`, where `<owner>` is the agent that did the work (`claude/`, `codex/`, `dsh/`, …) or `me/` for your own. New agents take their own prefix; do not reuse another agent's. Use short kebab-case topics, e.g. `claude/add-login-form`.
- Never force-push. Never rewrite history that has been pushed.

## Commits

Format (Conventional Commits 1.0.0):

```
type(scope): imperative summary

- English bullet describing what changed and why
- Another bullet if needed
```

- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`. Use `feat(ui)` / `fix(ui)` for UI changes; reserve `style` for formatting only.
- A scope is required. The body is required, in English, each line starting with `- `.
- One logical change per commit.
- Run `git diff --cached --check` before committing.

## Pull requests

- Open one PR per branch into `main`, one topic each. Say briefly what changed and paste the check command's result.
- Merge once CI passes. No review step.

## Checks

Run the project check command (see `AGENTS.md`, "Project-specific") before opening a PR. It must match what CI runs.

## Never commit

Secrets, `.env` files, credentials, private contact details, personal real names, or paths that identify a local machine.
