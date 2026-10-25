## MODIFIED Requirements

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

