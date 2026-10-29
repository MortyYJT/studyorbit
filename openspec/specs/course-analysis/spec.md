# course-analysis Specification

## Purpose
TBD - created by archiving change course-contract-v2. Update Purpose after archive.
## Requirements
### Requirement: Model output version 2
The system SHALL send the model a JSON Schema whose `document` contains `version: 2`, `course`, `materials` and `assessments`, where each assessment has only `key`, `parentKey`, `refs`, `name`, `kind`, `nature`, `scoring`, `weight`, `weightQuote`, `rule` and `ruleQuote`. The schema MUST reject `id`, `parentId`, `due`, `score`, `maxScore`, `status` and `sources` on an assessment. The prompt SHALL give the parsed Handbook components and each Canvas group's rendered rule text, and SHALL tell the model to cite platform IDs as collected, to cite Handbook components only by a listed name, to copy quotes exactly (a Handbook row with its cells separated by single spaces), and that facts are filled by code.

#### Scenario: Model sends a score
- **WHEN** a model output assessment contains `score`
- **THEN** validation fails with a schema issue and the repair prompt is used

#### Scenario: Minimal valid output
- **WHEN** a model output has one assessment with a Canvas reference that exists, `parentKey: null` and `weight: null`
- **THEN** it passes validation

### Requirement: Handbook components are parsed from the assessment table
The system SHALL parse Handbook components from the collected Handbook text: a row ends at a line that has a tab and whose last tab-separated cell is a percentage or one of `N/A`, `Nil`, `-`, `—`; a row starts after the previous row end or after a header line containing a `Percentage` cell, whichever is later, or is the end line alone when neither precedes it. The component name SHALL be the first non-empty line of the row's first cell with whitespace collapsed; the percentage SHALL be the number in the last cell or `null`; the row text SHALL be the whole row with tabs and line breaks replaced by single spaces. Rows with the same normalised name and the same percentage SHALL be merged into one component that keeps every row text; other repeated names SHALL get ` (2)`, ` (3)` in page order. When the Handbook was collected but no component parses, the course status SHALL be at most `partial` and the reason SHALL include 「Handbook 考核表未能解析」.

#### Scenario: Row with timing between name and percentage
- **WHEN** the Handbook text contains the line `Project report\tWeek 10\t30%`
- **THEN** a component `Project report` with percentage 30 and row text `Project report Week 10 30%` is parsed

#### Scenario: Multi-line description cell
- **WHEN** a row's first cell spans the lines `Mid-semester test` and `Online, 45 minutes`, and the next line is `\tWeek 6\t15%`
- **THEN** one component `Mid-semester test` with percentage 15 is parsed

#### Scenario: Hurdle row without a percentage
- **WHEN** a row ends with the cell `N/A`
- **THEN** a component with `percent: null` is parsed and the following row is parsed separately

#### Scenario: Table repeated per study period
- **WHEN** the Handbook text contains the row `Project report\tWeek 10\t30%` twice, once under each study period
- **THEN** one component `Project report` is parsed and both row texts are in the quote corpus

#### Scenario: Same name, different percentage
- **WHEN** one row is `Quiz\tWeekly\t10%` and a later row is `Quiz\tWeek 12\t5%`
- **THEN** the components are `Quiz` and `Quiz (2)`

#### Scenario: No table found
- **WHEN** the Handbook was collected but no line ends with a percentage cell
- **THEN** no components are parsed, Handbook references are invalid and the reason includes 「Handbook 考核表未能解析」

### Requirement: References must exist in the collected data
The system SHALL treat each of the following as a validation issue, handled by the existing one-repair loop: a `canvas` reference whose ID is not a collected Canvas assignment ID; a `canvas-group` reference that is not a collected assignment group ID; an `ed` reference that is not a collected Ed lesson ID; a `handbook` reference whose normalised name is not equal to the normalised name of a parsed Handbook component; any reference to a source that was not collected; a `canvas` or `ed` reference used by more than one assessment; an assessment with no references and no children; a duplicate `key`; a `parentKey` that is missing, cyclic or more than one level deep; and duplicate final IDs. A valid Handbook reference SHALL be stored with the canonical component name.

