## 1. Tool exposure for Codex

- [ ] 1.1 Failing test: with `COURSEWORK_MCP_PROFILE=codex`, the `coursework mcp` tool list has no `browser.*` and no owner command; without it the list is unchanged (scenario "No resident-browser tools")
- [ ] 1.2 Implement the profile filter in the MCP server; keep the MCP tool-count assertion in `test/cli.test.ts` for the default profile

## 2. Codex adapter

- [ ] 2.1 Record a few real `codex exec --json` lines (agent message, MCP tool call ok and failed, command execution, turn completed; synthetic content only) as test fixtures; note any computer-use item shape
- [ ] 2.2 Failing tests with a fake `codex` executable on `PATH`: "Codex events" mapping, "Resume" arguments, "Stop a Codex reply" (SIGTERM then SIGKILL), "Agent not signed in" (missing executable and auth exit), unknown item types ignored, raw output never stored
- [ ] 2.3 Implement `src/agent/codex.ts`: spawn with argument arrays and a minimal environment, stdin prompt with preset skill text, JSONL parsing, event mapping, interrupt
- [ ] 2.4 Failing test then implementation: the workspace `AGENTS.md` (from `src/agent/codex-instructions.md`) is written before the child starts and holds the no-final-submit, prohibited-course and granted-level rules (scenario "Workspace instructions")

## 3. Wiring and policy

- [ ] 3.1 Failing test then implementation: `createProductionProtocol` uses the Codex adapter by default and the Claude adapter with `COURSEWORK_AGENT=claude` (scenario "Claude on request")
- [ ] 3.2 Tests for "Owner command through the shell" (non-TTY owner command refused, failed step stored) and "Reading the owner session" (no file under a temporary data directory holds the secret while a conversation runs)
- [ ] 3.3 Repository `AGENTS.md`: privacy red line records the accepted unredacted-browsing exception (#168) and the Codex agent (#167); keep it short

## 4. Verification

- [ ] 4.1 `openspec validate codex-agent --strict`, `bash .claude/check.sh` (exit code), `npm run build`
- [ ] 4.2 Owner live check (moved from `v1-delivery` 10.4): `coursework ui`, one real conversation that asks Codex to read the Ed dashboard in the owner's Edge; record steps, turns, duration and that no submit happened, in the PR
