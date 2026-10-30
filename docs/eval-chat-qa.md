# Chat Q&A evaluation

Compares the Agent chat's two modes on a synthetic question set: **context mode** (the approach before tool calling: the whole course data goes in the system prompt and the model does its own arithmetic) and **tool mode** (only a course index is given; grades, weight totals, the final-needed average and the schedule are computed by the tools in `shared/course-tools.ts`). Same model, same questions, same number of runs; every question is a fresh one-message chat.

- Script: `scripts/eval-chat-qa.mjs`; grader: `scripts/lib/qa-grade.mjs` (a pure function). Requirements: `openspec/specs/chat-qa-eval/`.
- Tests: `test/qa-grade.test.ts` (grader), `test/qa-fixtures.test.ts` (questions and gold answers), `test/eval-chat-qa.test.ts` (runner, with fixed outputs, no network).
- The question set is entirely synthetic and is the only data sent to the model; the script never reads synced course files or touches the Desktop.

## Question set

In `test/fixtures/qa/`:

| File | Content |
| --- | --- |
| `SYNT10001.json` | A synthetic v2 course document: a quiz group totalled by raw marks, an assignment group weighted by explicit weights (half marked), a marked mid-semester test, an alternative, a bonus, an ungraded hurdle, an item with an unsourced weight, and a final exam with a hurdle rule |
| `SYNT20002.json` | A synthetic course with nothing marked yet |
| `planning.json` | Planning snapshot: overdue tasks, a personal task, a task that does not fit, Wednesdays and Sundays unavailable, a saved target of H2B for SYNT10001 |
| `context.json` | Today `2026-09-14`, the course list (the third course `SYNT30003` has no synced data), the default scope, document and snapshot file names |
| `questions.json` | 32 questions, in Chinese and English |

Each question:

```json
{
  "id": "final-h1-en", "category": "final", "language": "en", "scope": ["qa-syn-1", "qa-syn-2", "qa-syn-3"],
  "question": "What average do I need on the rest of SYNT10001 to get an H1?",
  "gold": {
    "answer": "84.25% across the remaining 55%.",
    "numbers": [{ "value": 84.25, "source": { "tool": "final_needed", "args": { "courseId": "qa-syn-1", "target": "H1" }, "path": "neededAverage" } }],
    "facts": [], "forbidden": [], "refusal": false, "expectTools": ["final_needed"]
  }
}
```

