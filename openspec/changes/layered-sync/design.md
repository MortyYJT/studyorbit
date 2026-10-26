## Context

Since #165 one Codex job (the course reading prompt in `src/agent/course-reading.md`) discovers courses, reads every page of every selected course and writes one large course document per course, which `course.import` validates and maps (`src/sync/course-json.ts`, `course-import.ts`). Measured cost (2026-10-25, 2026-10-26): 92–127 steps, 11.8–18.3 million input tokens, 45–80% of a five-hour quota for four courses, with most of the input being earlier page text kept in context. The schema in the prompt is about 14,000 characters and every course needed three submissions.

The earlier C-5 change planned a narrow check: Codex copies Canvas's `assignment_groups` API page to the clipboard and code compares it with the agent's read (#193, #198). A student session can read `/api/v1` (#100). The owner has now decided to make that API page the source of Canvas numbers instead of a check (#208), and to restructure the whole sync into layers (#199–#207). The design draft lives outside the repository as "分层同步 v0.3" (owner's diagram); this document is the repository's version of it.

Constraints that stay: Codex works only in the owner's signed-in Edge and stops at sign-in pages (#167, #176); code reads no cookie and holds no Canvas token; agents cannot change grants or selections; every agent-read fact that is not from an API carries a quote.

## Goals / Non-Goals

**Goals:**
- Cut a sync's model input by keeping page text out of long-lived contexts: each agent job sees one page or one small task, then ends.
- Take every number Canvas already knows from its API; let agents read only what has no API (home page purpose, quiz descriptions, AI statements, classification).
- Read the deep layer of an assessment only when the owner starts it, from files already on disk.
- Make cost measurable per layer (steps and turns per job).

**Non-Goals:**
- No automatic start of deep reading (no "N days before due" trigger; Start is pressed by the owner, #200).
- No announcement or discussion reading (#201); email ingestion is later.
- No recordings or videos saved; Lecture Capture is links only.
- No code-side Canvas or Ed login, cookie reading or token handling. `edstem-cli` keeps its own token.
- No dependency added to `package.json`.

## Decisions

**D1. A pipeline of small jobs, orchestrated by code.** `AgentSync.run` becomes: list → per selected course, in order: skeleton (capture job) → Canvas API pages → main job → routed jobs → classification job → build document → import → folder archive. Each agent job is one `adapter.start()` with a short prompt (role, task, output) and only the tools it needs; it ends after its single output tool call. Jobs share state through the store (the existing SyncJob row gains per-course stage results), because tool calls run in the `coursework mcp` process. A course finishes completely before the next starts, so a quota stop loses at most one course.
- Why code orchestration, not a main agent that spawns subagents: code knows each job's steps and turns, can retry exactly one job, and enforces routing; an agent spawning agents would hide all three.

**D2. Canvas API pages through the clipboard (from C-5 D1/D2).** For each Canvas page Codex opens one fixed URL in its own window, selects all, copies and calls `canvas.capture {jobId, courseKey, page}` with `page` one of `courses`, `tabs`, `groups`; the command reads the clipboard itself (`pbpaste`, behind an injectable reader). Parsing strips text before the first `[` or `{`, validates only needed keys with zod, checks `course_id`, caps at 5 MB, never stores raw text. URLs:
- `courses`: `/api/v1/courses?enrollment_state=active&include[]=term&per_page=100`
- `tabs`: `/api/v1/courses/{id}/tabs`
- `groups`: `/api/v1/courses/{id}/assignment_groups?include[]=assignments&include[]=submission&per_page=100`
The `groups` page sets each Canvas item's due (`due_at`), unlock time (`unlock_at`), points (`points_possible`), score and submission state, and each group's weight. These values are stored with `via: "api"` and are not read by any agent.
- Alternative kept as fallback: if the probe (task 1.1) shows the includes are refused, the two URLs of #193.

**D3. Handbook skeleton through the clipboard, tentative (#214).** The Handbook is behind bot protection: a plain `fetch` of `https://handbook.unimelb.edu.au/<year>/subjects/<code>/assessment` returns a block page (probe 2026-10-26, task 1.3), and code does not try to get around it. Instead, as for the Canvas API pages (D2), one short agent job opens that URL in the owner's Edge, selects all, copies and calls `handbook.capture {jobId, courseKey}`; the command reads the clipboard itself, caps it at 1 MB, parses the copied page text into the assessment rows (description, timing, percentage, hurdle text) with a small parser, never stores the raw text, and stores components as the course's tentative skeleton. Failure to capture or parse is not fatal: the course continues with the Canvas groups as the only structure. Where Handbook and Canvas give a component weight and they differ, the Canvas group weight is used and a `weight` conflict is shown (D8).

**D4. Page routing by code (#201).** The `tabs` page gives each navigation tab's id, label and URL. A fixed table maps tab ids (Canvas built-ins such as `home`, `assignments`, `quizzes`, `modules`, `grades`, `pages`, `files`, `announcements`, `discussions`, `people`, `outcomes`, `collaborations`, `syllabus`) and known external tool labels (Lecture Capture, Ed Discussion, Gradescope, Echo360, Zoom, Office 365, Google Drive, Readings Online) to one route: `read`, `save`, `link`, `on-home-link` or `never`. Unknown tabs are `never` and are listed in the run for the owner. Prompts receive only allowed URLs and the rule "open no other page", but the guarantee is that no job is given a disallowed URL.
- Why code, not prompt text: the navigation list is data; a fixed filter costs no tokens and cannot be forgotten.

**D5. Main job reads only the home page.** Output tool `course.map {jobId, courseKey, lms, ed, syllabus, links[]}`: what the LMS site is used for, what Ed holds, where the syllabus is (Canvas page, Ed or Handbook), and home-page links with a label and the route it falls under (a link into Pages or Files becomes allowed only through this list). Each statement carries a quote from the home page.

**D6. Routed jobs.** Each produces one tool call, then ends:
- Quiz page (one job per course): reads quiz list descriptions and availability text that the API does not hold (for example "Requires Respondus LockDown Browser", an exam window description), and flags surveys and practice quizzes; output `quizzes.read`.
- Assignment page (one job per Canvas assignment page with an unknown or changed AI statement): reads only the AI statement (#195) with a quote, then saves the page (Edge "Save as", single-file `.mhtml`) and downloads attachments without reading them; output `assignment.saved {policy, files[]}`.
- Saver (one job per course): opens the modules page, downloads each week's slides, records Lecture Capture and other link-only targets as links; output `materials.saved {files[], links[]}`.
- Ed: when `edstem` is on the PATH and `edstem auth status` succeeds, code runs it (`units`, `lessons`, `files get`) with JSON output and maps lessons with due dates to Ed items and their slides to the folder; otherwise one Ed job reads the Ed course list page and lesson titles with due dates. The code part of Ed assignments is not available from previews and is left to the Start flow.

**D7. Classification and the six categories (#202).** One classification job per course gets a compact list (item name, Canvas group name and weight, quiz flags, Handbook components) and returns, per item, a category among `exam`, `quiz`, `assignment`, `presentation`, `participation`, `ungraded` and the component it belongs to, with a quote or the group name as evidence. Code then applies the grading rule (#202): an item is graded if its Canvas group has weight > 0 or it maps, with evidence, to a Handbook component with weight > 0; a weight-0 group under a weighted component opens a `weight` conflict; an item with a hurdle keeps its category at weight 0; everything else becomes `ungraded` whatever the agent said. `ungraded` needs L2 like unknown kinds, because it can hide a written piece such as a for-feedback essay (#120). `ungraded` assessments are kept, excluded from the grade projection and from planning, and folded at the bottom of the course page (#192).
- Why the agent still classifies: names like "Token Use: Assignment 1 Extensions" need reading; why code has the last word on graded: the group weight is what Canvas itself grades with.

**D8. Code builds the course document.** `build-document.ts` turns skeleton, API values, course map, routed outputs and classification into the existing course document shape (components and items), then passes it through the existing `course.import` mapping (remainders, component Assessments, precedence, retirement). Agent-read fields carry their quotes; API fields carry `via: "api"` and the API URL as source. The "three submissions" loop disappears: a single classification retry is allowed when its output fails validation. Conflicts that remain (#208): `weight` (Handbook versus Canvas group weight, owner picks with `check.resolve`; until then the Canvas side wins when both are above 0, and the Handbook side when the Canvas group weight is 0, so a weighted component is never silently dropped) and `unmatched` (a graded Canvas item that maps to no component; owner dismisses or assigns).

**D9. Course folder and fingerprints (#204, #205).** Root `~/Desktop/<School> <YYSn>/` (`UniMelb 26S2` for 2026:S2), one subfolder per course named by the course name (code when the name is unknown, unsafe characters replaced), and inside it `assessments/<assessment name>/` and `materials/`. Files the jobs report are moved from `~/Downloads` by exact name and modification time after the job started; files not found are reported, not guessed. Each stored file gets a SHA-256 of its bytes (for `.mhtml`, of its decoded HTML body with `<script>` and inline timestamps removed) recorded per assessment. When a later sync's fingerprint differs, the old file is kept with a date suffix, the new one becomes current, and "needs you" shows "assessment content updated" until the owner opens it. The folder is the owner's; code never deletes in it.

**D10. Start reads the deep layer (#200).** The assessment drawer's Start button opens an agent conversation with a Start preset. For `quiz` the preset gives the quiz URL and the granted level (L1 needed, final submit never pressed, #173). Otherwise the agent calls `assessment.files {assessmentId}`, which extracts the text of the saved files (HTML text, PDF text via the existing `unpdf`), records each as a `material` SourceItem linked to the assessment, and returns the texts with their ids, saving first through one assignment-page job if nothing is saved; the agent records requirements and rubric points as annotations citing those SourceItems, so the existing citation check applies. Codex never reads the Desktop directly (its shell stays sandboxed).

**D11. Per-assessment AI policy (from C-5 D6).** `AssessmentAutonomy.policy(courseId, assessmentId?)` returns `{ value, origin, level }` by #197; the cap and `autonomy.read` use it per assessment; denials add `assessment-prohibited` when only the assessment's policy prohibits.

**D12a. Run bounds.** Each agent job is bounded at 10 minutes; the run is bounded at 20 minutes per selected course (at least 20), replacing the single 20-minute bound; a stopped run keeps every course already imported.

**D12. Parallelism (#206).** Routed jobs of one course may run in parallel up to `sync.parallel` (default 1), each told to open its own Edge window. The default stays 1 until the experiment (task 1.4) shows that parallel Codex computer-use jobs do not take each other's window or pointer.

**D13. Storage.** One additive migration: Assessment `kind` accepts the six categories (stored `ongoing` rows read as `participation`), `aiPolicy`, `unlockAt`; a `saved_files` table (assessment or course, path, fingerprint, savedAt, superseded); a `sync_conflicts` table for `weight` and `unmatched`. SourceItem facts gain `unlockAt`.

## Risks / Trade-offs

- [Student session refuses an include or `tabs`] → Probe first (task 1.1); fall back to the #193 URLs; tabs fallback is the agent listing the navigation once.
- [Handbook page text changes, the subject has no assessment table, or the bot protection also blocks the owner's Edge] → Skeleton is optional; Canvas groups alone still give weights.
- [`.mhtml` fingerprints change on every save (timestamps, tokens)] → Normalize before hashing; measure false "updated" notices in the live run (task 1.5).
- [Parallel computer use fights over one pointer] → Default 1; experiment before raising it.
- [`edstem-cli` changes its commands or output] → Called behind one adapter with a version check; the agent fallback stays.
- [Classification is wrong] → Code overrides graded/ungraded by weights; the owner can reclassify in the drawer (owner annotation of `kind`).
- [Downloads are matched to the wrong job] → Exact name and time window only; unmatched files are reported, never moved.
- [More agent jobs means more start-up overhead] → Measured per job; jobs are skipped when inputs are unchanged since the last sync (same API values and fingerprints).

## Migration Plan

Additive migration only. Existing assessments keep their values; `ongoing` reads as `participation`. Courses imported by the old reading job are updated in place by the next layered sync (same Course keys and item keys). The old reading prompt is removed with this change; there is no switch back. Rollback: older code ignores the new columns and tables.

## Open Questions

- Do `include[]=assignments&include[]=submission` and `/tabs` work for the student session, and what does Edge copy from a JSON page? (task 1.1)
- Can the owner create an Ed API token, and does `edstem-cli` return lessons with due dates for these courses? (task 1.2)
- Is the Handbook fetch by code acceptable (public page, no login)? Answered: approved by the owner (#213), but a plain fetch is blocked by bot protection, so the page is captured through the clipboard instead (#214). What does Edge copy from the assessment page (row separators, column order)? (task 1.3, now with Codex)
- Do parallel Codex jobs in separate Edge windows interfere? (task 1.4)
