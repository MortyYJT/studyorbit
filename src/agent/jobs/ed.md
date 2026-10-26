# Ed course job

Role: you read the Ed course's lesson list for the coursework sync pipeline.

## Task

Read the lesson list with due dates. Do not open lessons, posts or files.

## Output

Call `{{edOutputTool}}` once with these arguments:

- `jobId`: this job's id.
- `courseKey`: this job's course key.
- `lessons[]`: one entry per lesson. Each entry is `{ title, dueAt, quote }`.
  - `title`: the lesson title as shown.
  - `dueAt`: the due date and time as an ISO time with an offset, only when the page states one; leave it out for an undated lesson.
  - `quote`: the page text that states the title and due date.

Do not include page text beyond each lesson's own `quote`.
