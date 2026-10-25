## MODIFIED Requirements

### Requirement: Course JSON contract
For each selected course the agent SHALL submit one document with the agent command `course.import`. The document SHALL have a course level (`code`, `name`, `term`, `pages` with Canvas and Ed URLs, `aiPolicy`, `platforms` saying for Canvas and Ed whether they were `read`, `blocked` by a sign-in page or `absent` for this course, and `componentsComplete` saying whether the agent read the course's full grading breakdown), a list of grading components (`key`, `name`, `kind`, `count`, `weight`, `isFinal`, `hurdleMin`, `items`) and, per component, items (`key`, `name`, `due`, `status`, `score` with `outOf`, `weight`, and an optional `aiPolicy`). `term` SHALL match `YYYY:S1`, `YYYY:S2`, `YYYY:SUMMER` or `YYYY:WINTER`. Every field SHALL be an object with `value` (or `null`), `state` (`found` | `unknown` | `not_applicable` | `derived`), `via` (`ax` | `screenshot`) when found, and `checkedAt` when unknown; `due`, `weight`, `hurdleMin` and `aiPolicy` (course or item) that are found SHALL carry the page `quote` and source URL. An item without `aiPolicy` SHALL be treated as an unknown item policy. Component keys SHALL be the course code and a slug of the component name; item keys SHALL be the course code, the platform and the platform's id (for example `ABCD10001:canvas:assignment:500001`). The contract SHALL be one zod schema shared by the command and the reading prompt.

#### Scenario: Valid document
- **WHEN** the agent submits a document whose fields all follow the contract
- **THEN** `course.import` returns `ok` with the counts of stored components and items

#### Scenario: Wrong field shape
- **WHEN** a found `due` has no quote or a value that is not an ISO time
- **THEN** `course.import` returns `INVALID_INPUT` naming the field path, and nothing is stored

#### Scenario: Item policy without a quote
- **WHEN** an item's `aiPolicy` is `found` as `prohibited` without a quote
- **THEN** `course.import` returns `INVALID_INPUT` naming that item's `aiPolicy` path

## REMOVED Requirements

### Requirement: One AI policy field per course
**Reason**: AI rules usually apply to particular assessments, not a whole course (#195); one course field cannot express "AI banned for reports and reflections only".
**Migration**: The course `aiPolicy` stays in the document and on the Course as the course default. Its storage, owner precedence, missed-read and "needs you" rules move into "AI policy per assessment with a course default", which adds the same rules per item.

## ADDED Requirements

### Requirement: AI policy per assessment with a course default
The document's course `aiPolicy` SHALL be the course's agent-read default policy, stored on the Course with its quote. Each item's `aiPolicy` SHALL be stored as the agent-read policy of that item's Assessment with its quote in the Assessment's read state (#195). A component Assessment (final or hurdle) SHALL store `prohibited` when any of its items reads `prohibited`, else the value its items agree on, else none; a remainder Assessment SHALL store none. A run that reads a course or item policy as unknown SHALL keep the previously stored agent-read value and its quote and update its check time (#184). Agents SHALL NOT record an `aiPolicy` annotation on a course or an assessment; `annotation.record` SHALL refuse that field. Owner policies SHALL be recorded only from the frontend's owner session, per course or per assessment, SHALL never be overwritten by import, and an owner value of `null` SHALL clear the owner's policy at that level. When a run stores a course or item value different from the previously stored agent-read value, "needs you" SHALL show the course or assessment, the new value and its quote until the next run; no confirmation is required. How the stored values combine into the effective policy is defined in `assessment-autonomy`.

#### Scenario: Item policy read
- **WHEN** the agent reads `prohibited` for the item "Report" quoting "You must not use generative AI to write this report" and the course default as `allowed`
- **THEN** the Report Assessment stores `prohibited` with the quote, the Course stores `allowed`, and "needs you" shows the new item value

#### Scenario: Missed item read keeps the last value
- **WHEN** an item was read as `prohibited` earlier and this run reads its policy as unknown
- **THEN** the stored value stays `prohibited` and its check time is updated

#### Scenario: Owner item policy kept
- **WHEN** the owner set an assessment to `allowed` and the agent reads `prohibited` for its item
- **THEN** the owner value stays, and the agent-read value and quote are stored for display

#### Scenario: Agent item policy annotation refused
- **WHEN** an agent records an `aiPolicy` annotation on an assessment
- **THEN** it is rejected and nothing is stored
