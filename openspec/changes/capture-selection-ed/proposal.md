## Why

The current Canvas crawl includes unrelated courses and saves duplicate course-home snapshots when disabled tabs redirect. Assignments hosted only on Ed are missed; decisions [#50, #52–#54](../../../note/decisions.md) require selected-course capture from both sources now rather than deferring Ed to M1.

## What Changes

- On the first `c`, discover current-term Canvas and Ed courses, let the user tick them in the terminal, and persist their selection in the local data directory. Reuse it and provide explicit reselection (#50, #54).
- Crawl selected courses only; allow non-interactive capture using stored selection and return a clear agent-envelope error if selection is absent.
- Save each final Canvas URL once per crawl and record disabled-tab redirects in the summary, retaining the safety constraints from #43–#47.
- Capture Ed's own same-origin GET JSON responses for course discovery, lessons, assignment lessons and slides, bounded thread lists, and resources, using the browser profile's login (#52, #53). Never send `view=1`.
- Keep raw snapshots local, require removal of classmates' personal data before model access, and isolate Ed authentication expiry from Canvas capture.

## Capabilities

### New Capabilities

- `course-selection`: current-term discovery, terminal selection, local persistence, reselection, and no-TTY behavior.
- `ed-capture`: bounded same-origin JSON snapshots, session authentication, partial outcomes, and privacy boundaries.

### Modified Capabilities

- `page-capture`: selection-aware dual-source orchestration, shared limits, and Canvas final-URL deduplication. Its baseline is the unarchived `v1-foundation` delta, not yet `openspec/specs/`.

## Impact

- Future implementation affects `src/capture/`, CLI capture options, synthetic capture tests, and local selection/JSON snapshot files. Existing protocol codes and envelope helpers suffice; no dependency, SQLite migration, CI, or deployment change is proposed.
- Raw course data remains under the ignored `.local/` data directory (or the configured private `COURSEWORK_HOME`); nothing is uploaded or sent to a model by capture.
- This draft changes specs/docs only. Implementation and fresh-context reviews follow #48/#49. Archive this change only after `v1-foundation` has established `page-capture` in current-truth specs.
