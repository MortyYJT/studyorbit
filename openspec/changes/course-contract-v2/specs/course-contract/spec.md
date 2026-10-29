## ADDED Requirements

### Requirement: Stored course document version 2
The system SHALL store each synced course as a version 2 document whose assessments carry every version 1 field plus `refs` (platform references `{ platform: 'canvas' | 'canvas-group' | 'ed' | 'handbook', id }`), `weightQuote` and `ruleQuote` (verified verbatim quotes or `null`) and `unsourced` (a list of `weight` and `rule` naming fields cleared by quote verification). The version 1 rules on unique IDs, score not above maximum, one parent level and no cycles MUST also hold for version 2.

#### Scenario: Valid version 2 document
- **WHEN** a document has `version: 2` and every assessment has the version 1 fields plus `refs`, `weightQuote`, `ruleQuote` and `unsourced`
- **THEN** it passes `CourseDocumentSchema`

#### Scenario: Version 2 assessment missing a new field
- **WHEN** a `version: 2` document has an assessment without `unsourced`
- **THEN** it fails `CourseDocumentSchema`

#### Scenario: Unknown unsourced field name
- **WHEN** an assessment lists `score` in `unsourced`
- **THEN** it fails `CourseDocumentSchema`

### Requirement: Version 1 documents stay readable
The system SHALL accept documents with `version: 1` unchanged and SHALL convert either version into one display shape, where a version 1 assessment has empty `refs`, `null` quotes and empty `unsourced`. Every reader of course documents (course reports, the course page, the chat context) MUST use this conversion.

#### Scenario: Version 1 file on the Desktop
- **WHEN** the newest valid course file for a course is a version 1 document
- **THEN** the course page shows its assessments, weights, scores and rules as before and no 「无出处」 tag appears

#### Scenario: Mixed versions in one folder
- **WHEN** a course folder holds an older version 1 file and a newer valid version 2 file
- **THEN** the version 2 file is used

#### Scenario: Unsupported version
- **WHEN** a course file has `version: 3`
- **THEN** it is treated as invalid and the next newest valid file is used

### Requirement: Unsourced fields are shown as 「无出处」
The course page SHALL show a 「无出处」 tag beside the weight wherever the weight is shown (assessment list, weight breakdown, drawer) when `unsourced` lists `weight`, and beside the rule in the drawer and the Revision tab when `unsourced` lists `rule`. The drawer SHALL show a verified quote under its value. The chat context SHALL mark the same fields as 「权重无出处」 or 「规则无出处」.

#### Scenario: Weight cleared by verification
- **WHEN** an assessment has `weight: null` and `unsourced: ['weight']`
- **THEN** the course page shows the weight as unknown with a 「无出处」 tag and the chat context describes it with 「权重无出处」

#### Scenario: Verified weight with a quote
- **WHEN** an assessment has `weight: 20` and `weightQuote: "Assignment 1 (20%)"`
- **THEN** the drawer shows 20% and the quote, with no 「无出处」 tag

#### Scenario: Owner correction supplies the weight
- **WHEN** an assessment has `unsourced: ['weight']` and the owner has saved a weight correction for it
- **THEN** the corrected weight is shown and used, and the 「无出处」 tag is not shown

### Requirement: Existing corrections survive the ID change
When no correction is stored under `<courseId>:<v2 id>`, the course page SHALL apply a correction stored under `<courseId>:<id>`, where `<id>` is the bare platform ID of the assessment's primary Canvas reference, or of its primary Ed reference when it has no Canvas reference.

#### Scenario: Correction keyed by a v1 Canvas ID
- **WHEN** a correction exists for key `100:5551` and the version 2 assessment `canvas:5551` has no correction of its own
- **THEN** the page applies the `100:5551` correction to `canvas:5551`

#### Scenario: New key wins
- **WHEN** corrections exist for both `100:canvas:5551` and `100:5551`
- **THEN** the page applies only `100:canvas:5551`
