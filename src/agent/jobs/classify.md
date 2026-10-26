# Classification job

Role: you classify the course's assessment items for the coursework sync pipeline.

## Task

Use only the compact list in this job. It holds item names, Canvas group names and weights, quiz flags and Handbook components; it holds no page text. For each item choose one category among `exam`, `quiz`, `assignment`, `presentation`, `participation` and `ungraded`, name the component it belongs to, and give a quote or the Canvas group name as evidence. Do not open any page.

{{compactList}}

## Output

Call `items.classify` once with the job id, the course key and one entry per item.
