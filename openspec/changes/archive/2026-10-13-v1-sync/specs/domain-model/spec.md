## MODIFIED Requirements

### Requirement: Entity fields
The schemas SHALL contain at least these fields (ids are non-empty strings; times are ISO 8601 strings):
- Module: `id`, `name`, `glyph`, `auto` (fed by coursework sources).
- Course: `id`, `moduleId`, `code`, `name`, `term`, `assessmentsComplete` (the user or a sync confirmed the assessment list is final).
- Assessment: `id`, `courseId`, `name`, `kind`, `weight`, `score?`, `due?`, `hurdleMin?`, `isFinal`, `status` (`not_started` | `in_progress` | `submitted` | `graded`).
- SourceItem: `id`, `platform` (`canvas` | `ed` | `manual`), `externalId`, `courseId?`, `kind` (`assignment` | `announcement` | `material` | `post` | `event`), `title`, `url?`, `text` (already redacted), `contentHash`, `fetchedAt`.
- Citation: `sourceItemId`, `quote`, `locator`.
- Step: `title`, `estimateMinutes`, `done`, `citations` (array, may be empty only for manual tasks).
- Task: `id`, `moduleId`, `courseId?`, `assessmentId?`, `title`, `source` (`coursework` | `manual`), `due?`, `repeat?` (`daily` | `weekly`), `steps`.
- Change: `seq`, `kind` (`created` | `updated` | `deleted`), `entity` (`course` | `assessment` | `source_item` | `task`), `entityId`, `before?`, `after?`, `at`.
- Run: `id`, `command`, `startedAt`, `endedAt`, `steps`, `outcome` (`ok` | `error`), `errorCode?`, `costUsd?`; M1 sync runs SHALL additionally carry measured `pages`, `requests`, `failures` and per-source `coverage`. These measurement fields SHALL be optional for historical/non-sync runs, without fabricated backfill.

Removing `ical` from the domain enum and `src/domain/schemas.ts` SHALL happen in the same implementation increment (#77/#80). No other SourceItem/Citation/Assessment fields or enums SHALL change under this milestone.

#### Scenario: Unknown enum value
- **WHEN** a SourceItem with `platform: "moodle"` is parsed
- **THEN** parsing fails and the error names the `platform` path

#### Scenario: iCal removed
- **WHEN** SourceItems with `platform: "ical"` and each of `canvas`, `ed`, `manual` are parsed
- **THEN** iCal fails at `platform` and all three supported providers pass when their remaining fields are valid

#### Scenario: Historical Run compatibility
- **WHEN** a valid historical Run has no M1 measurement fields
- **THEN** it remains readable without claiming measured coverage

### Requirement: Changes and runs are recorded
A Change SHALL record its kind (`created`, `updated`, `deleted`) and the affected entity. `created` MUST have `after` and no `before`; `deleted` MUST have `before` and no `after`; `updated` MUST have both. Its positive integer `seq` is assigned by the store (see `local-store`); caller-supplied sequence assignment SHALL be forbidden. Changes SHALL retain stable entity references, timestamps and validated redacted snapshots. Existing specialized update history SHALL map to `updated`, additions to `created` and removals to `deleted` while preserving seq, references and snapshots. A Run SHALL record the command, start and end time, step count, outcome, and an optional cost reported by the caller; M1 measurements SHALL follow the Entity fields and Run measurements requirements without invented costs.

#### Scenario: Change without before or after
- **WHEN** an `updated` change lacks `before`, or a `created` change has a `before`
- **THEN** validation fails

#### Scenario: Several unavailable reasons
- **WHEN** a course has nothing graded and no final
- **THEN** the need is `unavailable` with reason `nothing_graded`

#### Scenario: Operation payload validation
- **WHEN** a synthetic created has before, updated lacks before, or deleted has after
- **THEN** validation rejects the invalid payload without storage writes

#### Scenario: Historical operations migrate
- **WHEN** a synthetic database contains item-added, item-removed and deadline/grade/content changes
- **THEN** migration retains their seq and evidence with corresponding created/deleted/updated operations

## ADDED Requirements

### Requirement: Run measurements validate operational coverage
M1 pages/requests/failures SHALL be nonnegative integer measurements. Per-source coverage SHALL use validated provider and scope references, attempted/completed/skipped/failed/not-started counts and sanitized gap/outcome codes. Coverage SHALL remain operational data within Run, not new coursework entities or permission grants. `RunSchema` SHALL remain the read/compatibility validator, including historical `command: sync` records. `SyncRunSchema` SHALL validate new finalization with `command: sync` and all four required measurement fields. Optional historical measurements, when present, SHALL form a complete group; none SHALL be backfilled.

Each coverage entry SHALL be a strict operational record: `provider` (`canvas` | `ed`), an opaque lowercase 64-hex `scopeRef` generated from the provider-qualified scope, `collection`, nonnegative integer `planned`, `attempted`, `completed`, `skipped`, `failed`, `notStarted`, and `codes`. Canvas collections are `assignments`, `assignment_groups`, `submissions`, `modules`, `files`, `materials`; Ed collections are `courses`, `lessons`, `attempts`, `slides`, `threads`, `resources`, `materials`. Codes SHALL be existing protocol error codes or the local coverage outcomes `CANCELED`, `INCOMPLETE`, `UNSUPPORTED`, `SKIPPED`, `NOT_STARTED`; these local outcomes do not extend the protocol error vocabulary. Coverage SHALL reject unknown fields, raw URLs, course titles, names, quotes and free-form errors. Schema validation cannot prove measurements are actual; the sync lifecycle is responsible for counting operations.

New sync finalization SHALL require the measurements; successful HTTP reads alone MUST NOT imply complete normalized coverage. All metrics SHALL reflect actual operations without personal data or invented costs.

#### Scenario: Invalid metrics
- **WHEN** a synthetic M1 Run has negative/nonintegral counts, unsafe coverage or missing required sync measurements
- **THEN** finalization is refused by validation rather than storing false metrics
