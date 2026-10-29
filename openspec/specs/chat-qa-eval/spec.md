# chat-qa-eval Specification

## Purpose
A synthetic question set with gold answers and a deterministic grader compares context-mode and tool-mode chat answers, and the results are recorded.
## Requirements
### Requirement: Synthetic question set with gold answers
The repository SHALL contain, in `test/fixtures/qa/`, synthetic course documents (at least one with graded items, points and weighted groups, a bonus, an alternative, a hurdle and an unsourced weight, and one with nothing graded), a planning snapshot, a fixed date and course scope, and at least 24 questions in Chinese and English covering lookups, weights, grade calculation, final-needed, scheduling, refusals of graded-work requests, out-of-scope requests and missing data. Each question SHALL have a category, a language, the course scope and gold data: reference text, expected numbers with tolerance (default 0.1) and a `source` (`{ tool, args, path }`: the registry call that must produce the number and a path into its result), required fact groups (each a list of accepted alternatives), forbidden strings, whether a refusal is expected, and the tools expected to be used. Fixtures MUST NOT contain real course data, grades, names or local paths. A test SHALL run every number's `source` call against the fixture context and check that the value at its `path` equals the expected number.

#### Scenario: Gold number disagrees with the tools
- **WHEN** a question's expected number differs from the value at its `source.path` in the result of its `source.tool` called with `source.args` on the fixtures
- **THEN** the fixture test fails

### Requirement: Deterministic grader
The grader SHALL be a pure function of an answer and its gold data. It SHALL normalise the answer (NFKC, lower case, thousands separators removed), pass a number check when some number in the answer is within tolerance of the expected value, pass a fact group when one alternative appears, fail when a forbidden string appears, and for refusal questions require a refusal marker from a fixed bilingual list. An answer SHALL pass only when every check passes, and the result SHALL list each check. A failed or stopped model call SHALL count as a failed answer.

#### Scenario: Close number
- **WHEN** the gold number is 83.33 with tolerance 0.1 and the answer says 「需要平均 83.3%」
- **THEN** the number check passes

#### Scenario: Refusal with leaked work
- **WHEN** a refusal question's answer contains a refusal marker and also a forbidden string
- **THEN** the answer fails

### Requirement: Runner compares context mode and tool mode
A runner script SHALL ask each question as a fresh one-message conversation, N times per mode (default 5, at most 20), in context mode (the prompt and context in use before this change) and tool mode, building the prompt, tools and context exactly as the chat does but from the fixtures, with the configured model or `--provider` / `--model` overrides. It SHALL support scripted provider responses for tests, a question filter and an output directory (default `.local/eval/qa/<start time>/`, refused inside the Desktop). It SHALL print the planned number of conversations before calling a model, write each answer with its steps, usage, duration and grade, and write a summary with accuracy overall and by category, per-question pass rate, tool use (answers with a step; grade and final-needed answers that called `calculate_grades` or `final_needed`), fallbacks, call failures, tokens and time per mode. Output files SHALL have mode 600.

#### Scenario: Scripted run
- **WHEN** the runner runs both modes with scripted responses and N = 2
- **THEN** it writes 2 answers per question per mode and a summary whose accuracy matches the scripted answers' grades, without any network call

### Requirement: Before and after results are recorded
After the tool loop is merged, the configured model (DeepSeek Flash, per decision #245, unless the owner chooses otherwise) SHALL be run in both modes with N = 5, and `docs/eval-results.md` SHALL record the date, commit, provider and model, N, accuracy per mode overall and by category, tool-use rates, fallbacks, failures, tokens and time, and the limitations. The question format, grading rules and runner options SHALL be documented in `docs/eval-chat-qa.md`.

#### Scenario: Results section
- **WHEN** the live run finishes
- **THEN** `docs/eval-results.md` has a section with context-mode and tool-mode accuracy side by side for the same model, questions and N

