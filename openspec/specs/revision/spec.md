# revision Specification

## Purpose
The course page's revision tab: exam information, preset revision prompts that start a session with the assistant on the Agent page, and the revision notes saved from the former built-in chat, which stay listed and can be deleted.
## Requirements
### Requirement: Revision tab shows exams
The Revision tab SHALL list the course's visible exam assessments (after the owner's corrections) with name, date, weight and rule, and SHALL say so when the course has no identified exam. Course materials stay listed below.

#### Scenario: Exam listed
- **WHEN** a course has an exam assessment due on 2026-11-10 worth 60% with a hurdle rule
- **THEN** the Revision tab shows its name, that date, 60% and the rule text

#### Scenario: No exam
- **WHEN** a course has no visible exam assessment
- **THEN** the Revision tab says no exam has been identified for this course

### Requirement: Preset revision prompts open the Agent page
The Revision tab SHALL offer actions that open the Agent page on a new DeepTutor session for that course and send a preset prompt naming the course code and its exams. The prompt SHALL be sent only after the owner clicks the action. When the assistant is not running, the action SHALL open the Agent page, which explains how to start it, and SHALL send nothing.

#### Scenario: Revise with the agent
- **WHEN** the owner clicks "让 Agent 带我复习" on COMP10001 while the assistant is running
- **THEN** the Agent page shows a new DeepTutor session whose first message is a revision prompt that names COMP10001

#### Scenario: Assistant not running
- **WHEN** the owner clicks a preset while DeepTutor is not running
- **THEN** the Agent page shows how to start it and no prompt is sent

### Requirement: Revision notes persist locally
Revision notes SHALL be stored under `.local/revision/` with owner-only file permissions, read and written only through `/api/local/revision-notes` behind the existing same-origin guard. The API SHALL list notes for one course newest first and delete a note by id. It SHALL reject a course id that is not 1–200 characters of letters, digits, `.`, `_`, `:` or `-`. Notes saved before the assistant was replaced SHALL stay listed in the Revision tab, which SHALL say that new notes cannot be saved while the assistant's note features are not installed, and where the conversations are kept.

#### Scenario: Notes survive a restart
- **WHEN** a note exists and the dev server restarts
- **THEN** listing that course returns the note

#### Scenario: Invalid course id
- **WHEN** a list request uses the course id `../x`
- **THEN** the API answers 400

#### Scenario: Delete
- **WHEN** the owner deletes a note
- **THEN** it no longer appears in the list

