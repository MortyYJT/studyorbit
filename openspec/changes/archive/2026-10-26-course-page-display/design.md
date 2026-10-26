## Context

`web/src/course.ts` builds ring segments (`ringSegments`, styles earned / lost / ungraded / unknown) and groups assessments by component in list order (`groupAssessments`). `CoursePage.tsx` renders them. Scores are stored as percentages on Assessment; raw points live in the linked SourceItem `facts` (`pointsEarned`, `pointsPossible`).

## Goals / Non-Goals

**Goals:** the four #192 display rules, in light and dark themes, at default width and 390 px.

**Non-Goals:** the week view order; reading or storing more data; C-5's per-assessment locks (that change adds them later).

## Decisions

1. **Order groups, not a flat list.** The tab stays grouped by component (#171); a group's kind is its items' kind (the component kind when all agree, otherwise the first item's). Sorting inside the existing grouping keeps earned shares correct.
2. **No-marks means effective weight 0.** Unknown weight is not "no marks": it stays in place with its unknown label, because it may be worth marks.
3. **Points from platform facts.** Use the linked platform item's `pointsEarned` and `pointsPossible` only when both are present; never compute points from a percentage. `assessments.list` already returns a `platform` object per assessment (`linked`, `submitted`, `removed`); it gains optional `pointsEarned` and `pointsPossible`, taken from the linked platform item when exactly one linked item states both. This stays within the current `protocol-reads` requirement, which already lists platform item facts.
4. **Ring styles collapse to two.** Keep the segment model but map every non-earned style to white; the groove is the track colour behind the segments. The legend shows only earned and not earned.

## Risks / Trade-offs

- Lost marks and ungraded work look the same on the ring. The centre total, legend and the tab still show the difference; the owner chose simplicity (#192).
