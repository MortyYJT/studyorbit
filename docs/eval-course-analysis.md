# Course analysis evaluation

Scores the model's course analysis against a gold course document: the same collected data is analysed N times, and the evaluation reports which fields are right, how consistent the runs are, and how many errors local validation caught. Script: `scripts/eval-course-analysis.mjs`; scoring: `scripts/lib/eval-score.mjs` (pure functions, tested in `test/eval-score.test.ts`). Requirements: `openspec/specs/course-analysis/` ("Evaluation matches assessments by identity").

The evaluation reads collected data only: it starts no collector, opens neither Edge nor Ed, and never writes the Desktop course folders.

> **Read this first:** in the [results](#results) below, "accuracy" measures **agreement with an earlier model output**, not with a human-verified answer. When page corrections were exported (2026-10-30) the page had none, so the gold answers are the earlier model-written course JSON on the Desktop, unchanged and unverified. See [Limits of the results](#limits-of-the-results).

## Gold answers

- One file per course: `<gold dir>/<course code>.json`, for example `SYNT10001.json`.
- The format is the [course JSON](course-json.md) version 1 (`CourseDocumentSchema` in `shared/course-data.ts`): the Desktop course JSON plus the corrections you made in the page. Only the `document`, not the outer `{ status, reason, document }`.
- `course.code` must equal the course code and the file must be valid version 1; otherwise the run stops with an error.
- Gold answers contain grades: keep them in `.local/` or another ignored place and never commit them.

## Matching

Each gold assessment matches at most one model assessment:

1. Equal `id` first.
2. Then platform identity, in two passes:
   1. The gold assessment's own ID: a platform-shaped ID (`canvas-12`, `ed:40`), a Canvas group ID (`canvas-group-501`), or all digits (tried as a Canvas assignment, then an Ed lesson, then a Canvas group; version 1 groups use the group number as ID, version 2 uses `canvas-group:<number>`).
   2. Then version 2 `refs` and version 1 source links (the same Canvas assignment or Ed lesson).

   IDs come before source links because a version 1 group's source links point at its children. On the model side only `canvas` and `ed` references, platform-shaped IDs and its own `canvas-group:` IDs count, not `canvas-group` references (children also reference their group).
3. Then names: lower case, punctuation to spaces, whitespace collapsed (`Weekly Quizzes` matches `weekly quizzes!`).

An unmatched gold assessment is "missed"; an unmatched model assessment is "extra".

## Scored fields

Each matched assessment compares 9 fields: `kind`, `nature`, `parentId`, `weight`, `maxScore`, `score`, `due`, `scoring`, `status`.

- Numbers within 1e-6 are equal; `null` equals only `null`.
- `due` compares the date part only (the first 10 characters, `YYYY-MM-DD`), without time-zone conversion.
- `parentId` first maps the model's parent to the gold ID it matched: if the model says `501` and the gold says `canvas-group-501` and those two matched, the child's parent counts as right.
- `name`, `rule`, `sources` and `materials` are not scored.

## Metrics

| Metric | Definition |
| --- | --- |
| Field accuracy | Correct fields ÷ (gold assessments × 9). All 9 fields of a missed assessment count as wrong |
| Per-field accuracy | The same, per field |
| Recall | Matched gold assessments ÷ gold assessments |
| Precision | Matched model assessments ÷ model assessments |
| Cell consistency | Share of (gold assessment, field) cells with the same value in every run that produced a result; unmatched counts as `<missing>` |
| Same as first | Runs that, after normalisation, equal the first run with a result ÷ all runs. Normalisation keeps only the ID, the normalised name and the 9 scored fields, sorted by ID |
| Repairs | Runs whose first output failed validation and were sent back for one repair |
| Rejected | Runs where the model replied normally but still failed validation after the repair, so nothing would be saved |
| Call failures | Runs with no result because the model call or process errored, threw or was cancelled; not counted as rejected |
| Unsourced | In runs with a result, weights and rules cleared by quote verification and listed in `unsourced` (counted separately); per run in `summary.json` under `unsourced.perRun` |
| Validation problems | Problems in attempts where the model replied normally, counted per problem (call failures excluded), merged after removing the `assessments.N.` prefix |

- Accuracy, recall and precision count only runs with a result (validated, with a document). Rejected runs, call failures and `failed` replies are excluded and counted under "rejected" and "call failures".
- Totals across courses add the per-course counts before dividing; they are not averages of percentages.
- Each run also records duration and tokens (when the model reports usage).

## Running it

```bash
# Synthetic course with fixed outputs: no UniMelb account or model key needed
node scripts/eval-course-analysis.mjs --fixture test/fixtures/synthetic-course

# Real collected data + gold answers, using the model in Settings → Analysis model, 5 runs per course
node scripts/eval-course-analysis.mjs --run .local/lms/runs/<runId> --gold .local/eval/gold --n 5

# Re-score saved results with the current scoring code, without calling a model
node scripts/eval-course-analysis.mjs --rescore .local/eval/results/<results dir> --gold .local/eval/gold --out .local/eval/results/<new dir>
```

| Option | Meaning |
| --- | --- |
| `--run <dir>` | Collected data, one sub-folder per course `<Canvas course ID>/{canvas,ed,handbook}.json` (a sync creates them in `.local/lms/runs/<runId>/`) |
| `--courses <file>` | Course list, default `.local/lms/courses.json`, for course codes, names and semesters |
| `--gold <dir>` | Gold answer folder |
| `--n <runs>` | Runs per course, default 5, at most 50 |
| `--model <id>`, `--provider <id>` | Use another model or provider without changing settings. With another provider the settings' key is not reused; only that provider's own environment variables apply (`DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, or `COURSE_ANALYSIS_*` naming the same provider) |
| `--fake <dir>` | Read fixed outputs instead of calling a model (see below) |
| `--fixture <dir>` | Shorthand for a synthetic course: reads `course.json`, the three collected files and `gold.json` from the folder and uses `outputs/` as fixed outputs |
| `--live` | With `--fixture`: call the real model instead |
| `--rescore <results dir>` | No model call: reads `<course code>/run-<i>.json` from an earlier evaluation, re-scores with the current scoring code and `--gold`, and writes only `summary.json` (mode `rescore`, with the original folder, mode, provider and model) and `summary.md`. Saved documents are scored as they are, not rebuilt; courses without a gold file are skipped. Cannot be combined with `--run`, `--fixture`, `--fake`, `--courses`, `--model`, `--provider` or `--live`; `--out` must not be inside the original folder |
| `--out <dir>` | Results folder, default `.local/eval/results/<start time>/`; must not be on the Desktop (checked after resolving symlinks, case-insensitively on macOS) |

Courses without collected data, missing from the course list or without a gold file are skipped and listed in the summary; a gold file that exists but cannot be read, is not valid JSON or is not valid version 1 stops the run. Command-line paths are relative to the current folder; default paths (`.local/...`) and model settings are always relative to the repository root. Courses run in parallel; one course's runs run in sequence. Ctrl-C starts no new run and lets the current call finish; a second Ctrl-C exits at once.

### Fixed outputs

A `--fake` folder holds `1.json`, `2.json`, …, each a raw model reply (the outer `{ status, reason, document }`). A course's k-th model call reads `<k>.json` (a repair counts as a call); if that file is missing, the highest lower-numbered file is used. If the folder has a `<Canvas course ID>/` sub-folder, that course reads from it.

The synthetic course's `outputs/`:

| File | Content | Result |
| --- | --- | --- |
| `1.json` | Quiz 2 cites Canvas assignment 7999, which does not exist | Rejected by validation, triggers the repair |
| `2.json` | A correct model output v2 (references, grouping, kind, weights and rules only) | Passes; group status, the bonus item's maximum and status are filled by code and differ from the gold answer (3 cells) |
| `3.json` | Misses the lab attendance hurdle, wrong kind for quiz 2, one extra exercise | Passes validation but is wrong; only the evaluation finds it |
| `4.json` | Same as `2.json` | Same as `2.json` |

Fixed outputs are model output v2. Evaluation and sync take the same path: validation, one repair, then code builds the stored v2 document (ID, deadline, score, maximum, status, sources), and that document is scored. The gold answer is still version 1, so v2 IDs (such as `canvas:7101`) differ from gold IDs and matching goes by platform identity or name.

With the default 5 runs: run 1 reads 1 and 2, run 2 reads 3, runs 3–5 read 4. The synthetic course has the same assignment on Canvas and Ed, a quiz group with two children, a bonus item, a hurdle rule attached to the exam and a separate hurdle.

### Output files

- `<course code>/run-<i>.json`: every attempt of the run (raw reply, validation problems, exit code, usage), whether it was accepted or failed, the final document, duration;
- `summary.json`: every metric per course and in total, mode, model, skipped courses;
- `summary.md`: the same short tables as the terminal.

Results contain grades and raw replies; they stay in `.local/` (ignored by Git) with file mode 600.

### Limits of the method

- There is one gold answer and it represents one person's judgement; where several organisations are reasonable (for example how parents and children are split), differing from the gold is not necessarily wrong.
- When platform identity does not match, name matching needs identical normalised names, so a reworded assessment counts as missed plus extra.
- `due` compares only the date part of the string without time-zone conversion: the same moment written in UTC and local time can differ by one day.
- `name`, `rule`, `sources` and `materials` are not scored.
- Fixed outputs only exercise validation and scoring; they say nothing about any real model. Real-model results describe only those courses at that time.
- Cancelling does not interrupt a model call already in flight.

## Results

Results of the script on real collected data. Only course codes and aggregate metrics are recorded here; raw replies, final documents and gold answers contain grades and stay in the local `.local/eval/`.

### Baseline (contract v1)

| Item | Value |
| --- | --- |
| Date | 2026-10-30 (started 00:45 AEDT, two invocations in parallel, 6 min 18 s and 3 min 19 s) |
| Code | `8964477` (`main`, including the evaluation script from #257) |
| Provider / model | `deepseek` / `deepseek-flash` (passed explicitly, same as the code's DeepSeek default; key from `DEEPSEEK_API_KEY`, no saved model settings) |
| Runs per course N | 5 |
| Gold | `.local/eval/gold/`: each course's newest valid course JSON on the Desktop; there were no page corrections to merge |
| Re-runs | None; both invocations finished in one go without 429s or timeouts |

Each course uses the collection that produced its gold answer as input:

| Collection run | Courses | Note |
| --- | --- | --- |
| `93c0e78d` | COMP20003 | Only this course; that collection was partial |
| `cfe27abb` | COMP20008, MAST10007, MUSI20163 | This run also has COMP20003 data, but COMP20003's gold did not come from it, so it is not evaluated (decision #263) |

```bash
node scripts/eval-course-analysis.mjs --run .local/lms/runs/93c0e78d --gold .local/eval/gold \
  --n 5 --provider deepseek --model deepseek-flash --out .local/eval/results/baseline-93c0e78d
# The gold sub-folder holds only the COMP20008, MAST10007 and MUSI20163 files
node scripts/eval-course-analysis.mjs --run .local/lms/runs/cfe27abb --gold .local/eval/gold-cfe27abb \
  --n 5 --provider deepseek --model deepseek-flash --out .local/eval/results/baseline-cfe27abb
```

The second invocation's summary lists COMP20003 as "skipped: no gold file", on purpose.

Numbers as recorded at the time (total field accuracy 83.0%; re-scored with the current scoring code it is 83.9%, which is what the [comparison](#before-and-after) uses):

| Course | Gold assessments | Runs | With result | Field accuracy | Recall | Precision | Cell consistency | Same as first |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMP20003 | 20 | 5 | 5 | 80.1% | 85.0% | 76.6% | 24.4% | 20.0% |
| COMP20008 | 10 | 5 | 5 | 91.6% | 98.0% | 98.0% | 78.9% | 20.0% |
| MAST10007 | 8 | 5 | 5 | 96.7% | 100.0% | 100.0% | 91.7% | 20.0% |
| MUSI20163 | 8 | 5 | 5 | 66.1% | 70.0% | 75.7% | 68.1% | 20.0% |
| **Total** | 46 | 20 | 20 | **83.0%** | **87.8%** | **84.9%** | **55.6%** | **20.0%** |

- "Same as first" at 20.0% means only run 1 equalled itself: runs 2–5 all differed from run 1 after normalisation. Same input, same model, and no two of the five runs were identical.
- COMP20003's cell consistency was only 24.4%: most of its 20 × 9 cells took at least two values across the 5 runs.

Per-field accuracy (as recorded):

| Field | COMP20003 | COMP20008 | MAST10007 | MUSI20163 | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| kind | 85.0% | 90.0% | 100.0% | 70.0% | 86.1% |
| nature | 85.0% | 98.0% | 100.0% | 70.0% | 87.8% |
| parentId | 79.0% | 98.0% | 100.0% | 70.0% | 85.2% |
| weight | 72.0% | 74.0% | 90.0% | 55.0% | 72.6% |
| maxScore | 75.0% | 92.0% | 100.0% | 70.0% | 82.2% |
| score | 80.0% | 98.0% | 100.0% | 70.0% | 85.7% |
| due | 80.0% | 92.0% | 95.0% | 60.0% | 81.7% |
| scoring | 84.0% | 94.0% | 97.5% | 62.5% | 84.8% |
| status | 81.0% | 88.0% | 87.5% | 67.5% | 81.3% |

`weight` was the lowest or near-lowest field in all four courses. All 9 fields of a missed assessment count as wrong, so low-recall courses (MUSI20163, COMP20003) are pulled down across all fields; matching needs an equal ID or an identical normalised name, so a reworded assessment also counts as missed plus extra (inference; not checked item by item).

Validation: 1 repair (COMP20003 run 2, `scoring: 只有有计分子项的顶层父项可使用 points 或 weighted` (only top-level parents with scored children may use points or weighted), passed after the repair), 0 rejected, 0 call failures. All 20 runs produced a result; the accuracy differences above all come from outputs that passed validation and differ only when compared with the gold.

Usage and time (DeepSeek's reported usage; input includes cache hits, output includes reasoning; the repair is counted in its run; model usage, not cost):

| Course | Input tokens (cached) | Output tokens (reasoning) | Mean time | Range |
| --- | ---: | ---: | ---: | --- |
| COMP20003 | 83,156 (76,928) | 76,136 (51,878) | 75.5 s | 38–128 s |
| COMP20008 | 26,755 (21,376) | 37,911 (29,516) | 39.8 s | 26–58 s |
| MAST10007 | 22,410 (18,288) | 29,035 (21,637) | 31.2 s | 15–47 s |
| MUSI20163 | 21,410 (17,280) | 32,004 (24,824) | 34.7 s | 19–48 s |
| Total | 153,731 (133,872) | 175,086 (127,855) | 45.3 s | 15–128 s |

328,817 tokens in total over 21 model calls (20 runs + 1 repair).

### After contract v2

> The gold is still the same earlier, unverified version 1 model output, so "accuracy" is still **agreement with that output**. Version 2 also works differently: deadlines, scores, maxima and status are filled in by code from platform data, and weights and rules without a source are cleared and marked unsourced. Where v2 differs from the gold, either v2 is wrong or v2 corrected it; this evaluation cannot tell which.

| Item | Value |
| --- | --- |
| Date | 2026-10-30 (started 02:24 AEDT, two invocations in parallel, 4 min 41 s and 4 min 16 s) |
| Code at run time | `a0a2bbb` (branch `claude/eval-v2`) = `main` at `ee0b962` (contract v2 fully merged, #266) + the evaluation's unsourced counts; analysis, validation and storage logic identical to `ee0b962` |
| Scoring code | The final version from that PR: matching also tries all-digit IDs as Canvas groups and puts IDs before source links (decision #372). Both baseline and v2 were re-scored with it from their saved runs (`--rescore`, no model call) |
| Flow | Contract v2: the model gives references → validation (one repair on failure) → `buildStoredDocument` builds the stored v2 document → quote verification |
| Provider / model | `deepseek` / `deepseek-flash` (passed explicitly; key from `DEEPSEEK_API_KEY`) |
| Runs per course N | 5 |
| Input and gold | Identical to the baseline: COMP20003 uses run `93c0e78d` + `.local/eval/gold/`; the other three use run `cfe27abb` + `.local/eval/gold-cfe27abb/` (decision #263) |
| Result folders | Runs: `.local/eval/results/v2-93c0e78d/`, `v2-cfe27abb/`; re-scores: `.local/eval/results/rescore-{baseline,v2}-{93c0e78d,cfe27abb}/` |
| Re-runs | None; both invocations finished in one go without 429s or timeouts |

The runs used the same commands with another `--out` and an explicit course list; then the same scoring code re-scored baseline and v2:

```bash
node scripts/eval-course-analysis.mjs --run .local/lms/runs/93c0e78d --gold .local/eval/gold --courses .local/lms/courses.json \
  --n 5 --provider deepseek --model deepseek-flash --out .local/eval/results/v2-93c0e78d
node scripts/eval-course-analysis.mjs --run .local/lms/runs/cfe27abb --gold .local/eval/gold-cfe27abb --courses .local/lms/courses.json \
  --n 5 --provider deepseek --model deepseek-flash --out .local/eval/results/v2-cfe27abb

# No model call; once for each of baseline-* and v2-* (93c0e78d with gold/, cfe27abb with gold-cfe27abb/)
node scripts/eval-course-analysis.mjs --rescore .local/eval/results/v2-93c0e78d --gold .local/eval/gold \
  --out .local/eval/results/rescore-v2-93c0e78d
```

The four-course totals add both re-scores' per-course counts before dividing (`summariseOverall`), as for the baseline.

**Historical numbers:** the baseline's recorded total was 83.0%; re-scored with the current code it is 83.9% (platform-identity matching was added later, #265; group matching did not affect the baseline). The v2 run printed 75.2% at the time, when matching did not yet recognise Canvas groups: version 1 parents use the group's bare number and version 2 uses `canvas-group:<same number>`, so parents did not match and every child's `parentId` counted as wrong (`parentId` 44.8%). Everything below uses the final scoring code.

| Course | Gold assessments | Runs | With result | Field accuracy | Recall | Precision | Cell consistency | Same as first |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| COMP20003 | 20 | 5 | 5 | 95.3% | 99.0% | 91.7% | 93.3% | 20.0% |
| COMP20008 | 10 | 5 | 5 | 87.8% | 96.0% | 96.0% | 75.6% | 40.0% |
| MAST10007 | 8 | 5 | 5 | 90.3% | 100.0% | 100.0% | 98.6% | 40.0% |
| MUSI20163 | 8 | 5 | 5 | 61.7% | 67.5% | 75.0% | 59.7% | 20.0% |
| **Total** | 46 | 20 | 20 | **87.0%** | **93.0%** | **91.5%** | **84.5%** | **30.0%** |

| Field | COMP20003 | COMP20008 | MAST10007 | MUSI20163 | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| kind | 99.0% | 96.0% | 100.0% | 67.5% | 93.0% |
| nature | 99.0% | 96.0% | 100.0% | 67.5% | 93.0% |
| parentId | 96.0% | 90.0% | 100.0% | 57.5% | 88.7% |
| weight | 99.0% | 94.0% | 50.0% | 67.5% | 83.9% |
| maxScore | 94.0% | 68.0% | 87.5% | 52.5% | 80.0% |
| score | 94.0% | 86.0% | 100.0% | 67.5% | 88.7% |
| due | 89.0% | 96.0% | 87.5% | 67.5% | 86.5% |
| scoring | 99.0% | 96.0% | 87.5% | 67.5% | 90.9% |
| status | 89.0% | 68.0% | 100.0% | 40.0% | 77.8% |

### Before and after

Both sides are the current scoring code re-scoring saved runs. Repairs, rejections, failures, tokens and time do not depend on scoring and come straight from the run records.

| Metric (total) | Baseline | v2 |
| --- | ---: | ---: |
| Field accuracy | 83.9% | 87.0% |
| Recall | 88.7% | 93.0% |
| Precision | 85.7% | 91.5% |
| Cell consistency | 55.6% | 84.5% |
| Same as first | 20.0% | 30.0% |
| Repairs | 1 | 3 |
| Rejected | 0 | 0 |
| Call failures | 0 | 0 |
| Model calls | 21 | 23 |
| Input tokens (cached) | 153,731 (133,872) | 154,765 (121,344) |
| Output tokens (reasoning) | 175,086 (127,855) | 151,146 (124,646) |
| Total tokens | 328,817 | 305,911 |
| Mean time / range | 45.3 s / 15–128 s | 37.8 s / 6–105 s |

| Field (total) | Baseline | v2 |
| --- | ---: | ---: |
| kind | 87.0% | 93.0% |
| nature | 88.3% | 93.0% |
| parentId | 86.1% | 88.7% |
| weight | 73.5% | 83.9% |
| maxScore | 83.0% | 80.0% |
| score | 86.5% | 88.7% |
| due | 82.6% | 86.5% |
| scoring | 85.7% | 90.9% |
| status | 82.2% | 77.8% |

| Course field accuracy | Baseline | v2 |
| --- | ---: | ---: |
| COMP20003 | 80.1% | 95.3% |
| COMP20008 | 91.6% | 87.8% |
| MAST10007 | 96.7% | 90.3% |
| MUSI20163 | 70.8% | 61.7% |

What can be said:

- In total v2 agrees more with the old output (83.9% → 87.0%, recall 88.7% → 93.0%, precision 85.7% → 91.5%), but only COMP20003 went up (80.1% → 95.3%); the other three went down, MUSI20163 lowest (61.7%, recall 67.5%). The total rose mainly because COMP20003 has the most assessments.
- `maxScore` and `status` are lower than the baseline in total (83.0% → 80.0%, 82.2% → 77.8%). In v2 code fills these from platform data, so differing from the old output is not necessarily wrong; not checked item by item.
- Runs are more stable: cell consistency 55.6% → 84.5%, same-as-first 20.0% → 30.0%. These compare runs with each other, not with the gold; N = 5, so they vary a lot.
- All 3 repairs were in MAST10007 and all passed afterwards: 2 × `scoring: weighted 要求每个计分子项有明确正权重` (weighted needs an explicit positive weight on every scored child), 1 × `Unrecognized key: "children"` (the model added a key).
- About 7% fewer tokens (328,817 → 305,911) and about 7.5 s faster per run on average; one run only, so this does not show that v2 is reliably cheaper.

**Unsourced.** Fields cleared by quote verification and marked unsourced in the v2 documents (all 20 runs): 0 weights and 0 rules in every course. Why 0: the 20 v2 documents had 85 model-given weights and all passed: 61 by a quote found verbatim in the collected data that states the percentage, 13 by the referenced Canvas group weight, 3 by the referenced Handbook percentage, and 8 where both the group weight and the Handbook agreed; all 46 rules had a quote that was found. So in these runs the model mostly quoted verbatim rather than paraphrasing. This only shows that nothing was cleared for these two collections and this model; whether real syncs, other models or other courses clear many fields is unverified. Weights the model left empty itself are not counted as unsourced (`unsourced` lists only fields cleared by verification).

**Where v2 differs from the gold.** In the 20 v2 runs, each cell that matched but differs from the gold, classified by the two values (final scoring code; "missed" = a gold assessment that did not match, one cell per field):

| Field | Missed | v2 empty (unsourced) | v2 empty (other) | Gold empty, v2 has a value | Both have different values |
| --- | ---: | ---: | ---: | ---: | ---: |
| kind | 16 | 0 | 0 | 0 | 0 |
| nature | 16 | 0 | 0 | 0 | 0 |
| parentId | 16 | 0 | 3 | 0 | 7 |
| weight | 16 | 0 | 20 | 0 | 1 |
| maxScore | 16 | 0 | 22 | 8 | 0 |
| score | 16 | 0 | 10 | 0 | 0 |
| due | 16 | 0 | 0 | 15 | 0 |
| scoring | 16 | 0 | 0 | 0 | 5 |
| status | 16 | 0 | 0 | 0 | 35 |
| Total | 144 | 0 | 55 | 23 | 48 |

- "v2 empty (unsourced)" is 0: no difference comes from quote verification clearing a field.
- "v2 empty (other)" is concentrated in weights (20) and maxima (22): weights the model did not give, and maxima that code fills from platform data and leaves empty when the platform has none. Whether these are missing values or numbers the old output had without a platform source was not checked item by item.
- "Gold empty, v2 has a value" is mostly deadlines (15): v2 fills deadlines from Canvas / Ed where the old output left them empty; probably an improvement, not checked item by item.
- "Both have different values" is mostly status (35): v2 computes status from platform data too.
- The baseline classified the same way (same scoring code): 234 missed, 16 model empty, 48 gold empty with a model value, 36 both different.

### Limits of the results

- **The gold is not human-verified truth.** When page corrections were exported on 2026-10-30, corrections, manual assessments and ordering were all empty (the reset marker suggests the page data was cleared on 2026-10-28; not confirmed), so the gold is an earlier model-written course JSON from the Desktop, unchanged. "Accuracy", "recall" and "precision" here measure how much `deepseek-flash` agrees with that earlier output and cannot say which side is right: a low number may mean this run is wrong, the gold is wrong, or both organisations are reasonable.
- Small sample: 4 courses, 1 student, one collection per course; it describes only these courses at this time.
- COMP20003's collection was partial, so its input was incomplete and its metrics also reflect missing input.
- N = 5, so the consistency metrics vary a lot; re-running on another day may give different results.
- Only `deepseek-flash` was run; no other model or provider was compared.
- v2 ran about 1 h 40 min after the baseline; whether the provider changed anything in between is unknown.
- The v2 breakdowns ("where v2 differs" and "why unsourced is 0") were counted locally from the saved runs and have no script command; the overall and per-field metrics can be reproduced with the `--rescore` commands above.
- The scoring rules' own limits are in [Limits of the method](#limits-of-the-method).
