## ADDED Requirements

### Requirement: Model output version 2
The system SHALL send the model a JSON Schema whose `document` contains `version: 2`, `course`, `materials` and `assessments`, where each assessment has only `key`, `parentKey`, `refs`, `name`, `kind`, `nature`, `scoring`, `weight`, `weightQuote`, `rule` and `ruleQuote`. The schema MUST reject `id`, `parentId`, `due`, `score`, `maxScore`, `status` and `sources` on an assessment. The prompt SHALL tell the model to cite platform IDs as collected, to copy Handbook component names and quotes exactly, and that facts are filled by code.

#### Scenario: Model sends a score
- **WHEN** a model output assessment contains `score`
- **THEN** validation fails with a schema issue and the repair prompt is used

#### Scenario: Minimal valid output
- **WHEN** a model output has one assessment with a Canvas reference that exists, `parentKey: null` and `weight: null`
- **THEN** it passes validation

### Requirement: References must exist in the collected data
The system SHALL treat each of the following as a validation issue, handled by the existing one-repair loop: a `canvas` reference whose ID is not a collected Canvas assignment ID; a `canvas-group` reference that is not a collected assignment group ID; an `ed` reference that is not a collected Ed lesson ID; a `handbook` reference whose normalised name does not occur in the normalised Handbook text; any reference to a source that was not collected; a `canvas` or `ed` reference used by more than one assessment; an assessment with no references and no children; a duplicate `key`; a `parentKey` that is missing, cyclic or more than one level deep; and duplicate generated IDs.

#### Scenario: Invented Canvas ID
- **WHEN** the model cites `{ platform: 'canvas', id: '999' }` and no collected assignment has ID 999
- **THEN** validation fails with an issue naming that reference, and the model is asked once to repair it

#### Scenario: Handbook component found in the page text
- **WHEN** the model cites `{ platform: 'handbook', id: 'Mid-semester test' }` and the Handbook text contains "Mid‑Semester  Test"
- **THEN** the reference is valid

#### Scenario: Handbook not collected
- **WHEN** the Handbook collection is unavailable and the model cites a Handbook component
- **THEN** validation fails for that reference

#### Scenario: Leaf without a source
- **WHEN** an assessment has no references and no other assessment names it as `parentKey`
- **THEN** validation fails

#### Scenario: Failure after repair
- **WHEN** the repaired output still cites a missing reference
- **THEN** nothing is saved and the course fails with the issues, as for any other validation failure

### Requirement: Deterministic assessment IDs
The system SHALL generate each assessment ID from its references with priority Canvas assignment, Ed lesson, Canvas group, Handbook component, none: `canvas:<id>`, `ed:<id>`, `canvas-group:<id>`, `handbook:<slug>` or `group:<slug of the assessment name>`. The slug MUST be NFKC, lowercase, with each run of non-alphanumeric characters replaced by one `-` and leading and trailing `-` trimmed. When several references share the chosen platform, the smallest ID (numeric order for digit IDs, otherwise code-point order) SHALL be used. `parentId` SHALL be the generated ID of the assessment named by `parentKey`.

#### Scenario: Canvas beats Ed
- **WHEN** an assessment cites Ed lesson `77` and Canvas assignment `5551`
- **THEN** its ID is `canvas:5551`

#### Scenario: Handbook-only assessment
- **WHEN** an assessment cites only the Handbook component "Final Examination (3 hours)"
- **THEN** its ID is `handbook:final-examination-3-hours`

#### Scenario: Model-only group
- **WHEN** an assessment named "Weekly Quizzes" has no references and has children
- **THEN** its ID is `group:weekly-quizzes`

#### Scenario: Order of references does not matter
- **WHEN** two runs cite Canvas assignments `12` and `9` on the same assessment in different orders
- **THEN** both runs produce the ID `canvas:9`

