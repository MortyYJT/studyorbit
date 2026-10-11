## ADDED Requirements

### Requirement: Discover current-term courses from both sources
Before first selection or explicit reselection, capture SHALL discover current-term courses from Canvas `/courses` and Ed's same-origin `GET /api/user` endpoint, using their logged-in profile sessions. Ed discovery SHALL read `courses[]` entries shaped as `{course, role, lab, last_active}`, where `course` contains `id`, `code`, `name`, `year`, `session`, and `status`. Ed eligibility SHALL require `course.year` and `course.session` to match the current term context and `course.status` to equal `active`. Eligibility SHALL use source term/current-course evidence, never a course-code heuristic. Choices SHALL be source-qualified by provider, origin and course id, with no implicit cross-provider matching. Discovery reads SHALL share the run's rate limiter and attempt cap. An unavailable source or indeterminate term SHALL be reported explicitly, without silently treating it as an empty successful result.

#### Scenario: List both sources
- **GIVEN** Canvas and Ed list current-term ABCD10001 and historical WXYZ10002 with explicit term evidence
- **WHEN** first selection starts
- **THEN** the terminal lists source-labelled current-term choices only, and Canvas and Ed rows remain independently selectable

#### Scenario: Ed term and active status
- **GIVEN** a synthetic `GET /api/user` response includes courses matching the current year and session with `status: active`, an active course from another year or session, and an inactive course in the current term
- **WHEN** Ed discovery builds choices
- **THEN** only courses matching both current-term fields and active status are eligible; neither course codes nor active status alone determine eligibility

#### Scenario: One source unavailable
- **GIVEN** Ed discovery is unavailable and Canvas discovery succeeds
- **WHEN** the user selects Canvas courses
- **THEN** the Ed gap is reported and existing Ed choices are retained unchanged rather than erased

#### Scenario: Unknown term
- **GIVEN** a source listing has no verified current-term evidence
- **WHEN** discovery runs
- **THEN** that source is reported unavailable for selection and historical courses are not guessed to be current

### Requirement: Persist and reuse terminal selection
The first interactive `c` in `coursework capture` SHALL let the user tick discovered courses before any course-specific reads. A confirmed selection SHALL be saved atomically as a validated versioned file under `<data dir>/capture-selection.json`, outside tracked repository content, with source-qualified ids and term context and without credentials. Later runs SHALL reuse it by default without prompting or automatically expanding it. Only selected course ids SHALL enter either provider's course-specific queue. Empty selection SHALL be valid; discovery list snapshots are exempt from course filtering.

#### Scenario: First selection and reuse
- **GIVEN** no stored selection exists and a TTY is available
- **WHEN** the user enters `c`, ticks only Canvas ABCD10001 and Ed EFGH10002, and confirms
- **THEN** capture stores those source-qualified choices locally and schedules only those courses
- **AND** a later run reuses them without prompting

#### Scenario: Empty selection
- **GIVEN** the user confirms no ticked courses
- **WHEN** capture runs
- **THEN** the empty selection is persisted and no course-specific request is made

### Requirement: Explicit reselection preserves prior choices on cancellation
`coursework capture --reselect` SHALL refresh discovery and show the terminal picker before the next crawl. Cancelling SHALL leave the prior selection file unchanged and SHALL NOT begin a crawl. Missing or inaccessible selected courses SHALL be reported rather than replaced with newly discovered courses.

#### Scenario: Reselect
- **GIVEN** a selection already exists and a TTY is available
- **WHEN** the user runs `coursework capture --reselect` and confirms different choices
- **THEN** the local file is atomically replaced and the next crawl uses the new choices only

#### Scenario: Cancel reselection
- **GIVEN** a valid prior selection exists
- **WHEN** the user cancels the picker
- **THEN** the prior file stays unchanged and no course-specific crawl begins

### Requirement: Non-interactive capture uses stored selection and agent envelopes
`coursework capture --crawl` SHALL execute one capture run without the terminal command loop. Without a TTY, plain `coursework capture` SHALL use that same one-shot path. With a valid stored selection it SHALL use it and never prompt. With a TTY and no valid stored selection, `--crawl` SHALL first run the same terminal picker as the first interactive `c`, then crawl the confirmed selection. Without a TTY it SHALL never prompt; missing or invalid selection SHALL yield a `coursework.agent/v1` failure envelope with code `INVALID_INPUT` and an interactive-selection recovery hint before browser launch or network reads. Non-TTY `--reselect` SHALL return `INVALID_INPUT` without overwriting the file. Stdout SHALL contain one bounded envelope only; raw snapshots SHALL never be envelope data.

#### Scenario: Agent without selection
- **GIVEN** no TTY and no valid saved selection
- **WHEN** an agent invokes capture
- **THEN** it receives an `INVALID_INPUT` envelope, no prompt appears, and no browser or crawl starts

#### Scenario: Agent with selection
- **GIVEN** no TTY, a valid saved selection and usable logged-in profile
- **WHEN** an agent invokes capture
- **THEN** one selected-course run completes and returns an envelope with bounded counts and per-source outcomes without prompting

#### Scenario: One-shot crawl at a terminal without selection
- **GIVEN** a TTY and no valid saved selection
- **WHEN** the user runs `coursework capture --crawl`
- **THEN** the terminal picker runs first, the confirmed selection is saved, and one selected-course run follows

#### Scenario: Agent requests reselection
- **GIVEN** no TTY and an existing selection
- **WHEN** capture is invoked with `--reselect`
- **THEN** it returns `INVALID_INPUT` and retains the file unchanged
