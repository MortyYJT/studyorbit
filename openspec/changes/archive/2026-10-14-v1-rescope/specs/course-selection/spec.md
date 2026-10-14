## REMOVED Requirements

### Requirement: Discover selectable courses from both sources
**Reason**: Decision #100 cuts terminal course selection and discovery. Sync reads the owner's active current-term enrollments directly.
**Migration**: Use `coursework sync`, optionally with `--course <code>`; see `coursework-sync`, delivered by the `v1-delivery` change.

### Requirement: Persist and reuse terminal selection
**Reason**: There is no terminal selection to persist.
**Migration**: An existing selection file in `.local/` is ignored and left in place.

### Requirement: Explicit reselection preserves prior choices on cancellation
**Reason**: There is no terminal selection to repeat.
**Migration**: None.

### Requirement: Non-interactive capture uses stored selection and agent envelopes
**Reason**: Non-interactive capture is replaced by `coursework sync`, which returns its own agent envelope.
**Migration**: Agents call `coursework sync`.
