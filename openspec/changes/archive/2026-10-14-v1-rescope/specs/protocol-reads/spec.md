## REMOVED Requirements

### Requirement: Bounded paging never skips change evidence
**Reason**: Decision #101 removes the change stream, so there are no change cursors to page. Run reads keep reporting missing measurements as absent.
**Migration**: Agents read current state instead of changes. The `changes` command is removed.
