## MODIFIED Requirements

### Requirement: Code fetches citable sources
A `source.record` agent command SHALL take a course id, a Canvas or Ed page URL on the validated provider origins that belongs to that course (a Canvas URL under one of the course's Canvas course ids, an Ed URL under one of its Ed course ids, both from `course.sources`), its title, the text the agent read from that page in the owner's Edge, and for a PDF a one-based page number, redact the text with the deterministic redactor, and store it as a SourceItem of kind `material` (one per PDF page) marked as copied by the agent, with a content hash. This replaces the resident-browser `source.fetch` and partly overturns #109: the agent supplies the text, so a citation shows that a quote is in the recorded text, not that the page says it (#166, #187). Discussion-thread URLs, off-origin URLs, URLs of another course and texts whose JSON encoding exceeds 60,000 UTF-8 bytes per page SHALL be refused with `LIMIT_EXCEEDED` and a message telling the agent to record the page in parts (`#part-2`, …), so that `sources.get` of the largest recorded page fits the 64 KiB envelope. An empty text SHALL be stored as empty and reported, not guessed. Recording the same URL and page again SHALL replace its text and content hash, so earlier quotes that are no longer in the text fail later citation checks. The redactor masks emails, phone numbers, student numbers and named-student patterns in agent text, but cannot find classmates' names without a structured author list; this weaker redaction is accepted (#168), and discussion threads stay refused.

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

### Requirement: Revision skill
The repository SHALL ship an agent skill used by the "prepare revision", "tutor revision" and "wrong answers only" presets. Preparing SHALL stop with a clear message when the needed site shows a sign-in page; find the exam scope and course content through L0 reads and the owner's Edge, recording what it cites with `source.record` (never discussion threads); and write the exam scope, revision notes and practice questions through the validated writes, each claim cited to a stored redacted source, reporting counts of accepted and rejected writes in the chat. Tutoring SHALL read the stored notes and questions, quiz the owner, explain answers with their stored citations, record attempts, and say plainly when stored material does not cover a question rather than inventing a source. The skill MUST NOT answer graded work. There is no scheduled stage in v1 (#127, #144).

#### Scenario: Signed out
- **WHEN** preparation starts and Canvas shows a sign-in page
- **THEN** it reads nothing, writes nothing and asks the owner to sign in

#### Scenario: Question outside stored material
- **WHEN** the owner asks about a topic with no stored note
- **THEN** the agent says the material does not cover it and offers to prepare it, without fabricating a citation
