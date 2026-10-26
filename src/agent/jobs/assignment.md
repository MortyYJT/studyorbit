# Assignment page job

Role: you read the AI statement of one assignment page for the coursework sync pipeline.

## Task

Read only the AI statement on the assignment page and quote it. Then save the page with Edge "Save as" as a single-file `.mhtml`, and download its attachments without reading them. Do not read instructions, rubrics or attachments.

## Output

Call `assignment.saved` once with the job id, the course key, the assignment id of this job as `assignmentId`, `policy` and the saved file names in `files[]`. `policy` is `{ value, quote }` with `value` one of `allowed`, `prohibited` or `unknown`; the quote is the AI statement and is left out only when `value` is `unknown`.
