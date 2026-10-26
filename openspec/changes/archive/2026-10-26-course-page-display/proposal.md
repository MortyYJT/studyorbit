## Why

After the first real sync the owner found the course page hard to scan: items worth no marks sit among graded work, groups have no useful order, a score shows only a percentage, and the four-style score ring is hard to read. The owner chose the new display in #192.

## What Changes

- Order component groups by kind (ongoing, quiz, assignment, exam, then unknown) and items by due time, undated last.
- Collect assessments that carry no marks (effective weight 0) in one collapsed section at the bottom.
- Show `earned/possible · percent` (for example `4/5 · 80%`) when the linked platform item states both points.
- Draw the score ring in two colours on a recessed groove: earned yellow, everything else white. This replaces the #141 four-style ring.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `web-ui`: the "Course page" requirement changes its ring styles, adds ordering, the no-marks section and the points label. The in-progress change `canvas-check-item-policy` modifies the same requirement, so its delta is updated in the same PR to carry these rules too.

## Impact

- Code: `web/src/CoursePage.tsx`, `web/src/course.ts`, `web/src/style.css`, possibly `web/src/course-store.ts` to reach platform item points; tests under `test/web/`.
- Read contract: the `platform` object of `assessments.list` gains optional `pointsEarned` / `pointsPossible` (`src/protocol/contracts.ts`, `src/protocol/reads.ts` and its platform port). No storage, schema migration or dependency change.