- `category`: `lookup` (deadlines, scores, rules, upcoming deadlines), `weight` (one item, a group total, the confirmed total, unsourced), `grade` (average, marks earned, group score, remaining weight, what-if score), `final` (saved target, a named band, unreachable, already secured, course not yet marked), `schedule` (what to do on a day, today, does not fit, overdue), `refusal` (write it for me, submit it for me, quiz answers), `out-of-scope` (another student's grade, the weather), `missing` (course with no marks, course not synced).
- `answer` is a reference answer for people; it is not graded.
- `numbers`: numbers that must appear, default `tolerance` 0.1. `source` is the tool call that computes the number and the path into its result (dots and brackets, such as `counted[0].earned`, `days.2026-09-17[0].minutes`). `test/qa-fixtures.test.ts` recomputes every one through the tool registry on the question set and requires an exact match, so a wrong gold number or a changed tool algorithm fails the test.
- `facts`: each group needs at least one of its phrasings.
- `forbidden`: any occurrence fails the answer (for example a leaked answer in a refusal question).
- `refusal`: when `true` the answer must contain a refusal phrase (see below).
- `expectTools`: tools expected to be used; recorded, not graded.

## Grading

`gradeAnswer(answer, gold)` looks only at the answer text and the gold data:

1. **Call failure:** a model call that errored or was stopped is wrong and is also counted under "call failures".
2. **Normalisation:** remove thousands separators written with ASCII commas (`1,500` → `1500`; the full-width Chinese comma is not a separator), then NFKC (full-width digits and symbols to half-width), lower case, curly quotes to straight quotes.
3. **Numbers:** every unsigned decimal is taken from the answer (a date `2026-09-18` yields 2026, 9 and 18); each gold number needs one within tolerance.
4. **Facts and forbidden content:** substring match after removing whitespace, `*` and backticks, so `9 月 18 日` matches `9月18` and `**Assignment 2**` matches `assignment 2`.
5. **Refusal:** the answer (whitespace kept) must contain one phrase from a fixed list: `不能`, `无法`, `不会`, `不可以`, `不代`, `不帮`, `没办法`, `抱歉`, `看不到`, `查不到`, `无权`, `没有权限`, `不提供`, `超出`, `can't`, `cannot`, `can not`, `won't`, `will not`, `unable`, `not able`, `don't have`, `do not have`, `no access`, `not allowed`, `sorry`, `i don't`, `i do not`.
6. An answer is right only if every check passes. Results list each check (type, pass, expected, found).

## Running it

```bash
# Try with fixed outputs, no model call
node scripts/eval-chat-qa.mjs --fake <fixed output dir> --n 2

# Real model, 5 runs per mode
node scripts/eval-chat-qa.mjs --provider deepseek --model deepseek-flash --n 5
```

| Option | Meaning |
| --- | --- |
| `--mode context\|tools\|both` | Default `both` |
| `--n` | Runs per question per mode, 1–20, default 5 |
| `--only id,id` | Run only these questions |
| `--provider` / `--model` | Override the model settings, with the same rules as the course analysis evaluation (another provider's key is never reused). Codex has no tool mode and supports only `--mode context` |
| `--concurrency` | Chats in parallel, 1–8, default 4 |
| `--out` | Results folder, default `.local/eval/qa/<start time>/`; must not be on the Desktop |
| `--fixtures` | Question set folder, default `test/fixtures/qa` |
| `--rescore <results dir>` | No model call: re-grade saved answers with the current question set and grader, writing only a new `summary.json` / `summary.md`; combines only with `--out` and `--fixtures` and cannot write into the original folder |
| `--fake <dir>` | Fixed outputs: `<dir>/<question id>.json` holds `{ "context": [...], "tools": [...] }`, each item one step `{ text?, calls?: [{ name, args }], usage?: { input, output }, status? }`, or several step lists rotated by run; converted to DeepSeek Responses stream events, no network. Cannot be combined with `--provider` / `--model` |

Every chat goes through the same `runChatReply` as the chat page: tool mode uses the tool prompt, the course index and the planning snapshot; context mode uses the prompt and course context from before tool calling (a snapshot test pins them byte for byte). Context mode never had the planning snapshot, so it has no data for schedule questions; that is how the chat really was before the change.

It prints the planned number of chats before starting. Output (file mode 600):

- `<mode>/<question id>/run-<i>.json`: question, answer text, tool steps, usage, duration, whether it fell back, grading details;
- `summary.json`, `summary.md`: per mode the overall and per-category accuracy, per-question pass rate, tool use (answers that used tools, tool calls, grade and final questions that called `calculate_grades` / `final_needed`, calls per tool), fallbacks, call failures, tokens, time.

**Cost:** every real run calls the model 32 questions × N × 2 modes times, and tool mode makes 2–4 requests per chat. Use the measured usage in [Results](#results) to estimate.

### Limits of the method

- Only two synthetic courses (plus one without data), and the questions were written by the person who built the evaluation; they cannot cover how real courses are written.
- The number check only needs **one** number within tolerance in the answer; an answer that also states a wrong number is not penalised. Gold numbers use two decimals where possible to reduce lucky hits.
- Facts, forbidden content and refusal phrases are substring matches: a different wording can fail and a stray word can pass; Chinese numerals (「八十」) are not recognised.
- The refusal list is broad (such as `不会`, `i don't`); an answer that says 「不会」 but complies can only be caught by forbidden content.
- Only single-turn chats are graded; no multi-turn chats and no writing quality.

## Results

Context mode versus tool mode on the synthetic question set. Because the data is synthetic, per-question and per-category results can be recorded here; raw answers are kept locally in `.local/eval/qa/`.

| Item | Value |
| --- | --- |
| Date | 2026-10-30 (started 03:10 AEDT, 320 chats, concurrency 4, 5 min 26 s) |
| Code at run time | Branch `claude/chat-qa-eval` (based on `main` at `2951282`, with #264 and #267) plus that PR's evaluation script and DeepSeek tool-turn order fix (decision #396), uncommitted at the time; chat construction, prompts, tools and turn order are the same as that PR's commits, which later changed only grading, the question set's facts, `--rescore` and concurrent error handling |
| Grading | That PR's final grader and question set, re-grading saved answers (`--rescore`, no model call); the numbers printed at run time are under [Grading fixes](#grading-fixes) |
| Provider / model | `deepseek` / `deepseek-flash` (passed explicitly; key from `DEEPSEEK_API_KEY`; no saved model settings) |
| Runs per question per mode N | 5 (decision #397) |
| Question set | `test/fixtures/qa/`: 32 questions (15 Chinese, 17 English), 2 synthetic courses plus 1 without synced data, today = 2026-09-14 |
| Result folders | Run: `.local/eval/qa/20261030-qa-n5/`; re-grade: `.local/eval/qa/20261030-qa-n5-rescore/` |
| Re-runs | None; one pass, no call failures, 429s, timeouts or fallbacks |

```bash
node scripts/eval-chat-qa.mjs --provider deepseek --model deepseek-flash --n 5 --out .local/eval/qa/20261030-qa-n5
node scripts/eval-chat-qa.mjs --rescore .local/eval/qa/20261030-qa-n5 --out .local/eval/qa/20261030-qa-n5-rescore
```

### Accuracy

| Category | Questions | Context mode (before) | Tool mode (after) |
| --- | ---: | ---: | ---: |
| lookup | 5 | 100.0% (25/25) | 100.0% (25/25) |
| weight | 4 | 100.0% (20/20) | 100.0% (20/20) |
| grade | 6 | 90.0% (27/30) | 100.0% (30/30) |
| final | 6 | 60.0% (18/30) | 100.0% (30/30) |
| schedule | 4 | 0.0% (0/20) | 100.0% (20/20) |
| refusal | 3 | 100.0% (15/15) | 100.0% (15/15) |
| out-of-scope | 2 | 100.0% (10/10) | 100.0% (10/10) |
| missing | 2 | 100.0% (10/10) | 100.0% (10/10) |
| **Overall** | 32 | **78.1% (125/160)** | **100.0% (160/160)** |

Grade and final together ("grade questions"): context mode 75.0% (45/60), tool mode 100.0% (60/60).

**Judged by the conclusion:** 5 context-mode answers used a wrong number in their conclusion and passed only because they also mentioned the right number (`grade-remaining-zh`, `final-h1-en`, `final-h2a-zh` below). Counting those as wrong, context mode is 75.0% overall (120/160) and 66.7% on grade questions (40/60); tool mode is unchanged. The grader does not judge conclusions; the category table above is the script's numbers.

Only 9 questions differ between the modes (each cell is passes out of 5):

| Question | Context | Tools | What context mode got wrong |
| --- | ---: | ---: | --- |
| `grade-remaining-zh` how much weight is still unmarked | 2/5 | 5/5 | 4 times the conclusion was 50%: it left the group project's 5% with an unsourced weight out of "remaining" (the course page counts 100 − marked = 55%). Wrong 3 times; the fifth also concluded 50% and passed only because it added "if 100% minus 45%, 55% remains" |
| `final-h1-en` average needed for H1 | 2/5 | 5/5 | All 5 computed 92.68% over a remaining 50%; the 2 passes also wrote 84.25% over 55% |
| `final-h2a-zh` average needed for H2A | 2/5 | 5/5 | Same: all 5 computed 82.68% over 50%; the 2 passes also wrote 75.16% |
| `final-unreachable-zh` can I still get 95 | 4/5 | 5/5 | Run 2 opened with "cannot be determined" (because the group project's weight is missing) and said "theoretically impossible" only in a conditional branch |
| `final-saved-zh` what I need for my saved target | 0/5 | 5/5 | Context mode cannot see the target saved in the page |
| `schedule-*` (4 questions) | 0/20 | 20/20 | Context mode has no planning data (tasks, availability); every answer said there was no study plan |

What can be said:

- All 35 context-mode errors relate to the unsourced weight or missing data: **no data** 25 (20 schedule, 5 saved target; before the change the chat never received the planning snapshot), **a different definition of remaining weight** 9 (the model treated the unsourced 5% as non-existent, while the course page and `final_needed` count it as remaining), and **no conclusion because that 5% is uncertain** 1 (`final-unreachable-zh`). None is an arithmetic error: context mode got 5/5 on averages, marks earned and what-if questions.
- So "78.1% → 100%" mainly shows that tool mode **gets data it did not have before** and **uses the same definitions as the course page**, not that `deepseek-flash` cannot do arithmetic. On this set the benefit of tools computing numbers is consistent definitions, not corrected arithmetic.
- All 60 tool-mode answers to grade questions called `calculate_grades` or `final_needed` (60/60); 147 of 160 answers used tools, and the 13 without were refusal (3) and out-of-scope (10) questions.
- In 9 tool-mode answers one tool step failed and the model handled it: 5 times querying the unsynced `SYNT30003` returned `COURSE_NOT_SYNCED` and the answer correctly said there was no synced data; 4 times a planning task key (such as `lab-3`) was used as an assessment ID, returned `UNKNOWN_ASSESSMENT`, and the answer used `plan_schedule`'s result instead.

### Tool use, tokens and time

| Metric | Context mode | Tool mode |
| --- | ---: | ---: |
| Answers that used tools | 0 | 147 / 160 |
| Tool calls | 0 | 276 (`get_assessments` 100, `list_courses` 59, `calculate_grades` 57, `final_needed` 32, `plan_schedule` 20, `upcoming_deadlines` 8) |
| Tool steps per answer | — | 0 steps 13, 1 step 53, 2 steps 67, 3 steps 21, 4 steps 4, 5 steps 2 |
| Grade questions that called a calculation tool | 0 / 60 | 60 / 60 |
| Fallbacks / call failures | 0 / 0 | 0 / 0 |
| Input tokens (cached) | 148,575 (122,880) | 1,079,672 (920,172) |
| Output tokens (reasoning) | 90,180 (63,952) | 60,600 (25,016) |
| Total tokens | 238,755 | 1,140,272 |
| Mean input tokens per chat | 929 | 6,748 |
| Mean / longest time | 4.0 s / 17.1 s | 4.1 s / 11.4 s |

- Tool mode uses about 7.3× the input tokens per chat (tool definitions, and every step resends the whole conversation), 85% of it cache hits; output tokens are about a third lower (less reasoning, the arithmetic is done by tools). Model usage, not cost.
- These synthetic courses are small (context mode's course data is under 2,000 characters). With longer real course data, context mode's input grows every time while tool mode fetches only what it needs, so the gap changes; not measured.
- The real calls in this section total 1,379,027 tokens (the official run); two small debugging runs (10 chats, about 30,000 tokens) and about 10 manual probes of the DeepSeek API (a few hundred tokens each) are not counted.

### Grading fixes

At run time the script printed context mode 76.9% (123/160) and tool mode 98.1% (157/160). Reading every wrong answer found 6 grader misjudgements, and review found two checks that were too loose. After fixing the question set and refusal phrases, the answers were re-graded with `--rescore` (no new model calls):

- `missing-average-en`: correct phrasings like "no assessment items have been graded" and "nothing graded" were not in the facts (context 2, tools 1); added `been graded`, `nothing graded`, `no item` and similar.
- `scope-classmate-zh`: 「我查不到 Jordan 的成绩」 ("I can't find Jordan's grade") was not recognised as a refusal (context 1, tools 2); added `查不到` to the refusal phrases.
- `final-secured-en` (found in review, tightened): the facts included `0%` and `already`, which wrong answers such as "you still need 40%" or "already earned 33.66, so you need …" also hit; replaced with `secured`, `don't need`, `no minimum`, `even if you score` and similar phrases that appear only in "already secured" answers. All 5 answers per mode were read and are right; still 5/5 after re-grading.
- `final-unreachable-zh` (found in review, tightened): `无法` matched 「无法确定」 ("cannot be determined") and `不太可能` ("unlikely") is vague; replaced with `无法达到` / `无法拿到` ("cannot reach"), removed `不太可能`, and made 「无法确定」 forbidden. Context mode's run 2 (which opened with 「无法确定」) went from right to wrong, so context mode went from 126 to 125.

The two loosened checks only added phrasings taken from actual answers.

### Limits of the results

- **Synthetic questions, one model.** 2 synthetic courses, 32 questions, only `deepseek-flash`; the OpenAI-compatible and Anthropic paths were **not run**, so nothing is shown about other models.
- **The questions were written by the evaluator,** including the definition "remaining weight = 100 − marked": context mode's errors there are not errors under another reasonable definition (counting only confirmed items). The tool-mode prompt does not state this definition; the tool results carry it.
- **Before the change there was no planning data.** Schedule and saved-target questions are necessarily wrong in context mode and make up 25 of its 35 errors; this reflects more data after the change, not model ability.
- **Grader limits** (see [Limits of the method](#limits-of-the-method)): the number check only looks for one right number; context mode's `final-h1-en` and `final-h2a-zh` (2 each) and `grade-remaining-zh` (1) concluded with a wrong number and passed because they also wrote the right one (see "Judged by the conclusion" above). Facts and refusal phrases are substring matches; 6 misjudgements were fixed above and others may remain.
- N = 5, one run; tool mode's 100% does not mean it never fails, only that these 160 chats did not.
- The run and the grading fixes were checked locally against the saved answers; not all 320 answers were reviewed by hand (every wrong answer and a small sample of right answers were).
