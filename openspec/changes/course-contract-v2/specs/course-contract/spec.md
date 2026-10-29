## ADDED Requirements

### Requirement: Stored course document version 2
The system SHALL store each synced course as a version 2 document whose assessments carry every version 1 field plus `refs` (platform references `{ platform: 'canvas' | 'canvas-group' | 'ed' | 'handbook', id }`), `weightQuote` and `ruleQuote` (verified verbatim quotes or `null`) and `unsourced` (a list of `weight` and `rule` naming fields cleared by quote verification), and whose top level carries `legacyIds` (a map from earlier assessment IDs to current IDs, possibly empty). The version 1 rules on unique IDs, score not above maximum, one parent level and no cycles MUST also hold for version 2.

#### Scenario: Valid version 2 document
- **WHEN** a document has `version: 2`, a `legacyIds` object, and every assessment has the version 1 fields plus `refs`, `weightQuote`, `ruleQuote` and `unsourced`
- **THEN** it passes `CourseDocumentSchema`

#### Scenario: Version 2 assessment missing a new field
- **WHEN** a `version: 2` document has an assessment without `unsourced`
- **THEN** it fails `CourseDocumentSchema`

#### Scenario: Unknown unsourced field name
- **WHEN** an assessment lists `score` in `unsourced`
- **THEN** it fails `CourseDocumentSchema`

### Requirement: Version 1 documents stay readable
The system SHALL accept documents with `version: 1` unchanged and SHALL convert either version into one display shape, where a version 1 assessment has empty `refs`, `null` quotes and empty `unsourced`, and a version 1 document has empty `legacyIds`. Every reader of course documents (course reports, the course page, the chat context) MUST use this conversion.

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
- **WHEN** an assessment has `weight: 20` and `weightQuote: "Assignment 1 Week 6 20%"`
- **THEN** the drawer shows 20% and the quote, with no 「无出处」 tag

#### Scenario: Owner correction supplies the weight
- **WHEN** an assessment has `unsourced: ['weight']` and the owner has saved a weight correction for it
- **THEN** the corrected weight is shown and used, and the 「无出处」 tag is not shown

### Requirement: Legacy ID map from the previous document
When saving a course, the system SHALL fill `legacyIds` by matching each assessment of the newest valid earlier document of the same course to the new assessments: first by platform identity (version 2 `canvas` and `ed` references; for version 1, Canvas assignment and Ed lesson IDs parsed from `sources` URLs, and an `id` of the form `<digits>`, `canvas-<digits>`, `canvas:<digits>`, `ed-<digits>` or `ed:<digits>`), then by equal name slug when that slug is unique on both sides. Only one-to-one pairs whose ID changed SHALL be kept. Entries from an earlier version 2 document's `legacyIds` SHALL be carried forward and composed, dropping entries whose target no longer exists.

#### Scenario: v1 Canvas item
- **WHEN** the earlier v1 document has an assessment `a1` whose source URL is a Canvas assignment `5551` URL and the new document has `canvas:5551`
- **THEN** `legacyIds` contains `a1 → canvas:5551`

#### Scenario: v1 Ed item with a bare ID
- **WHEN** the earlier v1 assessment has `id: '77'`, no Canvas assignment 77 exists in the new document, and the new document has `ed:77`
- **THEN** `legacyIds` contains `77 → ed:77`

#### Scenario: Ambiguous match left out
- **WHEN** two earlier assessments both match the same new assessment
- **THEN** neither is in `legacyIds`

#### Scenario: Map carried forward
- **WHEN** the earlier document is v2 with `legacyIds` `{ a1: 'canvas:5551' }` and the new document still has `canvas:5551`
- **THEN** the new `legacyIds` still contains `a1 → canvas:5551`

### Requirement: Local stores move to the new IDs
The system SHALL apply a course's `legacyIds` to every local store that refers to synced assessments, with one pure function usable both on browser storage and, after decision #248, on the `.local/` store: correction keys in item form `<courseId>:<id>` and group form `<courseId>:group:<courseId>:<id>`; the `parent` and `mergeInto` values inside corrections; the `parent` of manual assessments; the `key` of planned work; and the course's order list. An old entry whose new key already has an entry SHALL be left in place unused. Applying the map twice SHALL change nothing. Entries that cannot be mapped (no platform identity and no unique name match, ambiguous matches, assessments that no longer exist, or no earlier document in the course folder) SHALL stay in storage untouched.

#### Scenario: Group correction and work move together
- **WHEN** `legacyIds` maps `quizzes` to `canvas-group:300` for course `100`, a correction exists under `100:group:100:quizzes` and a planned task has key `100:quizzes`
- **THEN** the correction moves to `100:group:100:canvas-group:300` and the task key becomes `100:canvas-group:300`

#### Scenario: References inside corrections
- **WHEN** a correction of course `100` has `mergeInto: '100:a1'` and `legacyIds` maps `a1` to `canvas:5551`
- **THEN** its `mergeInto` becomes `100:canvas:5551`

#### Scenario: New key already present
- **WHEN** corrections exist under both `100:a1` and `100:canvas:5551` and `legacyIds` maps `a1` to `canvas:5551`
- **THEN** `100:canvas:5551` is unchanged and `100:a1` stays in storage unused

#### Scenario: Idempotent
- **WHEN** the migration runs a second time on already migrated stores
- **THEN** the stores are unchanged
