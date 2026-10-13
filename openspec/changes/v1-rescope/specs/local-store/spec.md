## ADDED Requirements

### Requirement: Additive migrations keep local data
Migrations for this change SHALL only add tables and columns. The existing change-event table SHALL stop receiving writes but SHALL NOT be dropped or emptied, and no existing row SHALL be deleted or rewritten, so the owner's local database loses nothing. Dropping it later needs a separate owner decision.

#### Scenario: Upgrade a database with change history
- **WHEN** a synthetic database with change-event rows is migrated
- **THEN** the new tables exist, the old rows are still present and unchanged, and no new change rows are written by later syncs

## REMOVED Requirements

### Requirement: The store assigns change sequence numbers
**Reason**: Decision #101 removes change detection; sync writes only the latest state.
**Migration**: Existing rows stay in the database unread (see "Additive migrations keep local data").
