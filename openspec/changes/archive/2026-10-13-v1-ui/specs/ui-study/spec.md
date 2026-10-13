## ADDED Requirements

### Requirement: Cited course and week study content
The study page SHALL read notes and practice per course/week through `revision.list` and `practice.list`, render claim citations and evidence limitations, and resolve trusted source/PDF page through M2. Empty, partial, unavailable and stale revisions SHALL remain distinct. Course prose SHALL NOT execute as HTML; cited source text SHALL retain its exact trusted meaning.

#### Scenario: Partial revision material
- **WHEN** a course/week read contains notes with PDF citations and missing-material coverage
- **THEN** the UI renders notes, quote/page links and the explicit gap without claiming complete coverage or answer correctness

### Requirement: Objective browser scoring and external open feedback
Objective practice SHALL be graded locally only using a selected explicit answer representation supported by the protocol. Unsupported/ambiguous answers SHALL remain ungraded. Cited explanations SHALL be shown after response. Open answers SHALL be sent to the external agent through the M2 chat relay; pending/unavailable feedback SHALL NOT become an invented local grade or miss. These flows SHALL remain study assistance, never disguised graded-assessment answering above the course/exam cap.

#### Scenario: Deterministic objective result
- **WHEN** the owner selects an option for a synthetic objective question using the agreed answer encoding
- **THEN** the browser reports correct/incorrect deterministically and displays the cited explanation without a model call

#### Scenario: Unsupported answer encoding
- **WHEN** a stored objective answer cannot be interpreted under the selected contract
- **THEN** the UI reports unsupported scoring and records no fabricated correctness outcome

#### Scenario: Open feedback unavailable
- **WHEN** the owner submits an open practice answer while the relay is unavailable
- **THEN** the UI shows unavailable feedback without a local correctness claim or weak-topic miss

### Requirement: Weak-topic feedback influences revision planning
Practice misses SHALL update the weak-topic list through selected M2 state contracts, bound to the course/question/revision and selected topic rules. Revision-plan inputs SHALL include that weak-topic state. Reloaded or changed question revisions SHALL NOT silently inherit incompatible attempts. No permanent browser-only or direct-file authority SHALL replace protocol state. Automatic exam-window regeneration remains M4.

#### Scenario: Miss enters revision input
- **WHEN** a supported synthetic practice answer is incorrect and its attempt command succeeds
- **THEN** the corresponding weak topic appears in the list and in the subsequent revision-planning input

#### Scenario: Attempt persistence fails or revision changes
- **WHEN** saving an attempt fails or a newer incompatible question revision is loaded
- **THEN** the UI distinguishes unsaved/obsolete feedback from authoritative current weak-topic state and does not claim it was persisted
