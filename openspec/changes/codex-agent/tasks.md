## 1. Tool exposure for Codex

- [x] 1.1 Failing test: with `COURSEWORK_MCP_PROFILE=codex`, the `coursework mcp` tool list has no `browser.*` and no owner command; without it the list is unchanged (scenario "No resident-browser tools")
- [x] 1.2 Implement the profile filter in the MCP server; keep the MCP tool-count assertion in `test/cli.test.ts` for the default profile

## 2. Codex adapter

- [x] 2.1 Spike against the real CLI (synthetic prompts only, no course pages): record `codex exec --json` and `codex exec resume <id> --json` lines (agent message, MCP tool call ok and failed, command execution, turn completed) as test fixtures; confirm which options `resume` accepts; confirm computer-use still works under `-s workspace-write`; confirm the `coursework` MCP server runs outside Codex's sandbox, so a validated write reaches a temporary data directory (if it is sandboxed, stop and re-plan); note the computer-use item shape. Record findings in the PR (done 2026-10-24 against codex-cli 0.163.0-alpha.11; findings in design Decision 1)
- [x] 2.2 Failing tests with a fake `codex` executable on `PATH`: "Codex events" mapping, "Resume" arguments, "Resume fails" (falls back to the stored transcript), "Stop a Codex reply" (SIGTERM then SIGKILL), "Agent not signed in" (missing executable and auth exit), "Owner command through the shell" (arguments include `sandbox_mode="workspace-write"`, the child's `cwd` is the workspace, never bypass flags), "Same data directory" (MCP entry carries `COURSEWORK_HOME`), unknown item types ignored, raw output never stored
- [x] 2.3 Implement `src/agent/codex.ts`: spawn with argument arrays and a minimal environment, stdin prompt with preset skill text, JSONL parsing, event mapping, interrupt
- [x] 2.4 Failing test then implementation: the workspace (`~/.coursework/codex-workspace/<hash>`, mode 0700, no Git working tree above it) and its `AGENTS.md` from `src/agent/codex-instructions.md` are written before the child starts, with the no-final-submit, stop-at-sign-in, prohibited-course, granted-level and no-other-sites rules (scenario "Workspace instructions")

## 3. Wiring and policy

- [x] 3.1 Failing test then implementation: `createProductionProtocol` uses the Codex adapter by default and the Claude adapter with `COURSEWORK_AGENT=claude` (scenario "Claude on request")
- [x] 3.2 Test for "Reading the owner session": no file under a temporary data directory or the workspace holds the secret while a conversation runs
- [x] 3.3 Failing test then implementation in `ConversationService.send`: a conversation stored under another adapter continues under the current one from its transcript, without the old session reference, and records the new adapter id and thread id (scenario "Conversation from another adapter")
- [x] 3.4 Repository `AGENTS.md` red lines, kept short: data access (Codex works in the owner's own Edge; a model still never types passwords — it stops at sign-in pages), privacy (accepted unredacted browsing, #168), autonomy (Codex's on-screen actions are neither audited nor confirmation-gated by code; it stops before final submit, #173)

## 4. Verification

- [x] 4.1 `openspec validate codex-agent --strict`, `bash .claude/check.sh` (exit code), `npm run build`
- [ ] 4.2 Owner live check (moved from `v1-delivery` 10.4): `coursework ui`, one real conversation that asks Codex to read the Ed dashboard in the owner's Edge; record steps, turns, duration, that no submit happened, and that a shell write outside the workspace is refused; in the PR
