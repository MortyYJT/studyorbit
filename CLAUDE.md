@AGENTS.md

## Claude Code specifics

- Hooks in `.claude/settings.json` enforce two rules: `guard.sh` blocks writes to secret files and unsafe git commands; `verify.sh` runs `.claude/check.sh` before a turn can finish. If a hook blocks you, fix the cause; do not look for a way around it.
- When compacting, always preserve the list of modified files and the check command.
