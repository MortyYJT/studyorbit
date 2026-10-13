## ADDED Requirements

### Requirement: Scheduled preparation stage
The repository SHALL ship an agent skill whose scheduled stage, run for one course, (1) checks `coursework browser status` and stops with an owner notification if the needed site is signed out; (2) finds the exam scope and course content only through L0 reads of synced data (modules, items, file links) and `source.fetch` results, storing each page or PDF it relies on through `source.fetch` (see "Code fetches citable sources"), and never reads raw pages in the browser itself; (3) writes revision notes and practice questions through the existing validated study-write commands, each claim cited to a stored redacted source; and (4) notifies the owner that material is ready, with counts of notes, questions and rejected writes. It MUST NOT answer graded work, run above L1, or store raw course content outside `.local/`. Classmates' personal data MUST be stripped before course content reaches the model, per the project privacy red line: the model sees course content only after `source.fetch` or sync has redacted it.

#### Scenario: Signed out at schedule time
- **WHEN** the scheduled stage starts and Canvas is signed out
- **THEN** it reads nothing, writes nothing and notifies the owner to sign in

#### Scenario: Rejected citation
- **WHEN** one generated note cites text not found in its source
- **THEN** that note is rejected, the others are stored, and the notification reports one rejected write

### Requirement: Interactive tutoring stage
When the owner opens a conversation, the skill's interactive stage SHALL read the stored notes and practice questions for the chosen course, quiz the owner, explain answers with their stored citations, and record the owner's weak topics in the course's revision notes through `revision.write`. It SHALL say plainly when stored material does not cover a question rather than inventing a source.

#### Scenario: Question outside stored material
- **WHEN** the owner asks about a topic with no stored note
- **THEN** the agent says the material does not cover it and offers to prepare it, without fabricating a citation

### Requirement: Code fetches citable sources
A `source.fetch` command SHALL take a Canvas or Ed URL on the validated provider origins, read it through the resident browser with a same-origin GET (JSON, HTML page text, or a PDF), extract text (PDF text per one-based page with the pre-approved `unpdf`), redact it, and store it as SourceItems of kind `material` (one per PDF page) with a content hash. The agent SHALL NOT supply source text itself. Off-origin URLs, external redirects, non-GET methods and responses over a size bound SHALL be refused. Raw downloads SHALL stay private under `<data dir>/materials/` with owner-only permissions. Image-only pages SHALL be stored with empty text and reported, not guessed.

#### Scenario: Lecture PDF
- **WHEN** the agent asks to fetch a synthetic three-page Canvas PDF
- **THEN** three material SourceItems exist with page locators 1–3, and a note quoting page 2 passes the citation check

#### Scenario: Off-origin link
- **WHEN** the URL points outside the Canvas and Ed origins or redirects there
- **THEN** nothing is fetched or stored and the refusal names the reason

### Requirement: Study records persist
Records accepted by `revision.write`, `practice.write` and `breakdown.write` SHALL be stored durably in the local SQLite database (owner choice, 2026-10-14) with their id, revision and validated JSON, keeping the existing compare-and-swap publication rule. Reads SHALL return the current revision after a process restart.

#### Scenario: Survives restart
- **WHEN** a revision note is accepted and the process restarts
- **THEN** reading that note returns the same revision and content

### Requirement: Ready before finals
The scheduled and interactive stages SHALL be usable on at least one real course by 2026-10-26 (#102). Owner acceptance SHALL be recorded separately from synthetic tests.

#### Scenario: Acceptance record
- **WHEN** the owner runs both stages on one real course
- **THEN** the PR or handoff records the actual outcome and any failures, and synthetic test success is not reported as acceptance
