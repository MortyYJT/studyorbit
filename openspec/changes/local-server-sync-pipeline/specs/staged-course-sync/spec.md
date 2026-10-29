## ADDED Requirements

### Requirement: Four stages per course with checkpoints
The sync SHALL process each selected course through the stages collect, analyse, validate and merge, in that order. Collect SHALL run the Canvas, Ed and Handbook collectors with today's arguments, limits and `unavailable` placeholders into the job's run directory; analyse SHALL run the model with the existing repair loop; validate SHALL run `validateAnalysis`, quote verification when available, and `settleCourse` with the newest valid earlier Desktop document; merge SHALL save the course file, record the course snapshot and run the post-save steps. Each stage SHALL record a checkpoint with its input hash (sha256 of its canonical inputs, including a per-stage version constant), status, output reference, attempts, usage, timing and error. Collect SHALL update its checkpoint after each source. Collection SHALL stay serial across courses; a course's later stages SHALL start once its collect succeeds.

#### Scenario: Checkpoints after a normal course
- **WHEN** a course finishes a sync
- **THEN** the store has `succeeded` checkpoints for collect, analyse, validate and merge, the collect checkpoint lists the three collected files with their sha256, and the analyse checkpoint has the model usage

#### Scenario: Invalid model reply is a result, not a stage failure
- **WHEN** the model reply is still invalid after the repair call
- **THEN** analyse and validate are `succeeded`, the course is `failed` with today's validation reason, and no course file is written

#### Scenario: Collector failure becomes a placeholder
- **WHEN** the Ed collector exits with code 1
- **THEN** collect writes the Ed `unavailable` placeholder, collect succeeds, and the course is at most `partial` with today's reason

### Requirement: Stage failures stop only the affected course
A stage SHALL fail only on an exception, a timeout, an I/O error, a temporary collector or model failure left after retries, a model call that ended with a non-zero exit after retries, cancellation or interruption. A failed stage SHALL record its error code, SHALL mark the course `failed` with a reason (the provider's error text for model failures, as today) and `stopped_stage`, and SHALL NOT stop other courses. A job stopped by cancellation SHALL end `cancelled`; otherwise a job with any stopped course SHALL end `failed`, and a job whose courses all reached a result SHALL end `finished`.

#### Scenario: Model throttled beyond the retry budget
- **WHEN** the model answers HTTP 429 on all three attempts for course 2 of 3
- **THEN** course 2 is `failed` with `stopped_stage: 'analyse'`, courses 1 and 3 are saved, and the job is `failed` and resumable

### Requirement: Resume from checkpoints
`POST /api/local/sync-jobs/<jobId>/resume` SHALL create a new job with `resumed_from` set to that job, its own run ID and run directory, and the same courses in the same order. A job SHALL be resumable only when it is `failed`, `cancelled` or `interrupted`, has no resumed child, was created less than 24 hours ago, and has a course whose merge stage has not succeeded; otherwise the route SHALL answer `409` with `NOT_RESUMABLE`, `ALREADY_RESUMED` or `RESUME_EXPIRED`, or `404 JOB_NOT_FOUND`. In the resumed job, a course whose merge succeeded anywhere in the lineage (the job and its `resumed_from` ancestors) SHALL be copied as done without running; for other courses each stage SHALL reuse a `succeeded` checkpoint from the lineage with the same idempotency key (course ID, stage, input hash) when its outputs still verify (collected files exist with the recorded sha256; stored outputs exist), and SHALL run otherwise, writing into the new job's run directory. Collect SHALL reuse verified sources individually. A sync started by the owner SHALL NOT reuse checkpoints of other jobs.

#### Scenario: Resume after an analysis failure
- **WHEN** a job failed in analyse for one course and is resumed
- **THEN** that course's collect is reused without running a collector, analyse runs, and the other courses are copied as done without collector or model calls

#### Scenario: Collected file changed
- **WHEN** a collected file of a stopped course was modified before the resume
- **THEN** its sha256 no longer matches, that source is collected again, and the later stages run again

#### Scenario: Model changed before resume
- **WHEN** the owner changes the analysis model after a failure and resumes
- **THEN** analyse runs again for courses not yet merged, because the analyse input hash includes the provider and model

#### Scenario: Fresh sync never reuses
- **WHEN** the owner starts a new sync of a course that was fully synced an hour ago
- **THEN** every stage runs again

#### Scenario: Old job
- **WHEN** the owner resumes a job created 25 hours ago
- **THEN** the route answers `409 RESUME_EXPIRED` and no job is created

### Requirement: Idempotent stages and jobs
Running a stage again with the same input hash SHALL have the same effects as running it once. Merge SHALL record the chosen output path in its checkpoint before writing, write with exclusive create, and, when the planned file already exists, treat equal content as done and different content as the stage error `MERGE_TARGET_CHANGED` without overwriting. Stage outputs SHALL be stored content-addressed. Each job SHALL write at most one usage line per course and SHALL NOT append a change-log line for a course twice. At most one course-sync job SHALL run at a time; starting or resuming while one runs SHALL answer `409 SYNC_RUNNING`.

#### Scenario: Crash after the course file was written
- **WHEN** the server dies after merge wrote `分数结构.json` but before its checkpoint committed, and the job is resumed
- **THEN** no second course file is written, the snapshot is recorded once, and the course is `completed` or `partial` as it would have been

#### Scenario: Planned file replaced
- **WHEN** the planned file exists with different content when merge runs again
- **THEN** merge fails with `MERGE_TARGET_CHANGED` and the file is unchanged

### Requirement: Cancellation and interruption
`DELETE /api/local/course-sync` SHALL keep today's effects (pending and running courses become `cancelled`; collectors' process groups are terminated, then killed after 5 seconds; model requests are aborted) and SHALL also end retry waits immediately, mark running stages and the job `cancelled`, and keep finished checkpoints. On startup, the server SHALL mark every job still `running` as `interrupted`, with its running stages and its pending and running courses. On `SIGINT` or `SIGTERM` the server SHALL stop running work as for cancellation, mark it `interrupted`, wait at most 5 seconds, close the database and exit. Cancelled and interrupted jobs SHALL be resumable.

