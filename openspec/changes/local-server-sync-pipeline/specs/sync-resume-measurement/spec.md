## ADDED Requirements

### Requirement: Fault-injection test at every stage boundary
The test suite SHALL contain one test for each stage boundary — collect→analyse, analyse→validate, validate→merge, and merge→done (after the course file is written, before the merge checkpoint commits) — that runs a job over four synthetic courses with fake collectors and a fake model, crashes it at that boundary for the second course, re-opens the store, resumes the job, and checks that the Desktop files' bytes, the snapshot hashes, the course statuses and reasons, and the change-log lines (ignoring run ID and time) equal those of an uninterrupted run with the same fakes, and that the collector and model calls of the failed and resumed jobs together equal those of the uninterrupted run. Tests SHALL use synthetic data only.

#### Scenario: Crash after analysis
- **WHEN** the job crashes right after the analyse checkpoint of course 2 and is resumed
- **THEN** the resumed job makes no model call for courses 1 and 2, and the final output equals the uninterrupted run

#### Scenario: Crash after the file write
- **WHEN** the job crashes after merge wrote course 2's file and is resumed
- **THEN** course 2 has exactly one course file and no duplicate change-log line

### Requirement: Resume versus restart is measured and labelled
The repository SHALL provide `scripts/measure-sync-resume.mjs`, which, for each stage boundary, runs an uninterrupted job, a job crashed at that boundary followed by a resume, and the same crash followed by a fresh full job, and reports per job and as totals ("failed + resume", "failed + restart") the input, cached, output and reasoning tokens and the wall-clock duration. It SHALL write its results to `.local/measure/<time>/` with mode `0600` and SHALL refuse an output directory inside the Desktop. `docs/sync-optimization.md` SHALL gain a section with these results that states, next to the numbers, whether each was measured on a real run or with fake collectors and a fake model, that fake-model token counts are not provider tokens, and which durations are simulated. A real-model measurement MUST NOT be run without the owner's authorisation.

#### Scenario: Fake measurement reported
- **WHEN** the measurement runs with the fake model
- **THEN** the documentation section says 「伪造模型」 (fake model) for every token figure and lists the simulated latencies used

#### Scenario: Resume saves the finished work
- **WHEN** the crash happens at the analyse→validate boundary
- **THEN** the "failed + resume" model tokens are lower than the "failed + restart" model tokens by the model tokens recorded in the analyse checkpoints that succeeded before the crash
