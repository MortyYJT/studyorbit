## Context

A course sync runs three collectors per course and writes their raw output to `.local/lms/runs/<runId>/<courseId>/`:

- `canvas.json` (`scripts/canvas-background.mjs`): `groups[] = { id, name, group_weight, rules }` and `assignments[] = { id, name, group_id, points_possible, due_at, unlock_at, html_url, submission: { score, workflow_state, submitted_at } | null }`, or `{ status: 'unavailable' }`.
- `ed.json` (`scripts/collect-ed-course.mjs`): `lessons[] = { id, title, module, due, status, url }`, `scores[] = { lessonId, status: 'graded' | 'not_available' | 'no_final_submission' | 'unavailable', score, maxScore, submittedAt }`, and `context[] = { lessonId, slideId, text, url, ... }`, or `status: 'not_found' | 'unavailable'`.
- `handbook.json` (`scripts/collect-handbook.mjs`): `{ status: 'available', url, text }` where `text` is the page's visible text (no structured components), or `{ status: 'unavailable' }`.

`buildAnalysisPrompt` sends all three to the model with the JSON Schema from `courseOutputSchema()`; `analyseWithRepair` validates with `validateAnalysis` and retries once with the issues; `settleCourse` decides what to save; the runner writes `分数结构*.json` to the Desktop course folder. Readers (`course-reports.mjs`, `chat-context.mjs`, `vite.config.ts`, `LocalPlanning.tsx`) parse with `CourseDocumentSchema` (v1 only). Browser corrections are keyed `<courseId>:<assessmentId>`.

Owner decisions: #208 (platform facts come from the platform, not the model), #246 (v2 with references and quotes; v1 still readable), #247 (failing quote → clear, flag 「无出处」, save the rest). Lead design choices made under #253 are recorded as #270–#278.

## Goals / Non-Goals

**Goals:**
- IDs are stable across runs and models for the same collected data.
- Due date, score, maximum score and status are never written by the model.
- Every displayed weight and rule is traceable to a quote in the collected data, or visibly marked 「无出处」.
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

`refs[].id` is the Canvas assignment ID, the Canvas assignment group ID, the Ed lesson ID, or the Handbook component name as written on the page. There is no `id`, `parentId`, `due`, `score`, `maxScore`, `status` or `sources`; the schema is strict, so the model cannot send them.

**Stored document v2** (`version: 2`): the v1 document with each assessment extended by

```
refs: [{ platform, id }]            // as returned, de-duplicated
weightQuote: string | null          // kept only when verified
ruleQuote: string | null            // kept only when verified
unsourced: ('weight' | 'rule')[]    // fields cleared by quote verification
```

