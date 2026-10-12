## ADDED Requirements

### Requirement: Calendar and task views preserve domain meaning
The UI SHALL display month/week assessments and tasks with module filters, explicit configurable teaching weeks and selected timezone rules. Missing dates SHALL remain visible as undated work. Coursework steps SHALL display their source quotes/locators and resolve evidence through M2 without altering trusted text/hash/offsets. Daily recurring tasks SHALL be summarized in one calendar row per day; recurrence SHALL NOT create a due date on the recurring Task. Manual/recurring task and module editing/completion SHALL use selected merged M2 contracts; unsupported controls SHALL remain unavailable.

#### Scenario: Undated and recurring work
- **WHEN** a synthetic list includes an undated assessment and daily recurring task
- **THEN** the assessment remains in an undated-work view and daily recurrence is summarized without fabricating Task.due or completion history

#### Scenario: Citation drawer
- **WHEN** the owner opens a coursework step's citation
- **THEN** the UI shows verified redacted quote, source locator/page and any missing-evidence or coverage limitation from M2

#### Scenario: Manual task editing
- **WHEN** the selected M2 manual-task contract is available and an owner saves a valid edit
- **THEN** the UI sends that validated command and reflects confirmed current state, while a rejected/conflicting edit preserves prior authoritative state

### Requirement: Delivery module progress
All modules SHALL be delivery-type per decision #31. Progress SHALL equal done steps divided by total steps across non-recurring tasks only; an empty denominator SHALL yield zero. Module names/glyphs and mutations SHALL come from the selected protocol contract, not guessed course metadata or a UI-only permanent store.

#### Scenario: Recurrence excluded from progress
- **WHEN** two non-recurring tasks have 1 of 2 and 2 of 3 steps done and a recurring task also exists
- **THEN** module progress is 3/5, and a module without non-recurring steps shows zero

### Requirement: Required manual assessment weight and score entry
The UI SHALL support manually entering assessment weights and scores in v1 per decision #28; later Canvas auto-fill SHALL NOT be a prerequisite for manual entry. Save and authoritative reads SHALL use separately specified, reviewed and merged M2 owner contracts under O3, with validation and version/conflict semantics. Missing contracts SHALL keep this required feature and full M3 acceptance pending, not reduce scope to projection display. The UI SHALL confirm saved state only after protocol success and authoritative reread, restore saved values on reload and compute the existing projection from those values. Rejected/conflicting saves SHALL preserve prior authoritative values and projection; no permanent browser-only store SHALL substitute for M2.

#### Scenario: Save and reload manual grades
- **WHEN** the owner enters valid synthetic assessment weights and scores and the M2 save succeeds
- **THEN** authoritative reread confirms the values, and a page reload retrieves the same values through M2 without relying on browser-only persistence

#### Scenario: Saved grades drive projection
- **WHEN** saved manual inputs are 10% at 82, 15% at 88, 10% at 74, ungraded 25% and a 40% final with H1 target
- **THEN** after save and reload the existing projection presents earned 28.8, average about 82.29 and final need about 76.6 with its assumption; changing and successfully saving a score recomputes from the new authoritative values

#### Scenario: Invalid or conflicting grade save
- **WHEN** M2 rejects an invalid weight/score or a stale conflicting edit
- **THEN** the UI displays the failure, claims no durable save and preserves or rereads prior authoritative values and their projection

### Requirement: Transparent existing grade projection
The UI SHALL present the existing pure domain grade projection from M2 courses/assessments, including graded weight, earned points, current average, selected target band, current-average assumption for ungraded non-finals, hurdle floor and secured/unreachable/unavailable reasons. It SHALL distinguish partial assessment coverage and estimates from confirmed results. It SHALL NOT fork the formula or claim a guaranteed grade.

#### Scenario: Existing domain example
- **WHEN** a complete synthetic course has 10% at 82, 15% at 88, 10% at 74, ungraded 25% and a 40% final with H1 target
- **THEN** the UI presents earned 28.8, average about 82.29 and final need about 76.6 with its projection assumption

#### Scenario: Hurdle or unavailable projection
- **WHEN** a hurdle raises the final need or the domain returns nothing_graded, no_final, final_graded, secured or unreachable
- **THEN** the UI displays that actual result/reason without converting it to a fabricated numeric score

### Requirement: Deterministic EDF plan with visible overflow
The weekly planner SHALL be a pure deterministic function of explicit horizon, daily available minutes, tasks/occurrences and selected calendar/edge rules. It SHALL allocate unfinished work in earliest-deadline order within each day's capacity. Identical inputs SHALL give identical results. Capacity-exceeding work SHALL remain visible at risk with unscheduled effort, never be dropped. Missing deadlines/effort and already overdue work SHALL be explicitly represented according to recorded choices. Recurring occurrences, splitting, ties and timezone rules SHALL be selected before implementation; no clock/storage/network/model access SHALL occur inside the algorithm.

#### Scenario: Work exceeds capacity
- **WHEN** synthetic unfinished dated work totals 180 minutes but only 120 minutes fit before its deadlines
- **THEN** at most 120 minutes are allocated and the remaining 60 minutes remain accounted for and visibly at risk

#### Scenario: Repeatability and done work
- **WHEN** identical planner inputs include completed steps and tied deadlines
- **THEN** repeated calls yield identical allocations under the selected tie rule, completed work consumes no capacity and no unfinished work disappears

#### Scenario: Calendar boundary and unknown work
- **WHEN** the horizon crosses a timezone offset/break boundary or contains undated/unknown-effort work
- **THEN** the selected explicit rules determine day/week allocation and uncertain inputs remain visible rather than using invented deadlines or zero effort
