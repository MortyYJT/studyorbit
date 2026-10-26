## MODIFIED Requirements

### Requirement: Plannable work
Plannable work SHALL be: every unsubmitted, not-removed assessment of the current term that is neither an exam nor `ungraded` (#202), every unfinished step of a stored task, and every unfinished manual task that is not all-day (#132). Each work item carries an id, a title, its course (if any), a due time (if any), an estimate in minutes (if any) and the estimate's origin. An exam SHALL appear only as a deadline in the week view, not as plannable work. An all-day manual task SHALL appear only in the top row of its date and SHALL take no planned minutes (#143).

#### Scenario: All-day task
- **WHEN** the owner adds an all-day manual task "Career fair" on Thursday
- **THEN** it appears in Thursday's top row and the plan assigns it no minutes

#### Scenario: Submitted work drops out
- **WHEN** a platform item linked to an assessment reports `submitted: true`
- **THEN** that assessment is no longer plannable work

#### Scenario: Ungraded work is not planned
- **WHEN** a course holds an unsubmitted practice quiz of kind `ungraded`
- **THEN** it is not plannable work and gets no planned minutes
