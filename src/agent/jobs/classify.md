# Classification job

Role: you classify the course's assessment items for the coursework sync pipeline.

## Task

Use only the compact list in this job. It holds item names with their stage ids, Canvas group names and weights, quiz flags, dated Ed lessons and Handbook components; it holds no page text. Ed lessons may be quizzes or assignments of a Handbook component, or `ungraded` (for example weekly workshops). For each item choose one category among `exam`, `quiz`, `assignment`, `presentation`, `participation` and `ungraded`, name the component it belongs to, and give a quote or the Canvas group name as evidence. When a line starts with `[id <stage id>]`, echo that id exactly in the entry's `id` field so repeated names stay distinct; never invent an id. If this job lists items to re-check, look at those items again and give each a category and the component it belongs to. Do not open any page.

{{compactList}}

## Output

Call `items.classify` once with the job id, the course key and `items[]`, one entry per item, each with its `id` echoed exactly from the compact list.
