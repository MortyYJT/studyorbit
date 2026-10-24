---
name: revision
description: Prepare cited revision material, tutor from stored notes, or practise only questions whose latest attempt was incorrect. Never complete graded work.
---

# Revision presets

Use the course id supplied by the preset. All preparation uses L0 reads, the owner's
Edge (through your computer use) and `source.record`; do not change autonomy grants,
start sync, read discussion threads, or fill or submit anything on Canvas or Ed.
Store revision material only through the validated commands.
This skill never answers, fills, drafts, or submits graded assessments, including exams.
If a request is graded work, stop and explain that this preset is for revision only.
There is no scheduled revision stage in v1.

## Prepare revision

1. Open the needed Canvas or Ed page in the owner's Edge first, before reading course
   content or writing anything. If it shows a sign-in page, stop: read nothing, write
   nothing, and ask the owner to sign in in their Edge. Never type a password or code.
2. Read `courses.list`, `assessments.list`, `materials.list`, and `revision.read`
   for the selected course. Find the final assessment and exam-information material
   through L0 reads. Exam time comes from `revision.read.examTime` (the final's
   effective due), never a guessed date. Missing or ambiguous scope/time stays unknown.
3. Read each course page or PDF you will cite in the owner's Edge and record it with
   `source.record { courseId, url, title, text, page? }`: the page's Canvas or Ed URL
   (under this course), its title and the text exactly as shown, one call per PDF page
   with its one-based `page`. Copy text faithfully; never add, summarise or invent text,
   never record discussion threads, and never work around a refusal. Image-only pages
   are recorded empty and reported. Use `sources.get` to read stored evidence.
4. After recording, call `revision.read` again for the current `sourceRevision`.
   Record scope with `revision.write` using `type: "exam-scope"` and `topics`:
   each topic is `{ text, citations: [{ sourceItemId, quote, locator }] }`.
   Scope is per course, so omit `week`. Copy quotes and locators from stored redacted
   evidence exactly; one invalid quote rejects the entire write.
5. Write notes through `revision.write` with `claims` (optional `type: "note"`,
   optional teaching `week`). Write questions through `practice.write` with
   `questions` containing a stable id, prompt, kind (`objective` or `open`), answer,
   and cited `explanation` claims. Objective questions also need at least two options.
   Every explanation and note claim must cite stored evidence. Do not copy graded
   questions into practice or treat a citation as proof that your interpretation is right.
6. For replacing a record, read `revision.list` or `practice.list` and include its
   exact `previousRevision`. Never overwrite blindly or retry a conflict with stale
   evidence. Refresh the sources/version and explain what changed. If a write returns
   `UNCERTAIN`, inspect stored state before retrying. Report accepted and rejected
   write counts in chat, plus unsupported pages/topics. Do not claim a rejected write
   was saved. Only accepted records survive restart.

## Tutor revision

1. Read `revision.list`, `practice.list`, and `practice.stats` for the course.
   Use stored notes and questions only. Ask one practice question at a time; wait for
   the owner's answer before showing the stored answer or cited explanation.
2. Compare the response with the stored answer and explain using its stored citations.
   For open questions, describe the reasoning and uncertainty instead of claiming
   objective grading. Do not invent a source, quote, question, or exam requirement.
3. After each attempt call `practice.attempt.record` with only `questionId`, the
   containing practice record's `revision`, `outcome` (`correct`, `incorrect`, or
   `skipped`), and ISO timestamp `at`. Never include the owner's answer text.
   A stale revision requires rereading the stored question before recording.
4. If a topic is absent from stored notes/questions, say plainly that stored material
   does not cover it and offer to prepare it. Preparation starts at the course page in
   the owner's Edge and stops at a sign-in page.

## Wrong answers only

Read `practice.stats.wrongQuestions` and match each `(questionId, revision)` to
`practice.list`. Tutor only these current questions, using the tutor procedure above.
A question corrected since an earlier mistake is excluded. Skipped questions are
not counted as answered. Refresh statistics after recording attempts. If none remain,
say that no current questions have a latest incorrect attempt; do not fabricate work.
