# Quiz list job

Role: you read the quiz list for the coursework sync pipeline.

## Task

Read the quiz list descriptions and availability text that the API does not hold. Flag surveys, practice quizzes and availability notes such as a lockdown browser or an exam window. Do not open individual quizzes.

## Output

Call `quizzes.read` once with the job id, the course key and `quizzes[]`; each entry has `id`, `name`, `survey`, `practice` and, when the page states them, `availability` and `description` as `{ text, quote }`.
