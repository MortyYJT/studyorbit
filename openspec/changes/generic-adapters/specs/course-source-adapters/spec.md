## ADDED Requirements

### Requirement: Course sources behind one interface
The system SHALL collect course data only through `CourseSource` implementations, each with an `id`, a `label`, the reference platforms it provides, whether it uses the browser, its limiter key, a function that returns the collector command for a course (or none when the source does not apply), a discovery command for sources that discover courses, and its `unavailable` placeholder. Collectors SHALL keep running as separate processes through the pipeline's existing collector runner, with its cancellation, time limit and exit code 75 for retryable failures. Collectors SHALL receive their configuration in the environment variable `STUDYORBIT_SOURCE_CONFIG` as validated JSON that contains no credential.

#### Scenario: Placeholder on failure
- **WHEN** the Ed collector exits with code 1
- **THEN** the collect stage writes the Ed source's placeholder, identical to today's, and the course is at most `partial` with today's reason

#### Scenario: Old command still works
- **WHEN** the owner runs `node scripts/canvas-background.mjs discover <out>` with no settings file
- **THEN** it collects from the UniMelb Canvas through Edge exactly as before the change

### Requirement: Collect stage runs the registered sources
The collect stage SHALL run the sources returned by `resolveSources(settings, institution)` in order: Canvas, Ed, then the institution's framework source when it has one. Checkpoint keys and run-directory file names SHALL be the source ids (`canvas.json`, `ed.json`, `handbook.json` for UniMelb). Sources that use the browser SHALL share the browser mutex. Collection flags SHALL be kept per source, and course reasons SHALL be built from them in source order with each source's label. The collect input hash SHALL include the institution id, the Canvas origin, the Ed region and the source id list, and SHALL NOT include the browser.

#### Scenario: Generic institution has no framework source
- **WHEN** the institution is `generic`
- **THEN** collect runs only Canvas and Ed, the checkpoint has two sources, and no reason mentions a framework source

#### Scenario: Changing browser does not invalidate collected data
- **WHEN** a stopped job is resumed after the browser setting changed from Edge to Chrome
- **THEN** the collect input hash is unchanged and verified collected sources are reused

#### Scenario: UniMelb setup unchanged
- **WHEN** the synthetic course is synced with no settings file using fake collectors
- **THEN** the collector arguments, the run-directory files, the prompt and the course reasons are byte-identical to those recorded before the change

### Requirement: Canvas source for any instance
The Canvas source SHALL build every URL from the configured Canvas origin and fixed Canvas REST API paths, SHALL follow pagination only to the same origin and path, and SHALL build course links on that origin. The origin SHALL be `https`, without user information, path, query or fragment, and not an IP address literal. Discovery SHALL record `canvasOrigin` and `institution` in `.local/lms/courses.json`. Sync and the course reports SHALL refuse a course list whose origin differs from the current setting with `409 COURSE_LIST_STALE` and 「Canvas 地址已更改，请重新获取课程」; a list without `canvasOrigin` SHALL be read as the UniMelb origin.

#### Scenario: Pagination to another host
- **WHEN** a Canvas response's `Link: rel="next"` points to a different origin
- **THEN** collection fails with 「Canvas 下一页链接不属于当前接口」 and writes nothing

#### Scenario: Instance changed
- **WHEN** the Canvas address setting changes and the owner starts a sync without fetching courses again
- **THEN** the sync is refused with `COURSE_LIST_STALE` and no collector runs

#### Scenario: Plain-HTTP origin
- **WHEN** the owner saves `http://canvas.example.edu` as the Canvas address
- **THEN** the settings route answers `400 INVALID_SOURCE_SETTINGS` naming `canvasOrigin`

### Requirement: Ed source with configurable region
The Ed source SHALL match the Ed unit with the institution's term key and session matcher, SHALL regex-escape the course code before matching, and SHALL use the API base for the region: `auto` uses the region reported by `edstem auth status --json`; `au`, `us`, `eu` map to `https://edstem.org/api/`, `https://us.edstem.org/api/`, `https://eu.edstem.org/api/`. An explicit region different from the CLI's SHALL make Ed `unavailable` with 「Ed 登录区域与设置不一致」. The scores step SHALL keep using only the `edstem` CLI's own credential.

#### Scenario: Region mismatch
- **WHEN** the setting is `us` and the CLI reports `au`
- **THEN** the Ed source is `unavailable` with the mismatch reason and no Ed API request is made

#### Scenario: Code with regex characters
- **WHEN** a generic course code is `CS.101`
- **THEN** only Ed units whose code starts with the literal `CS.101` match
