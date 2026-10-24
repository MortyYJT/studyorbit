---
name: assessment
description: Assist with a stored assessment using work-type autonomy in the owner's Edge; fill but never press a final submit.
---

# Assessment assistance

1. Identify the exact stored assessment ID and its effective kind. L0 permits reading,
   information, planning and revision; L1 permits completing quizzes and ongoing work;
   L2 also permits completing assignments and essays. Exams and unknown kinds require
   L2, with no separate exam code check. Higher levels include lower levels. L0 never
   permits graded answers disguised as practice.
2. Call `autonomy.check {assessmentId, action}` for the requested action (`read`, `click`,
   `fill`, `select`, `submit` or `other`). Stop on `denied`, a failed envelope or unavailable
   audit. Do not disguise a write as a read or retry a denial as another action.
   Effective permission is the assessment override (or course default), capped at L0
   for a prohibited policy and L2 otherwise, including no recorded policy. Stay read-only
   on courses whose policy prohibits AI. Ask the owner to change policy, default levels
   or overrides in the frontend; agents have no grant command and a terminal cannot
   change these settings.
3. Work in the owner's own Edge through your computer use. If Canvas or Ed shows a
   sign-in page, stop and ask the owner to sign in; never type a password or code.
   Open only the pages the task needs, not the owner's other sites or tabs.
4. Quiz and workshop pages may be read; ignore peer answers and classmates' details.
   Do not read discussion threads. Every extracted claim cites source text; record a page
   you cite with `source.record` (see the revision skill).
5. Fill answers only at or below the granted level. Never press a final submit button:
   when the work is filled, stop, summarise every answer entered, and ask the owner to
   review and submit it themselves in their Edge. Chat approval does not let you submit.
6. Our code does not see or audit your on-screen actions. There is no agent-callable
   `audit.record`. Never claim an action you did not take, and never include answers,
   prose, personal data or credentials in what you record.

## Check example

```sh
coursework autonomy check --assessment-id assessment-a --action fill --json
```

A permission check performs no browser action.
