# revision Specification

## Purpose
TBD - created by archiving change v1-delivery. Update Purpose after archive.
## Requirements
### Requirement: Study records persist
Records accepted by `revision.write`, `practice.write` and `breakdown.write` SHALL be stored durably in the local SQLite database (#108) with their id, revision and validated JSON, keeping the existing compare-and-swap publication rule. Reads SHALL return the current revision after a process restart.

#### Scenario: Survives restart
- **WHEN** a revision note is accepted and the process restarts
- **THEN** reading that note returns the same revision and content

### Requirement: Code fetches citable sources
A `source.record` agent command SHALL take a course id, a Canvas or Ed page URL on the validated provider origins that belongs to that course (a Canvas URL under one of the course's Canvas course ids, an Ed URL under one of its Ed course ids, both from `course.sources`), its title, the text the agent read from that page in the owner's Edge, and for a PDF a one-based page number, and store the text as given (not redacted; #191) as a SourceItem of kind `material` (one per PDF page) marked as copied by the agent, with a content hash. This replaces the resident-browser `source.fetch` and partly overturns #109: the agent supplies the text, so a citation shows that a quote is in the recorded text, not that the page says it (#166, #187). Discussion-thread URLs, Canvas announcement URLs (they can carry replies), authentication URLs (an auth, login, token, password or credential path segment, or a credential word in the query or fragment), off-origin URLs, URLs of another course (matched on the undecoded path) and texts whose JSON encoding exceeds 60,000 UTF-8 bytes per page SHALL be refused with `LIMIT_EXCEEDED` and a message telling the agent to record the page in parts (`#part-2`, …), so that `sources.get` of the largest recorded page fits the 64 KiB envelope. An empty text SHALL be stored as empty and reported, not guessed. Recording the same URL and page again SHALL replace its text and content hash, so earlier quotes that are no longer in the text fail later citation checks. Discussion threads stay refused because they are not revision sources. Invisible format characters are dropped; all other text, including emails, names and credential-shaped values, is kept.

#### Scenario: Lecture PDF
- **WHEN** the agent records the text of pages 1–3 of a synthetic Canvas PDF
- **THEN** three material SourceItems marked as copied by the agent exist with page locators 1–3, and a note quoting page 2 passes the citation check

#### Scenario: Discussion thread
- **WHEN** the agent calls `source.record` with an Ed or Canvas discussion-thread URL
- **THEN** it is refused, because discussion content is not a revision source

#### Scenario: Page of another course
- **WHEN** the agent records an Ed lesson URL whose Ed course id belongs to another course
- **THEN** nothing is stored and the refusal names the course mismatch

#### Scenario: Off-origin link
- **WHEN** the URL points outside the Canvas and Ed origins
- **THEN** nothing is stored and the refusal names the reason

### Requirement: Exam scope is a cited record
The agent SHALL be able to record, per course, the exam's scope as a revision record of type `exam-scope` whose topics each cite a stored source (#142). The exam's time SHALL come from the effective `due` of the course's final assessment. Reads SHALL return the scope with its citations, or report that none is recorded.

#### Scenario: Scope with a citation
- **WHEN** the agent records three topics, each quoting the stored exam-information page
- **THEN** the course's revision tab shows the three topics with their source links

#### Scenario: Uncited topic
- **WHEN** one topic's quote is not in the cited source
- **THEN** the whole write is rejected and the previous scope stays

### Requirement: Practice attempts are recorded
During tutoring, the agent SHALL record each of the owner's attempts at a stored practice question with `practice.attempt.record`: question id, revision, outcome (`correct`, `incorrect`, `skipped`) and time. The owner's answer text SHALL NOT be stored. Reads SHALL return per-course counts (questions, attempted, correct, incorrect) and the list of questions whose latest attempt is incorrect ("wrong answers only", #144).

#### Scenario: Wrong answers only
- **WHEN** question q1's latest attempt is incorrect and q2's latest is correct after an earlier incorrect one
- **THEN** the wrong-answer list contains q1 and not q2

### Requirement: Revision skill
The repository SHALL ship an agent skill used by the "prepare revision", "tutor revision" and "wrong answers only" presets. Preparing SHALL stop with a clear message when the needed site shows a sign-in page; find the exam scope and course content through L0 reads and the owner's Edge, recording what it cites with `source.record` (never discussion threads); and write the exam scope, revision notes and practice questions through the validated writes, each claim cited to a stored source, reporting counts of accepted and rejected writes in the chat. Tutoring SHALL read the stored notes and questions, quiz the owner, explain answers with their stored citations, record attempts, and say plainly when stored material does not cover a question rather than inventing a source. The skill MUST NOT answer graded work. There is no scheduled stage in v1 (#127, #144).

#### Scenario: Signed out
- **WHEN** preparation starts and Canvas shows a sign-in page
- **THEN** it reads nothing, writes nothing and asks the owner to sign in

#### Scenario: Question outside stored material
- **WHEN** the owner asks about a topic with no stored note
- **THEN** the agent says the material does not cover it and offers to prepare it, without fabricating a citation

