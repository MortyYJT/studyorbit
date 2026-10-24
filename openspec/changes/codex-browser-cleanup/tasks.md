## 1. Agent-recorded sources

- [ ] 1.1 Failing tests then `source.record`: origin check, discussion-thread refusal, size bound, redaction, one SourceItem per PDF page, `copiedBy` marker, empty text reported, citation check against recorded text (scenarios "Lecture PDF", "Discussion thread", "Off-origin link"); registered as an agent command
- [ ] 1.2 Revision skill text (`skills/revision/SKILL.md`) and the course-reading prompt use `source.record`; no `browser.status` check (scenario "Signed out")

## 2. Delete the resident browser stack

- [ ] 2.1 Remove `src/browser/**`, `src/capture/**`, `source-fetch.ts`, `source-transport.ts`, `src/protocol/browser-*.ts`, browser and confirmation registry entries, `coursework browser` CLI, the MCP profile filter, and their tests; MCP tool-count assertion updated (scenario "Tool list"); `autonomy.check` kept (scenarios under "Enforce recorded policy and exact assessment grants" and "Append-only audit and run records fail safely")
- [ ] 2.2 Remove `playwright` (and `unpdf` if unused) from `package.json` and the lockfile

## 3. Frontend

- [ ] 3.1 Remove the sign-in button, per-site browser state and the confirmation card and item; "needs you" and the status panel use only `sync.status` (scenarios "Sign-in expired", "Confirmation card"); agent-copied sources labelled where sources are shown
- [ ] 3.2 Real-browser check on the synthetic harness at 390 and 1440 px, light and dark

## 4. Verification

- [ ] 4.1 `openspec validate codex-browser-cleanup --strict`, `bash .claude/check.sh` (exit code), `npm ci && npm run build`
- [ ] 4.2 Owner morning acceptance with C-2's live run (decision #186)