`id`, `parentId`, `due`, `score`, `maxScore`, `status` and `sources` are filled by code. The v1 refinements (unique IDs, score ≤ maxScore, one parent level, no cycles) apply to v2 too. `sources` is built from `refs` (decision #270): Canvas → the assignment `html_url`; Ed → the lesson `url`; Handbook → the Handbook page `url`; Canvas group → `url: null`; `evidence` is always `null` (the quotes carry the evidence).

`CourseDocumentSchema` becomes a union on `version` (1 | 2). `toDisplayDocument(doc)` returns the v2 shape for both: a v1 assessment gets `refs: []`, `weightQuote: null`, `ruleQuote: null`, `unsourced: []`. Every reader goes through it, so display code handles one shape.

Alternative: one schema with optional fields for both model and storage — rejected; the model could then still send facts, and storage could not require `id`.

### 2. Reference validation (part of `validateAnalysis`, so failures use the one-repair loop)

After the model output parses, each item is checked against the collected data:

- `canvas`: an `assignments[].id` with the same string value; `canvas-group`: a `groups[].id`; `ed`: a `lessons[].id`. A missing or unavailable collection makes every reference to it fail.
- `handbook`: the Handbook collector stores page text only, so a reference is valid when its normalised name (normalisation in §5) occurs in the normalised Handbook `text` (decision #271).
- `parentKey` must name another item; one parent level only; no cycles (same rules as v1, on keys).
- Keys are unique. A `canvas` or `ed` reference may appear on only one item; `canvas-group` and `handbook` references may repeat (a group parent and an alternative version may cite the same component) (decision #272).
- An item with no references must have at least one child; a leaf with no reference has no source at all (decision #272).
- The generated IDs (§3) must be unique.
- The v1 semantic rules on `scoring` (only top-level parents with scoring children use `points`/`weighted`; `weighted` needs a positive weight on every scoring child) stay. The v1 check that an Ed score keeps its own maximum is removed: the model no longer writes scores.

Issues are written as `assessments.<index>.refs.<n>: ...` so the repair prompt points at the item.

### 3. ID generation (pure, in `scripts/lib/course-refs.mjs`)

The ID comes from the highest-priority platform present in `refs`: `canvas` → `ed` → `canvas-group` → `handbook` → none.

| Source | ID |
| --- | --- |
| Canvas assignment | `canvas:<id>` |
| Ed lesson | `ed:<id>` |
| Canvas group | `canvas-group:<id>` |
| Handbook component | `handbook:<slug(name)>` |
| No reference (group only) | `group:<slug(item name)>` |

`slug(s)` = NFKC, lowercase, every run of non-alphanumeric characters (Unicode letters and digits count as alphanumeric) replaced by `-`, leading and trailing `-` trimmed; an empty slug becomes `item`. When an item has several references on the same platform, the *primary* one is the smallest ID (numeric order when both are digits, otherwise code-point order), so the ID does not depend on the order the model listed them (decision #273). `parentId` is the generated ID of the item named by `parentKey`.

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

- **Corpus:** every string value found by walking the collected `canvas`, `ed` and `handbook` JSON for the course (keys excluded). A quote must occur inside one string; it is not matched across two strings (decision #276).
- **Normalisation** (quote and corpus alike): strip HTML tags, decode the common entities (`&amp; &lt; &gt; &quot; &#39; &nbsp;` and numeric references), NFKC, lowercase, map curly quotes to `'`/`"` and the dash family (‐ ‑ ‒ – — −) to `-`, collapse whitespace to one space, trim.
- **Weight:** passes when the normalised `weightQuote` is 6–500 characters, occurs in the corpus, and contains a number token (`\d+(?:\.\d+)?` not touching another digit or `.`) whose value equals `weight` (decision #276), so `5` does not match "25%". It also passes with no quote when the item references a Canvas group whose `group_weight` equals `weight` after rounding both to two decimals; the stored `weightQuote` is then `null`.
- **Rule:** passes when the normalised `ruleQuote` is 6–500 characters and occurs in the corpus.
- **Failure:** the field (`weight` or `rule`) and its quote are set to `null` and the field name is appended to `unsourced`. A `null` weight or rule needs no quote; a quote given with a `null` field is dropped.
- **Knock-on:** if clearing a child's weight leaves a `weighted` parent with a scoring child that has no positive weight, the parent's `scoring` becomes `none` so the page does not compute a wrong total (decision #277).
- **Reporting:** the course status is not changed; when any field was cleared, `reason` gains 「N 项权重或规则无出处」 (decision #277).

### 6. Display

- The course page reads through `toDisplayDocument` and shows a small 「无出处」 tag beside the weight in the list, the weight breakdown legend and the drawer, and beside the rule in the drawer and the Revision tab, for every field listed in `unsourced`. A verified quote is shown in the drawer under the value as the quoted source text.
- The chat context marks such fields 「权重无出处」/「规则无出处」 so the agent does not present them as confirmed.
- **Correction keys:** v2 IDs differ from v1 IDs, so corrections keyed by a v1 ID would no longer apply. When no correction exists for `<courseId>:<v2 id>`, the page falls back to `<courseId>:<bare id>` of the item's primary Canvas or Ed reference (v1 prompts asked for the raw platform ID). Other old corrections stay in storage untouched and unused (decision #278).

### 7. Evaluation matching

`scripts/lib/eval-score.mjs` (added by another change; it may not be on `main` yet) matches a run's assessment to the reference answer by, in order: equal `id`; shared platform identity (v2 `refs`, or Canvas assignment / Ed lesson IDs parsed from v1 `sources[].url`); equal `slug(name)`. Each reference item matches at most once.

## Risks / Trade-offs

- [Model paraphrases instead of quoting] → many weights become 「无出处」. The prompt asks for exact copy-paste and the repair loop is not spent on quotes; the evaluation run measures the clear rate before the prompt is tuned further.
- [Handbook text lacks a component name the model used] → reference fails and triggers repair; after the one repair the course fails as today. The prompt tells the model to copy component names exactly.
- [Derived child weights (20% split over 4 quizzes = 5% each) have no literal "5"] → cleared and flagged. Accepted: the owner prefers an honest gap over a computed guess; the owner can correct it on the page.
- [Old corrections orphaned] → bare-ID fallback covers the common case; the rest stay stored and can be re-entered.
- [Corpus walk is large (Handbook text ≤ 50 000 chars, Ed context ≤ 12 000 per slide)] → normalise once per course and use substring search; tens of quotes per course is cheap.

## Migration Plan

No file migration. v1 files stay on the Desktop and are read through the union; the newest valid file of either version wins as today. New syncs write v2. Rollback: revert the PRs; v2 files written meanwhile would then fail the v1-only schema and the course would show as unsynced until the next sync, so the rollback note in the PR must say so.

## Open Questions

- Should a cleared weight later be filled from a matching owner correction automatically? Left to #248/#249.
