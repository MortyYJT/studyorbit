# local-corrections Specification

## Purpose
The owner's corrections, manual assessments and order lists are stored per course in `.local/corrections/`, served by a local API, and merged three-way with each new sync result so owner changes survive re-syncs; disagreements are shown as conflicts the owner resolves.
## Requirements
### Requirement: Corrections are stored per course in `.local/`
The system SHALL store each course's owner corrections, manual assessments and order list in `.local/corrections/<courseId>.json`, with the file readable and writable by the owner only (0600) in an owner-only directory (0700), together with an integer `revision`, the merge base (the digest of the course document last reconciled and its overridable field values per assessment ID) and the open conflicts. Course IDs MUST match `^\d{1,20}$`. Writes SHALL be serialised and atomic. A file that exists but cannot be read, is not valid JSON, fails the store schema or has an unknown `version` MUST NOT be overwritten by any write, import or merge. Planned work, time logs, grade targets, availability and the selected course IDs SHALL stay in browser localStorage.

#### Scenario: Corrections survive a cleared browser
- **WHEN** the owner corrects a weight, then clears the browser's site data and reloads the page
- **THEN** the corrected weight is still shown

#### Scenario: Unreadable store is left alone
- **WHEN** `.local/corrections/100.json` contains invalid JSON and the page saves a correction for course `100`
- **THEN** the save fails with `CORRECTIONS_UNREADABLE` and the file content is unchanged

#### Scenario: Invalid course ID
- **WHEN** a request names the course `../x`
- **THEN** it is rejected with `INVALID_COURSE_ID` and no file is touched

### Requirement: Corrections API with optimistic revisions
The system SHALL serve `/api/local/corrections` to loopback, same-origin requests only, with JSON bodies required for writes: `GET` for all courses with a store or one course (`?courseId=`), `PUT /<courseId>` with `{ revision, corrections, manual, order }`, `POST /<courseId>/import`, and `POST /<courseId>/conflicts/<conflictId>`. A `PUT` with revision 0 for a course without a file SHALL create the store with the same base as an import (the current newest valid course file of the course). A `PUT` or conflict resolution whose `revision` differs from the stored revision (0 when no file exists) MUST be rejected with `409` and the current store, and MUST NOT change the file. Every successful write SHALL increase `revision` by one.

#### Scenario: Stale write is rejected
- **WHEN** two tabs read course `100` at revision 4, the first saves (revision 5), and the second then saves with revision 4
- **THEN** the second save gets `409` with the revision 5 store, and the page shows that the corrections were updated elsewhere and refreshes them

#### Scenario: First save creates the store
- **WHEN** course `300` has no store file and no localStorage data, and the owner saves a weight correction with revision 0
- **THEN** the store is created with the course's newest valid course file as its base, and the correction is kept only if it differs from that file

#### Scenario: Foreign origin
- **WHEN** a page served from another local port sends `GET /api/local/corrections`
- **THEN** the request is refused with `403`

### Requirement: One-time migration from localStorage
On page load, after the course-contract-v2 key migration has run on localStorage, the page SHALL import, for every course that has corrections, manual assessments or an order list in localStorage and is not yet listed in `coursework.corrections-migrated.v1`, that course's data through `POST /<courseId>/import`. The server SHALL create the store only when no file exists for the course, using the current newest valid course file as the base, and SHALL otherwise answer `imported: false` without changing anything. The page SHALL add the course to the marker after either answer and SHALL use the `.local/` store for it from then on; until then it SHALL keep using localStorage for that course. The localStorage data MUST NOT be deleted.

#### Scenario: First load after the upgrade
- **WHEN** localStorage holds corrections for courses `100` and `200`, neither has a `.local/` store, and the page loads
- **THEN** both stores are created with those corrections, the marker lists `100` and `200`, the page shows the same corrected values as before, and localStorage still holds the original data

#### Scenario: Import repeated
- **WHEN** the import for course `100` is sent again after its store exists
- **THEN** the server answers `imported: false` and the store and its revision are unchanged

#### Scenario: One course fails
- **WHEN** the import for course `200` fails and the owner then edits a correction of course `200`
- **THEN** the edit is saved to localStorage, course `200` is not in the marker, and the next load imports it including the edit

#### Scenario: Keys moved before import
- **WHEN** localStorage holds a correction under a v1 key and the course's newest file is v2 with `legacyIds` mapping that ID
- **THEN** the imported store holds the correction under the v2 key

