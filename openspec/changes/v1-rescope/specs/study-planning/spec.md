## ADDED Requirements

### Requirement: Owner availability settings
The store SHALL hold one owner-editable planning settings record: time zone (default `Australia/Melbourne`), available minutes for each weekday, teaching-week anchor date and break weeks. Settings SHALL be validated before saving and changed only through an owner command or the owner's UI action, never by an agent.

#### Scenario: Invalid minutes
- **WHEN** the owner sets Monday to -30 minutes
- **THEN** the save is rejected and the previous settings remain

### Requirement: Deterministic earliest-deadline-first plan
A pure planning function SHALL take explicit inputs (settings, a start date, a horizon in days, and open work: unfinished task steps and unsubmitted platform items with due dates and estimates) and SHALL allocate minutes day by day in earliest-deadline-first order. Work may split across days. Overdue work SHALL come first and undated work last. Ties SHALL break by a stable id order. Identical inputs SHALL produce identical plans. Work that does not fit before its deadline SHALL stay in the output as overflow with the missing minutes; no work SHALL disappear. Work without an estimate SHALL be listed as unestimated, not given a guessed duration. The plan SHALL be exposed as a read command and MUST NOT call a model.

#### Scenario: Overflow is visible
- **WHEN** 180 minutes of work are due in two days and the settings allow 60 minutes per day
- **THEN** 120 minutes are scheduled and 60 minutes are reported as overflow for that item

#### Scenario: Same input, same plan
- **WHEN** the planner runs twice on identical inputs
- **THEN** both plans are identical

#### Scenario: Unestimated item
- **WHEN** a platform item has a due date but no estimate
- **THEN** it appears as unestimated with its due date and takes no scheduled minutes
