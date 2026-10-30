# grade-target Specification

## Purpose
The final-needed calculation: the average the student needs on the remaining weight to reach a chosen grade band, and how the course page shows it.
## Requirements
### Requirement: Final-needed average across remaining weight
The system SHALL compute, for a target band, the average percentage the owner still needs across all course weight that has no mark yet, as `(target − earned) / (100 − gradedWeight) × 100`, where `earned` and `gradedWeight` come from the existing grade calculation. Bands are H1 80, H2A 75, H2B 70, H3 65 and P 50.

#### Scenario: Reachable target
- **WHEN** 40% of the weight is graded with 30 earned and the target is H1 (80)
- **THEN** the result is reachable with a needed average of 83.3%

#### Scenario: Target already secured
- **WHEN** the earned points already reach or exceed the target
- **THEN** the result is secured and no percentage is shown as required

#### Scenario: Target out of reach
- **WHEN** the needed average is above 100%
- **THEN** the result is unreachable

#### Scenario: Nothing left to mark
- **WHEN** the graded weight is 100% or more
- **THEN** the result is secured if earned reaches the target and unreachable otherwise

#### Scenario: Nothing graded yet
- **WHEN** no weight is graded
- **THEN** the needed average equals the target

### Requirement: Course page shows the final-needed result
The course page SHALL show the result for the selected band beside the band selector, remember the selected band per course in browser storage, and say when the identified weights add up to less than 100% that the missing weight is counted as still to be marked.

#### Scenario: Band choice is remembered
- **WHEN** the owner picks H2A on a course and reopens the course later
- **THEN** H2A is still selected and its result is shown

#### Scenario: Unidentified weight is disclosed
- **WHEN** the identified weights of a course add up to 85%
- **THEN** the result carries a note that 15% of the weight is unidentified and counted as remaining

