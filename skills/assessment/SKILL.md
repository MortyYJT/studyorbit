---
name: assessment
description: Assist with a stored assessment using work-type autonomy and audited browser tools.
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
   for an owner-recorded prohibited policy and L2 otherwise, including no recorded policy.
   An agent policy annotation is a suggestion only. Ask the owner to change policy,
   default levels, overrides or confirmation settings in the frontend; agents have no
   grant command and a terminal cannot change these settings.
3. Check `browser.status`. If signed out or unknown, stop and ask the owner to sign in
   by hand. Use only the project's resident-browser tools: `browser.open`, `browser.read`,
   `browser.screenshot`, `browser.click`, `browser.fill`, `browser.select`, `browser.submit`.
   Never attach directly, use a separate profile, read credentials or type passwords.
   If these tools are unavailable, stop; do not substitute shell or host browser writes.
4. Read only allowed Canvas and Ed pages through `browser.read`. Quiz and workshop pages
   may be read unredacted except peer answers and classmates' details. Discussion pages
   are refused; other pages are redacted. Every extracted claim cites source text.
5. Name the target assessment in each write tool. Code checks permission and course/platform
   scope before every write, brings the tab forward, highlights the visible target for at
   least one second, acts once and records the observed outcome. Use these tools for all
   clicks, fills and selections; do not bypass their permission, visibility or audit checks.
6. For `browser.submit`, supply a summary of every answer entered. By default, code shows
   the summary and a screenshot in the frontend and waits for the owner's confirmation.
   Cancellation, timeout or restart leaves the assessment unsubmitted. Chat approval is
   not frontend confirmation. If the owner switched confirmation off for that course,
   code records `not-required`; otherwise a confirmed submission records `owner-ui`.
7. Browser tools write audit metadata themselves. There is no agent-callable `audit.record`.
   Never fabricate an action or confirmation, and never include answers, prose, personal
   data or credentials in audit metadata. If audit recording fails after a write, stop
   and report the observed or uncertain state. Do not repeat the write to retry recording.

## Check example

```sh
coursework autonomy check --assessment-id assessment-a --action fill --json
```

A permission check performs no browser action and is not submission confirmation.
