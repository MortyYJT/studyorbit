## MODIFIED Requirements

### Requirement: Cited annotations set facts sync cannot know
An agent SHALL be able to record an annotation that sets one field of one Assessment or Course: assessment `weight`, `kind` (`quiz` | `ongoing` | `assignment` | `exam`), `hurdleMin`, `isFinal`, `name`, `due`, or course `assessmentsComplete`. AI policies are not agent annotations: the agent reads course and item policies into the course document (see `coursework-sync`), and `annotation.record` SHALL refuse the field `aiPolicy` from agents on both courses and assessments. Each agent annotation SHALL carry at least one citation whose quote is an exact normalized substring of a stored SourceItem of the same course (checked by the shared citation service). An annotation that fails validation SHALL be rejected without changing stored values, and the rejection SHALL be recorded in the run ledger. Owner annotations MAY omit citations and SHALL be recorded only through a trusted owner interaction (the frontend's owner session or a TTY, see `command-registry`).

#### Scenario: Weight from the syllabus
- **WHEN** the agent annotates an assessment's weight as 40 citing the syllabus text "Final exam (40%)" from a stored page
- **THEN** the citation is verified, the annotation is stored, and the assessment's effective weight becomes 40

#### Scenario: Invented quote
- **WHEN** the agent cites a quote that appears in no stored source of that course
- **THEN** the annotation is rejected with `CITATION_MISMATCH` and the weight is unchanged

#### Scenario: Agent policy annotation refused
- **WHEN** an agent records an annotation of a course's or an assessment's `aiPolicy`
- **THEN** it is rejected and nothing is stored

### Requirement: Precedence and history
The effective value of an annotated field SHALL be the newest owner annotation, else the newest valid agent annotation, else the sync value (for imported data, the value of the course document, or a value the owner took from a Canvas check, see `canvas-check`), else unknown; an owner annotation whose value is `null` clears the owner's value for a course's or an assessment's `aiPolicy`, so the next source applies. Annotations SHALL be append-only: a new annotation supersedes, never edits or deletes, an older one. Reads SHALL return the effective value with its origin (`owner`, `agent` or `sync`) and citations. Classification SHALL default to unknown, never to a guessed kind, until an annotation sets it.

#### Scenario: Owner overrides agent
- **WHEN** an agent annotation sets weight 30 and a later owner annotation sets 25
- **THEN** the effective weight is 25 with origin `owner`, and both annotations remain in history

#### Scenario: Unknown classification
- **WHEN** no annotation has set an assessment's kind and sync has no kind
- **THEN** reads report the kind as unknown and autonomy checks require the highest work level (see `assessment-autonomy`)