#### Scenario: Cancel during a retry wait
- **WHEN** the owner cancels while the model limiter waits 8 seconds before a retry
- **THEN** the wait ends at once, no further model request is sent, and the job is `cancelled`

#### Scenario: Server killed mid-sync
- **WHEN** the server process is killed during a sync and started again
- **THEN** the job is `interrupted`, `GET /api/local/course-sync` reports it with `resumable: true`, and resuming it reuses the finished stages

### Requirement: Per-platform rate limiting and bounded retry
The sync SHALL limit each platform: Canvas, Ed and the Handbook to one collector at a time with at least 500 ms between starts, with Canvas and Handbook never overlapping; each model provider to four concurrent analyses. A task SHALL be retried only for a temporary failure: collector exit code 75, model HTTP 429, HTTP 5xx, or a connection error before a response. It SHALL make at most three attempts, wait `max(Retry-After, 2 s × 4^(n−2))` before attempt n, capped at 30 seconds, with ±20 % jitter, SHALL NOT wait for a `Retry-After` above 60 seconds, and SHALL wait at most 2 minutes in total per stage. Other HTTP 4xx, timeouts, aborts, incomplete model results, Codex CLI failures and invalid replies SHALL NOT be retried by the limiter. Usage reported for failed attempts SHALL be counted. Model analysis results SHALL expose `httpStatus` and `retryAfterMs`; collectors SHALL exit with code 75 when their last request failed with HTTP 429, HTTP 5xx or a network error.

#### Scenario: Throttled once
- **WHEN** the model answers HTTP 429 with `Retry-After: 3` and then succeeds
- **THEN** the second request is sent after at least 3 seconds and the course is saved normally

#### Scenario: Not retryable
- **WHEN** the model answers HTTP 401
- **THEN** no retry is made and analyse fails with the provider's error

#### Scenario: Concurrency cap
- **WHEN** six courses reach analyse at the same time
- **THEN** at most four model requests are in flight

### Requirement: Job status API and resume in the page
`GET /api/local/course-sync` SHALL keep its response shape (`running`, `courses` with `id`, `code`, `status`, `reason`, `phase`, `file`, and `error`), SHALL be built from the newest job in the store, and SHALL add `jobId`, `resumedFrom`, `resumable`, and per course `stage` and `reused`. `GET /api/local/sync-jobs` SHALL return the newest 20 jobs with their status, times, lineage, resumability and course statuses. `POST /api/local/sync-jobs/<jobId>/resume` SHALL follow the write checks of the other local routes. When the newest job is resumable, the sync dialog SHALL offer 「继续上次同步」, and courses copied from an earlier job SHALL be marked 「沿用上次结果」.

#### Scenario: Status survives a restart
- **WHEN** the server restarts after a finished sync
- **THEN** `GET /api/local/course-sync` returns that job's courses with `running: false`

#### Scenario: Resume from the dialog
- **WHEN** the newest job is `interrupted` and the owner clicks 「继续上次同步」
- **THEN** a resumed job starts and the dialog shows its progress

### Requirement: Injectable stage dependencies
The pipeline SHALL take its collector runner, model caller, model settings resolver, clock, limiters and hooks as constructor parameters. Hooks that simulate a crash before a stage, after a checkpoint, or after merge wrote the course file SHALL be settable only through that parameter, never through a route, environment variable or command-line flag.

#### Scenario: Production server has no hooks
- **WHEN** the server creates the pipeline
- **THEN** it passes no hooks, and no request can enable them
