## ADDED Requirements

### Requirement: Study records persist
Records accepted by `revision.write`, `practice.write` and `breakdown.write` SHALL be stored durably in the local SQLite database (#108) with their id, revision and validated JSON, keeping the existing compare-and-swap publication rule. Reads SHALL return the current revision after a process restart.

#### Scenario: Survives restart
- **WHEN** a revision note is accepted and the process restarts
- **THEN** reading that note returns the same revision and content

### Requirement: Code fetches citable sources
A `source.fetch` command SHALL take a Canvas or Ed URL on the validated provider origins, read it through the resident browser with a same-origin GET (JSON, HTML page text, or a PDF), extract text (PDF text per one-based page with the pre-approved `unpdf`), redact it, and store it as SourceItems of kind `material` (one per PDF page) with a content hash (#109). The agent SHALL NOT supply source text itself. Discussion threads and replies, off-origin URLs, external redirects, non-GET methods and responses over a size bound SHALL be refused. Raw downloads SHALL stay private under `<data dir>/materials/` with owner-only permissions. Image-only pages SHALL be stored with empty text and reported, not guessed.

#### Scenario: Lecture PDF
- **WHEN** the agent asks to fetch a synthetic three-page Canvas PDF
- **THEN** three material SourceItems exist with page locators 1–3, and a note quoting page 2 passes the citation check

#### Scenario: Discussion thread
- **WHEN** the agent asks `source.fetch` for an Ed or Canvas discussion thread
- **THEN** it is refused, because discussion content is not a revision source

#### Scenario: Off-origin link
- **WHEN** the URL points outside the Canvas and Ed origins or redirects there
- **THEN** nothing is fetched or stored and the refusal names the reason

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
The repository SHALL ship an agent skill used by the "prepare revision", "tutor revision" and "wrong answers only" presets. Preparing SHALL check `browser.status` first and stop with a clear message if the needed site is signed out; find the exam scope and course content only through L0 reads and `source.fetch` (never reading discussion threads); and write the exam scope, revision notes and practice questions through the validated writes, each claim cited to a stored redacted source, reporting counts of accepted and rejected writes in the chat. Tutoring SHALL read the stored notes and questions, quiz the owner, explain answers with their stored citations, record attempts, and say plainly when stored material does not cover a question rather than inventing a source. The skill MUST NOT answer graded work. There is no scheduled stage in v1 (#127, #144).

#### Scenario: Signed out
- **WHEN** preparation starts and Canvas is signed out
- **THEN** it reads nothing, writes nothing and asks the owner to sign in

#### Scenario: Question outside stored material
- **WHEN** the owner asks about a topic with no stored note
- **THEN** the agent says the material does not cover it and offers to prepare it, without fabricating a citation
