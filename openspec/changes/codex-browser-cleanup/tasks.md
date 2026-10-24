## 1. Agent-recorded sources

- [x] 1.1 Move the helpers other modules import from `src/revision/source-fetch.ts` (`courseEvidence`, `courseEvidenceSnapshot`, `materialIdentity`, `materialMetadata`, `sourceURL`) into a kept module and update their importers (`src/protocol/{annotations,reads}.ts`, `src/store/sqlite.ts`, `src/revision/service.ts`, tests)
- [x] 1.2 Failing tests then `source.record { courseId, url, title, text, page? }`: origin check, URL must belong to the course (`course.sources`), discussion-thread refusal, 100,000-character bound, redaction, one SourceItem per PDF page, re-record replaces text, `copiedBy: 'agent'`, empty text reported, citation check against recorded text (scenarios "Lecture PDF", "Discussion thread", "Page of another course", "Off-origin link"); registered as an agent command
- [x] 1.3 Skills and prompts: `skills/revision/SKILL.md` and `skills/assessment/SKILL.md` drop `browser.*`, `browser.status` and frontend confirmation, and say: stop at sign-in pages, record cited pages with `source.record`, fill but never press a final submit (scenario "Signed out"); the course-reading prompt and the `src/sync/course-import.ts` comment mention `source.record`

## 2. Delete the resident browser stack

- [ ] 2.1 Remove `src/browser/**`, `src/capture/**`, `source-fetch.ts`, `source-transport.ts`, `src/protocol/browser-*.ts`, the `browser.*` and `confirmation.*` registry entries, the `browser.view` / `browser.image` HTTP routes, `coursework browser` CLI, the "Browser tools" journal conversation, the MCP profile filter, `autonomy.confirmation.set` and `confirmBeforeSubmit` from `autonomy.read`, and their tests; MCP tool-count assertion updated (scenario "Tool list"); `autonomy.check` kept (scenarios under "Enforce recorded policy and exact assessment grants" and "Append-only audit and run records fail safely"); adapter `screenshotRef` / `viewUrl` fields stay optional for historical rows; the adapter `confirmation` event is removed (the stored part stays readable)
- [ ] 2.2 Remove `playwright` and `unpdf` from `package.json` and the lockfile

## 3. Frontend

- [ ] 3.1 Remove the sign-in button and per-site browser state, the confirmation card and needs-you item, tool-step screenshots and "view in Edge", the confirm-before-submit select; "needs you" and the status panel use only `sync.status` (scenarios "Sign-in expired", "Confirmation card"); agent-copied sources labelled in the drawer (scenario "Agent-copied source"); `web/src/client.ts` stops importing browser contracts; harness and web tests updated
- [ ] 3.2 Real-browser check on the synthetic harness at 390 and 1440 px, light and dark

## 4. Docs and verification

- [ ] 4.1 Docs: `docs/engineering/protocol.md` resident-browser section removed, `README.md` capture and managed-profile lines, `AGENTS.md` stack (Playwright), data-access red line (no managed Playwright profile or `coursework login`; Codex in the owner's Edge stops at sign-in) and autonomy red line (#121 audit/confirmation now historical), `docs/engineering/v1-technical-design.md` Playwright note; keep each edit short
- [ ] 4.2 `openspec validate codex-browser-cleanup --strict`, `bash .claude/check.sh` (exit code), `npm ci && npm run build`
- [ ] 4.3 At archive, delete the emptied spec folders `openspec/specs/{resident-browser,agent-browser-tools,page-capture,ed-capture}`
- [ ] 4.4 Owner morning acceptance with C-2's live run (decision #186)
