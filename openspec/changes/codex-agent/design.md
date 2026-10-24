## Context

`v1-delivery` shipped a chat backend behind an adapter interface (`src/agent/adapter.ts`) with one adapter on the Claude Agent SDK (`src/agent/claude.ts`): in-process MCP tools, a pre-tool policy hook, a dedicated workspace. Our own browser tools drive a resident Edge with a separate profile over remote debugging, because Chromium 136+ ignores remote debugging on the default profile.

On 2026-10-24 the owner chose to move every agent task to Codex working in their own signed-in Edge (decisions #165–#175). Spikes that day showed:
- `codex exec` (non-interactive) can use Codex's computer-use tool on the owner's Edge without a new permission prompt; reading the Ed dashboard took 23–30 s.
- Edge's accessibility tree omitted visible course names; a screenshot read them. This drives sub-project 2's "tree first, screenshot for empty fields" rule (#170).
- `codex exec --json` prints JSONL: `thread.started {thread_id}`, `turn.started`, `item.started|completed {item}` (agent messages, tool calls, commands), `turn.completed {usage}` with token counts and no money cost. `codex exec resume <id>` continues a thread. `--output-schema` constrains the final message.
- Codex reads `AGENTS.md` files from the Git root down to its working directory. The default data directory is `<repo>/.local`, inside the repository, so a workspace there would also load the repository's own development instructions.

## Goals / Non-Goals

**Goals:**
- Codex is the default chat agent, with streaming, resume, stop, tool steps and safe errors matching the existing `agent-chat` contract.
- Codex uses our agent commands through `coursework mcp`, and the owner's Edge through its own computer-use feature.
- The submit guardrail and course-policy rules reach every session as workspace instructions.

**Non-Goals:**
- Agent course reading and removing the API sync (sub-project 2, change `agent-course-reading`).
- Removing the resident Edge, our `browser.*` tools and the submit-confirmation flow (sub-project 3, change `codex-browser-cleanup`).
- Frontend changes. Metrics changes beyond storing unknown cost.

## Overall plan (all three sub-projects)

| # | Change | Content | Depends on |
| --- | --- | --- | --- |
| 1 | `codex-agent` (this) | Codex adapter, tool exposure, workspace instructions, privacy red line | — |
| 2 | `agent-course-reading` | Owner ticks courses in the frontend; Codex fills the three-level JSON (#169) and submits it through a validated MCP command; code checks format, sanity and required fields, returns errors for at most 2 retries (#170), writes the store; `unknown` fields re-checked each sync; per-item weights split evenly as `derived` (#171); earned score computed by code; Canvas/Ed API sync code deleted (#172) | 1 |
| 3 | `codex-browser-cleanup` | Delete the resident Edge, `browser.*` tools, sign-in front command and submit-confirmation UI; frontend and specs follow; agent instructions keep "stop before final submit" (#173) | 1, 2 |

Specs for 2 and 3 are written when each starts (roadmap rule).

## Decisions

### 1. Child process, not an SDK
Spawn `codex` with `child_process.spawn` and parse JSONL. Alternatives: an npm Codex SDK (a new, unapproved dependency, and the CLI is what the owner already signed in to); the Codex app server protocol (more surface for no gain). Arguments are passed as an array, never through a shell, with a minimal environment (`HOME`, `PATH`, `TMPDIR`, `CODEX_HOME`), as the Claude adapter does. Because the MCP server is a separate process, its entry also carries `COURSEWORK_HOME` set to the host's resolved data directory, so it opens the same store.

Invocation, new thread: `codex exec --json --skip-git-repo-check -C <workspace> -s workspace-write -c mcp_servers.coursework.command=<node> -c mcp_servers.coursework.args=[<cli.js>,"mcp"] -c mcp_servers.coursework.env.COURSEWORK_MCP_PROFILE="codex" -c mcp_servers.coursework.env.COURSEWORK_HOME=<data dir> -` with the prompt on stdin. Later messages: `codex exec resume <thread_id> --json ...` with the same options; task 2.1 checks which of these options `resume` accepts and that computer-use still works under `workspace-write` (the 2026-10-24 spikes ran with `-s read-only`). The prompt carries the preset's skill text when a preset applies, as today.

### 2. Event mapping
| Codex JSONL | Agent event |
| --- | --- |
| `thread.started.thread_id` | kept as `sessionRef` |
| `item.completed` with an agent message | `text` |
| `item.completed` with an MCP tool call or command execution | `tool_step` (`ok`, or `error` on failure; tool name `server.tool` or `shell`) |
| `turn.completed` | counts one turn; at process exit a `result` with turns, `sessionRef`, no `costUsd` |
| non-zero exit with an auth message, or `spawn` ENOENT | `error AGENT_UNAVAILABLE` |
| other failures | `error INTERNAL` with a fixed safe message |
Unknown item types are ignored. Raw Codex output is never stored or logged (it can contain page text).

### 3. Tools through `coursework mcp` with a Codex profile
Codex cannot take in-process tools, so the adapter points it at our existing stdio MCP server. A `COURSEWORK_MCP_PROFILE=codex` environment variable, set only in the child's MCP server entry, removes `browser.*` from the listed tools; owner commands are already absent from MCP. Alternative: a new CLI flag on `coursework mcp` (the CLI currently treats `mcp` with extra arguments as an error; an environment variable keeps that rule).

### 4. Guardrails as workspace instructions, sandbox for the shell
The Claude pre-tool hook (which also blocked pseudo-terminal wrappers such as `script`) cannot apply to Codex. The code-side protection is Codex's `workspace-write` sandbox: shell writes outside the workspace and shell network access are refused, so an owner command the agent starts through a pseudo-terminal cannot write our database. The adapter never passes `--dangerously-bypass-approvals-and-sandbox` or `--approve-for-me`. Owner protections that do not depend on the agent stay: the owner session exists only in memory; session-only commands (levels, overrides, submit confirmation) refuse anything but the frontend session. The adapter writes the workspace `AGENTS.md` at every session start (fixed English text in `src/agent/codex-instructions.md`): no final submit (#173), stop at sign-in pages and never type a password or code (the data-access red line), prohibited courses read-only (#124), granted levels only, no other sites or tabs (Claude's addition, #176). Accepted (#168): screen content is not redacted, and on-screen actions are not blocked or audited by code.

### 4a. Workspace outside the repository
The workspace is `~/.coursework/codex-workspace/<first 12 hex of sha256(data dir)>`, created with mode 0700, so no repository `AGENTS.md` above it applies and two data directories never share one. Alternative: disabling Codex's project-doc discovery by configuration (relies on an undocumented-to-us option and still leaves the workspace inside the repository).

### 5. Adapter selection
`createProductionProtocol` uses `CodexAdapter` unless `COURSEWORK_AGENT=claude`. The Claude adapter, its SDK dependency and its tests stay (#167).

### 6. Stop
`interrupt()` sends `SIGTERM` to the child, then `SIGKILL` after 3 s if it has not exited. The conversation service already stores the partial reply with a stopped marker.

## Risks / Trade-offs

- [Codex acts on the screen; our code cannot block a submit click or a prohibited course] → workspace `AGENTS.md` rules; sub-project 3 keeps "stop before final submit"; accepted by the owner (#168, #173).
- [Unredacted classmates' data reaches the model while browsing] → accepted (#168); repository `AGENTS.md` red line updated so the exception is explicit.
- [JSONL format changes between Codex versions] → parse only the fields in the table, ignore unknown items, test against recorded synthetic lines; the adapter fails closed to `INTERNAL`.
- [No money cost from Codex] → stored as unknown; metrics already count unknown costs separately.
- [Codex works in the owner's visible Edge while they use it] → instructions tell Codex to open its own tab; the frontend notice belongs to sub-project 2.
- [The `workspace-write` sandbox still allows reading files outside the workspace] → no secret is on disk; local snapshots may hold page text (accepted, #168).

## Migration Plan

Merge with Codex as default. Rollback: set `COURSEWORK_AGENT=claude`, or revert the PR. No data migration. `ConversationService.send` currently refuses a conversation whose stored adapter differs (`CONFLICT`); task 3.3 changes it so the current adapter continues from the stored transcript without the old session reference and records its own adapter id and thread id (scenario "Conversation from another adapter"). The same path makes rollback to `COURSEWORK_AGENT=claude` keep Codex conversations usable.

## Open Questions

None blocking. Task 2.1 checks against real output: the item shape of computer-use calls (if no reliable tool name, those steps are stored as `computer` steps), which options `codex exec resume` accepts, and that computer-use works under `workspace-write`.
