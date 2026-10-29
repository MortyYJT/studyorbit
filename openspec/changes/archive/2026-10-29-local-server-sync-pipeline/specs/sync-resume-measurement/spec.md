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
The fault-injection test SHALL, for each stage boundary, also run the same crash followed by a fresh full job (restart from scratch), and SHALL print per boundary the fake-model tokens, the collector and model call counts and the wall-clock duration of the uninterrupted job, the failed job, the resumed job and the fresh job, and the totals "failed + resume" and "failed + restart". `docs/sync-optimization.md` SHALL have a section with these results that is labelled as measured with a fake model and synthetic data, not a real run; states that fake-model token counts are not provider tokens and that the durations come from collectors and a model without latency; marks any figure derived from a real run as an estimate; and lists the limitations. A real-model measurement MUST NOT be run without the owner's authorisation.

#### Scenario: Fake measurement reported
- **WHEN** the measurement is copied into the documentation
- **THEN** the section says 「假模型、合成数据，不是真实运行」 and explains the fake-model token unit

#### Scenario: Resume saves the finished work
- **WHEN** the crash happens at the analyse→validate boundary
- **THEN** the "failed + resume" model tokens are lower than the "failed + restart" model tokens by the model tokens recorded in the analyse checkpoints that succeeded before the crash
