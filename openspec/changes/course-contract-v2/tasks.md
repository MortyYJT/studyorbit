## 1. Schemas v2 and compatible reading (PR 1)

- [x] 1.1 Tests then the stored document v2 schema in `shared/course-data.ts`: new assessment fields, top-level `legacyIds`, strictness, `unsourced` values, v1 refinements (unique IDs, score ≤ maxScore, parent rules) apply to v2
- [x] 1.2 Tests then `CourseDocumentSchema` as a union on `version` (1 | 2); version 3 and missing version rejected
- [x] 1.3 Tests then `toDisplayDocument`: v1 → empty `refs`, `null` quotes, empty `unsourced`, empty `legacyIds`; v2 passes through
- [x] 1.4 Tests then the model output schema (`CourseModelOutputSchema`): allowed fields only; `id`, `parentId`, `due`, `score`, `maxScore`, `status`, `sources` rejected (schema only; not wired to the sync yet)
- [x] 1.5 Route every reader through the union and `toDisplayDocument`: `scripts/lib/course-reports.mjs` (+ `.d.mts`), `scripts/lib/chat-context.mjs`, `vite.config.ts`, `web/src/LocalPlanning.tsx`; existing v1 tests stay green
- [x] 1.6 `bash .claude/check.sh`; fresh-context review; record the PR number here (PR #259)

## 2. Model output v2 in the sync (PR 2)

- [x] 2.1 Tests then `parseHandbookComponents` in `scripts/lib/course-refs.mjs` (+ `.d.mts`) on synthetic tab-separated text: timing cell, multi-line first cell, header line, `N/A` hurdle row, table repeated per study period (merged), same name with different percentages (suffixed), no table; check it once against a real local Handbook capture (never committed)
- [x] 2.2 Tests then `slug` and ID generation: platform priority, primary reference = smallest ID, repeatable-reference suffix for all sharing items, `group:` fallback, empty slug, `parentKey` → `parentId`
- [x] 2.3 Tests then reference validation in `scripts/lib/course-validation.mjs`: missing Canvas / group / Ed IDs, Handbook name not a parsed component (substring rejected), uncollected source, shared Canvas or Ed reference, leaf with no references, duplicate keys, parent rules on keys, duplicate final IDs; issues name the item and reference; remove the v1 Ed score/maximum check
- [x] 2.4 Tests then fact back-fill: due precedence, score/maxScore pairs (Canvas graded, Ed graded, ungraded maximum, score above maximum), Canvas and Ed status mapping, most-advanced status, group/Handbook/model-only items, `sources` (Canvas group → `platform: 'canvas'`, `url: null`), canonical Handbook names in `refs`
- [x] 2.5 Tests then `buildLegacyIds(previous, current)`: equal IDs first and excluded, v1 source URLs, platform-shaped v1 IDs (Canvas before Ed for bare digits), unique name slug, ambiguous pairs dropped, unchanged IDs omitted, v2 carry-forward and composition
- [x] 2.6 Tests then `buildStoredDocument(modelDocument, collected, previous)` producing a valid stored v2 document (quotes kept as given and `unsourced: []` until PR 3)
- [x] 2.7 `courseOutputSchema()` from the model output schema; prompt gets `handbookComponents` and per-group `rulesText`; rewrite the prompt rules for references, listed Handbook names, exact quotes (Handbook row cells separated by single spaces) and "facts are filled by code"
- [x] 2.8 Runner: `validateAnalysis` gets Handbook data and components; reason 「Handbook 考核表未能解析」 and status at most `partial` when no component parses; the newest valid earlier document is passed in for `legacyIds`; `settleCourse` saves `buildStoredDocument(...)`; diagnostics unchanged
- [x] 2.9 Synthetic end-to-end test: model output fixture + collected fixtures + earlier v1 file → saved v2 file read back by `course-reports`
- [x] 2.10 `bash .claude/check.sh`; fresh-context review; record the PR number here (PR #262)

## 3. Quote verification, local key migration, 「无出处」 display and docs (PR 3)

- [x] 3.1 Tests then normalisation and corpus units in `scripts/lib/course-quotes.mjs` (+ `.d.mts`): tags, entities, NFKC, case, quotes, dashes, whitespace incl. tabs; units = Handbook rows, other Handbook lines, Ed context texts, Canvas group names, rendered group rules (`drop lowest <n>`, `drop highest <n>`, `never drop <name>`); assignment names and lesson titles excluded; no matching across units (PR #265)
- [x] 3.2 Tests then weight verification: Canvas group weight and cited Handbook percentage to two decimals, quote with number + `%`/`per cent`/`percent`, Handbook-row quote must contain the row's component name, `5` vs `25%`, `Quiz 5`, too short, quote with `null` field dropped; rule verification incl. a Canvas drop rule (PR #265)
- [x] 3.3 Tests then clearing: field and quote `null`, `unsourced` updated, weighted parent downgraded to `none`, reason note 「N 项权重或规则无出处」, status unchanged (PR #265)
- [x] 3.4 Wire verification after the repair loop in the runner, before saving (PR #265)
- [x] 3.5 Tests then `migrateLocalKeys(stores, courseId, legacyIds)` in `shared/`: correction item and group keys, `parent`/`mergeInto` values, manual `parent`, work keys (item and group form), order list rewritten and de-duplicated, existing new correction wins, planned-task key collision keeps both tasks, idempotent, other courses untouched (PR #265)
- [x] 3.6 Course page runs `migrateLocalKeys` on browser storage when course reports load and saves the result; written so the #248 `.local/` store can call the same function (PR #265)
- [x] 3.7 Course page: 「无出处」 tag on weight (list, breakdown, drawer) and rule (drawer, Revision tab); quote shown in the drawer; tag hidden when a correction supplies the value (PR #265)
- [x] 3.8 Chat context marks 「权重无出处」/「规则无出处」 (test in `test/chat-context.test.ts`) (PR #265)
- [x] 3.9 If `scripts/lib/eval-score.mjs` is on `main`: tests then matching by `id`, then platform identity (v2 `refs`, or v1 source URLs and platform-shaped IDs), then name slug, one-to-one; otherwise add this as an open item in `note/handoff.md` (PR #265)
- [x] 3.10 Rewrite `docs/course-json.md` for v2 (model output, stored document, Handbook components, IDs, back-fill, quotes, `legacyIds`, v1 compatibility) (PR #265)
- [ ] 3.11 `bash .claude/check.sh`; real-browser check of a synthetic v1 course, then the same course synced to v2 with corrections moved; fresh-context review; update `note/handoff.md`; archive the change after PR 3 merges
