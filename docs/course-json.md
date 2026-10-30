# Course JSON contract v2

Field definitions and local validation live in `shared/course-data.ts`; the requirements are in `openspec/specs/course-contract/` and `openspec/specs/course-analysis/`, and the design in `openspec/changes/archive/2026-10-29-course-contract-v2/design.md`. Every sync writes one `分数结构*.json` per course into its Desktop course folder. Unknown values are `null`, never `0`.

The contract has two layers. The **model output** contains only judgements: grouping, kind, weights, rules and their quotes, and which platform items they rest on. The **stored document** is built by code from that output: code adds IDs, deadlines, scores, status and source links, then verifies the quotes. Dates, scores and status are never filled in by the model (decision #208).

## How analysis works

The sync collects Canvas, Ed and the institution's framework source (the Handbook of the matching year for UniMelb) first; analysis receives only the collected data and never drives a browser. Every model gets the same prompt, data and output contract; the actual prompt and schema are built by `scripts/lib/course-analysis.mjs`.

- **Sources:** the Handbook gives the assessment framework, weights and hurdles for that year and semester; Canvas gives the concrete assessments, deadlines and submissions; Ed adds rules and released grades. A missing source does not stop analysis, and no source may be invented.
- **Judgement, not hard-coding:** the model identifies the same assessment across platforms, weights, parent–child structure and rules from context, and fills in a value only when the evidence supports it. Code checks the hierarchy and the rules it can decide, without special cases for course codes or names.
- **Shape:** at most two levels; a group and its items are never both counted; bonus, alternative exams and hurdles are handled separately.
- **Schema is not enough:** native schema or JSON mode only constrains the format. Local validation still checks the course identity, that references exist in the collected data, and the parent–child rules. On failure the original output and the errors go back to the model for one repair, so analysis makes at most two calls.
- **Privacy:** the data includes personal courses and grades and goes only to the configured model provider. Raw responses and errors are kept in the ignored `.local/` folder.
- The same prompt does not make different providers equivalent: models, tool environments, output-constraint support and billing differ, so experiments must name each of them.

## Model output

The model returns `{ status, reason, document }`. `status` is `completed`, `partial` or `failed`; `reason` briefly names what is missing (empty when nothing is); `document` is `null` when `failed`. `document` follows `CourseModelOutputSchema`:

- `version: 2`; `course` (ID, code, name, semester; ID and code must equal the input); `materials` (names and links of materials; no files are downloaded).
- Each item in `assessments[]` has only the fields below. The schema is strict: an `id`, `parentId`, `due`, `score`, `maxScore`, `status` or `sources` field fails validation and triggers the repair.

| Field | Meaning |
| --- | --- |
| `key` | Any string, unique within this output |
| `parentKey` | `null` for top-level items; a child points to a top-level `key`; at most two levels |
| `refs` | Evidence: `{ platform, id }`. `canvas` takes a Canvas assignment ID, `canvas-group` an assignment group ID, `ed` an Ed lesson ID, `handbook` only a component name listed in the prompt's `handbookComponents` |
| `name` | Name |
| `kind` | `quiz`, `assignment`, `test`, `presentation`, `participation`, `hurdle` or `other` |
| `nature` | `regular`, `ungraded`, `bonus` or `alternative` |
| `scoring` | For a parent: `points` (sum of raw marks), `weighted` (explicit weights) or `none` (no automatic total); children are `none` |
| `weight`, `weightQuote` | Percentage of the course total (not raw marks) and the verbatim text that proves it |
| `rule`, `ruleQuote` | A short scoring or pass rule and the verbatim text that proves it |

The prompt also carries two things computed by code: `handbookComponents: [{ name, percent }]` parsed from the Handbook assessment table, and each Canvas group's `rulesText` (numeric rules written as `drop lowest 2`, `drop highest 1`, `never drop <assignment name>`, joined with `; `).

## Reference validation

`validateAnalysis` (`scripts/lib/course-validation.mjs`) checks the following beyond the schema. Any one of them fails validation and uses the single repair; if the repair still fails, nothing is saved.

- References must exist in the collected data: Canvas assignment IDs, group IDs and Ed lesson IDs are compared as strings; a Handbook name, after normalisation (see [Quote verification](#quote-verification)), must equal a parsed component name exactly, and the stored document uses the canonical name. References to a source that was not collected are invalid.
- One Canvas assignment or Ed lesson can be referenced by only one assessment; group and Handbook references may repeat.
- An assessment without any reference must have children (a pure group).
- `key` is unique; `parentKey` exists, has no cycle and only one level.
- `points` and `weighted` are only for top-level parents with scored children; `weighted` requires a positive weight on every scored child.
- Generated IDs are unique and at most 500 characters.

Problems are written as `assessments.<index>.refs.<index>: 「<name>」引用的 <platform> <id> ...` ("<name> references …") so the repair prompt points at the faulty item.

## Handbook components

Handbook collection stores page text only. `parseHandbookComponents` (`scripts/lib/course-refs.mjs`) reads it line by line. A line is split into cells by tabs. A line whose last cell is a percentage (such as `30%`) or `N/A`, `Nil`, `-`, `—` ends an assessment row; a line with a `Percentage` cell is the header. A row starts after the previous row's end or the header and runs to its end line, so multi-line descriptions are joined. The name is the first line of the first cell, `percent` is the number in the last cell (`null` if none), and the row text collapses tabs and newlines to single spaces. Rows repeated per semester with the same name and percentage are merged; same name with different percentages become ` (2)`, ` (3)` in order. If the Handbook was collected but no component can be parsed, every Handbook reference is invalid, the course is at most `partial`, and the reason says 「Handbook 考核表未能解析」 ("the Handbook assessment table could not be parsed").

## Stored document

`CourseDocumentSchema` accepts `version: 1` and `version: 2`; any other version is invalid. Version 2 adds `refs`, `weightQuote`, `ruleQuote` and `unsourced` to every version 1 assessment field, and `legacyIds` at the top level:

| Field | Source |
| --- | --- |
| `id` | Generated by code, see [ID generation](#id-generation) |
| `parentId` | Final ID of the item named by `parentKey` |
| `name`, `kind`, `nature`, `scoring` | Model output (`scoring` may be lowered to `none` by quote verification) |
| `weight`, `rule` | Model output, cleared to `null` when verification fails |
| `due`, `score`, `maxScore`, `status` | Filled by code from the main Canvas assignment and main Ed lesson |
| `sources` | Generated from `refs`: Canvas assignment links, Ed lesson links, the Handbook page link; a Canvas group is `platform: 'canvas'`, `url: null`; `evidence` is always `null` |
| `refs` | Normalised, de-duplicated references |
| `weightQuote`, `ruleQuote` | Kept only when verified, otherwise `null` |
| `unsourced` | Field names cleared by quote verification: `weight`, `rule` |
| `legacyIds` (top level) | Previous document's IDs → new IDs |

The version 1 rules hold for version 2: unique IDs, score not above maximum, parent exists with one level only, no cycles. Also: an item's `refs` and `unsourced` have no duplicates; a field listed in `unsourced` and its quote are `null`; when a field is `null` its quote is `null`.

### ID generation

The highest-priority platform among `refs` decides: Canvas assignment → Ed lesson → Canvas group → Handbook → none.

| Basis | ID |
| --- | --- |
| Canvas assignment | `canvas:<id>` |
| Ed lesson | `ed:<id>` |
| Canvas group | `canvas-group:<id>` |
| Handbook component | `handbook:<slug(canonical name)>` |
| No reference (pure group) | `group:<slug(name)>` |

`slug` = NFKC, lower case, each run of non-alphanumeric characters replaced by one `-`, leading and trailing `-` removed, `item` if empty. With several references on the same platform the smallest ID wins (all-digit IDs first, numerically; others by code point), so IDs do not depend on the order the model lists them. Canvas group, Handbook and pure-group IDs can be shared; when shared, each item becomes `<base ID>:<slug(name)>`.

### Filled-in facts

- `due`: Canvas `due_at`, else the Ed lesson's `due`, else `null`.
- `score`/`maxScore` come as a pair from one source: graded on Canvas → Canvas score and `points_possible`; else graded on Ed → Ed score and maximum; graded nowhere → score `null`, maximum from Canvas `points_possible`. A score above the maximum (extra credit) keeps the score and sets the maximum to `null`.
- `status`: the earliest of the sources' statuses in `graded` > `submitted` > `not_started` > `unknown`. Canvas: `graded` → graded; `submitted`/`pending_review` → submitted; `unsubmitted` with no submission time → not started. Ed: `graded` → graded; `not_available` with a submission time → submitted; `no_final_submission` → not started. Code never produces `in_progress` (version 1 files may contain it).
- Items that reference only a Canvas group, the Handbook or nothing: deadline, score and maximum are `null` and status is `unknown`; the page still computes a parent's grade from its children.

### Quote verification

`verifyQuotes` (`scripts/lib/course-quotes.mjs`) runs after validation and repair and before saving; it never triggers a repair (decision #247).

- **Normalisation** (same for quotes and corpus): strip HTML tags; decode `&amp; &lt; &gt; &quot; &#39; &nbsp;` and numeric entities; NFKC; lower case; curly quotes to straight quotes; all dashes to `-`; every run of whitespace (including tabs and newlines) to one space.
- **Corpus units:** each Handbook assessment table row (the row text), every other non-empty Handbook line, each Ed context text, each Canvas group name and each group's rule text. Canvas assignment names, Ed lesson titles, links and IDs are not in the corpus. A quote must fall inside a single unit and be 6–500 characters after normalisation.
- **A weight is sourced** when any of these holds: the referenced Canvas group's `group_weight` equals it (compared to two decimals); the referenced Handbook component's percentage equals it; or the quote falls inside a unit and contains a standalone number equal to the weight (not touching other digits or a decimal point) followed by `%`, `per cent` or `percent`, and, when the quote is inside a Handbook table row, also contains that row's component name. Only the third case keeps `weightQuote`.
- **A rule is sourced** when its quote falls inside a unit.
- **On failure:** the field and its quote become `null` and the field name goes into `unsourced`; the rest of the document is saved as usual. If clearing a child's weight leaves a `weighted` parent with a scored child without a positive weight, the parent's `scoring` becomes `none`. The course status is unchanged and `reason` gains 「N 项权重或规则无出处」 ("N weights or rules unsourced").

The page shows 「无出处」 ("unsourced") next to such weights and rules, and the chat context writes 「权重无出处」 / 「规则无出处」. When you save a corrected value, the page uses it and drops the tag.

### Legacy ID map `legacyIds`

Version 2 IDs differ from version 1, while the browser's corrections, manual assessments' parents, study tasks and ordering are keyed by ID. Before a sync saves, `buildLegacyIds` pairs the course's previous valid document (version 1 or 2, chosen by the page's "newest valid file" rule) with the new one:

1. Equal IDs pair first (no entry is written) and are excluded from later steps.
2. Platform identity: version 2 uses `canvas`/`ed` references; version 1 uses Canvas assignment IDs parsed from `sources` links (`/courses/<course>/assignments/<id>`), Ed lesson IDs (`/lessons/<id>`) and IDs shaped like `<digits>`, `canvas-<digits>`, `canvas:<digits>`, `ed-<digits>`, `ed:<digits>` (all-digit IDs are tried as Canvas first, then Ed).
3. Items without any platform-identity candidate pair by a name slug that is unique on both sides.
4. Only one-to-one pairs are kept.
5. When the previous document is version 2, its `legacyIds` are carried and composed (`a → b` and `b → c` give `a → c`); entries whose target no longer exists are dropped.

Every time the page reads course data, `migrateLocalKeys` in `shared/local-keys.ts` moves local data to the new keys (idempotent): correction keys `<course>:<id>` and group keys `<course>:group:<course>:<id>`, `parent`/`mergeInto` inside corrections, manual assessments' `parent`, study task keys and ordering lists. If the new key already has a correction, the new one wins and the old one is left unused; if a study task's new key is taken, the old task keeps its old key; ordering lists are de-duplicated after rewriting. Old data that cannot be mapped (no platform identity and a non-unique name, a different merge or split, a vanished assessment, no previous document) is kept as is and no longer shown.

## Version 1 compatibility

Version 1 files are never rewritten and are read as before. Every reader (course reports API, course page, chat context) converts through `toDisplayDocument` into one display shape: version 1 assessments get empty `refs`, `null` quotes and empty `unsourced`, and version 1 documents get empty `legacyIds`, so version 1 courses never show 「无出处」. When a folder holds both versions, the newest valid file by modification time is still used.

## Other conventions

Weights are filled in only for assessments with evidence, never derived as a remainder; children and their group are never both counted towards the course total. A released submission score is the actual score; unreadable is not the same as not submitted or zero. User edits live in a separate overlay and are never rewritten by the model.
