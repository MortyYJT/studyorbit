## 1. Store and commands

- [ ] 1.1 Migration `005` (`memories`), domain schema `Memory`, store methods, parse tests
- [ ] 1.2 Failing tests then `memory.record` (agent; conversation from scope or the session environment), `memory.list` (L0), `memory.add` / `memory.edit` / `memory.delete` (owner) (scenarios "Weakness noticed while tutoring", "Too long or unknown course", "Owner deletes a wrong observation", "Agent cannot delete"); MCP tool-count assertion updated

## 2. Facts brief

- [ ] 2.1 Failing tests then `src/memory/brief.ts` (scenarios "New conversation for a course", "Bounded brief")
- [ ] 2.2 `ConversationService` prepends the brief only when a session starts, and the Codex adapter passes the conversation id to the MCP server entry (scenario "Resumed session")

## 3. Frontend

- [ ] 3.1 Memory panel in the avatar menu (scenario "Edit and delete"), en and zh
- [ ] 3.2 Real-browser check on the synthetic harness at 390 and 1440 px, light and dark (if Playwright was removed by C-3, use the coordinator's browser pane; otherwise system Chrome)

## 4. Verification

- [ ] 4.1 `openspec validate long-term-memory --strict`, `bash .claude/check.sh` (exit code), `npm run build`
- [ ] 4.2 Owner morning acceptance
