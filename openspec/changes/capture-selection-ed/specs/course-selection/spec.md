## ADDED Requirements

### Requirement: Discover selectable courses from both sources
Before first selection or explicit reselection, capture SHALL discover current-term Canvas courses from `/courses` and active Ed courses from Ed's same-origin `GET /api/user` endpoint, using their logged-in profile sessions. Ed discovery SHALL read `courses[]` entries shaped as `{course, role, lab, last_active}`, where `course` contains `id`, `code`, `name`, `year`, `session`, and `status`. Ed exposes no verified current-term marker, so Ed eligibility SHALL be `course.status` equal to `active` only, with no hard-coded or date-guessed term; the picker SHALL group Ed choices by `course.year` + `course.session`, newest group first, and label each row with its term so the user decides (#54). Courses whose status is not `active` SHALL NOT be listed. Canvas eligibility SHALL use Canvas's own current-enrolment evidence. Neither source SHALL use a course-code heuristic. Choices SHALL be source-qualified by provider, origin and course id, with no implicit cross-provider matching. Discovery reads SHALL share the run's rate limiter and attempt cap. An unavailable source, or a Canvas listing without current-term evidence, SHALL be reported explicitly, without silently treating it as an empty successful result.

#### Scenario: List both sources
- **GIVEN** Canvas lists current-enrolment ABCD10001 and past-enrolment WXYZ10002, and Ed lists active ABCD10001
- **WHEN** first selection starts
- **THEN** the terminal lists source-labelled Canvas ABCD10001 and Ed ABCD10001 only, and Canvas and Ed rows remain independently selectable

#### Scenario: One source unavailable
- **GIVEN** Ed discovery is unavailable and Canvas discovery succeeds
- **WHEN** the user selects Canvas courses
- **THEN** the Ed gap is reported and existing Ed choices are retained unchanged rather than erased

#### Scenario: Ed active courses from two terms
- **GIVEN** Ed lists active ABCD10001 (2026 Semester 2), active WXYZ10002 (2026 Semester 1) and non-active EFGH10003
- **WHEN** first selection starts
- **THEN** ABCD10001 and WXYZ10002 are listed in term groups with the 2026 Semester 2 group first, EFGH10003 is not listed, and nothing is pre-selected by term

#### Scenario: Canvas unknown term
- **GIVEN** the Canvas `/courses` listing has no verified current-enrolment evidence
- **WHEN** discovery runs
- **THEN** Canvas is reported unavailable for selection, historical Canvas courses are not guessed to be current, and Ed discovery is unaffected

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
