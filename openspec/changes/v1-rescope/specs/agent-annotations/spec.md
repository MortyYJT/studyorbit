## ADDED Requirements

### Requirement: Cited annotations set facts sync cannot know
An agent SHALL be able to record an annotation that sets one field of one Assessment or Course: assessment `weight`, `kind`, `hurdleMin`, `isFinal`, `name`, `due`, or course `assessmentsComplete`. Each agent annotation SHALL carry at least one citation whose quote is an exact normalized substring of a stored, redacted SourceItem of the same course (checked by the shared citation service). An annotation that fails validation SHALL be rejected without changing stored values, and the rejection SHALL be recorded in the run ledger. Owner annotations MAY omit citations and SHALL be recorded only through a trusted owner interaction.

#### Scenario: Weight from the syllabus
- **WHEN** the agent annotates an assessment's weight as 40 citing the syllabus text "Final exam (40%)" from a stored page
- **THEN** the citation is verified, the annotation is stored, and the assessment's effective weight becomes 40

#### Scenario: Invented quote
- **WHEN** the agent cites a quote that appears in no stored source of that course
- **THEN** the annotation is rejected with `CITATION_MISMATCH` and the weight is unchanged

### Requirement: Agents create syllabus-only assessments and links
An agent SHALL be able to create an Assessment that exists only in course documents (for example "Workshops 10%") with cited name and weight, and SHALL be able to link any number of platform items of the same course to one Assessment. A platform item SHALL belong to at most one Assessment; linking it elsewhere SHALL move it and keep the earlier link in history. Links SHALL record who made them. Links and created assessments MUST NOT cross courses.

#### Scenario: Ten workshops, one assessment
- **WHEN** the agent creates "Workshops" with a cited weight of 10 and links ten Ed attempt lessons to it
- **THEN** one Assessment of weight 10 exists and all ten items are linked to it

#### Scenario: Cross-course link
- **WHEN** a link names an item from another course
- **THEN** it is rejected and nothing changes

### Requirement: Precedence and history
The effective value of an annotated field SHALL be the newest owner annotation, else the newest valid agent annotation, else the sync value, else unknown. Annotations SHALL be append-only: a new annotation supersedes, never edits or deletes, an older one. Reads SHALL return the effective value with its origin (`owner`, `agent` or `sync`) and citations. Exam classification SHALL default to unknown, never to non-exam, until an annotation sets it.

#### Scenario: Owner overrides agent
- **WHEN** an agent annotation sets weight 30 and a later owner annotation sets 25
- **THEN** the effective weight is 25 with origin `owner`, and both annotations remain in history

#### Scenario: Unknown classification
- **WHEN** no annotation has set an assessment's kind and sync has no kind
- **THEN** reads report the kind as unknown and autonomy checks treat it as possibly an exam
