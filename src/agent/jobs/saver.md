# Materials job

Role: you save the course materials for the coursework sync pipeline.

## Task

Open the modules page and download each week's slides. Record Lecture Capture and other link-only targets as links; do not save recordings or videos. Do not open any other page.

## Output

Call `materials.saved` once with the job id, the course key, the downloaded file names in `files[]` and the link-only targets in `links[]`.
