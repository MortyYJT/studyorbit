## Context

`web/src/LocalPlanning.tsx` keeps every owner edit in browser localStorage:

- `coursework.local-planning.corrections.v1`: `Record<key, Correction>`. `key` is an item key `<courseId>:<assessmentId>` or a group key `<courseId>:group:<courseId>:<assessmentId>` (edits to a parent's group row). `Correction` has optional `name`, `kind`, `nature`, `weight`, `score`, `outOf`, `due`, `status`, `rule`, `scoring`, `parent` (an item key or `''`), `link`, `mergeInto` (an item key), `hidden` and the legacy `bonus`. `withCorrections` and `groupParents` lay them over the synced document at render time; `null` clears a value.
- `coursework.local-planning.assessments.v1`: manual assessments per course (`Record<courseId, Assessment[]>`, keys `<courseId>:manual:<uuid>`).
- `coursework.local-planning.order.v1`: the per-course order list (`Record<courseId, string[]>`).
- `coursework.local-planning.work.v1`: planned tasks and spent time; plus grade targets, availability and the selected course IDs.

The item edit form saves *every* field each time (name, kind, nature, rule, weight, score, out of, due, parent, status, link), using the currently displayed values as defaults. A stored correction therefore cannot tell which fields the owner actually changed.

The course page and the chat read the newest valid `分数结构*.json` per course through `loadCourseReports` (`scripts/lib/course-reports.mjs`). The sync runner (`scripts/course-sync-runner.mjs`) writes a new file per run and never overwrites. The course-contract-v2 change makes assessment IDs stable and code-generated, records `legacyIds` in each v2 document, passes the newest valid earlier document of the course to the runner (PR 2), and adds the pure `migrateLocalKeys(stores, courseId, legacyIds)` in `shared/` and `toDisplayDocument` (PR 3).

Local stores in `.local/` follow `scripts/lib/revision-store.mjs`: owner-only files (0600) in a 0700 directory, temp-file-and-rename writes, a promise queue to serialise read-modify-write, and a read that throws on anything other than a missing file so a later write never replaces data it could not read. Local API routes in `vite.config.ts` check the loopback address and use `foreignOrigin` (`scripts/lib/local-origin.mjs`); write methods also require an exact `Origin` and `Content-Type: application/json`.

Owner decisions: #248 (corrections move to `.local/`, merged by Node), #249 (on conflict the owner's value is used first, the conflict is shown, the owner chooses), #253 (Claude makes the remaining design choices). Choices made under #253 for this change are recorded as #290–#298.

## Goals / Non-Goals

**Goals:**
- Corrections, manual assessments and order lists live in `.local/` and survive a cleared browser profile.
- A re-sync never silently discards or silently overrides an owner correction.
- Every disagreement between a sync and a correction is visible and resolvable on the page.
- The owner learns when a sync moves a due date or changes a weight.
- Existing localStorage data is carried over once without loss.

**Non-Goals:**
- Moving planned work, time logs, grade targets, availability or course selection (they never meet sync data in a merge).
- Applying corrections in the chat context (it keeps using synced data only; a later change can read the same store).
- Logging score, status or name changes, or added and removed assessments.
- `node:sqlite` (#250); multi-device sync.

## Decisions

### 1. Store scope and file format (decision #290)

One file per course: `.local/corrections/<courseId>.json`, with `courseId` matching `^\d{1,20}$` (Canvas course IDs; this keeps the file name safe). It holds the three stores that describe course structure and are laid over synced data — corrections, manual assessments and the order list. Planned work, time logs, grade targets, availability and the selected course IDs stay in localStorage: they do not take part in the merge and moving them would only widen the migration.

```
{ version: 1,
  courseId: "<digits>",
  revision: <integer ≥ 1>,                     // +1 on every write
  base: { digest: string | null,               // sha256 of JSON.stringify(document) the base was taken from
          assessments: { [assessmentId]: Fields } },
  corrections: { [key]: Correction },          // keys start with "<courseId>:"; same shape as today
  manual: Assessment[],                        // keys "<courseId>:manual:<uuid>"; page shape, kept as given
  order: string[],
  pins: { [key]: string[] },                 // owner fields kept even when equal to the base (§4)
  conflicts: Conflict[],
  updatedAt: ISO string }
```

`Fields` is the synced value of every overridable field in correction vocabulary (§3). Validation (zod, in `shared/corrections.ts`): `version` is exactly 1; correction keys start with `<courseId>:`; corrections use the known fields with today's types (unknown fields rejected); a manual item needs a `key` of the form `<courseId>:manual:<id>` and a non-empty string `name` (other fields kept as given); limits of 2 000 corrections, 500 manual items and 2 000 order entries per course and 1 MB per request body.

I/O (`scripts/lib/corrections-store.mjs`) copies the revision-store pattern: 0700 directory, 0600 files, temp file + rename, one promise queue for all read-modify-write operations. A missing file reads as "no store". Any other read failure, invalid JSON, a failed schema check or an unknown `version` throws `CORRECTIONS_UNREADABLE`; the API returns 500 for that course and every write, import and reconcile for it is refused, so the file is never replaced.

Alternative: one file for all courses — rejected; one unreadable file would block every course, and per-course revisions keep concurrent edits on different courses apart.

### 2. Local API

All routes sit under the existing `/api/local` guard, check the loopback address, send `Cache-Control: no-store`, and for non-GET methods require an exact same-origin `Origin` and `Content-Type: application/json` (as `/api/local/revision-notes`).

| Route | Behaviour |
| --- | --- |
| `GET /api/local/corrections` | Every course with a store file. Courses in the current course list are reconciled first (§4). Returns `{ courses: { [courseId]: View } }`; an unreadable file is reported as `{ error: 'CORRECTIONS_UNREADABLE' }` for that course only. |
| `GET /api/local/corrections?courseId=<id>` | One course, reconciled. No file → `{ exists: false, revision: 0, corrections: {}, manual: [], order: [], conflicts: [] }`. |
| `PUT /api/local/corrections/<courseId>` | Body `{ revision, corrections, manual, order }`. `revision` must equal the stored one (0 when no file exists, which creates it with the same base as an import: the current newest valid course file of the course, or `digest: null` when there is none, §6); otherwise `409 { error: 'REVISION_MISMATCH', current: View }`. The server normalises (§3), closes conflicts on fields the request changed, writes, returns the new `View`. |
| `POST /api/local/corrections/<courseId>/import` | Body `{ corrections, manual, order }`. When any file exists for the course → `200 { imported: false }` (an unreadable file → 500, never overwritten). Otherwise creates the store (§5) with `flag: 'wx'` → `201 { imported: true, store: View }`. |
| `POST /api/local/corrections/<courseId>/conflicts/<conflictId>` | Body `{ revision, choice: 'sync' \| 'mine' }`; revision checked as for `PUT`; unknown conflict → 404. Returns the new `View`. |

`PUT`, import and conflict resolution reconcile the course first (inside the same queue entry), so a sync that landed after the page last read the store bumps the revision and the stale write gets `409` instead of being normalised against an old base.

`View` = `{ exists: true, revision, corrections, manual, order, conflicts }` (the base stays on the server). Errors use the codes `INVALID_COURSE_ID`, `INVALID_BODY`, `TOO_LARGE`, `REVISION_MISMATCH`, `CONFLICT_NOT_FOUND`, `CORRECTIONS_UNREADABLE`, `CORRECTIONS_UNAVAILABLE`.

### 3. Fields, equality and "what the owner changed" (decision #292)

`assessmentFields(document, courseId)` (pure, `shared/corrections.ts`) turns a course document (through `toDisplayDocument`) into `{ [assessmentId]: Fields }` in correction vocabulary:

| Correction field | From the document |
| --- | --- |
| `name` | `name` |
| `kind` | `kind`, with `test` → `exam` and `other` → `unknown` (as the page does) |
| `nature` | `nature` |
| `weight` | `weight` |
| `score` | `score` |
| `outOf` | `maxScore` |
| `due` | `due` |
| `status` | `status`, with `unknown` → `null` |
| `rule` | `rule` |
| `scoring` | `scoring` |
| `parent` | `<courseId>:<parentId>`, or `null` |
| `link` | the first source URL, or `null` |

A group correction (`<courseId>:group:<courseId>:<id>`) belongs to the same assessment `<id>`. The parent edit form takes its defaults from the source item *with its item correction already applied*, so for stripping (below) a group field is compared with the *effective item value*: the base value overlaid by the item correction of `<courseId>:<id>` for that field. An item-level correction copied under the group key is therefore removed, and choosing 「用同步的」 on the item field is not undone by a leftover group copy. In the merge a group field is compared with the base value, like an item field.

**Equality** (`sameValue(field, a, b)`): `undefined`, `null` and `''` (after trimming) are all "empty" and equal; numbers are equal when they agree to two decimal places; `due` values that both parse as full date-times are equal when they denote the same instant (so `2026-11-10T12:59:00Z` equals `2026-11-10T23:59:00+11:00`), and a date-only `YYYY-MM-DD` equals a date-time whose calendar date in `Australia/Melbourne` is that day; other strings compare trimmed.

**What the owner changed.** Because the edit forms save every field, a correction field *equal to the base value* (for group fields, the effective item value) is treated as not set by the owner. `normaliseCorrections(store)` removes such fields unless the field is pinned (§4), and removes a correction left with no field at all. It runs on import, on every `PUT` and inside every merge.

Form noise that the equality rule alone does not catch (decision #292):

- **Empty `status`.** The item edit form fills the status input from the stored correction (`corrections[key]?.status ?? ''`), not from the synced status, so every save stores `status: ''` even when the sync says `graded`. An empty `status` is always "not set" and is removed whatever the base says (the owner cannot clear a status to "unknown"; there is no such choice in the form). PR 1 also changes the item form's status default to the item's effective status. This fixes today's side effect where saving any edit hid the synced status.
- **Group `due: null`.** The parent edit form puts a full date-time into an `<input type="date">`, which the browser rejects, so every save of a parent stored `due: null` ("owner cleared the date"). PR 1 changes the default to the Melbourne calendar date of the effective due (`YYYY-MM-DD`), which the date-only equality above treats as unchanged. Group corrections imported from localStorage (§6) drop `due: null`, because the old form produced it on every save and a genuine clear cannot be told apart.

**Owner-only fields.** `hidden`, `mergeInto` and `bonus` have no synced counterpart; they are never stripped and never conflict. `link` is stripped when equal to the base link but never conflicts (a different link is shown next to the synced sources, as today).

Corrections on manual items (`<courseId>:manual:...`) and keys of neither form are kept as they are and skipped by the merge.

### 4. Three-way merge and when it runs (decision #291)

**Base.** The base is a copy of the field values (§3) of the document the corrections were last reconciled with, stored in the file with that document's digest. It is not looked up on the Desktop: the owner can delete or rename course files, and when two syncs happen without the page being opened, the correct base is the document the owner saw when making the corrections, not the second-newest file.

**When it runs.** The server reconciles a course when it reads its store (`GET` routes) and the newest valid course file that `loadCourseReports` returns for that course has a digest different from `base.digest`. The runner does not touch the store; reading is the single place where a new file is accepted, so syncs made before this change, a crashed run and a manually placed file are all handled the same way. Reconcile is idempotent: once the base digest equals the file's digest, nothing changes. A course without a valid course file is returned as stored.

**Steps** (inside the write queue):

1. If the new document is v2 with `legacyIds`, apply `migrateLocalKeys` to `{ corrections, manual: { [courseId]: manual }, order: { [courseId]: order }, work: [] }`, and rename `base.assessments` keys the same way (an existing new key wins). This is the same function the page uses; it is idempotent.
2. `mergeCorrections(base.assessments, incoming, store)` (pure).
3. `base` ← `{ digest, assessments: incoming }`; `revision` + 1; write.

**Merge rules**, for each correction key whose assessment ID is known, and each overridable field the correction sets (b = base, i = incoming, u = owner):

| Case | Result |
| --- | --- |
| `u` equals `b`, field not pinned (owner did not change it) | drop the field; the sync value shows |
| `u` equals `b`, field pinned, `i` equals `b` | keep `u` (pinned) |
| `u` equals `b`, field pinned, `i` differs | keep `u`; record a `field` conflict |
| `i` equals `b` (only the owner changed it) | keep `u` |
| `i` equals `u` (both changed to the same value) | keep the field and **pin** it; close any open conflict on it |
| all three differ | keep `u`; record a `field` conflict `{ base: b, incoming: i, user: u }` |
| no base entry for the assessment | treat `b` as `i`: keep `u` if it differs, no conflict |

**Pins** (decision #298). When the sync converges on the owner's value, dropping the field would let the next sync change silently replace a value the owner set (and name, score or kind changes are not in the change log). Instead the field stays in the correction and its name is added to `pins[key]`. A pinned field is never stripped by the "equal to the base" rule; a later sync that changes it raises a `field` conflict and the owner's value stays. A pin is removed when the owner changes that field's value in a `PUT` (the new value is then treated like any owner change) or chooses 「用同步的」 for it, and when the correction is deleted.

- **Assessment removed by the sync**: raised only on the transition from present to absent, i.e. the key's ID is in `base.assessments` and not in `incoming`. The correction is kept unchanged; unless its only fields are `hidden` (hiding something that is gone needs no decision), an `orphaned` conflict is recorded. Because the base then advances to `incoming`, which also lacks the ID, later syncs that still lack it raise nothing, so a 「保留」 choice sticks. If the assessment comes back, its correction is merged with no base entry (adopted, no conflict).
- **Reference to a removed assessment**: likewise only on the transition: a correction whose `parent` or `mergeInto` names an item key whose ID is in `base.assessments` and not in `incoming` (manual keys excluded) keeps the value and records a `dangling` conflict for that field.
- **New assessment**: no correction exists; nothing to do.
- Existing conflicts: a new conflict replaces an open one with the same ID; open `field` conflicts whose correction field was dropped are closed.
- Import and a `PUT` that creates the store run the same transition check once against the new base: corrections whose assessment or reference target is not in that base get `orphaned` or `dangling` conflicts. With `digest: null` nothing is raised.

`Conflict` = `{ id, type: 'field' | 'orphaned' | 'dangling', key, assessmentId, field: string | null, base, incoming, user, detectedAt }`, where `id` is the first 16 hex characters of `sha256("<type>|<key>|<field>")`, so the same disagreement keeps one ID across merges.

### 5. Conflict resolution and edits (decision #293)

- `choice: 'sync'` — `field`: delete that field from the correction (the correction is deleted when empty); `orphaned`: delete the correction; `dangling`: delete that field. The conflict is closed.
- `choice: 'mine'` — the conflict is closed and the correction stays; this neither adds nor removes a pin (the value differs from the new base, so it is kept anyway). The base already holds the incoming value, so the same disagreement is not raised again unless a later sync changes the field again; an orphaned or dangling conflict is not raised again while the assessment stays absent.
- A `PUT` that changes or removes a correction field with an open conflict closes that conflict (the owner has chosen by editing).

The page shows open conflicts in three places: a 「同步冲突」 block at the top of the course page (assessment name, field label, 「同步：」 incoming, 「你的：」 user, buttons 「用同步的」/「保留我的」; orphaned items read 「这项已不在最新同步里，你的修正暂时未用」 with 「删除修正」/「保留」); a mark beside the conflicted field in the drawer; and one line per course in the week page's 「需要你处理」 list (「<CODE>：N 项修正和同步结果不一致」) that opens the course. The owner's value is what the page uses until a choice is made (#249).

### 6. One-time migration from localStorage (decision #294)

On each course-reports load the page runs, in order:

1. The course-contract-v2 `migrateLocalKeys` on localStorage (unchanged), so keys are stable IDs before anything is sent.
2. For every course ID that has corrections (keys `^\d+:`), manual items or an order list in localStorage and is not listed in the marker `coursework.corrections-migrated.v1` (`{ courses: string[] }`): `POST /import` with that course's slices. On `imported: true` or `imported: false`, the course is added to the marker. On failure it is left out and retried on the next load.
3. `GET /api/local/corrections` and use it as the source for every course in the marker or with no localStorage data.

The server's import validates, takes the current newest valid course file of that course as the base (or an empty base with `digest: null` when there is none, adopted at the first reconcile), runs `migrateLocalKeys` once more, drops `due: null` from group corrections (§3), normalises (§3), runs the transition check (§4) and creates the file with `flag: 'wx'`. Import is idempotent: a second call finds the file and returns `imported: false`, which also covers two tabs importing at once and a profile whose course was already imported elsewhere (its localStorage copy is then not merged in).

A per-course marker is used instead of one flag: if one course fails, the page keeps reading and writing localStorage for that course only, as today, so an edit made before the retry cannot be lost when an already-imported course would otherwise be skipped. The localStorage stores are never deleted; after migration they are a read-only backup.

### 7. Page reads and writes (decision #295)

After migration, `corrections`, `manual` and `order` state are built from the views of all migrated courses, so `withCorrections`, `groupParents`, `visibleItems` and `sorted` work unchanged. `saveCorrections`, `saveManual` and `move` update state at once, then `PUT` each changed course with its `revision`. On `409` the page replaces that course's state with the returned `current` view and shows 「修正已在别处更新，已刷新；请重新编辑」; the edit is not re-applied automatically. On any other failure it restores the previous state and shows the existing save error. Writes for one course are sent one at a time so a second edit carries the revision returned by the first.

### 8. Change log (decision #296)

**Diff** (pure, `diffSnapshots(previous, current)` in `shared/course-changes.ts`): both documents go through `toDisplayDocument`. A previous assessment is paired with the current assessment of the same ID, or with `legacyIds[previousId]` when that entry exists in the current document. For each pair it reports `due` when `sameValue('due', …)` is false and `weight` when `sameValue('weight', …)` is false (both including value ↔ `null`). Output `[{ assessmentId, name, field: 'due' | 'weight', before, after }]` in current document order, `due` before `weight`; `name` is the current name. Unpaired assessments (added or removed) are not reported, because the first v2 sync would otherwise flood the log with unmapped v1 items; scores, statuses and names are never reported.

**Runner:** after a course file is written, the runner diffs it against the newest valid earlier document of the course (the same document course-contract-v2 passes to `buildLegacyIds`; none → no lines) and appends one line per change to `.local/lms/changes.jsonl` (directory 0700, file 0600): `{ at, runId, courseId, assessmentId, name, field, before, after }`. A failed append adds 「变更记录写入失败。」 to the course `reason` and does not change its status.

**API:** `GET /api/local/course-changes` returns `{ changes }`, the newest 200 lines that parse and match the schema, newest first; a missing file returns `[]`; malformed lines are skipped.

**Page:** a change is unseen when its `at` is later than localStorage `coursework.course-changes-seen.v1` (an ISO time; absent = everything unseen). Unseen changes of courses in the course list appear in the 「需要你处理」 list as 「<CODE> <name>：截止 <before> → <after>」 or 「权重 <before>% → <after>%」 (empty shown as 「未知」), and at the top of that course's page. 「知道了」 sets the marker to the newest `at` shown. The seen marker is a display preference, so it stays in localStorage.

### 9. Chat stays on synced data (decision #297)

`chat-context.mjs` and `/api/local/course-reports` are unchanged: the chat still sees synced data only, as its header comment says. Reading the store from the chat is now possible but is a separate change with its own prompt wording.

## Risks / Trade-offs

- [A `GET` writes the store] → only when a new course file is first seen; the write is queued, atomic and idempotent, and the routes are loopback and same-origin only.
- [Stripping fields equal to the base loses "pin this value" intent when the owner types the synced value itself] → the edit form saves every field, so this cannot be told apart from untouched; values the owner set *before* the sync agreed are pinned when it converges (§4), so they are never lost silently.
- [An imported group correction that genuinely cleared a due date loses that clear] → accepted; the old form wrote `due: null` on every parent save, so keeping it would clear every edited parent's date.
- [Imported corrections have an unknown original base] → the current file is used as the base; fields already equal to it are dropped (they changed nothing on screen); others are kept as owner changes. No conflict can be raised for changes that happened before the import.
- [The first v2 sync after v1 differs in many fields] → due dates compare by instant; remaining differences (kinds, cleared weights) raise conflicts or change-log lines, which is honest but may be many once.
- [Deleting the newest course file makes an older file "new"] → treated like a sync that changed values back; owner values still win and conflicts are shown.
- [Two tabs edit the same course] → the second write gets `409` and refreshes; nothing is silently overwritten.
- [Change-log entries and conflicts contain names, dates and, for conflicts, scores] → they stay in git-ignored `.local/` with owner-only permissions; tests use synthetic data.

## Migration Plan

PR 1 ships the store, the API and the import; the page switches each course to the server once its import succeeds, and keeps localStorage as a backup. Rollback: revert the PRs; the page reads localStorage again, which still holds the pre-migration data, but corrections made after migration exist only in `.local/corrections/` and must be re-entered (the PR body must say so). PR 2 and PR 3 add behaviour without new migrations; `.local/lms/changes.jsonl` can be deleted at any time.

## Open Questions

- Should the chat context apply corrections and mention open conflicts? Left to a later change (§9).
- Should a weight cleared as 「无出处」 by course-contract-v2 be filled automatically from a matching owner correction? With this design the correction already wins on screen; no automatic rewrite of course files is planned.