### Requirement: Facts are back-filled from collected data
The system SHALL set `due`, `score`, `maxScore`, `status` and `sources` from the collected data and never from the model. `due` SHALL be the primary Canvas assignment's `due_at`, else the primary Ed lesson's `due`, else `null`. `score` and `maxScore` SHALL be a pair from one source: a graded Canvas submission with `points_possible`, else a graded Ed score record with its `maxScore`, else `score: null` with `maxScore` from Canvas `points_possible` or `null`; a pair whose score exceeds its maximum keeps the score and sets `maxScore` to `null`. `status` SHALL be the most advanced of the per-source values (`graded` > `submitted` > `not_started` > `unknown`). Assessments with only Canvas group, Handbook or no references SHALL have `null` due, score and maximum and status `unknown`. `sources` SHALL list the Canvas assignment URL, Ed lesson URL or Handbook URL for each reference, and `null` for a Canvas group, each with `evidence: null`.

#### Scenario: Canvas graded
- **WHEN** an assessment cites a Canvas assignment with `points_possible: 20`, a `due_at` and a submission `{ workflow_state: 'graded', score: 17 }`
- **THEN** it is stored with that `due`, `score: 17`, `maxScore: 20` and `status: 'graded'`

#### Scenario: Ed score does not mix with the Canvas maximum
- **WHEN** an assessment cites an ungraded Canvas assignment with `points_possible: 100` and an Ed lesson whose score record is graded 8 of 10
- **THEN** it is stored with `score: 8`, `maxScore: 10` and `status: 'graded'`

#### Scenario: Canvas submitted
- **WHEN** the only reference is a Canvas assignment whose submission `workflow_state` is `pending_review`
- **THEN** `status` is `submitted` and `score` is `null`

#### Scenario: Not started
- **WHEN** the only reference is a Canvas assignment whose submission is `unsubmitted` with no `submitted_at`
- **THEN** `status` is `not_started`

#### Scenario: Handbook-only exam
- **WHEN** the only reference is a Handbook component
- **THEN** `due`, `score` and `maxScore` are `null` and `status` is `unknown`

### Requirement: Weights and rules need a verified quote
After validation succeeds, the system SHALL verify each non-null `weight` and `rule` against the course's collected text. Quote and corpus MUST be normalised the same way (HTML tags stripped, common entities decoded, NFKC, lowercase, quote and dash characters unified, whitespace collapsed); a quote MUST be 6 to 500 characters after normalisation and occur within a single collected string. A weight quote MUST also contain a number token equal to the weight. A weight SHALL also count as sourced, without a quote, when the assessment cites a Canvas group whose `group_weight` equals the weight to two decimals. A field that fails SHALL be set to `null` together with its quote, its name added to `unsourced`, and the rest of the document saved. Verification SHALL NOT be a validation failure and SHALL NOT trigger a repair.

#### Scenario: Quote found
- **WHEN** an assessment has `weight: 30` and `weightQuote: "Project – 30%"` and the Handbook text contains "Project - 30%"
- **THEN** the weight and quote are kept and `unsourced` is empty

#### Scenario: Paraphrased quote
- **WHEN** the `ruleQuote` does not occur in any collected string after normalisation
- **THEN** `rule` and `ruleQuote` are `null`, `unsourced` contains `rule`, and the course is still saved

#### Scenario: Quote lacks the number
- **WHEN** `weight: 5` and the quote found in the corpus is "Quizzes worth 25% in total"
- **THEN** the weight is cleared and flagged, because 5 is not a number token of the quote

#### Scenario: Canvas group weight
- **WHEN** an assessment with `weight: 40` and no quote cites a Canvas group whose `group_weight` is 40
- **THEN** the weight is kept, `weightQuote` is `null` and `unsourced` is empty

#### Scenario: Weighted parent loses a child weight
- **WHEN** a parent has `scoring: 'weighted'` and verification clears the weight of one of its scoring children
- **THEN** the parent's `scoring` becomes `none`

#### Scenario: Reason notes cleared fields
- **WHEN** verification clears two fields in a course
- **THEN** the course status is unchanged and its reason includes 「2 项权重或规则无出处」

### Requirement: Evaluation matches assessments by identity
The evaluation scorer SHALL match an assessment to the reference answer by equal `id`, then by a shared platform identity (version 2 `refs`, or Canvas assignment and Ed lesson IDs parsed from version 1 `sources` URLs), then by equal slug of the name, matching each reference assessment at most once.

#### Scenario: v1 reference answer, v2 run
- **WHEN** the reference answer has a version 1 assessment whose Canvas source URL ends in `/assignments/5551` and the run has `canvas:5551`
- **THEN** the two are matched