#### Scenario: Invented Canvas ID
- **WHEN** the model cites `{ platform: 'canvas', id: '999' }` and no collected assignment has ID 999
- **THEN** validation fails with an issue naming that reference, and the model is asked once to repair it

#### Scenario: Handbook component matches after normalisation
- **WHEN** a parsed component is named "Mid‑Semester Test" (with a non-breaking hyphen) and the model cites `{ platform: 'handbook', id: 'mid-semester  test' }`
- **THEN** the reference is valid and is stored as "Mid‑Semester Test"

#### Scenario: Handbook substring is not a component
- **WHEN** a parsed component is named "Final exam" and the model cites `{ platform: 'handbook', id: 'Exam' }`
- **THEN** validation fails for that reference

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
The system SHALL generate each assessment's base ID from its references with priority Canvas assignment, Ed lesson, Canvas group, Handbook component, none: `canvas:<id>`, `ed:<id>`, `canvas-group:<id>`, `handbook:<slug of the canonical name>` or `group:<slug of the assessment name>`. The slug MUST be NFKC, lowercase, with each run of non-alphanumeric characters replaced by one `-` and leading and trailing `-` trimmed. When several references share the chosen platform, the smallest ID (numeric order for digit IDs, otherwise code-point order) SHALL be used. When two or more assessments share a base ID from a Canvas group, Handbook component or no reference, each of them SHALL get the ID `<base ID>:<slug of its name>`. `parentId` SHALL be the final ID of the assessment named by `parentKey`.

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

#### Scenario: Two items cite the same Handbook row
- **WHEN** "Final exam" and "Final exam (alternative)" both cite only the Handbook component "Examination"
- **THEN** their IDs are `handbook:examination:final-exam` and `handbook:examination:final-exam-alternative`

#### Scenario: Same base ID and same name
- **WHEN** two assessments named "Exam" both cite only the Handbook component "Examination"
- **THEN** validation fails for duplicate IDs and the repair prompt is used

### Requirement: Facts are back-filled from collected data
The system SHALL set `due`, `score`, `maxScore`, `status` and `sources` from the collected data and never from the model. `due` SHALL be the primary Canvas assignment's `due_at`, else the primary Ed lesson's `due`, else `null`. `score` and `maxScore` SHALL be a pair from one source: a graded Canvas submission with `points_possible`, else a graded Ed score record with its `maxScore`, else `score: null` with `maxScore` from Canvas `points_possible` or `null`; a pair whose score exceeds its maximum keeps the score and sets `maxScore` to `null`. `status` SHALL be the most advanced of the per-source values (`graded` > `submitted` > `not_started` > `unknown`). Assessments with only Canvas group, Handbook or no references SHALL have `null` due, score and maximum and status `unknown`. `sources` SHALL have one entry per reference with `evidence: null`: platform `canvas` with the assignment URL, `ed` with the lesson URL, `handbook` with the Handbook page URL, and `canvas` with a `null` URL for a Canvas group.

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

#### Scenario: Canvas group source
- **WHEN** an assessment cites only a Canvas group
- **THEN** its `sources` has one entry `{ platform: 'canvas', url: null, evidence: null }`

### Requirement: Weights and rules need a verified source
After validation succeeds, the system SHALL verify each non-null `weight` and `rule`. Quotes are matched against corpus units that describe assessments only: each parsed Handbook row text, each other non-empty Handbook line, each Ed context text, each Canvas group name, and each Canvas group's rendered rule text (`drop lowest <n>`, `drop highest <n>`, `never drop <assignment name>`); Canvas assignment names, Ed lesson titles, URLs and IDs are excluded. Quote and corpus MUST be normalised the same way (HTML tags stripped, common entities decoded, NFKC, lowercase, quote and dash characters unified, all whitespace collapsed to one space), and a quote MUST be 6 to 500 characters after normalisation and occur within one unit. A weight SHALL count as sourced when the assessment cites a Canvas group whose `group_weight`, or a Handbook component whose percentage, equals the weight to two decimals, or when its quote passes and contains a number token equal to the weight followed by `%`, `per cent` or `percent`; a quote matched in a Handbook row MUST also contain that row's component name. A rule SHALL count as sourced when its quote passes. A field that fails SHALL be set to `null` together with its quote, its name added to `unsourced`, and the rest of the document saved. Verification SHALL NOT be a validation failure and SHALL NOT trigger a repair.

