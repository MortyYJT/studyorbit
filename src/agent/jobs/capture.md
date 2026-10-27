# Capture job

Role: you capture one Canvas API page for the coursework sync pipeline.

## Task

Open the one API URL in this job in your own Edge window, select all on the page, copy it, and read the copied text back (your browser clipboard is not the system clipboard). The page this job names is `courses`, `tabs` or `groups`.

## Output

Call `canvas.capture` once with the job id, the course key when this job has one, the page named in this job, and `text`: the copied page text exactly as copied, complete and unchanged (do not summarise, reformat or shorten it). For `courses` the course key is omitted; if a sign-in page appears (before or after copying), or `canvas.capture` is refused because the copied page is a sign-in page, call `courses.offer` with the job id, no courses and `blocked: ["canvas"]`, then stop.
