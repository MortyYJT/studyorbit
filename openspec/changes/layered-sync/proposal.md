## Why

One Codex session reads every selected course end to end (#165), and it is too expensive: a four-course sync used about 80% of the five-hour quota (2026-10-25 and 2026-10-26 runs), because 77 page reads returning 2.46 million characters stay in the context for every later step, and each course was submitted three times before the importer accepted the model-written document. Canvas's own `/api/v1` already holds the exact due dates, points, scores and group weights for the signed-in student (#193), and the first live read showed the agent missing exactly those numbers (#186). The owner chose to split finding from reading, read only what planning needs at sync time, and take Canvas numbers straight from the API (#199–#209). This change absorbs the earlier C-5 change `canvas-check-item-policy` (#208): the narrow Canvas check becomes the primary source of Canvas numbers, and its per-assessment AI policy part is kept.

## What Changes

- **BREAKING (sync pipeline):** a sync run becomes a code-driven pipeline, one course at a time (#199): course list → Handbook skeleton (agent copy, code parse) → page routing → small agent jobs → code-built course document → import. No model writes the full course document any more; the course reading prompt is replaced by one short prompt per job (main, quiz page, assignment page, saver, classifier, Handbook capture).
- Course list (layer 0): Codex copies Canvas's course list API page; code parses it into course candidates; the owner selects in the frontend (unchanged ownership, #117-style).
- Skeleton (layer 1): an agent copies the public Handbook assessment page in the owner's Edge and code parses the clipboard text into components and weights as a tentative skeleton; the LMS wins where they disagree (#203).
- Canvas numbers come from the API (#208): Codex copies `assignment_groups?include[]=assignments&include[]=submission` (and the course tabs page); code parses due, unlock time, points, score, submission state and group weights. The agent no longer reads these for Canvas items, and the old agent-versus-Canvas conflicts (#194, #198) are removed.
- Page routing by code (#201): the course's navigation tabs decide which pages any agent may open: read (home, grades via API, quizzes, assignments list), save (weekly slides from modules), link only (Lecture Capture, syllabus that redirects to Ed), only when the home page points there (Pages, Files), and never (announcements, discussions, Gradescope, Echo360, Zoom, People, Collaborations, Outcomes, Office 365, Google Drive, Readings Online).
- Main agent: reads only the course home page and returns a course map (what the LMS is used for, what Ed holds, where the syllabus is, home-page links).
- Two layers per assessment (#200): the surface (unlock time, due, points, weight, AI policy) is read at sync; the deep layer (instructions, rubrics, attachments) is saved without reading into the owner's course folder and read only when the owner presses Start. Quizzes save nothing deep; Start opens the quiz link.
- **BREAKING (data model):** assessment categories converge to six (#202): `exam`, `quiz`, `assignment`, `presentation`, `participation`, `ungraded`. An item counts toward the grade only when it maps to a weighted Canvas group or a weighted component; everything else is `ungraded` (practice quizzes, surveys, extension-token requests, for-feedback items). `ongoing` migrates to `participation`.
- Course folder (#204): saved files go to `~/Desktop/<School> <YYSn>/<course name>/` (for example `UniMelb 26S2`), outside the data directory; code moves the agent's downloads there, fingerprints each file, and on a change re-saves it and shows "assessment content updated" in the frontend (#205).
- Ed through `edstem-cli` when the owner has configured it (#207), called as an external command; otherwise Ed is read by an agent job as today.
- Parallel jobs in several Edge windows are allowed by configuration but default to one at a time until the experiment (#206) says otherwise.
- Kept from C-5: per-assessment AI policy with a course default and the #197 resolution order (#195–#197); `autonomy.policy.set` per assessment.
- Remaining conflicts are only what the API cannot answer (#208): Handbook versus Canvas component weights, and Canvas assignments that match no component.

## Capabilities

### New Capabilities
- `canvas-api-read`: the copied Canvas API pages (course list, tabs, assignment groups), accepted input, parsing and the fields they set.
- `layered-sync`: the per-course pipeline, page routing, the agent jobs and their outputs, the classification rule, the course folder with fingerprints and update notices, the Ed source, and the Start flow for the deep layer.

### Modified Capabilities
- `coursework-sync`: discovery, the course JSON contract and its validation move from an agent-written document to a code-built one; per-assessment AI policy replaces the course-only policy.
- `domain-model`: Assessment kind becomes the six categories; Assessment gains `aiPolicy`, `unlockAt` and saved-file records; a narrowed conflict entity; Run records per-job steps.
- `assessment-autonomy`: effective policy and cap are resolved per assessment (#197).
- `agent-annotations`: agents may not annotate `aiPolicy` on assessments; an owner `null` clears an assessment policy.
- `agent-chat`: the workspace rule becomes per-assessment; a Start preset reads the saved deep layer through a tool.
- `protocol-reads`: assessment reads carry the effective policy, category, saved files and open conflicts.
- `web-ui`: course selection from the API list, "needs you" with the narrowed conflicts and update notices, the Start button, ungraded items folded.
- `local-store`: the course folder on the Desktop is a second, owner-visible location outside the data directory.

## Impact

- Code: `src/sync/agent-job.ts` becomes a pipeline orchestrator; new `src/sync/canvas-api.ts`, `src/sync/handbook.ts`, `src/sync/routing.ts`, `src/sync/course-folder.ts`, `src/sync/ed-cli.ts`, `src/sync/build-document.ts`; `src/sync/course-json.ts` and `course-import.ts` (categories, policy, built documents); `src/protocol/sync.ts`, `autonomy.ts`, `annotations.ts`; store migration; web UI; agent prompts under `src/agent/`.
- Data: one additive migration (category values, `aiPolicy`, `unlockAt`, saved files, conflicts), authorized by #195, #202, #204 and #208.
- Network: code makes no Handbook request (the page is behind bot protection and is copied by an agent, #214); no Canvas or Ed request is made by code with a credential. Ed through `edstem-cli` uses the owner's own Ed token stored by that tool outside this repository.
- Dependencies: none added to `package.json`; `edstem-cli` is an optional external command on the owner's machine.
- Metrics: each run records steps and turns per job, so the measured-runs table (`分层同步设计.md`) can be filled from real data.
