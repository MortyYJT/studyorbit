# coursework-sync Specification

## Purpose
TBD - created by archiving change v1-delivery. Update Purpose after archive.
## Requirements
### Requirement: Sync current-term courses into the local store
`coursework sync` SHALL attach to the resident browser and read, with same-origin GETs inside signed-in pages, Canvas `/api/v1` JSON for the owner's active current-term enrollments (courses, assignments, assignment groups, the owner's own submissions and scores, modules) and Ed JSON for active current-term courses through the `ed-capture` transport. It SHALL validate every response with zod, redact it (see "Redact before storing"), and write the latest state of courses, platform items and sync-derived assessments to the local store in one transaction per course. A `--course <code>` option SHALL limit the run to matching courses. It MUST NOT use a self-issued Canvas token, a bearer header, HTML parsing or a write method, and MUST NOT read other students' submissions.

#### Scenario: Two sources, one run
- **WHEN** synthetic Canvas and Ed responses for one current-term course are read
- **THEN** the store holds that course, its platform items with due dates and the owner's scores, and one run record with measured counts

#### Scenario: Limit to one course
- **WHEN** sync runs with `--course ABCD10001`
- **THEN** only that course's endpoints are requested

### Requirement: Merge Canvas and Ed courses by normalized course code
Sync SHALL derive a normalized code from each provider course by taking the single match of the pattern four capital letters followed by five digits (for example `ABCD10001` from `ABCD10001_2026_SM2`). A Canvas course and an Ed course in the same term with the same normalized code SHALL become one Course whose `sources` list both provider ids. A course with no match, or a code that matches more than one course on the same provider, SHALL stay a separate unmerged Course, and the run SHALL report the ambiguity. Merging MUST NOT use course names.

#### Scenario: Same code on both providers
- **WHEN** Canvas reports `ABCD10001_2026_SM2` and Ed reports `ABCD10001` in the same term
- **THEN** one Course exists with both provider sources, and items from both attach to it

#### Scenario: Ambiguous code
- **WHEN** Ed lists two active courses whose codes both normalize to `ABCD10001`
- **THEN** neither merges with the Canvas course, each stays its own Course, and the run reports the ambiguity

### Requirement: Record platform facts, never guessed structure
Sync SHALL store each gradable platform entry (Canvas assignment, Ed attempt lesson) as a SourceItem of kind `assignment` with platform facts copied from the response: due date (Ed `effective_due_at` when present, otherwise `due_at`), points possible, the owner's points and submitted state when the platform returns them. For a Canvas assignment group that has an explicit weight, sync SHALL create or update one sync-origin Assessment with that weight and link the group's assignments to it; the citation is the group's weight field. Sync MUST NOT divide a group weight across items, set a missing weight to zero, classify an item as exam or final, or set `assessmentsComplete`. Facts and assessments set by an annotation (see `agent-annotations`) MUST NOT be overwritten by sync, and sync MUST NOT re-link an item whose current link has origin `agent` or `owner`.

#### Scenario: Weighted Canvas group
- **WHEN** a synthetic Canvas group "Assignments" has `group_weight` 30 and two assignments
- **THEN** one sync-origin Assessment of weight 30 exists, both assignments are linked to it, and neither item carries its own weight

#### Scenario: Ed lesson without weight
- **WHEN** an Ed attempt lesson has a due date and no weight information
- **THEN** it is stored as a platform item with its due date, and no Assessment weight is invented

#### Scenario: Agent link survives sync
- **WHEN** the agent moved a Canvas assignment from its group's sync assessment to another assessment and sync runs again
- **THEN** the item stays linked where the agent put it

#### Scenario: Annotation survives sync
- **WHEN** an owner annotation set an assessment's weight to 10 and the next sync sees a Canvas group weight of 15
- **THEN** the stored weight stays 10 and the run reports the difference

### Requirement: Latest state only
Sync SHALL overwrite the stored platform state with the latest validated responses and SHALL NOT record change events (#101). An item missing from a complete read of its course collection SHALL be marked `removed` rather than deleted, so links and annotations keep their target. A partial read (auth expiry, cap, failure) MUST NOT mark anything removed.

#### Scenario: Item disappears in a complete read
- **WHEN** a complete synthetic assignments read no longer contains item 7
- **THEN** item 7 is marked removed and its links remain

#### Scenario: Partial read
- **WHEN** the Canvas session expires halfway through a course
- **THEN** no item of that course is marked removed and the run reports the gap

### Requirement: Redact before storing
Sync SHALL apply the deterministic default-on redaction (names harvested from author and people fields, emails, student numbers, phones, owner rules and a staff-name allow-list) to every text field before it is stored or can reach a model. Raw responses SHALL be kept only as private snapshots under `<data dir>/snapshots/`. Content whose safety cannot be established SHALL be withheld, never stored raw.

#### Scenario: Classmate name in an announcement
- **WHEN** a synthetic Ed thread author's name also appears in an assignment description
- **THEN** the stored description contains a redaction marker instead of the name, and only the private snapshot keeps the original

### Requirement: Bounded, measured, source-isolated runs
All sync requests SHALL share the `ed-capture` limiter (at least one second between attempts, 300 attempts per run, no automatic retries). Canvas and Ed failures SHALL be isolated: one provider's `AUTH_EXPIRED` stops only that provider. Each run SHALL record a Run with measured pages, requests, failures and per-source coverage, and return one bounded `coursework.agent/v1` envelope with per-source outcomes. Metrics MUST reflect actual operations.

#### Scenario: Ed expires, Canvas continues
- **WHEN** Ed returns 401 during a run
- **THEN** Ed reports `AUTH_EXPIRED`, Canvas finishes within the shared budget, and the Run records both outcomes

### Requirement: Sync is started by the owner and its state is visible
Sync SHALL run only when started: by `coursework sync` or by the frontend's sync button through the `sync.run` command (#128); there is no schedule. One sync SHALL run at a time; a second start while one runs SHALL return `LOCKED` without starting another. The last run per provider (time, outcome, counts) and the current sign-in state from `browser.status` SHALL be readable, so the frontend can say when data is stale and why. When a provider returns `AUTH_EXPIRED`, its previously stored data SHALL stay readable and SHALL be marked with the time of the last successful sync for that provider.

#### Scenario: Sync from the frontend
- **WHEN** the owner presses the sync button and the resident browser is signed in to Canvas and Ed
- **THEN** one sync run starts, the button shows it is running, and the frontend shows the new run's outcome when it ends

#### Scenario: Expired sign-in is not hidden
- **WHEN** Canvas returns `AUTH_EXPIRED` and Ed succeeds
- **THEN** Ed data updates, Canvas data stays as it was, and reads report Canvas as signed out with its last successful sync time

#### Scenario: Second start
- **WHEN** a sync is running and another start arrives
- **THEN** the second start returns `LOCKED` and no second run begins

