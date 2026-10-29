Prerequisite: course-contract-v2 PR 2 (stable IDs, `legacyIds`, the newest valid earlier document passed to the runner) and PR 3 (`migrateLocalKeys`, `toDisplayDocument`) are merged. Start PR 1 only after both.

## 1. Corrections store, API and one-time migration (PR 1)

- [ ] 1.1 Tests then the store and correction schemas in `shared/corrections.ts`: `version: 1`, course ID `^\d{1,20}$`, correction keys prefixed by the course ID, known correction fields only, manual item key form, size limits
- [ ] 1.2 Tests then `assessmentFields(document, courseId)` (v1 and v2 through `toDisplayDocument`; `test` → `exam`, `other` → `unknown`, `unknown` status → empty, `maxScore` → `outOf`, `parentId` → item key, first source URL → `link`) and `sameValue` (empty equivalence, two decimals, due instants)
- [ ] 1.3 Tests then `normaliseCorrections`: fields equal to the base removed (item and group keys), empty corrections removed, `hidden`/`mergeInto`/`bonus` kept, manual-item corrections untouched
- [ ] 1.4 Tests then `scripts/lib/corrections-store.mjs` (+ `.d.mts`) in a temp dir: missing file reads as no store; invalid JSON, schema failure and unknown version throw `CORRECTIONS_UNREADABLE` and are never overwritten; 0600 file in a 0700 directory; atomic write; concurrent saves serialised; revision check and `+1`
- [ ] 1.5 Tests then import: creates the store with the current newest valid course file as base (or `digest: null`), runs `migrateLocalKeys`, normalises; a second import returns `imported: false` and changes nothing; an unreadable file is not replaced
- [ ] 1.6 `/api/local/corrections` routes in `vite.config.ts`: `GET` all / one, `PUT /<courseId>`, `POST /<courseId>/import`; loopback, same-origin, JSON-only writes, 1 MB limit, error codes; test the request handling with synthetic requests where the existing route tests allow it
- [ ] 1.7 Tests then the page-side migration helper (pure: localStorage slices per course, marker update): courses with corrections, manual items or order only; keys not of the form `<digits>:` ignored; marker per course; failed course left out
- [ ] 1.8 Page: run the migration after the v2 key migration; read corrections, manual items and order from the API for migrated courses and from localStorage for the rest; `PUT` per changed course with its revision, one at a time; `409` refreshes and shows 「修正已在别处更新，已刷新；请重新编辑」; other failures restore state and show the save error; localStorage never deleted
- [ ] 1.9 `bash .claude/check.sh`; real-browser check with synthetic localStorage data (migration, edit, reload, cleared site data); fresh-context review; record the PR number here

## 2. Three-way merge and conflicts (PR 2)

- [ ] 2.1 Tests then `mergeCorrections(base, incoming, store)` in `shared/corrections.ts`: only sync changed; only owner changed; both changed the same (field dropped, open conflict closed); both conflict (owner value kept, `field` conflict with base/incoming/user); assessment deleted by sync (kept, `orphaned`; hide-only correction raises none); `parent`/`mergeInto` to a removed item (`dangling`); new assessment; no base entry (adopted, no conflict); group corrections compared with their assessment; conflict IDs stable across merges and replaced, not duplicated
- [ ] 2.2 Test "after re-sync all owner corrections are preserved": several assessments with corrections on name, weight, due, score, parent and `hidden`; a new document changing some fields and not others; every owner value is still the effective value after applying the merged store
- [ ] 2.3 Tests then reconcile on read in the store: runs only when the newest file's digest differs from `base.digest`; applies `legacyIds` to keys and base first; base advanced (orphaned base entries kept); revision `+1`; second read changes nothing; two syncs without a read use the older base; `PUT`, import and resolution reconcile first so a stale revision gets `409`
- [ ] 2.4 Tests then `resolveConflict`: `sync` for `field`, `orphaned` and `dangling`; `mine` closes and is not raised again for the same values; a `PUT` changing a conflicted field closes it; route `POST /<courseId>/conflicts/<conflictId>` with revision check and `CONFLICT_NOT_FOUND`
- [ ] 2.5 Page: 「同步冲突」 block on the course page with 「用同步的」/「保留我的」 (orphaned: 「删除修正」/「保留」), field mark in the drawer, one 「需要你处理」 line per course with open conflicts
- [ ] 2.6 `bash .claude/check.sh`; real-browser check with a synthetic course re-synced to a changed synthetic file; fresh-context review; record the PR number here

## 3. Change log and reminder (PR 3)

- [ ] 3.1 Tests then `diffSnapshots(previous, current)` in `shared/course-changes.ts`: due moved, same instant in another notation, weight changed, weight to and from `null`, pairing through `legacyIds` (v1 → v2), score/status/name changes ignored, added and removed assessments ignored, output order
- [ ] 3.2 Runner: after saving a course file, diff against the newest valid earlier document and append lines to `.local/lms/changes.jsonl` (0700/0600); nothing for a first sync; append failure adds 「变更记录写入失败。」 to the reason only; test with synthetic documents and a temp project dir
- [ ] 3.3 Tests then the change-log reader and `GET /api/local/course-changes`: newest 200 first, malformed and schema-failing lines skipped, missing file → empty list
- [ ] 3.4 Page: unseen changes (after `coursework.course-changes-seen.v1`) in 「需要你处理」 and at the top of the course page; 「知道了」 sets the marker to the newest `at` shown; empty values shown as 「未知」
- [ ] 3.5 Update `docs/` (local data layout and the corrections/changes files) and `note/handoff.md`
- [ ] 3.6 `bash .claude/check.sh`; real-browser check of a synthetic re-sync with a moved due date; fresh-context review; record the PR number here; archive the change after PR 3 merges
