## ADDED Requirements

### Requirement: Memory panel
The avatar menu SHALL include a "Memory" panel listing live memories newest first with kind, course (or "general"), date, origin (agent or owner) and, for agent memories, a link that opens the source conversation. The owner SHALL be able to edit a memory's text and kind, delete it after a confirmation, and add one, through the owner session. Empty state SHALL say that nothing is remembered yet.

#### Scenario: Edit and delete
- **WHEN** the owner edits an agent memory's text and deletes another
- **THEN** the panel shows the new text and no longer shows the deleted memory, and both changes went through the owner session
