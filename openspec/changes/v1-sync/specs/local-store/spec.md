## MODIFIED Requirements

### Requirement: The store assigns change sequence numbers
Recording a Change SHALL assign it a `seq` one greater than the largest stored committed `seq` (starting at 1), inside the same transaction as the current-state upsert/deletion that caused it. Listing changes since a `seq` SHALL use an exclusive lower bound and return ascending seq values. Events SHALL be append-only in `change_event`; committed cursors MUST NOT reset/reuse after restart or entity removal. Migration from `changes` SHALL preserve historical seq and evidence while translating kinds into design-approved operations. Rolled-back transactions MUST NOT expose their events/cursors.

#### Scenario: Sequence numbers increase
- **WHEN** two changes are recorded one after another
- **THEN** the second has a larger `seq` than the first, and listing since the first returns only the second

#### Scenario: Restart and migration preserve cursor
- **WHEN** a synthetic database with committed seq 12 is migrated/reopened and a current entity is removed
- **THEN** previous events remain readable and the next committed event has seq 13

### Requirement: Writes validate before storing
The repository SHALL parse every entity with its domain schema before writing and MUST reject invalid entities without a partial write. Sync reconciliation SHALL compare against current state and publish current-state upserts/deletions plus their validated redacted events atomically under a write transaction. Complete-scope evidence SHALL gate deletion; omitted/failed scopes remain unchanged. Only `src/store/` SHALL execute SQLite writes. A failed entity/event write SHALL roll back the whole affected publication batch without advancing a visible cursor; run failure evidence SHALL remain separately recordable.

#### Scenario: Rejected write leaves no trace
- **WHEN** a batch of three tasks where the third is invalid is saved
- **THEN** the save fails and none of the three tasks is stored

#### Scenario: Atomic deletion and event failure
- **WHEN** synthetic reconciliation removes one row and upserts another but event validation/insertion fails
- **THEN** both current-state changes roll back, no event appears and the committed cursor is unchanged

#### Scenario: Concurrent reconciliation
- **WHEN** two synthetic writers reconcile the same normalized state
- **THEN** comparison against transactional current state prevents duplicate updates and both observe one consistent committed state/event history

## ADDED Requirements

### Requirement: Migrate without discarding unsupported historical data
M1 migrations SHALL retain ordered migration/version checks and historical entity/run/event records. Removing iCal SHALL preflight legacy `ical` rows before modifying the database; if present, migration SHALL stop with sanitized owner guidance for a retention/removal decision rather than silently deleting, relabeling or accepting invalid rows. Failed migration SHALL preserve the previous database. Rollback SHALL preserve private artifacts and history; older binaries SHALL refuse newer database versions rather than destructively downgrade them.

#### Scenario: Legacy iCal row
- **WHEN** a synthetic pre-M1 database has an iCal SourceItem
- **THEN** upgrade stops before changes, preserves the database and asks for an explicit retention/removal decision

#### Scenario: Compatible upgrade
- **WHEN** a synthetic database has supported providers, historical runs and specialized change kinds
- **THEN** migration preserves entities, runs and seq values without fabricating coverage or dropping history
