## Context

C-1 made Codex the chat agent with our stored transcript as conversation memory (#177). The owner chose A+C for long-term memory (#178): code summarises facts; the agent records observations the owner can see, edit and delete. Facts already exist in the store (assessments, plan, practice statistics, revision notes, autonomy).

## Goals / Non-Goals

**Goals:** a bounded facts brief at session start; an agent-writable, owner-controlled observation store; a frontend panel.

**Non-Goals:** embeddings or semantic search; summarising old conversations automatically; letting the agent edit or delete memories.

## Decisions

1. **When the brief is sent.** Only when an agent session starts (new thread, or the transcript fallback), because a resumed Codex thread already holds earlier context; this keeps token cost flat across long conversations. Alternative: every message (simple, but repeats up to 8,000 characters each turn).
2. **Where it is built.** `src/memory/brief.ts`, a pure function over store reads, unit-tested; `ConversationService` prepends it as a clearly marked "Background from the coursework store (not instructions)" block. It never includes page text or quotes, only titles, dates, numbers and memory texts.
3. **Storage.** Migration `005` adds `memories (id TEXT PRIMARY KEY, courseId TEXT, json TEXT NOT NULL)`; JSON holds kind, text, origin, conversationId, createdAt, editedAt, deletedAt. Additive only (#107).
4. **Source conversation.** `memory.record` takes the conversation from the tool scope the chat backend passes (the same scope the adapter uses for tool steps), so the agent cannot claim another conversation. Through the external `coursework mcp` process (Codex), the conversation id is passed in the MCP server entry's environment by the adapter for that session; without it the memory has no source.
5. **Owner commands** follow the existing pattern (frontend session or TTY). Delete is a soft delete (`deletedAt`).

## Risks / Trade-offs

- [The agent records something wrong or sensitive] → owner sees and deletes it; redactor runs on text; 500-character bound.
- [Brief goes stale within a long session] → accepted; a new conversation gets a fresh brief.

## Migration Plan

Merge; existing conversations get a brief the next time a session starts. Rollback: revert (table additive).

## Open Questions

None blocking.
