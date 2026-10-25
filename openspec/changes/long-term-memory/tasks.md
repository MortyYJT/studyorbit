## 1. Store and commands

- [x] 1.1 Migration `005` (`memories`), domain schema `Memory`, store methods, parse tests
- [x] 1.2 Failing tests then `memory.record` (agent; conversation from the tool scope or `COURSEWORK_CONVERSATION_ID`), `memory.list` (L0), `memory.add` / `memory.edit` / `memory.delete` (owner commands, added to the owner-command set; owner text redacted) (scenarios "Weakness noticed while tutoring", "Too long or unknown course", "Owner adds a memory", "Owner edits an observation", "Owner text is redacted", "Owner deletes a wrong observation", "Agent cannot delete"); MCP tool-count assertion updated

## 2. Facts brief

- [x] 2.1 Failing tests then `src/memory/brief.ts`: priority order, drop rule, all selected courses, no page text (scenarios "All selected courses", "Bounded brief")
- [x] 2.2 `AgentInput` gains `brief?` and `conversationId`; `ConversationService` passes the brief without storing it and gives every tool a scope with the conversation id; the Codex adapter adds the brief on new-thread and fallback attempts only and passes `COURSEWORK_CONVERSATION_ID` to the MCP entry; the Claude adapter adds it without `sessionRef` (scenarios "New conversation for a course", "Resumed session", "Resume falls back")

## 3. Frontend

- [x] 3.1 Memory panel in the avatar menu (scenario "Edit and delete"), en and zh
- [ ] 3.2 Real-browser check on the synthetic harness at 390 and 1440 px, light and dark (if Playwright was removed by C-3, use the coordinator's browser pane; otherwise system Chrome)

## 4. Verification

- [ ] 4.1 `openspec validate long-term-memory --strict`, `bash .claude/check.sh` (exit code), `npm run build`
- [ ] 4.2 At archive, if C-3 has archived first, add "Memory" to the avatar-menu list in the `web-ui` "Top bar and avatar menu" requirement
- [ ] 4.3 Owner morning acceptance
