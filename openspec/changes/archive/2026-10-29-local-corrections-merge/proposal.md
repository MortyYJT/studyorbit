## Why

The owner's corrections to synced assessments live only in browser localStorage. A re-sync replaces the course file, and the page then lays the old corrections over the new data blindly: a correction made against last week's due date silently hides this week's change, and nothing tells the owner that the sync and their correction now disagree. Node cannot see the corrections at all, so it cannot reconcile them, and a cleared browser profile loses them. The owner decided to move corrections to `.local/` and merge them in Node (#248), and that when a sync and a correction disagree the owner's value is used first, the conflict is shown and the owner chooses (#249). The owner also asked to be told when a sync changes a due date or a weight.

## What Changes

- **Corrections store in `.local/`.** One file per course, `.local/corrections/<courseId>.json` (file 0600, directory 0700), holding the corrections, the owner's manual assessments, the course's order list, the merge base and open conflicts, with an integer `revision`. Writes are serialised and atomic; a file that cannot be read or parsed is never overwritten.
- **Local API `/api/local/corrections`.** `GET` (all courses or one), `PUT /:courseId` (optimistic `revision`, `409` on mismatch), `POST /:courseId/import` (one-time import, ignored when the course already has a file), `POST /:courseId/conflicts/:conflictId` (resolve a conflict). Loopback and same-origin only, JSON bodies only, like the other local routes.
- **One-time migration.** On page load, after the course-contract-v2 key migration, every course that has corrections, manual assessments or an order list in localStorage and no `.local/` file is imported once; a per-course marker `coursework.corrections-migrated.v1` records success. The localStorage copy is kept as a backup and is not deleted.
- **Three-way merge.** A pure `mergeCorrections(base, incoming, store)` in `shared/` runs whenever the server reads a course whose newest valid course file differs from the store's base. Per assessment and per field: untouched → take the sync value; only the owner changed → keep the owner's value; both changed to the same value → kept and pinned, so a later sync change raises a conflict instead of silently replacing it; both changed differently → keep the owner's value and record a conflict. Corrections for assessments the sync removed are kept and flagged once, when they disappear; new assessments start with no corrections. Form noise (an empty status, a parent date the date input could not hold, item edits copied into group corrections) is not counted as an owner change.
- **Conflict UI.** The course page and the "Needs you" list show open conflicts with 「用同步的」/「保留我的」 actions that update the store.
- **Change log.** After each saved sync, a pure `diffSnapshots(previous, current)` compares the previous and new course documents by stable ID; due date and weight changes are appended to `.local/lms/changes.jsonl`, and the page shows unseen changes until dismissed. Score changes are never logged.
- Out of scope: planned work and time logs, grade targets, availability and course selection stay in localStorage; the chat context still uses synced data only (no corrections); `node:sqlite` (#250); added and removed assessments in the change log.

## Capabilities

### New Capabilities

- `local-corrections`: the `.local/` corrections store and its API, the one-time migration from localStorage, the three-way merge with sync results, and conflict display and resolution.
- `course-change-log`: diffing successive course documents by stable ID, the `.local/lms/changes.jsonl` log, and the change reminder on the page.

### Modified Capabilities

None. The course-contract-v2 change (not yet archived) defines `migrateLocalKeys` as reusable by the `.local/` store; this change calls it and does not alter its requirement.

## Impact

- New `shared/corrections.ts`: store and correction schemas, `assessmentFields`, `mergeCorrections`, `normaliseCorrections`, `resolveConflict`.
- New `shared/course-changes.ts`: `diffSnapshots`.
- New `scripts/lib/corrections-store.mjs` (+ `.d.mts`): file I/O, revision check, import, reconcile on read.
- `vite.config.ts`: `/api/local/corrections` and `/api/local/course-changes` routes.
- `scripts/course-sync-runner.mjs`: appends change-log lines after saving a course file.
- `web/src/LocalPlanning.tsx`: reads and writes corrections, manual assessments and order through the API; migration on load; conflict and change reminders.
- Tests: `test/corrections.test.ts`, `test/corrections-store.test.ts`, `test/course-changes.test.ts`, synthetic data only.
- Depends on course-contract-v2 PR 2 (stable IDs, `legacyIds`, the newest valid earlier document in the runner) and PR 3 (`migrateLocalKeys`, `toDisplayDocument`). No new dependencies.
