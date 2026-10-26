## MODIFIED Requirements

### Requirement: Course page
A course page SHALL show the course's AI policy and its default level, the score ring (#141, #192: one segment per assessment sized by weight on a recessed groove track, drawn in two colours only, the earned share in yellow and everything else, lost, ungraded or of unknown weight, in white; earned total in the centre, with legend, current average, progress and the final score needed), and two tabs. The Assessments tab SHALL group assessments by their grading component, showing each component's name, weight and the earned share computed by code, and SHALL list name, due, weight, score, status and effective level per assessment (#192): groups SHALL be ordered by kind, ongoing, then quiz, then assignment, then exam, then unknown kind, and items within a group by due time with undated items last; assessments that carry no marks (an effective weight of 0, such as an attendance hurdle or a feedback-only presentation) SHALL be collected in one section at the bottom, collapsed by default; a score SHALL show earned and possible points before the percentage (for example `4/5 · 80%`) when the linked platform item states both, and the percentage alone otherwise; retired assessments SHALL NOT be shown; exams SHALL show "—" for level and no agent entry (#146). Prohibited courses SHALL show the level locked at L0 (#124). The Revision tab SHALL show the exam time, the cited exam scope, notes, practice statistics, and the "tutor me" and "wrong answers only" buttons (#142).

#### Scenario: Unknown weight in the ring
- **WHEN** one assessment has no effective weight
- **THEN** its segment is white like every segment that is not earned, and the final-score figure shows it is unavailable because weights are unknown

#### Scenario: Owner changes a level
- **WHEN** the owner sets an assessment's level to L1 on a course whose default is L0
- **THEN** the change is saved through the owner session and the effective level shows L1

#### Scenario: Component group
- **WHEN** a component "Written assignments" of weight 15 has two graded items of derived weight 3.75 each, scored 80% and 100%
- **THEN** the tab shows the group with 15% and 6.75 earned, and each item's weight marked as an even split

#### Scenario: Order by kind and due time
- **WHEN** a course has an ongoing component, a quiz due 1 May, a quiz due 1 April, an assignment and an exam
- **THEN** the tab lists the ongoing component first, then the 1 April quiz before the 1 May quiz, then the assignment, then the exam

#### Scenario: Items without marks are folded
- **WHEN** a course has an attendance hurdle with weight 0
- **THEN** it appears in a collapsed section at the bottom of the tab and is shown when the owner expands it

#### Scenario: Points and percentage
- **WHEN** a graded quiz's platform item states 4 points earned of 5
- **THEN** its score reads `4/5 · 80%`