### Requirement: Only fields the owner changed are kept
The system SHALL compare each item correction field with the base value of the same assessment, and each group correction field with the effective item value (the base value overlaid by that assessment's item correction), using the correction vocabulary (`kind` `test` as `exam` and `other` as `unknown`, `status` `unknown` as empty, `outOf` for `maxScore`, `parent` as an item key, `link` as the first source URL), treating `undefined`, `null` and an empty string as equal, numbers as equal to two decimal places, due date-times as equal when they denote the same instant, and a date-only due as equal to a date-time on the same calendar day in `Australia/Melbourne`. A field equal to that value SHALL be removed on import, on every save and in every merge unless it is pinned, and a correction left without fields SHALL be removed. An empty `status` SHALL always be treated as not set and removed. Group corrections imported from localStorage SHALL drop `due: null`. `hidden`, `mergeInto` and `bonus` SHALL never be removed this way. The item edit form SHALL default the status to the item's effective status, and the parent edit form SHALL default its date input to the calendar date of the effective due.

#### Scenario: Form saves unchanged fields
- **WHEN** the base has weight 20 and due `2026-11-10T12:59:00Z`, and the owner saves the edit form changing only the weight to 25 (the form also sends due `2026-11-10T23:59:00+11:00` and status `''`)
- **THEN** the stored correction contains only `weight: 25`

#### Scenario: Empty status against a synced status
- **WHEN** the base status is `graded` and a saved correction has `status: ''`
- **THEN** the status field is removed and the page shows 「已出分」 with no conflict on any later sync

#### Scenario: Item correction copied into the group correction
- **WHEN** the owner corrected the weight of parent `canvas-group:300` to 40 (base 30), then saves the parent edit form changing only the name, and later chooses 「用同步的」 for the weight
- **THEN** the group correction holds only the name, and after choosing the sync value the page shows weight 30

#### Scenario: Parent due date round trip
- **WHEN** a parent's effective due is `2026-11-10T12:59:00Z` and the owner saves the parent edit form without touching the date (the form sends `2026-11-10`)
- **THEN** no `due` field is stored for the group

#### Scenario: Imported parent date noise
- **WHEN** localStorage holds a group correction with `due: null` and a name change, and it is imported while the base due is `2026-11-10T12:59:00Z`
- **THEN** the imported group correction holds only the name

### Requirement: Three-way merge with sync results
When the server reads a course store and the newest valid course file for that course has a digest different from the store's base digest, it SHALL first apply that document's `legacyIds` to the store's keys and base with `migrateLocalKeys`, then merge per assessment and per overridable field (`name`, `kind`, `nature`, `weight`, `score`, `outOf`, `due`, `status`, `rule`, `scoring`, `parent`, `link`) with the base as the common ancestor, then set the base to the new document. The owner's value SHALL be used whenever the owner changed a field, including when the sync also changed it to a different value (#249). When the sync converges on a value the owner set, the field SHALL be kept and pinned so that a later sync change raises a conflict instead of replacing it. Corrections for assessments the sync removed SHALL be kept, and orphaned or dangling conflicts SHALL be raised only when the assessment or reference target was in the base and is absent from the new document. Merging the same document twice SHALL change nothing.

#### Scenario: Only the sync changed
- **WHEN** the base weight is 20, the owner has corrected only the name, and the new file has weight 25
- **THEN** the page shows weight 25 and the owner's name, and no conflict is recorded

#### Scenario: Only the owner changed
- **WHEN** the base weight is 20, the owner corrected it to 30, and the new file still has 20
- **THEN** the page shows 30 and no conflict is recorded

#### Scenario: Both changed to the same value
- **WHEN** the base weight is 20, the owner corrected it to 30, and the new file has 30
- **THEN** the page shows 30, no conflict is recorded, and the weight field stays in the correction as pinned

#### Scenario: Sync changes a converged value later
- **WHEN** the base weight is 20 and the owner corrected it to 30; the first re-sync has 30; a second re-sync has 25
- **THEN** after the second re-sync the page still shows 30 and a `field` conflict records sync 25 and owner 30

#### Scenario: Both changed to different values
- **WHEN** the base due date is 3 November, the owner corrected it to 5 November, and the new file has 10 November
- **THEN** the page shows 5 November and a `field` conflict records base 3 November, sync 10 November and owner 5 November

#### Scenario: Assessment removed by the sync
- **WHEN** the owner corrected the weight of `canvas:5551`, the base has `canvas:5551`, and the new file no longer has it
- **THEN** the correction is kept and an `orphaned` conflict is recorded for it

#### Scenario: Kept orphan is not raised again
- **WHEN** the owner chose 「保留」 for that `orphaned` conflict and the next re-sync still lacks `canvas:5551`
- **THEN** no conflict is recorded and the correction is still kept

#### Scenario: Hidden assessment removed by the sync
- **WHEN** the owner's only correction of `canvas:5552` is `hidden: true` and the new file no longer has it
- **THEN** the correction is kept and no conflict is recorded

#### Scenario: Merge target removed by the sync
- **WHEN** a correction has `mergeInto: '100:canvas:5551'`, the base has `canvas:5551`, and the new file no longer has it
- **THEN** the `mergeInto` value is kept and a `dangling` conflict is recorded for that field

#### Scenario: New assessment
- **WHEN** the new file adds `canvas:5560`, which has no correction
- **THEN** it is shown with its synced values and no conflict is recorded

#### Scenario: All corrections survive a re-sync
- **WHEN** the owner has corrections on name, weight, due, score, parent and `hidden` across several assessments, and a re-sync writes a new file in which some of those fields changed and others did not
- **THEN** every value the owner set is still what the page shows, either kept in the correction or equal to the new synced value

#### Scenario: Two syncs before the page is opened
- **WHEN** the owner corrected a weight against file A, then files B and C are synced without the page being opened, and C differs from A in that weight
- **THEN** the merge compares with A as the base, not B

#### Scenario: Reading twice
- **WHEN** the store is read twice with no new course file in between
- **THEN** the second read does not change the store or its revision

### Requirement: Conflicts are shown and the owner chooses
The course page SHALL list the course's open conflicts with the assessment name, the field, the sync value and the owner's value, and offer 「用同步的」 and 「保留我的」 (for an assessment no longer in the sync, 「删除修正」 and 「保留」); the drawer SHALL mark a conflicted field; and the week page's 「需要你处理」 list SHALL show one line per course with open conflicts that opens the course. Choosing the sync value SHALL remove the correction field (an orphaned correction is removed whole) and close the conflict; keeping the owner's value SHALL close the conflict and keep the correction, and the same disagreement SHALL NOT be raised again unless a later sync changes that field again. A save SHALL count a field as changed only when the stored and sent values are not equal under the same equality used for the merge; an unchanged field SHALL keep its stored value, pin and conflict. Saving a changed value for a conflicted field SHALL close its conflict. Saving a changed value for a pinned field, or choosing the sync value, SHALL remove the field's pin. When a merge moves corrections to new keys through `legacyIds`, their pins and open conflicts SHALL move with them, and SHALL be dropped when the new key's own correction wins.

#### Scenario: Use the sync value
- **WHEN** a weight conflict shows sync 25 and owner 30, and the owner clicks 「用同步的」
- **THEN** the page shows 25, the weight field is gone from the correction, and the conflict disappears

#### Scenario: Keep the owner's value
- **WHEN** the owner clicks 「保留我的」 on that conflict and the next sync still has 25
- **THEN** the page shows 30 and no new conflict appears

#### Scenario: Conflict in the attention list
- **WHEN** course `SYNT10001` has two open conflicts
- **THEN** the week page's 「需要你处理」 list shows 「SYNT10001：2 项修正和同步结果不一致」 and clicking it opens that course

#### Scenario: Resending a pinned value in another notation
- **WHEN** a due date pinned as `2026-11-10T12:59:00Z` is resent by the edit form as `2026-11-10T23:59:00+11:00` together with a name change
- **THEN** the due date keeps its stored value and its pin, and only the name counts as changed

#### Scenario: Owner edit releases a pin
- **WHEN** a weight of 30 is pinned (base 30) and the owner saves the edit form with weight 35
- **THEN** the pin is removed and 35 is kept as an owner change; when a later sync changes the weight to 25, a conflict records sync 25 and owner 35

#### Scenario: Pin follows a legacy ID rename
- **WHEN** the weight of `100:a1` is pinned and the new document's `legacyIds` maps `a1` to `canvas:5551`
- **THEN** the correction and its pin move to `100:canvas:5551`, and a later sync change of that weight raises a conflict instead of replacing the owner's value

