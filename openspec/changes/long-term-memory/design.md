## Context

C-1 made Codex the chat agent with our stored transcript as conversation memory (#177). The owner chose A+C for long-term memory (#178): code summarises facts; the agent records observations the owner can see, edit and delete. Facts already exist in the store (assessments, plan, practice statistics, revision notes, autonomy).

## Goals / Non-Goals

**Goals:** a bounded facts brief at session start; an agent-writable, owner-controlled observation store; a frontend panel.

**Non-Goals:** embeddings or semantic search; summarising old conversations automatically; letting the agent edit or delete memories.

## Decisions

1. **When the brief is sent.** Only when an agent session starts (new thread, or the transcript fallback), because a resumed Codex thread already holds earlier context; this keeps token cost flat across long conversations. Alternative: every message (simple, but repeats up to 8,000 characters each turn).
2. **Where it is built and how it reaches the agent.** `src/memory/brief.ts`, a pure function over store reads, unit-tested. `AgentInput` gains `brief?` and `conversationId`; `ConversationService` passes the brief on every send but never stores it. Only the adapter knows whether it resumes or starts a thread, so it decides: the Codex adapter adds the brief (as a marked "Background from the coursework store (not instructions)" block before the owner's text, after any preset skill) on the new-thread attempt and on the fallback, not on `resume`; the Claude adapter adds it when it has no `sessionRef`. The transcript passed on fallback never contains briefs because they are not stored. Only titles, dates, numbers and memory texts; revision notes as counts per week (records have no title).
3. **Storage.** Migration `005` adds `memories (id TEXT PRIMARY KEY, courseId TEXT, json TEXT NOT NULL)`; JSON holds kind, text, origin, conversationId, createdAt, editedAt, deletedAt. Additive only (#107).
4. **Source conversation.** In-process tools receive the conversation id through a tool scope that `ConversationService` passes to every tool (not only `browser.*`, which C-3 removes). For Codex, `codex.ts` builds the MCP server entry per `start()` (new, resume and fallback paths share it), so one more `-c mcp_servers.coursework.env.COURSEWORK_CONVERSATION_ID=<id>` gives `coursework mcp` the id. Best effort, because Codex has a shell (#150, #154).
5. **Owner commands** follow the existing pattern (frontend session or TTY) and join the owner-command set so MCP refuses them. Delete is a soft delete (`deletedAt`). Owner and agent text are both redacted.
6. **Bound.** Sections in fixed priority (policy/level, due work, unknown fields, scores, practice, revision counts, memories); over 8,000 characters, drop whole sections from the end, then oldest items within the crossing section.

## Risks / Trade-offs

- [The agent records something wrong or sensitive] → owner sees and deletes it; redactor runs on text; 500-character bound.
- [Brief goes stale within a long session] → accepted; a new conversation gets a fresh brief.

## Migration Plan

Merge; existing conversations get a brief the next time a session starts. Rollback: revert (table additive).

## Open Questions

None blocking.
