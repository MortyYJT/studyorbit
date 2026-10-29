@AGENTS.md

## Claude Code specifics

- Hooks in `.claude/settings.json` enforce two rules: `guard.sh` blocks writes to secret files and unsafe git commands; `verify.sh` runs `.claude/check.sh` before a turn can finish. If a hook blocks you, fix the cause; do not look for a way around it.
- Use plan mode when the approach is uncertain, the change touches several files, or it is an OpenSpec change. If the diff can be described in one sentence, skip the plan and just do it.
- When compacting, always preserve the list of modified files, the current OpenSpec change id, and the check command. Before a long session ends or context gets heavy, update `note/handoff.md`.
