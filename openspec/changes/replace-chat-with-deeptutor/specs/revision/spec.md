## MODIFIED Requirements

### Requirement: Preset revision prompts open the Agent page
The Revision tab SHALL offer actions that open the Agent page on a new DeepTutor session for that course and send a preset prompt naming the course code and its exams. The prompt SHALL be sent only after the owner clicks the action. When the assistant is not running, the action SHALL open the Agent page, which explains how to start it, and SHALL send nothing.

#### Scenario: Revise with the agent
- **WHEN** the owner clicks "让 Agent 带我复习" on COMP10001 while the assistant is running
- **THEN** the Agent page shows a new DeepTutor session whose first message is a revision prompt that names COMP10001

#### Scenario: Assistant not running
- **WHEN** the owner clicks a preset while DeepTutor is not running
- **THEN** the Agent page shows how to start it and no prompt is sent

### Requirement: Revision notes persist locally
Revision notes SHALL be stored under `.local/revision/` with owner-only file permissions, read and written only through `/api/local/revision-notes` behind the existing same-origin guard. The API SHALL list notes for one course newest first and delete a note by id. It SHALL reject a course id that is not 1–200 characters of letters, digits, `.`, `_`, `:` or `-`. Notes saved before the assistant was replaced SHALL stay listed in the Revision tab, which SHALL say that new notes are kept in the assistant's own notebook.

#### Scenario: Notes survive a restart
- **WHEN** a note exists and the dev server restarts
- **THEN** listing that course returns the note

#### Scenario: Invalid course id
- **WHEN** a list request uses the course id `../x`
- **THEN** the API answers 400

#### Scenario: Delete
- **WHEN** the owner deletes a note
- **THEN** it no longer appears in the list

## REMOVED Requirements

### Requirement: Save an agent reply as a revision note
**Reason**: Replies are rendered by DeepTutor's page inside a frame; StudyOrbit no longer sees them and cannot offer "存到复习" on them.
**Migration**: Save replies in DeepTutor's notebook. Notes already saved stay in the Revision tab and can be read and deleted there. The create operation of `/api/local/revision-notes` is removed in the deletion PR together with the old chat page that was its only caller.
