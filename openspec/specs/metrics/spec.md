# metrics Specification

## Purpose
TBD - created by archiving change v1-delivery. Update Purpose after archive.
## Requirements
### Requirement: Metrics come only from recorded data
A `metrics.read` command SHALL compute, for a chosen date range, the four PRD metrics (#133) from stored records only: (1) sync duration (median and maximum) and success rate per run from sync Runs: an agent sync run counts as successful when its `syncOutcome` is `OK`, runs ending `NEEDS_SELECTION` are left out of both counts, and historical API sync runs keep their per-provider rule; (2) annotation accuracy as `correct / (correct + incorrect)` over owner verdicts on agent annotations, counting each annotation once by its latest verdict in the range, with the number of labelled annotations; (3) estimate versus actual as the median and mean ratio of actual to effective estimate over items with both, with the item count; (4) agent steps, turns and cost per conversation, grouped by the assessment kind of its context. A metric without data SHALL be reported as unavailable with the reason, never as zero. Unknown costs SHALL be excluded from cost totals and counted separately. Metrics SHALL NOT be written to the repository; the README and resume may quote only values this command returns (AGENTS.md red line).

#### Scenario: No verdicts yet
- **WHEN** no owner verdicts exist
- **THEN** annotation accuracy is unavailable with reason `no_labels`

#### Scenario: Re-judged annotation
- **WHEN** the owner confirms an agent annotation and later replaces its value in the same range
- **THEN** accuracy counts that annotation once, as `incorrect`

#### Scenario: Estimate ratio
- **WHEN** two items have estimates 60 and 120 minutes and actual 90 and 120 minutes
- **THEN** the ratios are 1.5 and 1.0, the mean is 1.25 and the item count is 2

#### Scenario: Unknown cost
- **WHEN** one of three conversations has an unknown cost
- **THEN** the cost total covers two conversations and one is reported as unknown

#### Scenario: Sync success per run
- **WHEN** three sync runs ended `OK`, `PARTIAL` and `OK`
- **THEN** the sync success rate is 2/3 over 3 runs; a fourth run ending `NEEDS_SELECTION` changes neither count

