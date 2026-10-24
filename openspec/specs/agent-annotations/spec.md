# agent-annotations Specification

## Purpose
TBD - created by archiving change v1-delivery. Update Purpose after archive.
## Requirements
### Requirement: Cited annotations set facts sync cannot know
An agent SHALL be able to record an annotation that sets one field of one Assessment or Course: assessment `weight`, `kind` (`quiz` | `ongoing` | `assignment` | `exam`), `hurdleMin`, `isFinal`, `name`, `due`, or course `assessmentsComplete` and `aiPolicy` (the policy text the agent found, which the owner then confirms). Each agent annotation SHALL carry at least one citation whose quote is an exact normalized substring of a stored, redacted SourceItem of the same course (checked by the shared citation service). An annotation that fails validation SHALL be rejected without changing stored values, and the rejection SHALL be recorded in the run ledger. Owner annotations MAY omit citations and SHALL be recorded only through a trusted owner interaction (the frontend's owner session or a TTY, see `command-registry`).

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
The effective value of an annotated field SHALL be the newest owner annotation, else the newest valid agent annotation, else the sync value, else unknown. Annotations SHALL be append-only: a new annotation supersedes, never edits or deletes, an older one. Reads SHALL return the effective value with its origin (`owner`, `agent` or `sync`) and citations. Classification SHALL default to unknown, never to a guessed kind, until an annotation sets it.

#### Scenario: Owner overrides agent
- **WHEN** an agent annotation sets weight 30 and a later owner annotation sets 25
- **THEN** the effective weight is 25 with origin `owner`, and both annotations remain in history

#### Scenario: Unknown classification
- **WHEN** no annotation has set an assessment's kind and sync has no kind
- **THEN** reads report the kind as unknown and autonomy checks require the highest work level (see `assessment-autonomy`)

### Requirement: Owner verdicts on agent values
For any field whose effective value has origin `agent`, the owner SHALL be able, from the frontend, to confirm the value or replace it with their own (#138). Confirming SHALL record an owner verdict `correct` without changing the value; replacing SHALL record an owner annotation and a verdict `incorrect`. Verdicts SHALL be append-only, linked to the agent annotation they judge, and SHALL be the labelled set used for annotation accuracy (see `metrics`).

#### Scenario: Owner replaces an agent weight
- **WHEN** the agent set a weight of 30 and the owner chooses "use my value" and enters 25
- **THEN** the effective weight is 25 with origin `owner`, and the agent annotation has a verdict `incorrect`

#### Scenario: Owner confirms an agent kind
- **WHEN** the owner confirms an agent annotation that set kind `quiz`
- **THEN** the kind stays `quiz` with origin `agent`, and the annotation has a verdict `correct`

