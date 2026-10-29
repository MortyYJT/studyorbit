# Repository instructions

Applies to the whole repository. Higher-priority instructions and the user's explicit scope win over this file.
More detail, read on demand: [docs/engineering/agent-guidelines.md](docs/engineering/agent-guidelines.md).

## Always apply

- Check premises, logical gaps, and missing information before acting. Verify numbers and outcomes. Never invent results.
- Never commit secrets, `.env` files, private contact details, the owner's real name, or identifying local paths. Identify the owner only by the public handle `MortyYJT`.
- Talk to the user in Chinese. Write source comments and engineering docs in English.

## Workflow

- **TDD for logic.** Data models, rules, calculations, validation, stores: write a failing test first, then make it pass. Docs, config, styling and renames skip TDD.
- **Check before done.** Run `bash .claude/check.sh` (= `npm run check`, the same command CI runs) and show its output. Do not claim "done" without it.
- **Git.** Work on a `<agent>/<topic>` branch, push it, open a PR into `main`, and merge once CI passes. No review step and no PR template. Never push to `main`, force-push, or rewrite pushed history. Commit format is in [CONTRIBUTING.md](CONTRIBUTING.md).
- **Ask first** only before adding a dependency, changing the course JSON contract in `shared/course-data.ts`, deleting files, touching CI, or any write action on Canvas or Ed.

## Project

- **What this is:** StudyOrbit (repository `MortyYJT/studyorbit`, package `study-orbit`), a local-first University of Melbourne coursework prototype. It discovers Canvas courses through the owner's signed-in Edge, collects Canvas, Ed and Handbook data with scripts in `scripts/`, has a model analyse them into structured course JSON validated by `shared/course-data.ts`, and the web app (`web/src/`) shows grades (`shared/course-calculations.ts`), plans the week and runs syncs through a loopback-only local API in `vite.config.ts`.
- **Stack and commands:** Node 24, strict TypeScript, React 19, Vite 8, zod, vitest. Install `npm ci`, run `npm run dev` (the local API exists only there), check `bash .claude/check.sh`. Tests live in `test/`.
- **Where data lives:** run data, collected raw material, model settings, chats and revision notes in `.local/` (git-ignored); course JSON in the owner's Desktop course folder, outside the repo; course selection, corrections, tasks and preferences in browser localStorage (keys keep the `coursework.` prefix).
- **Red lines:**
  - No self-issued Canvas tokens (forbidden by the university). A model never sees or types passwords; sign-in and MFA stay with the owner.
  - Real course data, grades, cookies, browser profiles and API keys never enter the repo, docs or test fixtures; tests use synthetic data.
  - No code that completes or submits assessments in this public repository.
  - Code from unlicensed repos: ideas only, no copying. Copied Apache-2.0/MIT code keeps its notice and attribution.
