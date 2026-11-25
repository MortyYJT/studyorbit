## REMOVED Requirements

### Requirement: Tool-calling chat for DeepSeek, OpenAI-compatible and Anthropic
**Reason**: DeepTutor runs the chat and the tool loop (owner's decision, 2026-11-24).
**Migration**: Use the Agent page, which shows DeepTutor; the same six tools are called through the MCP server. Removed in the deletion PR, after the DeepTutor path is validated.

### Requirement: Grade arithmetic comes from tools
**Reason**: The self-built chat prompt that enforced it is deleted.
**Migration**: The house-rules skill in `deeptutor-assistant` carries the same rule for DeepTutor.

### Requirement: Codex keeps context mode
**Reason**: The self-built chat is deleted; DeepTutor is not offered with the Codex provider.
**Migration**: Choose DeepSeek, an OpenAI-compatible service or Anthropic in the model settings to use the assistant.

### Requirement: Fallback when an OpenAI-compatible endpoint rejects tools
**Reason**: The self-built tool loop is deleted.
**Migration**: None; DeepTutor reports a provider's refusal in its own page.

### Requirement: Bounded tool loop
**Reason**: The self-built tool loop is deleted; DeepTutor bounds its own loop.
**Migration**: None.

### Requirement: Planning snapshot sent with each message
**Reason**: StudyOrbit no longer sends chat messages.
**Migration**: The page stores the snapshot through `PUT /api/local/agent-context` and the MCP server reads it (`local-api-server`, `course-mcp-server`).

### Requirement: Tool steps are streamed, stored and shown
**Reason**: DeepTutor's page shows tool calls.
**Migration**: None.

### Requirement: Stored chat format stays compatible
**Reason**: StudyOrbit no longer stores chats.
**Migration**: Existing files in `.local/chat/` are left in place and are not read any more; they can be deleted by hand.