#### Scenario: Weight quoted from a Handbook row
- **WHEN** an assessment with `weight: 30` cites no Handbook component, its `weightQuote` is "Project report Week 10 30%", and the Handbook text has the line `Project report\tWeek 10\t30%`
- **THEN** the weight and quote are kept and `unsourced` is empty

#### Scenario: Dash and spacing differences
- **WHEN** an Ed context text contains "Project – 30%" and the `weightQuote` for `weight: 30` is "project -  30%"
- **THEN** the quote passes

#### Scenario: Weight from the cited Handbook row
- **WHEN** an assessment with `weight: 30` and no quote cites the Handbook component "Project report" whose percentage is 30
- **THEN** the weight is kept, `weightQuote` is `null` and `unsourced` is empty

#### Scenario: Canvas group weight
- **WHEN** an assessment with `weight: 40` and no quote cites a Canvas group whose `group_weight` is 40
- **THEN** the weight is kept, `weightQuote` is `null` and `unsourced` is empty

#### Scenario: Number without a percent sign
- **WHEN** `weight: 5`, no structured source matches, and the quote is "Quiz 5 due in week 5"
- **THEN** the weight is cleared and flagged

#### Scenario: Number inside a larger number
- **WHEN** `weight: 5`, no structured source matches, and the quote found in the corpus is "Quizzes worth 25% in total"
- **THEN** the weight is cleared and flagged

#### Scenario: Fragment of another Handbook row
- **WHEN** an item named "Lab report" has `weight: 15`, cites no Handbook component, and its quote is "Week 6 15%", which occurs only in the row `Mid-semester test Week 6 15%`
- **THEN** the weight is cleared and flagged

#### Scenario: Assignment name is not a source
- **WHEN** the only collected string containing the quote is a Canvas assignment name
- **THEN** the quote does not pass

#### Scenario: Canvas drop rule
- **WHEN** an assessment cites a Canvas group with `rules: { drop_lowest: 2 }` and has `rule: "Lowest two quizzes dropped"` with `ruleQuote: "drop lowest 2"`
- **THEN** the rule and quote are kept

#### Scenario: Paraphrased rule quote
- **WHEN** the `ruleQuote` does not occur in any corpus unit after normalisation
- **THEN** `rule` and `ruleQuote` are `null`, `unsourced` contains `rule`, and the course is still saved

#### Scenario: Weighted parent loses a child weight
- **WHEN** a parent has `scoring: 'weighted'` and verification clears the weight of one of its scoring children
- **THEN** the parent's `scoring` becomes `none`

#### Scenario: Reason notes cleared fields
- **WHEN** verification clears two fields in a course
- **THEN** the course status is unchanged and its reason includes 「2 项权重或规则无出处」

### Requirement: Evaluation matches assessments by identity
The evaluation scorer SHALL match an assessment to the reference answer by equal `id`, then by a shared platform identity (version 2 `refs`, or Canvas assignment and Ed lesson IDs parsed from version 1 `sources` URLs or platform-shaped version 1 IDs), then by equal slug of the name, matching each reference assessment at most once.

#### Scenario: v1 reference answer, v2 run
- **WHEN** the reference answer has a version 1 assessment whose Canvas source URL ends in `/assignments/5551` and the run has `canvas:5551`
- **THEN** the two are matched

### Requirement: Framework references come from the institution's framework source
The `handbook` reference platform SHALL refer to the active institution's framework source. Parsing of framework rows and components, the prompt clauses about citing them and quoting their rows, and the reason texts about them SHALL come from that framework source; the existing Handbook requirements of this capability SHALL be the `unimelb` framework source's behaviour, unchanged. When the institution has no framework source, the prompt SHALL omit framework clauses and components, and a `handbook` reference SHALL be a validation issue as a reference to a source that was not collected.

#### Scenario: UniMelb Handbook unchanged
- **WHEN** the UniMelb Handbook text contains the line `Project report\tWeek 10\t30%`
- **THEN** a component "Project report" with percentage 30 is parsed, as today

#### Scenario: Handbook reference without a framework
- **WHEN** the institution is `generic` and the model cites `{ platform: 'handbook', id: 'Exam' }`
- **THEN** validation reports that the source was not collected and the repair prompt is used

