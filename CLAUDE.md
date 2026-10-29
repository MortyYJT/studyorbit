# StudyOrbit rules (single source of truth)

## Workflow
- All development is done by Claude. Claude opens and merges every PR.
- Large changes (contract, architecture, new subsystem): write an OpenSpec change first. Small features start straight from the task list.
- TDD for logic: write a failing test first, then make it pass. Docs and styling skip TDD.
- Before saying "done", run `bash .claude/check.sh` (= `npm run check`, same as CI) and show the output.
- Before merging, a fresh-context subagent reviews the diff and reports only correctness bugs.
- Work on a `claude/<topic>` branch; never push to `main`. Merge only after CI passes.
- Commit format: `type(scope): summary`, body as English `- ` bullets.

## Ask the user first
- Design choices (architecture, tech selection): offer options; the user picks and gives a reason. Record it in `note/decisions.md`.

## Records
- Keep `note/handoff.md` current: what is done, what is next, open questions.
- Task list: tick an item when it is done and add the PR number.

## Red line
- Never commit secrets, grades or real course data, the owner's real name, or local paths. Tests use synthetic data.

## Project facts
- StudyOrbit: Node 24, TypeScript, React 19, Vite 8, zod, vitest. `npm ci`, `npm run dev`, `npm run check`.
- Local data in `.local/` (git-ignored); course JSON on the owner's Desktop; corrections in browser localStorage.
