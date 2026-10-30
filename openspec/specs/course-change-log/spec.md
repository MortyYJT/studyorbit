# course-change-log Specification

## Purpose
After each sync, due date and weight changes between successive course documents are found by stable ID, appended to `.local/lms/changes.jsonl`, and shown on the page until the owner dismisses them. Scores are never logged.
## Requirements
### Requirement: Snapshot diff by stable ID
The system SHALL provide a pure `diffSnapshots(previous, current)` that reads both course documents (version 1 or 2) through the display conversion, pairs each previous assessment with the current assessment of the same ID or, when present, the current assessment named by `current.legacyIds[previousId]`, and reports a change `{ assessmentId, name, field, before, after }` for every pair whose `due` or `weight` differs. Due values that both parse as full date-times SHALL be compared as instants; weights SHALL be compared to two decimal places; a value becoming or ceasing to be `null` SHALL count as a change. Assessments without a pair (added or removed) SHALL NOT be reported, and no other field (in particular no score) SHALL be reported. Changes SHALL be ordered by current document order, `due` before `weight`, and `name` SHALL be the current name.

#### Scenario: Due date moved
- **WHEN** `canvas:5551` has due `2026-11-03T12:59:00Z` in the previous document and `2026-11-10T12:59:00Z` in the current one
- **THEN** one change `{ assessmentId: 'canvas:5551', field: 'due', before: '2026-11-03T12:59:00Z', after: '2026-11-10T12:59:00Z' }` is reported

#### Scenario: Same instant, different notation
- **WHEN** the previous due is `2026-11-10T12:59:00Z` and the current due is `2026-11-10T23:59:00+11:00`
- **THEN** no change is reported

#### Scenario: Weight cleared
- **WHEN** an assessment's weight goes from 20 to `null`
- **THEN** a `weight` change from 20 to `null` is reported

#### Scenario: Paired through legacy IDs
- **WHEN** the previous v1 document has `a1` with weight 20, and the current v2 document has `canvas:5551` with weight 25 and `legacyIds` `{ a1: 'canvas:5551' }`
- **THEN** a `weight` change from 20 to 25 is reported for `canvas:5551`

#### Scenario: Score change is not reported
- **WHEN** only an assessment's score and status change
- **THEN** no change is reported

#### Scenario: Added and removed assessments
- **WHEN** the current document adds `canvas:5560` and drops `canvas:5552`
- **THEN** neither is reported

### Requirement: Changes are appended to the change log after each sync
After the sync runner saves a course file, it SHALL diff the newest valid earlier document of the same course against the saved document and append one JSON line per change to `.local/lms/changes.jsonl` (file 0600, directory 0700) with `at`, `runId`, `courseId`, `assessmentId`, `name`, `field`, `before` and `after`. No line SHALL be written when there is no earlier document or no change. A failure to append SHALL add 「变更记录写入失败。」 to the course reason without changing the course status. The log MUST NOT contain scores or maximum scores.

#### Scenario: Re-sync moves a deadline
- **WHEN** a course is re-synced and one assessment's due date changed
- **THEN** exactly one line with `field: 'due'` and that run's `runId` is appended

#### Scenario: First sync of a course
- **WHEN** a course is synced for the first time
- **THEN** nothing is appended

#### Scenario: Incomplete sync
- **WHEN** a re-sync of a course is `incomplete` because a source could not be collected
- **THEN** no course file is saved and nothing is appended, so a missing source never shows up as a changed deadline or weight

#### Scenario: Log cannot be written
- **WHEN** appending to the change log fails after the course file was saved
- **THEN** the course keeps its status and its reason ends with 「变更记录写入失败。」

### Requirement: The page reminds the owner of unseen changes
The system SHALL serve `GET /api/local/course-changes` (loopback, same-origin) returning the newest 200 well-formed change-log lines, newest first, skipping malformed lines and returning an empty list when the log does not exist. The page SHALL treat a change as unseen when its `at` is later than the localStorage marker `coursework.course-changes-seen.v1`, and SHALL show unseen changes of courses in the course list in the week page's 「需要你处理」 list and at the top of that course's page, as the course code, assessment name, field and the values before and after (an empty value shown as 「未知」). 「知道了」 SHALL set the marker to the newest `at` shown, after which those changes are no longer shown.

#### Scenario: Reminder after a sync
- **WHEN** a sync logs that `SYNT10001` Assignment 1's weight changed from 20 to 25 and the owner opens the page
- **THEN** the 「需要你处理」 list shows 「SYNT10001 Assignment 1：权重 20% → 25%」

#### Scenario: Dismissed
- **WHEN** the owner clicks 「知道了」 and reloads the page
- **THEN** that change is not shown again, and a change logged by a later sync is shown

#### Scenario: Malformed line
- **WHEN** the log has a line that is not valid JSON between two valid lines
- **THEN** the API returns the two valid changes

