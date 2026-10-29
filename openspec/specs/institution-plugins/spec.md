# institution-plugins Specification

## Purpose
Everything institution-specific (subject codes, terms, folders, time zone, wording, framework source) lives in an institution plugin; `unimelb` reproduces the original behaviour and `generic` works with any Canvas.
## Requirements
### Requirement: Institution-specific behaviour lives in plugins
The system SHALL take subject-code extraction, the course filter, term parsing and labels, Desktop folder naming, the time zone, prompt and reason wording, and the framework source only from the active `Institution` plugin. The plugins SHALL be `unimelb` and `generic`. The course document contract SHALL be unchanged; the reference and source platform value `handbook` SHALL mean the active institution's framework source.

#### Scenario: Folder for a UniMelb course
- **WHEN** a UniMelb course with code `ABCD10001` and term `Semester 2 2026` is saved
- **THEN** its file goes to `<Desktop>/墨尔本大学 2026 S2/ABCD10001/分数结构.json`, as today

#### Scenario: Folder for a generic course
- **WHEN** the owner's code pattern yields the code `CS/101` for a generic course with term `Fall 2026`, and the course is saved
- **THEN** its file goes to `<Desktop>/StudyOrbit Fall 2026/CS_101/分数结构.json`

### Requirement: UniMelb plugin reproduces today's behaviour
The `unimelb` plugin SHALL use the subject-code pattern `[A-Z]{4}[1-9]\d{4}` at the start of `course_code`, "Semester 1/2" term parsing, `<year> S<n>` labels, `Australia/Melbourne`, the current prompt and reason sentences, and the Handbook framework source (collector and parsing moved unchanged). Golden tests recorded before the change from the synthetic course SHALL pass unchanged: the analysis prompt, the repair prompt, both chat system prompts, validation and settle reasons, Desktop paths, and `normalizeCourses` and the discovery collector's output for synthetic API pages with an injected clock. The discovery golden SHALL ignore only the fields added later by this change (`canvasOrigin`, `institution`).

#### Scenario: Golden prompt
- **WHEN** the analysis prompt is built for the synthetic course with the `unimelb` plugin
- **THEN** it equals the recorded prompt byte for byte

### Requirement: Generic plugin works with any Canvas
The `generic` plugin SHALL accept a course whose trimmed `course_code` matches the owner's code pattern (one capture group) or, when none is set, `^[A-Za-z0-9][A-Za-z0-9 ._-]{0,49}$`; SHALL take the first `20\d{2}` of the term as the year and no session; SHALL sanitise folder segments to `[A-Za-z0-9 ._-]`, never producing `.`, `..`, a trailing dot or space, or a Windows reserved device name; SHALL use the configured time zone; SHALL use neutral wording; and SHALL have no framework source.

#### Scenario: Community without a code
- **WHEN** a discovered Canvas entry has no `course_code`
- **THEN** it is not a sync candidate

#### Scenario: Reserved name
- **WHEN** a generic course code is `CON`
- **THEN** the folder segment is `_CON`

### Requirement: Prompts and messages are parameterised
The analysis prompt SHALL build its source rule from the plugin and its framework-reference and framework-quote clauses from the framework source; without a framework source those clauses and `handbookComponents` SHALL be omitted. Validation and settle reasons SHALL name sources by their labels. The chat system prompts SHALL take their English and Chinese assistant introductions and the time label from the plugin. Every computation of "today" and every due-date formatting in the server, the MCP server, the chat context, `shared/` and the page SHALL use the institution's time zone. Chat tool descriptions SHALL name the time zone with the plugin's English time label, so UniMelb descriptions stay unchanged.

#### Scenario: Generic prompt has no Handbook
- **WHEN** the analysis prompt is built with the `generic` plugin
- **THEN** it has no Handbook rule and no `handbookComponents` (the contract's schema descriptions are unchanged), and a `handbook` reference in the reply is a validation issue as a reference to a source that was not collected

#### Scenario: UniMelb tool descriptions unchanged
- **WHEN** the chat tool registry is built for `unimelb`
- **THEN** the `list_courses` and `upcoming_deadlines` descriptions equal today's, including "Melbourne"

#### Scenario: Today in another time zone
- **WHEN** the institution is `generic` with time zone `America/New_York` and the clock is 2026-10-30T02:00Z
- **THEN** the chat's today is `2026-10-29`

### Requirement: Generic code contains no UniMelb literals
A test SHALL fail when any module under `scripts/`, `server/`, `shared/` or `web/src/` outside `scripts/institutions/unimelb/` contains `unimelb`, `UniMelb`, `墨尔本`, `Melbourne`, `Handbook` or `[A-Z]{4}[1-9]`, except entries listed in the test with a reason: the registry id `unimelb`, the grade bands in `shared/course-calculations.ts`, and the `.describe` texts of `shared/course-data.ts`, which are model input through the output schema and describe the kept contract value `handbook`.

#### Scenario: Hard-coded host added
- **WHEN** a generic module adds the string `canvas.lms.unimelb.edu.au`
- **THEN** `npm run check` fails naming the file and line

