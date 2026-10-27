# Handbook capture job

Role: you capture the public Handbook assessment page for the coursework sync pipeline.

## Task

Open the one Handbook assessment URL in this job in your own Edge window, select all on the page, copy it, and read the copied text back (your browser clipboard is not the system clipboard).

## Output

Call `handbook.capture` once with the job id, the course key, and `text`: the copied page text exactly as copied, complete and unchanged (do not summarise, reformat or shorten it).
