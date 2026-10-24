## Why

The owner already uses Codex with its computer-use feature to work in their own signed-in Edge (decision #167), and a spike on 2026-10-24 showed a non-interactive `codex exec` reading their Ed dashboard in 23–30 seconds. The Claude Agent SDK adapter cannot act in the owner's own browser, so every agent task should move to Codex. This change is sub-project 1 of 3 of that rescope (#174): it swaps the chat agent; agent course reading (2) and removing the resident browser (3) follow as their own changes.

## What Changes

- Add a Codex adapter behind the existing agent adapter interface. It starts the owner's signed-in `codex` CLI as a child process (`codex exec --json`, `codex exec resume <id> --json`), maps its JSONL events to our agent events, and interrupts by stopping the child. No new dependency.
- **BREAKING (behaviour):** production chat uses the Codex adapter by default. The Claude adapter stays in the code and is selected only with `COURSEWORK_AGENT=claude` (#167).
- Codex reaches our tools through the existing `coursework mcp` stdio server (agent commands only). Our resident-browser tools (`browser.*`) are not offered to Codex; it uses its own computer-use feature on the owner's Edge instead.
- Guardrails become instructions (#173): a dedicated agent workspace holds an `AGENTS.md` that tells Codex never to press a final submit button, to stay read-only on courses whose policy prohibits AI, and to respect the owner's levels. The workspace lives outside the repository, and shell commands run in Codex's `workspace-write` sandbox rooted there; Codex also stops at sign-in pages and never types passwords.
- Cost: Codex reports tokens, not money, so reply cost is stored as unknown, never zero.
- Repository `AGENTS.md` red lines (data access, privacy, autonomy) record what changes for Codex (#168, #173).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-chat`: the adapter requirement names Codex as the default adapter, keeps Claude as an alternative and lets a conversation continue across adapters; the tool-policy requirement replaces the Claude pre-tool hook with Codex's sandbox, the stdio MCP tool server and workspace instructions outside the repository.
- `resident-browser`: the visible-actions requirement no longer claims to cover agents that act on the screen directly; Codex's on-screen actions are outside it (#168).

## Impact

- Code: new `src/agent/codex.ts`; adapter selection in `src/protocol/production.ts`; workspace `AGENTS.md` written at session start; tests with a fake `codex` executable.
- Docs: repository `AGENTS.md` red lines (data access, privacy, autonomy); `note/handoff.md`; `note/product/roadmap.md`.
- Runtime: requires the owner's `codex` CLI on `PATH`, signed in, with its computer-use plugin enabled in the owner's Codex config. Missing or signed out returns `AGENT_UNAVAILABLE`.
- Not changed here: sync, the resident browser and its tools, the frontend.
