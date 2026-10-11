## ADDED Requirements

### Requirement: Compare semantic fields against current state
Sync SHALL compare every adapter-owned canonical redacted domain field against current-state entities and emit `created`, `updated` or `deleted` with stable entity references and before/after snapshots. One updated event SHALL reflect all changed fields, including removed optional due/score values. Fetch timestamps, raw JSON formatting and insignificant ordering MUST NOT cause semantic events. Current state SHALL remain authoritative; content hashes alone MUST NOT replace field comparison, and no new changed-fields entity SHALL be introduced.

#### Scenario: New assessment and changed due and score
- **WHEN** a synthetic new assessment is followed by a run changing both its due date and score
- **THEN** events are one created with only after and one updated with before/after showing both differences

#### Scenario: No semantic change
- **WHEN** the same source is fetched later with reordered irrelevant JSON and equivalent numeric/date representations
- **THEN** no event is appended and no change cursor advances

#### Scenario: Optional value removed
- **WHEN** a fresh authoritative source explicitly removes a previously recorded due date or score
- **THEN** field comparison emits an updated event with that removal reflected in after

### Requirement: Delete only from complete authoritative scopes
Deletion SHALL require fresh complete enumeration of the same provider/course/collection and apply only to absent adapter-owned entities. Incomplete pagination, auth/error/cap/cancel, malformed normalization, skipped endpoints, first-page-only threads, failed PDF extraction and deselection MUST NOT prove deletion. Independently complete scopes SHALL be publishable while failed scopes retain prior state. Manual tasks/modules and owner-owned fields MUST NOT be deleted by source reconciliation.

#### Scenario: Complete removal
- **WHEN** complete synthetic enumeration of a selected assessment collection omits a formerly present owned item
- **THEN** current state removes the item and appends a deleted event with only its redacted before snapshot

#### Scenario: Partial run and deselection
- **WHEN** page two fails, Ed auth expires, a first thread page omits an old post, or a course is deselected
- **THEN** prior entities in the affected scopes remain and no deleted event is inferred

#### Scenario: Independent scope completion
- **WHEN** one synthetic course collection completes and another fails
- **THEN** the completed collection can publish while the failed collection retains prior state and reports incomplete coverage

### Requirement: Read incremental changes with a monotonic cursor
`coursework changes --since <cursor> --json` SHALL validate a nonnegative exclusive cursor, read append-only events in ascending seq order with bounded pagination and return the last emitted seq as next cursor, or the input cursor when empty. It SHALL use the existing validated `coursework.agent/v1` envelope within 64 KiB. Invalid input SHALL return `INVALID_INPUT`; an event too large to return SHALL yield `LIMIT_EXCEEDED` without skipping it, silently truncating or advancing the cursor. Committed seq values SHALL remain monotonic across restarts and entity deletions. Cursor reads MUST NOT depend on event replay for current-state queries.

#### Scenario: Resume between pages
- **WHEN** synthetic events 1, 2 and 3 exist and a bounded read since 1 returns event 2
- **THEN** its next cursor is 2 and reading since 2 returns event 3 exactly once

#### Scenario: Empty and invalid cursor
- **WHEN** a valid cursor has no later events or input is negative/nonintegral
- **THEN** the empty result retains the input cursor and invalid input returns `INVALID_INPUT`

#### Scenario: Oversized event
- **WHEN** one synthetic event cannot fit the envelope bound
- **THEN** `LIMIT_EXCEEDED` is returned without omission or cursor advance
