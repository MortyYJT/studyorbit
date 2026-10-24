## Why

The owner wants the agent to remember them across conversations (#177, #178): facts about their progress, and what the agent has observed about how they study. Conversations already keep their own transcript (#177), but nothing carries knowledge from one conversation to the next. This change, sub-project C-4, adds that long-term memory with the owner in control.

## What Changes

- **Facts brief (code):** when an agent session starts, the backend prepends a bounded brief built from the store: open work due in the next 14 days, recent scores, practice statistics (wrong-answer counts), revision-note titles, fields still unknown, and the course's AI policy and level, for the conversation's course or, without one, for all selected courses. Code builds it; the agent never writes it.
- **Observations (agent):** a new agent command `memory.record { courseId?, kind, text }` (`kind`: `habit` | `weakness` | `preference` | `other`; text ≤ 500 characters, redacted) stores an observation with its date and the conversation it came from. Agents cannot edit or delete memories.
- **Owner control:** owner commands `memory.edit`, `memory.delete` (kept as deleted, never shown or sent again) and `memory.add`; L0 read `memory.list`. Up to 20 newest live memories (course-specific first, then general) are included in the brief.
- **Frontend:** a "Memory" panel in the avatar menu lists memories with kind, course, date and source conversation, with edit, delete and add.

## Capabilities

### New Capabilities

- `long-term-memory`: facts brief, agent observations, owner control.

### Modified Capabilities

- `web-ui`: adds the Memory panel requirement (ADDED, no existing requirement changes).

## Impact

- Code: `src/memory/` (brief builder, memory service), registry commands, migration `005` (`memories` table, additive), `ConversationService` prepends the brief when a session starts, `web/src/MemoryPanel.tsx`.
- No new dependencies.
