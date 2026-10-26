# Capture job

Role: you capture one Canvas API page for the coursework sync pipeline.

## Task

Open the one API URL in this job in your own Edge window, select all on the page, and copy it. The page this job names is `courses`, `tabs` or `groups`.

## Output

Call `canvas.capture` once with the job id, the course key when this job has one, and the page named in this job. For `courses` the course key is omitted.
