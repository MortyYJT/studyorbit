## 1. Schemas v2 and compatible reading (PR 1)

- [ ] 1.1 Tests then the stored document v2 schema in `shared/course-data.ts`: new fields, strictness, `unsourced` values, v1 refinements (unique IDs, score ≤ maxScore, parent rules) apply to v2
- [ ] 1.2 Tests then `CourseDocumentSchema` as a union on `version` (1 | 2); version 3 and missing version rejected
- [ ] 1.3 Tests then `toDisplayDocument`: v1 → empty `refs`, `null` quotes, empty `unsourced`; v2 passes through
- [ ] 1.4 Tests then the model output schema (`CourseModelOutputSchema`): allowed fields only; `id`, `parentId`, `due`, `score`, `maxScore`, `status`, `sources` rejected (schema only; not wired to the sync yet)
- [ ] 1.5 Route every reader through the union and `toDisplayDocument`: `scripts/lib/course-reports.mjs` (+ `.d.mts`), `scripts/lib/chat-context.mjs`, `vite.config.ts`, `web/src/LocalPlanning.tsx`; existing v1 tests stay green
- [ ] 1.6 `bash .claude/check.sh`; fresh-context review; record the PR number here

## 2. Model output v2 in the sync (PR 2)

- [ ] 2.1 Tests then `slug` and ID generation in `scripts/lib/course-refs.mjs` (+ `.d.mts`): platform priority, primary reference = smallest ID, `group:` fallback, empty slug, `parentKey` → `parentId`
- [ ] 2.2 Tests then reference validation in `scripts/lib/course-validation.mjs`: missing Canvas / group / Ed IDs, Handbook name not in text, uncollected source, shared Canvas or Ed reference, leaf with no references, duplicate keys, parent rules on keys, duplicate generated IDs; issues name the item and reference; remove the v1 Ed score/maximum check
- [ ] 2.3 Tests then fact back-fill: due precedence, score/maxScore pairs (Canvas graded, Ed graded, ungraded maximum, score above maximum), Canvas and Ed status mapping, most-advanced status, group/Handbook/model-only items, `sources` URLs
- [ ] 2.4 Tests then `buildStoredDocument(modelDocument, collected)` producing a valid stored v2 document (quotes kept as given, `unsourced: []` until PR 3)
- [ ] 2.5 `courseOutputSchema()` from the model output schema; rewrite the prompt rules for references, exact Handbook names, exact quotes, and "facts are filled by code"
- [ ] 2.6 Runner: `validateAnalysis` gets Handbook data; `settleCourse` saves `buildStoredDocument(...)`; diagnostics unchanged
- [ ] 2.7 Synthetic end-to-end test: model output fixture + collected fixtures → saved v2 file read back by `course-reports`
- [ ] 2.8 `bash .claude/check.sh`; fresh-context review; record the PR number here

## 3. Quote verification, 「无出处」 display and docs (PR 3)

- [ ] 3.1 Tests then normalisation and corpus building in `scripts/lib/course-quotes.mjs` (+ `.d.mts`): tags, entities, NFKC, case, quotes, dashes, whitespace; strings only, per-string matching
- [ ] 3.2 Tests then weight and rule verification: found, paraphrase, too short, number token present/absent (`5` vs `25%`), Canvas group weight match to two decimals, quote with `null` field dropped
- [ ] 3.3 Tests then clearing: field and quote `null`, `unsourced` updated, weighted parent downgraded to `none`, reason note 「N 项权重或规则无出处」, status unchanged
- [ ] 3.4 Wire verification after the repair loop in the runner, before saving
- [ ] 3.5 Course page: 「无出处」 tag on weight (list, breakdown, drawer) and rule (drawer, Revision tab); quote shown in the drawer; tag hidden when a correction supplies the value
- [ ] 3.6 Course page: correction lookup falls back to the bare primary Canvas/Ed ID key
- [ ] 3.7 Chat context marks 「权重无出处」/「规则无出处」 (test in `test/chat-context.test.ts`)
- [ ] 3.8 If `scripts/lib/eval-score.mjs` is on `main`: tests then matching by `id`, then platform identity (v2 `refs` or IDs parsed from v1 `sources` URLs), then name slug, one-to-one; otherwise add this as an open item in `note/handoff.md`
- [ ] 3.9 Rewrite `docs/course-json.md` for v2 (model output, stored document, IDs, back-fill, quotes, v1 compatibility)
- [ ] 3.10 `bash .claude/check.sh`; real-browser check of a synthetic v1 and v2 course; fresh-context review; update `note/handoff.md`; archive the change after PR 3 merges
