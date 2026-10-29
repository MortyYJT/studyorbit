## ADDED Requirements

### Requirement: Revision tab shows exams
The Revision tab SHALL list the course's visible exam assessments (after the owner's corrections) with name, date, weight and rule, and SHALL say so when the course has no identified exam. Course materials stay listed below.

#### Scenario: Exam listed
- **WHEN** a course has an exam assessment due on 2026-11-10 worth 60% with a hurdle rule
- **THEN** the Revision tab shows its name, that date, 60% and the rule text

#### Scenario: No exam
- **WHEN** a course has no visible exam assessment
- **THEN** the Revision tab says no exam has been identified for this course

### Requirement: Preset revision prompts open the Agent page
The Revision tab SHALL offer actions that open the Agent page in a new chat scoped to that course and send a preset prompt naming the course code and its exams. The prompt SHALL be sent only after the owner clicks the action.

#### Scenario: Revise with the agent
- **WHEN** the owner clicks "让 Agent 带我复习" on COMP10001
- **THEN** the Agent page opens a new chat scoped to COMP10001 and sends a revision prompt that names COMP10001

### Requirement: Save an agent reply as a revision note
In a chat scoped to exactly one course, each finished assistant reply SHALL offer "存到复习", which saves the reply text as a revision note for that course. Replies that ended in an error are not offered.

#### Scenario: Note saved
- **WHEN** the owner saves a finished reply in a chat scoped to one course
- **THEN** the note appears in that course's Revision tab with its title, save time and full text

#### Scenario: Multi-course chat
- **WHEN** a chat is scoped to more than one course
- **THEN** its replies do not offer "存到复习"

### Requirement: Revision notes persist locally
Revision notes SHALL be stored under `.local/revision/` with owner-only file permissions, read and written only through `/api/local/revision-notes` behind the existing same-origin guard. The API SHALL list notes for one course newest first, create a note, and delete a note by id. It SHALL reject a course id that is not 1–200 characters of letters, digits, `.`, `_`, `:` or `-`, note text that is empty or longer than 20,000 characters, and a new note when the course already has 200.

#### Scenario: Notes survive a restart
- **WHEN** a note is saved and the dev server restarts
- **THEN** listing that course returns the note

#### Scenario: Invalid course id
- **WHEN** a create request uses the course id `../x`
- **THEN** the API answers 400 and writes nothing

#### Scenario: Delete
- **WHEN** the owner deletes a note
- **THEN** it no longer appears in the list
