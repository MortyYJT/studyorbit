## Context

A course sync runs three collectors per course and writes their raw output to `.local/lms/runs/<runId>/<courseId>/`:

- `canvas.json` (`scripts/canvas-background.mjs`): `groups[] = { id, name, group_weight, rules }` and `assignments[] = { id, name, group_id, points_possible, due_at, unlock_at, html_url, submission: { score, workflow_state, submitted_at } | null }`, or `{ status: 'unavailable' }`.
- `ed.json` (`scripts/collect-ed-course.mjs`): `lessons[] = { id, title, module, due, status, url }`, `scores[] = { lessonId, status: 'graded' | 'not_available' | 'no_final_submission' | 'unavailable', score, maxScore, submittedAt }`, and `context[] = { lessonId, slideId, text, url, ... }`, or `status: 'not_found' | 'unavailable'`.
- `handbook.json` (`scripts/collect-handbook.mjs`): `{ status: 'available', url, text }` where `text` is the page's `innerText` (no structured components; the assessment table comes out as tab-separated cells with the percentage as the last cell of a row, and the timing cell between the description and the percentage), or `{ status: 'unavailable' }`.

`buildAnalysisPrompt` sends all three to the model with the JSON Schema from `courseOutputSchema()`; `analyseWithRepair` validates with `validateAnalysis` and retries once with the issues; `settleCourse` decides what to save; the runner writes `分数结构*.json` to the Desktop course folder. Readers (`course-reports.mjs`, `chat-context.mjs`, `vite.config.ts`, `LocalPlanning.tsx`) parse with `CourseDocumentSchema` (v1 only). Browser stores in `LocalPlanning.tsx` refer to synced assessments by item key `<courseId>:<assessmentId>`: corrections (keyed by item key, or by group key `<courseId>:group:<item key>` for a parent's own edits, with `parent` and `mergeInto` values holding item keys), manual assessments (`parent`), planned work (`key`, item or group key) and the per-course order list.

Owner decisions: #208 (platform facts come from the platform, not the model), #246 (v2 with references and quotes; v1 still readable), #247 (failing quote → clear, flag 「无出处」, save the rest). Lead design choices made under #253 are recorded as #270–#280.

## Goals / Non-Goals

**Goals:**
- IDs are stable across runs and models for the same collected data.
- Due date, score, maximum score and status are never written by the model.
- Every displayed weight and rule is traceable to the collected data (a structured value or a verbatim quote), or visibly marked 「无出处」.
- v1 files on the Desktop keep loading and displaying unchanged.

**Non-Goals:**
- New collectors or new collected fields (for example Canvas assignment descriptions).
- Moving corrections to `.local/` (#248) or conflict prompts (#249).
- Rewriting v1 files to v2.
- The evaluation runner; only its matching rule is specified here.

## Decisions

### 1. Two schemas in `shared/course-data.ts`

**Model output** (`CourseModelOutputSchema`, the `document` inside the existing `{ status, reason, document }` wrapper):

```
{ version: 2,
  course: { id, code, name, term },                      // unchanged from v1
  assessments: [{
    key: string,                                         // unique within the output, any string
    parentKey: string | null,                            // another item's key, or null
    refs: [{ platform: 'canvas' | 'canvas-group' | 'ed' | 'handbook', id: string }],
    name, kind, nature, scoring,                         // same enums as v1
    weight: number | null, weightQuote: string | null,
    rule: string | null,   ruleQuote: string | null }],
  materials: [...] }                                     // unchanged from v1
```

`refs[].id` is the Canvas assignment ID, the Canvas assignment group ID, the Ed lesson ID, or a Handbook component name copied from the parsed component list in the prompt (§2). There is no `id`, `parentId`, `due`, `score`, `maxScore`, `status` or `sources`; the schema is strict, so the model cannot send them.

**Stored document v2** (`version: 2`): the v1 document with each assessment extended by

```
refs: [{ platform, id }]            // as returned, de-duplicated
weightQuote: string | null          // kept only when verified
ruleQuote: string | null            // kept only when verified
unsourced: ('weight' | 'rule')[]    // fields cleared by quote verification
```

and one top-level field, `legacyIds: Record<string, string>` (earlier assessment ID → current ID, possibly empty; §6).

`id`, `parentId`, `due`, `score`, `maxScore`, `status` and `sources` are filled by code. The v1 refinements (unique IDs, score ≤ maxScore, one parent level, no cycles) apply to v2 too. `sources` is built from `refs` (decision #270): Canvas → the assignment `html_url`; Ed → the lesson `url`; Handbook → `platform: 'handbook'` with the Handbook page `url`; Canvas group → `platform: 'canvas'` with `url: null`; `evidence` is always `null` (the quotes carry the evidence).

`CourseDocumentSchema` becomes a union on `version` (1 | 2). `toDisplayDocument(doc)` returns the v2 shape for both: a v1 assessment gets `refs: []`, `weightQuote: null`, `ruleQuote: null`, `unsourced: []`, and a v1 document gets `legacyIds: {}`. Every reader goes through it, so display code handles one shape.

Alternative: one schema with optional fields for both model and storage — rejected; the model could then still send facts, and storage could not require `id`.

### 2. Handbook components and reference validation

**Handbook components** (pure, `parseHandbookComponents(text)` in `scripts/lib/course-refs.mjs`, decision #271). The Handbook collector stores page text only, and accepting any substring of it as a reference would let the same component be cited as "Exam" in one run and "Final exam" in the next. References are therefore restricted to component names parsed from the assessment table:

1. Split `text` into lines on `\n`; split a line into cells on `\t`.
2. A *terminal line* has at least one tab and a last cell (trimmed) that is a percentage (`^\d+(?:\.\d+)?\s*%$`) or one of `N/A`, `Nil`, `-`, `—` (no percentage, e.g. a hurdle row).
3. A *header line* is a line with a tab and a cell equal (case-insensitive, trimmed) to `Percentage`.
4. A row runs from the line after the later of the previous terminal line and the header line, through the next terminal line; with neither before it, the row is the terminal line alone. This keeps multi-line description cells together.
5. The row's first cell is the row text before its first tab. The component `name` is the first non-empty line of the first cell, whitespace collapsed, at most 200 characters; rows with an empty name are skipped. `percent` is the number from the last cell, or `null`. `rowText` is the whole row with tabs and line breaks replaced by single spaces.
6. A second row with the same normalised name gets ` (2)`, a third ` (3)`, in page order.

The prompt receives `handbookComponents: [{ name, percent }]` next to the raw Handbook text and is told to cite Handbook components only by a name from that list. When the Handbook was collected but no component parses, Handbook references are invalid and the course reason gains 「Handbook 考核表未能解析」 with status at most `partial` (like a failed Handbook collection).

**Reference validation** (part of `validateAnalysis`, so failures use the one-repair loop):

- `canvas`: an `assignments[].id` with the same string value; `canvas-group`: a `groups[].id`; `ed`: a `lessons[].id`; `handbook`: a parsed component whose normalised name (normalisation in §5) equals the normalised reference. The stored reference keeps the canonical component name. A missing or unavailable collection makes every reference to it fail.
- `parentKey` must name another item; one parent level only; no cycles (same rules as v1, on keys).
- Keys are unique. A `canvas` or `ed` reference may appear on only one item; `canvas-group` and `handbook` references may repeat (a group parent and an alternative version may cite the same component) (decision #272).
- An item with no references must have at least one child; a leaf with no reference has no source at all (decision #272).
- The generated IDs (§3) must be unique after the repeatable-reference suffix.
- The v1 semantic rules on `scoring` (only top-level parents with scoring children use `points`/`weighted`; `weighted` needs a positive weight on every scoring child) stay. The v1 check that an Ed score keeps its own maximum is removed: the model no longer writes scores.

Issues are written as `assessments.<index>.refs.<n>: ...` so the repair prompt points at the item.

### 3. ID generation (pure, in `scripts/lib/course-refs.mjs`)

The *base ID* comes from the highest-priority platform present in `refs`: `canvas` → `ed` → `canvas-group` → `handbook` → none.

| Source | Base ID |
| --- | --- |
| Canvas assignment | `canvas:<id>` |
| Ed lesson | `ed:<id>` |
| Canvas group | `canvas-group:<id>` |
| Handbook component | `handbook:<slug(canonical name)>` |
| No reference (group only) | `group:<slug(item name)>` |

`slug(s)` = NFKC, lowercase, every run of non-alphanumeric characters (Unicode letters and digits count as alphanumeric) replaced by `-`, leading and trailing `-` trimmed; an empty slug becomes `item`. When an item has several references on the same platform, the *primary* one is the smallest ID (numeric order when both are digits, otherwise code-point order), so the ID does not depend on the order the model listed them (decision #273).

**Repeatable references** (decision #279): Canvas and Ed references are unique per item, so their base IDs never collide. Canvas-group, Handbook and group base IDs can (an alternative exam and a hurdle may both cite the Handbook "Examination" row). When two or more items share such a base ID, *every one* of them gets the ID `<base ID>:<slug(item name)>`; no item keeps the bare base ID, so the result does not depend on output order. IDs still equal after that are a validation issue, which the repair can fix by giving the items distinct names.

`parentId` is the final ID of the item named by `parentKey`.

### 4. Fact back-fill (pure, in `scripts/lib/course-refs.mjs`)

Facts come from the primary Canvas assignment and the primary Ed lesson of the item (decision #273):

- `due`: Canvas `due_at`, else Ed lesson `due`, else `null`.
- `score` / `maxScore` are taken as a pair from one source so a numerator is never divided by another source's denominator (decision #274, refining the lead rule "Canvas wins for maxScore"): Canvas graded (`workflow_state === 'graded'` and a numeric `score`) → Canvas `score` and `points_possible`; else Ed graded score record → Ed `score` and `maxScore`; else `score: null` and `maxScore` = Canvas `points_possible`, else `null`. If a pair has `score > maxScore` (Canvas extra credit), `score` is kept and `maxScore` becomes `null`, because the stored schema rejects the pair.
- `status`: each source maps to one value; the most advanced across sources wins, `graded` > `submitted` > `not_started` > `unknown` (decision #275), which keeps the v1 rule that a released mark beats another platform's "not submitted".
  - Canvas: `graded` → `graded`; `submitted` or `pending_review` → `submitted`; `unsubmitted` with no `submitted_at` → `not_started`; anything else, or no submission object → `unknown`.
  - Ed score record: `graded` → `graded`; `not_available` with `submittedAt` → `submitted`; `no_final_submission` → `not_started`; anything else or no record → `unknown`.
- Items whose references are only `canvas-group`, `handbook`, or none: `due`, `score`, `maxScore` are `null`, `status` is `unknown`. A parent's grade is still computed from its children by the existing `parentGrade`.
- The code never produces `in_progress`; v1 files may still contain it.

### 5. Quote verification (pure, in `scripts/lib/course-quotes.mjs`)

Runs after the validation and repair loop on the built stored document; it is never a validation failure (#247).

- **Normalisation** (quote and corpus alike): strip HTML tags, decode the common entities (`&amp; &lt; &gt; &quot; &#39; &nbsp;` and numeric references), NFKC, lowercase, map curly quotes to `'`/`"` and the dash family (‐ ‑ ‒ – — −) to `-`, collapse all whitespace (tabs and line breaks included) to one space, trim.
- **Corpus units** (decision #276). Only text that describes assessments counts, so a weight cannot be "sourced" by an assignment called "Quiz 5":
  - each parsed Handbook component row (`rowText`: name, timing and percentage of one row form one unit);
  - each other non-empty line of the Handbook text;
  - each Ed `context[].text`;
  - each Canvas group `name`, and each Canvas group's rendered rule text (decision #280): `rules.drop_lowest: n` → `drop lowest <n>`, `rules.drop_highest: n` → `drop highest <n>`, each `rules.never_drop` assignment ID → `never drop <assignment name>` (or `never drop <id>` when the assignment is unknown). The same rendered text is given to the model as `rulesText` on each group in the prompt.
  - Excluded: Canvas assignment names, Ed lesson titles and modules, URLs, IDs, statuses, dates and collector messages.
  A quote must occur inside one unit; it is never matched across two units.
- **Weight** is sourced when any of these holds:
  1. the item cites a Canvas group whose `group_weight` equals `weight` after rounding both to two decimals;
  2. the item cites a Handbook component whose `percent` equals `weight` after rounding both to two decimals;
  3. the normalised `weightQuote` is 6–500 characters, occurs in one corpus unit, and contains a number token (`\d+(?:\.\d+)?`, not touching another digit or `.`) equal to `weight` and followed, after optional spaces, by `%`, `per cent` or `percent`. So `5` matches neither "25%" nor "Quiz 5".

  `weightQuote` is stored only when check 3 passes; with check 1 or 2 alone it is `null`. The prompt tells the model to copy a weight quote from one Handbook row as its cells read left to right, separated by single spaces (e.g. `Project report Week 10 30%`).
- **Rule:** sourced when the normalised `ruleQuote` is 6–500 characters and occurs in one corpus unit (a Canvas drop rule is quoted from its rendered text, e.g. `drop lowest 2`).
- **Failure:** the field (`weight` or `rule`) and its quote are set to `null` and the field name is appended to `unsourced`. A `null` weight or rule needs no quote; a quote given with a `null` field is dropped.
- **Knock-on:** if clearing a child's weight leaves a `weighted` parent with a scoring child that has no positive weight, the parent's `scoring` becomes `none` so the page does not compute a wrong total (decision #277).
- **Reporting:** the course status is not changed; when any field was cleared, `reason` gains 「N 项权重或规则无出处」 (decision #277).

### 6. Display, and moving local keys to the new IDs

- The course page reads through `toDisplayDocument` and shows a small 「无出处」 tag beside the weight in the list, the weight breakdown legend and the drawer, and beside the rule in the drawer and the Revision tab, for every field listed in `unsourced`. A verified quote is shown in the drawer under the value as the quoted source text.
- The chat context marks such fields 「权重无出处」/「规则无出处」 so the agent does not present them as confirmed.

**Legacy ID map** (decision #278). v2 IDs differ from v1 IDs, and every local store refers to items by ID. The runner records in the new document's `legacyIds` how the previous document's IDs map to the new ones, and the app moves local keys once.

*Building the map* (pure, `buildLegacyIds(previous, current)` in `scripts/lib/course-refs.mjs`; the runner passes the newest valid earlier document of the same course from the Desktop course folder, or none):

1. Platform identity of a previous assessment: from v2 `refs`; or, for v1, Canvas assignment IDs parsed from `sources[].url` (`/courses/<course>/assignments/<id>`), Ed lesson IDs parsed from `sources[].url` (`/lessons/<id>`), and the v1 `id` itself when it is `<digits>`, `canvas-<digits>`, `canvas:<digits>`, `ed-<digits>` or `ed:<digits>` (bare digits are tried as a Canvas ID, then as an Ed ID). A previous item maps to the current item whose `refs` contain one of these identities (`canvas` and `ed` references only, since they are unique per item).
2. Otherwise, by equal `slug(name)` when exactly one previous item and exactly one current item have that slug.
3. Only one-to-one pairs are kept: a previous item matching several current items, or several previous items matching one current item, is left unmapped. Pairs with an unchanged ID are omitted.
4. When the previous document is v2, its own `legacyIds` are carried forward and composed with the new pairs (`a → b` with `b → c` becomes `a → c`); entries whose target no longer exists are dropped.

*Applying the map* (pure, `migrateLocalKeys(stores, courseId, legacyIds)` in `shared/`; today the page runs it on browser storage when it loads course reports, and after #248 the same function runs on the `.local/` store in Node). For every `old → new` of the course, with `K(id) = <courseId>:<id>` and `G(id) = <courseId>:group:<courseId>:<id>`:

- corrections: key `K(old)` → `K(new)` and `G(old)` → `G(new)`; inside every correction of the course, `parent` and `mergeInto` values equal to `K(old)` → `K(new)`;
- manual assessments: `parent` equal to `K(old)` → `K(new)`;
- planned work: `key` equal to `K(old)` or `G(old)` → `K(new)` or `G(new)`;
- the course's order list: entries `K(old)` / `G(old)` rewritten the same way.
- If the target key already has its own entry, the new entry wins and the old one is left in place, unused. Running the migration again changes nothing (idempotent), so no marker is needed.

*Cannot be mapped* (left in storage, untouched and unused): previous items with no platform URL, no platform-shaped ID and no unique name match (typically Handbook-only exams and model-invented groups that were renamed); items merged or split differently between the two documents (ambiguous pairs); items that no longer exist; everything when no earlier document is found in the course folder (e.g. the v1 files were deleted before the first v2 sync). Manual assessments keep their own `manual:` keys and need no mapping.

### 7. Evaluation matching

`scripts/lib/eval-score.mjs` (added by another change; it may not be on `main` yet) matches a run's assessment to the reference answer by, in order: equal `id`; shared platform identity (v2 `refs`, or Canvas assignment / Ed lesson IDs from v1 as in §6 step 1); equal `slug(name)`. Each reference item matches at most once.

## Risks / Trade-offs

- [Model paraphrases instead of quoting] → many weights become 「无出处」. Handbook row percentages and Canvas group weights are checked structurally, so most top-level weights do not depend on quoting; the prompt asks for exact copy-paste; the evaluation run measures the clear rate before the prompt is tuned further.
- [Handbook table text differs from the expected tab layout] → no components parse, Handbook references are invalid and the course is marked partial. PR 2 checks the parser against a real capture locally (never committed) and tests synthetic fixtures for multi-line cells, hurdle rows and duplicate names.
- [Derived child weights (20% split over 4 quizzes = 5% each) have no literal "5%"] → cleared and flagged. Accepted: the owner prefers an honest gap over a computed guess and can correct it on the page.
- [The suffix rule changes an ID when a sibling citing the same repeatable reference appears or disappears] → the legacy map's name match usually covers it; otherwise the old local entries stay unused.
- [Unmappable old local entries] → listed above; they remain stored and can be re-entered.
- [Corpus size (Handbook text ≤ 50 000 chars, Ed context ≤ 12 000 per slide)] → normalise once per course and use substring search; tens of quotes per course is cheap.

## Migration Plan

No course-file migration. v1 files stay on the Desktop and are read through the union; the newest valid file of either version wins as today. New syncs write v2 with `legacyIds`; local stores move to the new keys on first load (§6). Rollback: revert the PRs; v2 files written meanwhile would then fail the v1-only schema and the course would show as unsynced until the next sync, and local keys already moved to v2 IDs would no longer match v1 IDs, so the rollback note in the PR must say so.

## Open Questions

- Should a cleared weight later be filled from a matching owner correction automatically? Left to #248/#249.
