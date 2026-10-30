# Sync optimisation

How the sync went from "an agent reads web pages" to "code collects, one model call per course", with the measured numbers. Except for [Resume versus restart](#resume-versus-restart-fake-model-synthetic-data), every number comes from a real run record, named at the end of each section and reproduced in the [appendices](#appendix-a-stage-0-raw-record-2026-10-27); values that were not recorded are written "not recorded", never estimated. The resume section uses a fake model and synthetic data, and its estimates are marked.

## Result

Full sync of four courses (COMP20003, COMP20008, MAST10007, MUSI20163):

| Stage | Date | Approach | End-to-end time | Model input tokens | Model output tokens |
| --- | --- | --- | ---: | ---: | ---: |
| 0. Original project | 2026-10-27 | 33 Codex jobs, each opening its own Edge window and copying pages with computer use | 21 min | not recorded | not recorded |
| 1. v2 first version | 2026-10-28 | Per course one Codex coordinator job plus one gpt-6-luna subagent reading pages, serial | 17 min 19 s | 8,817,416 (cached 8,262,272) | 61,429 |
| 2. Code collection | 2026-10-28 | Code reads the Canvas API in a background Edge tab and Ed through the edstem CLI; one Luna subtask per course organises the data, in parallel | 206.4 s | 917,810 (cached 693,120) | 42,780 |
| 3. Single call | 2026-10-29 | Collection as in stage 2 plus the Handbook; one structured DeepSeek Flash call per course, in parallel | **116.5 s** | **44,269** (cached 20,224) | 36,740 (reasoning 23,130) |

From stage 0 to stage 3:

- Time: 21 min → 116.5 s, about **10.8×** faster (about 8.9× against stage 1).
- Model input: 8,817,416 → 44,269, about **199×** less (against stage 1; stage 0 was not recorded).
- Model output barely changed (61,429 → 36,740); DeepSeek's reasoning tokens are most of it.
- Canvas collection itself takes 2–6 s per course and no tokens.

## Why it got faster

1. **Code reads the data.** The Canvas API already returns courses, groups, assignments, deadlines, points and scores. In stages 0 and 1 the model read and transcribed page after page, resending the whole context at every step (94% of stage 1's input was cached input).
2. **No agent in between.** Stage 2 was still an agent that read files and spawned subtasks. Stage 3 is one API call whose input is the collected data and whose output follows a schema. Input fell by about 20× here, mostly from this change rather than from the model change.
3. **Serial collection, parallel analysis.** The browser does one thing at a time so tabs do not fight for focus; analysis runs in parallel, so the total is roughly the slowest course (COMP20003).

## Method

- Stage 3 time: in the usage log each course's `at` is its start and `durationMs` its time from collection to saving. End-to-end time = latest (start + duration) − earliest start. COMP20003 started first and finished last, so the result is its own 116.5 s. Clicking "Sync" and selecting courses are not included.
- Tokens are as reported by the provider. Input includes cached input and output includes reasoning; nothing is counted twice. Providers count and price differently, so **fewer tokens does not mean proportionally lower cost**.
- Sources: stage 0, [Appendix A](#appendix-a-stage-0-raw-record-2026-10-27); stages 1 and 2, [Appendix B](#appendix-b-stage-1-and-early-agent-runs-2026-10-28) and the hybrid-sync experiment (contains personal grades, kept only on the owner's machine); stage 3, the four records in the local `.local/lms/course-sync-usage.jsonl` that start at 2026-10-28T15:15–15:16Z (the first COMP20003 result, not its later re-run) and [Appendix C](#appendix-c-first-four-course-run-of-stage-3-2026-10-29).

## Stage 3 usage log

The four raw records from the local `.local/lms/course-sync-usage.jsonl`, keeping only time and token fields (`at` is the course's start in UTC; `durationMs` is collection to saving; tokens come from DeepSeek's `usage`). `partial` is because one COMP20003 grade API call returned 403.

| Course | `at` (UTC) | Duration | Canvas | Ed | Handbook | Analysis | Input | Cached | Output | Reasoning | Status |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| COMP20003 | 2026-10-28T15:15:54.023Z | 116,475 ms | 5,993 ms | 19,588 ms | 3,915 ms | 86,978 ms | 30,376 | 14,464 | 19,309 | 10,197 | partial |
| COMP20008 | 2026-10-28T15:16:23.519Z | 32,786 ms | 4,135 ms | 4,863 ms | 1,869 ms | 21,918 ms | 5,203 | 1,920 | 4,751 | 3,221 | completed |
| MAST10007 | 2026-10-28T15:16:34.386Z | 46,513 ms | 2,785 ms | 353 ms | 2,312 ms | 41,062 ms | 4,445 | 1,920 | 8,236 | 6,719 | completed |
| MUSI20163 | 2026-10-28T15:16:39.836Z | 26,613 ms | 3,119 ms | 174 ms | 1,886 ms | 21,433 ms | 4,245 | 1,920 | 4,444 | 2,993 | completed |
| **Total** | | | | | | | **44,269** | **20,224** | **36,740** | **23,130** | |

Model `deepseek-flash`; each record has exactly one model call (`coordinator`) and no subtasks (`subagents` is null).

## Resume versus restart (fake model, synthetic data)

The staged sync (`local-server-sync-pipeline`) splits each course into collect → analyse → validate → merge and writes a checkpoint to `.local/studyorbit.db` after each stage. A sync that stops can be continued ("Continue last sync", resume) or all courses can be synced again (restart). This section compares what each costs; the requirement is `openspec/specs/sync-resume-measurement/`.

**Every number in this section comes from a fake model and synthetic data, not a real run.** No real collection was run and no real model was called.

### How it was measured

- Test `test/sync-faults.test.ts`, run with `NODE_DEBUG= npx vitest run test/sync-faults.test.ts --silent=false`; the test prints this section's numbers when it finishes.
- Four synthetic courses (course IDs 900001–900004), fake collectors (one Canvas, Ed and Handbook call per course, writing synthetic files) and a fake model (returning synthetic results). Course 3's first analysis deliberately returns an invalid result and needs one repair, so a full sync is 12 collections and 5 model calls.
- At each stage boundary, after course 2 finishes that stage and records its checkpoint, a process crash is simulated (`SimulatedCrash`). Course 1 is then complete and courses 3 and 4 have not started. At the merge boundary the crash comes after the course file is written and before the checkpoint is committed.
- Three runs per boundary: **uninterrupted** (one full run); **fail + resume** (crash, reopen the database, resume in a new job); **fail + restart** (same crash, then a new full sync of all courses).
- The test asserts that a resumed run's result (Desktop file bytes, snapshot hashes, course status and reasons, change log) is identical to the uninterrupted run, not only that the numbers match.
- Run 5 times on 2026-10-30 on the machine in [Environment](#environment) (Node.js 24.19.0). Tokens and call counts were identical in all 5 runs; durations are given as the range.

### Units

- **Fake-model tokens:** each call counts ceil(prompt characters ÷ 4) + ceil(reply characters ÷ 4); cached and reasoning tokens are always 0. These are not any provider's tokens and cannot be turned into cost. Synthetic courses are similar in size (courses 1 and 2 are 2,949 units per analysis); real courses differ a lot (stage 3 input ranged from 4,245 to 30,376).
- **Calls:** written "collections / model". One collection is one source for one course.
- **Duration:** wall-clock milliseconds on this machine. The fake collectors and model never wait, so this measures only the pipeline's own overhead (hashing, SQLite reads and writes, file checks), not a real sync.

### Results

Fake-model tokens (failed job + the job that follows):

| Crash boundary | Uninterrupted | Failed job | Resume | Restart | Fail + resume | Fail + restart | Extra for restart |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| collect → analyse | 13,885 | 2,949 | 10,936 | 13,885 | 13,885 | 16,834 | 2,949 |
| analyse → validate | 13,885 | 5,898 | 7,987 | 13,885 | 13,885 | 19,783 | 5,898 |
| validate → merge | 13,885 | 5,898 | 7,987 | 13,885 | 13,885 | 19,783 | 5,898 |
| merge → done (file written, checkpoint not committed) | 13,885 | 5,898 | 7,987 | 13,885 | 13,885 | 19,783 | 5,898 |

Calls (collections / model):

| Crash boundary | Uninterrupted | Failed job | Resume | Restart | Fail + resume | Fail + restart |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| collect → analyse | 12 / 5 | 6 / 1 | 6 / 4 | 12 / 5 | 12 / 5 | 18 / 6 |
| analyse → validate | 12 / 5 | 6 / 2 | 6 / 3 | 12 / 5 | 12 / 5 | 18 / 7 |
| validate → merge | 12 / 5 | 6 / 2 | 6 / 3 | 12 / 5 | 12 / 5 | 18 / 7 |
| merge → done | 12 / 5 | 6 / 2 | 6 / 3 | 12 / 5 | 12 / 5 | 18 / 7 |

Duration (ms, range over 5 runs, zero-latency fakes):

| Crash boundary | Uninterrupted | Failed job | Resume | Restart |
| --- | ---: | ---: | ---: | ---: |
| collect → analyse | 22–23 | 5 | 8 | 10 |
| analyse → validate | 10 | 5 | 6–7 | 9 |
| validate → merge | 9–11 | 5 | 6 | 9–10 |
| merge → done | 10 | 5 | 6 | 8–9 |

How to read them:

- At every boundary "fail + resume" equals the uninterrupted run exactly: no finished collection or analysis was redone.
- "Extra for restart" equals what the failed job had already spent: at collect → analyse only course 1 had been analysed (2,949); at later boundaries courses 1 and 2 had (5,898). Validation and merging call no model, so the last three boundaries have the same tokens.
- At merge → done the saving is more than tokens: resume sees the file already written as planned, so it writes no second file and appends no second change entry (the test asserts course 2 has exactly one new file and one change entry).
- The 22–23 ms of the first uninterrupted row is the first run in the test file and includes warm-up; the others are about 10 ms. Millisecond differences are mostly fixed overhead and noise and say nothing about resume being faster or slower.

### Applied to the real run (estimate, not a measurement)

These tables apply "which steps need no redo" to stage 3's real per-course numbers (2026-10-28 UTC, which was 10-29 in Melbourne; start order COMP20003, COMP20008, MAST10007, MUSI20163). **They are estimates**: they assume a redone step costs what it cost in that run, and every run differs.

Following the test scenario, with course 1 complete at the crash:

| Where it stops | Extra model tokens for restart (estimate) | Extra collection time for restart (estimate) |
| --- | --- | --- |
| Course 2 collected, not analysed (collect → analyse) | Course 1's analysis: input 30,376, output 19,309 | Courses 1 and 2 collection: 29.5 s + 10.9 s ≈ 40.4 s |
| After course 2's analysis (later boundaries) | Courses 1 and 2 analysis: input 35,579, output 24,060 | Same, about 40.4 s |

The real run's timeline differs: course 1 (COMP20003) analysed for 87.0 s and finished last (about 15:17:50 UTC). When course 2 finished collecting (about 15:16:34) and analysing (about 15:16:56), course 1 was still analysing; a crash then leaves that analysis without a checkpoint, so resume would redo it too. On that timeline:

| Where it stops | Extra model tokens for restart (estimate) | Extra collection time for restart (estimate) |
| --- | --- | --- |
| Course 2 collected, not analysed | 0 (both approaches redo course 1's analysis) | Courses 1 and 2 collection, about 40.4 s |
| After course 2's analysis | Course 2's analysis: input 5,203, output 4,751 | All four courses' collection, about 51.0 s (courses 3 and 4 were collected by about 15:16:40 and 15:16:45) |

- Collection costs no tokens but is slow: that run's serial collection of four courses took about 51.0 s in total (Canvas + Ed + Handbook per course), 29.5 s of it for COMP20003 alone (Ed 19.6 s).
- All tokens are in analysis: the four analyses took 21.4–87.0 s each and used all 44,269 input and 36,740 output tokens. They ran in parallel, so saved analysis time cannot simply be added to the end-to-end time; no end-to-end estimate is given.
- So what resume saves depends on where the sync stops: in an early course's collection it mainly saves time; after analysis it mainly saves tokens.

### Limits

- No real sync was measured. A real resume goes through the signed-in browser and real course data and cannot run unattended; measuring with DeepSeek was not authorised (decision #245 covered only the evaluation), see decision #350.
- The crash points were chosen so that no other collection or model call was in flight. In a real interruption the call in flight is redone on resume, so the extra cost is larger than in the tables.
- Synthetic courses have similar fake token counts, while real courses differ by more than 7× (input 4,245 to 30,376), so the ratios do not carry over to real runs.
- Only one course mix (4 courses, crash at course 2). In general the later the crash, the more finished work resume saves over restart; that was not measured separately.
- Durations exclude reopening the database and starting a new process, and no network or model latency was simulated (the planned "simulated latency" set was not run, decision #435).

## Environment

Stages 0 to 3 ran on the same machine:

| Item | Value |
| --- | --- |
| Chip | Apple M5 |
| Memory | 24 GB |
| System | macOS 26.6.2 (25G83) |
| Browser | Microsoft Edge 156.0.4314.50 |
| Node.js | 24.19.0 |

System, Edge and Node versions were read on 2026-10-30; the run days did not record versions and automatic updates may have happened in between.

## Limits (be able to explain these in an interview)

- Each stage had only one full run, with four courses and one student account. It does not show the same stability on other courses.
- The stages read different scopes: stage 1 read the teaching material list and stage 3 did not, but stage 3 added the Handbook. The comparison is "a full sync of the same courses", not the same amount of work.
- Faster is not more accurate. Stage 3 still had known errors: the COMP20003 A3 grade API returned 403; the first analysis wrote A1's score wrong until Ed data was joined by lesson ID; the model sometimes took points for weights. Accuracy was checked by hand for the four courses, without an automated accuracy metric at the time (see [Course analysis evaluation](eval-course-analysis.md) for the later one and its limits).
- In both stage 0 runs Canvas was not read for any of the four courses (recorded as `absent`), see [Appendix A](#appendix-a-stage-0-raw-record-2026-10-27).
- Stage 0 was the owner's own earlier design; part of the gain corrects that design rather than an external bottleneck.
- Only run on macOS + Edge.

Questions to expect:

- Why 21 minutes at first? The university does not let students issue their own Canvas token, so the first design had an agent read pages. Later it turned out that same-origin API calls work inside the signed-in browser, so no agent needs to read pages.
- How do you know the result is right? At the time, by checking each course by hand and recording known errors. Since then: code-generated stable IDs, an offline evaluation with repeated runs, and quote verification (see the evaluation documents); the gold answers there are still not human-verified.
- 199× fewer tokens, 199× cheaper? No. Providers and unit prices differ, and cached input is priced differently.

## Appendix A: stage 0 raw record (2026-10-27)

The source of stage 0. Personal data removed: no grades, Canvas course numbers, internal course IDs, accounts or local paths.

**Original text.** From the proposal of the v1 OpenSpec change `extension-course-list` (first paragraph of "Why", unchanged):

> The last full sync (2026-10-27) took 21 minutes for four courses: 33 separate Codex jobs, each starting its own agent, opening and closing its own Edge window, and copying the page through computer use. The course list job alone cost about 200,000 input tokens and 4 computer-use steps. A layer-0 experiment on the owner's signed-in Edge read the same Canvas course list through a small browser extension in 233 ms (fetch) plus 2 ms (parse), with no model and no tab (decision #219).

The v1 code and that change were moved off the main branch (decision #223) and are kept only locally.

**Timeline.** From the v1 local database table `sync_jobs`: the two full four-course syncs of 2026-10-27 whose result was `OK` (the 9 earlier jobs with 0 courses, each under a minute, were empty runs and are not counted). Times are UTC; "done" is when each course's result was saved.

| | First | Second |
| --- | --- | --- |
| Start | 05:04:08.6 | 09:27:07.2 |
| COMP20003 done | 05:08:24.4 (+4 min 16 s) | 09:32:18.6 (+5 min 11 s) |
| COMP20008 done | 05:12:53.5 (+8 min 45 s) | 09:36:27.1 (+9 min 20 s) |
| MAST10007 done | 05:20:17.3 (+16 min 09 s) | 09:41:09.5 (+14 min 02 s) |
| MUSI20163 done | 05:25:13.7 (+21 min 05 s) | 09:47:36.6 (+20 min 29 s) |
| End | 05:25:13.7 | 09:47:36.6 |
| **Total** | **21 min 05 s** | **20 min 29 s** |

The four courses ran serially, about 4 to 7.5 minutes each.

**Caveats.** In both runs the Canvas column was `absent` (not read) for all four courses, and MUSI20163's Ed was `absent` too, so these 21 minutes did not produce complete data: later stages are compared on "finishing a sync", not on "getting the same data". The database recorded no tokens; "about 200,000 input tokens for the course list" comes only from the text above, and the total for the 33 jobs was not recorded.

## Appendix B: stage 1 and early agent runs (2026-10-28)

Per-course token usage as reported by the subtasks. Input includes cached input and output includes reasoning output. These are model usage, not cost or account quota. Unknown values are "unknown", never zero. No grades, cookies or personal data.

**Single-course agent runs:**

| Course | Model | Input | Cached | Output | Reasoning | Total | Time | Result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| COMP20003 first run | gpt-6-luna | 1,301,887 | 1,220,352 | 9,050 | 1,294 | 1,310,937 | about 3 min 23 s | Partial: Canvas read, Ed did not load |
| MAST10007 first run and wrap-up | gpt-6-luna | 2,664,937 | 2,575,616 | 9,298 | 2,362 | 2,674,235 | first round about 5 min 40 s, plus two wrap-ups | First round stopped on repeated downloads; JSON written from what had been read |
| COMP20008 first run | gpt-6-luna | 741,326 | 713,728 | 2,193 | 579 | 743,519 | about 1 min 22 s | Canvas navigation failed twice; course not read; nothing downloaded |
| MUSI20163 first run | gpt-6-luna | 1,559,370 | 1,507,840 | 6,035 | 1,743 | 1,565,405 | about 3 min 39 s | Canvas assessments and visible material list read; nothing downloaded |
| COMP20003 Ed supplement | gpt-6-luna | 699,935 | 674,688 | 3,127 | 504 | 703,062 | about 2 min 9 s | Clicked from the Ed home page into the course and read the 42-item lesson list; nothing downloaded |

These five rows total 6,967,455 input (6,692,224 cached), 29,703 output, 6,997,158 tokens. They include MAST10007's interrupted run and wrap-ups, COMP20008's failed attempt and COMP20003's two reads, and exclude the coordinating agent and other turns not listed. COMP20003, COMP20008, MUSI20163 and the Ed supplement are each the subtask session's cumulative `token_count` when its first task finished, excluding later follow-up turns. MAST10007 covers the interrupted first run plus the two turns that explained and saved the JSON; at the interruption it stood at 2,050,455 input (1,968,768 cached) and 3,298 output (1,450 reasoning), and the rest went into explaining the downloads and saving what had been read. The owner then decided that no files are downloaded and a failing operation is tried at most twice. Times come from the task logs and are not end-to-end sync times. The subtask session IDs are in the history of the former `docs/sync-measurements.md` (`git show 24621e3:docs/sync-measurements.md`). COMP20003's first run opened the Ed lessons address directly and tried through Canvas's Ed link, without clicking the Ed course card; both attempts stayed on the loading animation, so Ed content was not confirmed (the Ed supplement row then clicked the course card from the Ed home page). COMP20008's run did not read the course and its JSON recorded only the failure, which does not count as a successful sync. MUSI20163 recorded the visible material hierarchy without claiming to have read every file; its syllabus and Canvas deadlines disagreed and were left to check.

**Stage 1: four courses from the front end.** Started from the front end on 2026-10-28, serial. Per course, the coordinator job's and its subagent's input / cached / output tokens; time is the project's recorded task duration.

| Course | Time | Status | Coordinator input / cached / output | Subagent input / cached / output |
| --- | --- | --- | --- | --- |
| COMP20003 | 4 min 05 s | Partial | 185,815 / 132,608 / 1,010 | 1,911,438 / 1,822,592 / 13,206 |
| COMP20008 | 5 min 02 s | Partial | 124,143 / 101,888 / 672 | 2,503,962 / 2,387,456 / 15,553 |
| MAST10007 | 4 min 28 s | Completed | 103,364 / 86,656 / 610 | 1,841,075 / 1,705,728 / 15,141 |
| MUSI20163 | 3 min 44 s | Partial | 155,760 / 121,984 / 1,130 | 1,991,859 / 1,903,360 / 14,107 |

Total task time about 17 min 19 s; coordinators and subagents together used 8,817,416 input (8,262,272 cached) and 61,429 output tokens. Source: the local `.local/lms/course-sync-usage.jsonl`, these four run records. Statuses are as reported by the program and agents and were not checked field by field. COMP20003's report listed assignment bodies, rubrics and attachments as "not obtained", as instructed, and so marked itself partial; out-of-scope items alone should not make a run partial. True failure, unknown, conflict and skipped-by-design need to be told apart.

**Second full front-end sync (stability).** After clearing test data and fetching the four courses again; the log is the four records after that baseline.

| Course | Time | Status | Observation |
| --- | ---: | --- | --- |
| COMP20003 | 4 min 41 s | Completed | 25 items; A2's score was not read this time; the exam was a 55% parent this time but separate mid-semester and final items last time. Which is right needs checking against the source. |
| COMP20008 | 3 min 02 s | Completed | A1 15%, A2 35%; a final exam item for this semester was created with `null` weight and date; the workshop bonus kept. |
| MAST10007 | 2 min 49 s | Completed | Read the final exam time and four 3.75% sub-items; more complete than last time. |
| MUSI20163 | 2 min 41 s | Failed | The raw reply had full course data and passed the schema, but `course.id` was `canvas:237718` instead of the expected `237718`, so the identity check refused to save it. |

About 13 min 14 s in total; coordinators and subtasks used 7,555,095 input (7,119,104 cached), 64,907 output and 29,318 reasoning tokens (reasoning is the provider's sub-count and is not added again). COMP20003 went from 149 s last time to 281 s.

**General problems these runs exposed** (all addressed later by the v2 contract, stable IDs and the staged sync):

- Native schema constrains the format, not the model's judgement or consistency across runs: grouping, how deep sources are read, actual scores and IDs varied. Two conflicting results must not be resolved without going back to the source.
- The top-level course ID format was not constrained, so MUSI20163 was read but rejected, and the failure did not say the IDs differed.
- Item IDs changed platform and format between runs (the same Canvas group as `canvas:group-691098` and `canvas:691098`), so corrections keyed by ID could lose their owner after a resync.
- The newest valid file wins, so a missing field in a new run could replace information read earlier; an incremental merge by source and stable ID, with conflict handling that never overwrites user corrections, was needed.
- Grouping was unstable (COMP20003's exams as separate items or under a parent), which affects display and grade totals; the same assessment and group weight must never be counted twice.
- A model saying `completed` does not mean the fields are complete or correct. Token logs came from Codex sessions; when a subagent's usage is missing it must be recorded as `null`, and whether a course was read must not be judged from whether its token log is readable.

## Appendix C: first four-course run of stage 3 (2026-10-29)

DeepSeek Flash with the Responses API's native schema; four courses selected in the front end; Canvas, Ed and Handbook collected serially and analysed in parallel. No course files downloaded. Personal courses, grades and raw model data stay in ignored local folders or the Desktop course folders.

| Course | Sources and result | Total per course | Analysis | Input / output tokens |
| --- | --- | ---: | ---: | ---: |
| COMP20003 | Ed A3 grade returned 403; partial | 116.5 s | 87.0 s | 30,376 / 19,309 |
| COMP20008 | All three sources read; saved | 32.8 s | 21.9 s | 5,203 / 4,751 |
| MAST10007 | Canvas and Handbook read; Ed lesson list empty; saved | 46.5 s | 41.1 s | 4,445 / 8,236 |
| MUSI20163 | Canvas and Handbook read; no Ed course found; saved | 26.6 s | 21.4 s | 4,245 / 4,444 |

The analyses ran in parallel, so the four totals must not be added as the user's waiting time. Model and source parsing have separate defects; a finished run does not mean every field is right.

- COMP20003: the first result wrote Ed A1's score wrong. After joining the Ed lesson list and grades by lesson ID before analysis, and checking numerator and denominator from the same source when an item maps to one Ed source and has no matching Canvas grade, a second collection and analysis read A1, A2 and A3's maximum (15); A3's actual score was still missing because of the 403. Weights: assignments 40%, workshops 5%, mid-semester test 10%, final exam 45%. The second run took 119.8 s (analysis 111.6 s), 12,940 input and 21,200 output tokens. It no longer listed Canvas's "All 12 Workshops Completed" 0.04-point item separately, which still needs checking. Not every cross-platform grade error can be claimed solved.
- COMP20008: A1 15%, A2 35%, final 50%; workshop bonus capped at 2. The model recorded hurdles for continuous assessment and the exam.
- MAST10007: written assignments 15%, mid-semester test 10%, computer lab test 15%, final 60%; four assignment sub-items at 3.75% each. The owner confirmed the equal split here and the COMP20008 exam figure; that confirmation does not extend to other courses.
- MUSI20163: class participation 50%, two performances 35% together, essay 15%, with attendance and submission hurdles. The Handbook was read; no Ed course is not a sync failure.

The five real model calls used 57,209 input tokens (21,120 cached) and 57,940 output tokens (40,743 reasoning); cached and reasoning tokens are included in the totals. Cancellation, model refusal, complex cross-source conflicts, automatic updates and other platforms were not fully verified at the time.
