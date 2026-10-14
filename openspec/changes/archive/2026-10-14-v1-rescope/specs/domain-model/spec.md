## MODIFIED Requirements

### Requirement: Every entity has a validating schema
The system SHALL define a zod schema for each stored entity: Module, Course, Assessment, SourceItem, Task and Run. Every value written to storage or returned to an agent MUST pass its schema first.

#### Scenario: Valid entity is accepted
- **WHEN** a Task with an id, module id, title, and at least one step is parsed
- **THEN** parsing succeeds and returns a typed value

#### Scenario: Invalid entity is rejected with a path
- **WHEN** a Task without a title is parsed
- **THEN** parsing fails and the error names the `title` path

### Requirement: Entity fields
The schemas SHALL contain at least these fields (ids are non-empty strings; times are ISO 8601 strings):
- Module: `id`, `name`, `glyph`, `auto` (fed by coursework sources).
- Course: `id`, `moduleId`, `code`, `name`, `term`, `assessmentsComplete` (the user or a sync confirmed the assessment list is final).
- Assessment: `id`, `courseId`, `name`, `kind`, `weight`, `score?`, `due?`, `hurdleMin?`, `isFinal`, `status` (`not_started` | `in_progress` | `submitted` | `graded`).
- SourceItem: `id`, `platform` (`canvas` | `ed` | `manual`), `externalId`, `courseId?`, `kind` (`assignment` | `announcement` | `material` | `post` | `event`), `title`, `url?`, `text` (already redacted), `contentHash`, `fetchedAt`.
- Citation: `sourceItemId`, `quote`, `locator`.
- Step: `title`, `estimateMinutes`, `done`, `citations` (array, may be empty only for manual tasks).
- Task: `id`, `moduleId`, `courseId?`, `assessmentId?`, `title`, `source` (`coursework` | `manual`), `due?`, `repeat?` (`daily` | `weekly`), `steps`.
- Run: `id`, `command`, `startedAt`, `endedAt`, `steps`, `outcome` (`ok` | `error`), `errorCode?`, `costUsd?`, and for sync runs the measured `pages`, `requests`, `failures` and per-source `coverage`.

#### Scenario: Unknown enum value
- **WHEN** a SourceItem with `platform: "moodle"` or `platform: "ical"` is parsed
- **THEN** parsing fails and the error names the `platform` path

## ADDED Requirements

### Requirement: Runs are recorded with measurements
A Run SHALL record the command, start and end time, step count, outcome, and an optional cost reported by the caller. Sync runs SHALL additionally record measured nonnegative integer `pages`, `requests` and `failures` and per-source `coverage` entries (provider, opaque scope reference, collection, planned/attempted/completed/skipped/failed/not-started counts and sanitized outcome codes). Historical runs without measurements SHALL stay readable without backfilled values. Coverage MUST NOT contain URLs, course titles, names, quotes or free-form errors.

#### Scenario: Invalid metrics
- **WHEN** a synthetic sync Run has a negative count or a coverage entry with a raw URL
- **THEN** validation refuses it rather than storing false metrics

#### Scenario: Historical run
- **WHEN** a historical Run without measurements is read
- **THEN** it is returned without invented counts

## REMOVED Requirements

### Requirement: Changes and runs are recorded
**Reason**: Decision #101 removes the Change entity. Run recording continues under "Runs are recorded with measurements".
**Migration**: Existing change rows stay in the database unread; see `local-store`.
