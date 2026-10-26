## ADDED Requirements

### Requirement: Sync runs as a per-course pipeline of small jobs
A sync run SHALL be orchestrated by code (#199). After the course list, it SHALL process selected courses one at a time, each through these stages in order: skeleton (Handbook capture job), Canvas API captures (`tabs`, `groups`), main job, routed jobs, classification job, document build, import, folder archive. A course SHALL be imported before the next course starts. Each agent job SHALL be one adapter start with a short prompt stating its role, task and output, only the tools it needs, and the URLs it may open; it SHALL end after its output tool call. Stage results SHALL be kept in the store under the sync job, so the `coursework mcp` process and the orchestrator see the same state. A failed or timed-out job SHALL be retried at most once and then reported, and the course SHALL continue with what the other stages produced. The run SHALL record, per job, its kind, course, steps, turns and outcome, and token counts when the adapter reports them.

#### Scenario: One course at a time
- **WHEN** two courses are selected and every job of the second course fails (for example the adapter reports the agent unavailable after the quota runs out)
- **THEN** the first course is stored in full and the second keeps its previously stored data

#### Scenario: Per-job record
- **WHEN** a run finishes
- **THEN** its record lists every job with kind, course, steps, turns and outcome

### Requirement: Tentative skeleton from the Handbook
For each course, a short agent job SHALL open the public Handbook assessment page `https://handbook.unimelb.edu.au/<year>/subjects/<code>/assessment` (`<year>` from the course term, `<code>` lower-case) in the owner's Edge, copy the whole page and call `handbook.capture` with the job id and course key; the command SHALL read the clipboard itself through the injectable reader, refuse text over 1 MB or text without an assessment table, store no raw text, and parse each assessment row into a component name, weight, timing text and hurdle text, with the row text as quote. The skeleton SHALL be tentative (#203): where a Canvas group gives a weight above 0 for the same component, the Canvas weight SHALL be used and a differing Handbook weight SHALL open a `weight` conflict; where the Canvas group weight is 0 and the Handbook weight is above 0, the Handbook weight SHALL be used and a `weight` conflict opened. Code SHALL make no request to the Handbook and SHALL NOT try to get around its bot protection (#214). A failed capture or parse SHALL NOT stop the course.

#### Scenario: Handbook unavailable
- **WHEN** the Handbook page shows an error or block page, or the capture is refused
- **THEN** the course continues with Canvas groups as its components and the run notes the missing skeleton

#### Scenario: Weights disagree
- **WHEN** the Handbook says "Assignments 30%" and the matching Canvas group weight is 40
- **THEN** the component weight is 40 from the API and a `weight` conflict shows 30 and 40

### Requirement: Page routing by navigation tabs
Code SHALL route each navigation tab of a Canvas course from its `tabs` capture by a fixed table (#201): `read` for home, assignments, quizzes and grades (grades through the `groups` capture); `save` for modules (weekly slides); `link` for Lecture Capture and for a syllabus that leads to Ed; `on-home-link` for pages and files, opened only for links the main job reported from the home page; `never` for announcements, discussions, people, outcomes, collaborations, Gradescope, Echo360, Zoom, Office 365, Google Drive, Readings Online and every tab not in the table. Agent jobs SHALL be given only URLs whose route allows them, and their prompts SHALL say to open no other page. Tabs routed `never` because they are unknown SHALL be listed in the run.

#### Scenario: Gradescope never opened
- **WHEN** a course's tabs include Gradescope and Echo360
- **THEN** no job is given their URLs

#### Scenario: Files only through the home page
- **WHEN** the home page links to a Files folder of audio and PDF material
- **THEN** the saver job is given that folder's URL, and without such a link the Files tab is not opened

### Requirement: Main job reads only the home page
The main job SHALL open only the course home page and call `course.map` with: what the LMS site is used for, what Ed is used for, where the syllabus is (`canvas`, `ed`, `handbook` or unknown), and the home-page links with a label and URL, each statement with a quote from the home page. It SHALL NOT open assignments or other pages.

#### Scenario: Syllabus on Ed
- **WHEN** the home page says the syllabus and lessons are on Ed
- **THEN** `course.map` reports the syllabus as `ed` with that quote, and the Ed stage reads the course on Ed

### Requirement: Surface read at sync, deep layer saved without reading
For each assessment the sync SHALL obtain only the surface (#200): unlock time, due, points and weight (from the API for Canvas items), the AI statement and, for quizzes, the description and availability text the API does not hold. The assignment-page job SHALL read only the AI statement, then save the page as a single file and download its attachments without reading them, and call `assignment.saved` with the policy (quoted) and the saved file names. The saver job SHALL download each week's slides from the modules page and record link-only targets (Lecture Capture, video and audio) as links, then call `materials.saved`. Quizzes SHALL save nothing deep. An assignment page whose AI statement and saved-file fingerprints did not change since the last sync MAY be skipped when its API `updated_at` is unchanged.

#### Scenario: Rubric not read at sync
- **WHEN** an assignment page holds instructions, a rubric and a PDF attachment
- **THEN** the job returns only the AI statement and the saved file names, and no instruction or rubric text reaches the store

#### Scenario: Recordings stay links
- **WHEN** a module lists lecture slides and a lecture recording
- **THEN** the slides are saved to the course folder and the recording is stored as a link only

### Requirement: Six categories and the grading rule
A classification job SHALL assign each item one category among `exam`, `quiz`, `assignment`, `presentation`, `participation` and `ungraded`, and the component it belongs to, with a quote or the Canvas group name as evidence (#202). Code SHALL then decide whether the item counts: it is graded when its Canvas group has weight above 0 or when it maps, with evidence, to a skeleton component with weight above 0 (#202); when the group weight is 0 but the component's weight is above 0, the item is graded and a `weight` conflict is opened. An item carrying a hurdle (for example an attendance requirement) keeps its category with weight 0, because the owner must still meet it. Every other item SHALL be `ungraded` whatever the job said. Ungraded items SHALL be stored but excluded from the grade projection and from planning. A graded Canvas item that maps to no component SHALL open an `unmatched` conflict.

#### Scenario: Extension token survey
- **WHEN** the quizzes list holds "Token Use: Assignment 1 Extensions" in a survey group of weight 0
- **THEN** it is stored as `ungraded`, gets no grade weight and no planned time

#### Scenario: Practice quiz
- **WHEN** a practice quiz worth 14 points sits in a group of weight 0 and maps to no weighted component
- **THEN** it is `ungraded` even if the job classified it as `quiz`

#### Scenario: Weight-0 group, weighted component
- **WHEN** a Canvas item sits in a group of weight 0 and maps, with a quote, to the Handbook component "Assignments 30%"
- **THEN** it is graded under that component with the effective component weight 30 from the Handbook, and a `weight` conflict shows 0 and 30

#### Scenario: Attendance hurdle kept
- **WHEN** an attendance item has weight 0 and the skeleton states an 80% attendance hurdle
- **THEN** it stays `participation` with weight 0 and its hurdle, not `ungraded`

### Requirement: Code builds the course document
Code SHALL build the course document from the skeleton, API values, `course.map`, routed outputs and classification, and import it through the existing mapping (remainders, component assessments, precedence, retirement). API fields SHALL carry `via: "api"`; agent-read fields SHALL carry their quote and source URL. No agent SHALL submit a whole course document.

#### Scenario: Built document imported
- **WHEN** every stage of a course finished
- **THEN** one document is built and imported in one transaction, with no agent call to `course.import`

### Requirement: Remaining conflicts
Only values the API cannot answer SHALL open sync conflicts (#208): `weight` (a skeleton weight that differs from the Canvas group weight) and `unmatched` (a graded Canvas item with no component). Until the owner resolves a `weight` conflict, the Canvas side SHALL be effective when both weights are above 0, and the skeleton side when the Canvas group weight is 0; the owner resolves it with `check.resolve` (`skeleton` or `canvas`) through the owner session; an `unmatched` conflict SHALL be resolved by assigning a component or dismissing. Agents SHALL have no command that resolves conflicts. A later sync whose values agree SHALL close an open conflict.

#### Scenario: Owner keeps the Handbook weight
- **WHEN** the owner resolves a `weight` conflict with `skeleton`
- **THEN** the component weight becomes the Handbook value through an owner annotation and the conflict is resolved

### Requirement: Course folder with fingerprints and update notices
Saved files SHALL be stored under `~/Desktop/<School> <YYSn>/<course name>/` (for example `UniMelb 26S2` for term `2026:S2`), with `assessments/<assessment name>/` and `materials/` inside (#204); unsafe path characters SHALL be replaced and the course code used when the name is unknown. Code SHALL move each file a job reported from `~/Downloads` only when its exact name exists and it was modified after the job started; a missing file SHALL be reported, never guessed. Each stored file SHALL get a fingerprint (SHA-256 of its bytes; for single-file web pages, of the page body with scripts and volatile timestamps removed). When a later sync saves a file whose fingerprint differs, the previous file SHALL be kept with a date suffix, the new one becomes current, and "needs you" SHALL show "assessment content updated" for that assessment until the owner opens it (#205). Code SHALL never delete files in the course folder.

#### Scenario: Requirements changed
- **WHEN** an assignment's saved instructions differ from last week's
- **THEN** the old file stays with a date suffix, the new one is current, and "needs you" shows the update

#### Scenario: Download not found
- **WHEN** a job reports `spec.pdf` but no such file was downloaded after the job started
- **THEN** nothing is moved and the run reports the missing file

### Requirement: Ed source
When the `edstem` command is installed and its authentication check succeeds, code SHALL read Ed units, lessons with due dates and lesson slides through it with JSON output (#207), map lessons to Ed items and save slides to the course folder; the owner's Ed token stays with that tool and is never read by our code. Otherwise one Ed job SHALL read the Ed course's lesson list with due dates. Content that Ed previews do not show (code parts of assignments) SHALL be left to the Start flow.

#### Scenario: CLI available
- **WHEN** `edstem` is installed and signed in
- **THEN** Ed items come from the command and no agent opens Ed during sync

#### Scenario: CLI missing
- **WHEN** `edstem` is not installed
- **THEN** one Ed job reads the lesson list and the run notes that the CLI was not used

### Requirement: Start reads the deep layer
The assessment drawer SHALL offer Start for every non-exam assessment (#200). For a `quiz`, Start SHALL open an agent conversation with the quiz URL and the granted level; the workspace rules apply (L1 needed, never press a final submit, #173). For other categories, Start SHALL open a conversation whose agent calls `assessment.files` for that assessment; the command SHALL extract the text of the saved files (web page text, PDF text), record each as a `material` SourceItem of the course linked to the assessment (this is when instruction text first reaches the store), and return the texts with their SourceItem ids; when nothing is saved it SHALL first run one assignment-page job. The agent records requirements and rubric points as annotations citing those SourceItems, so citations verify. The agent SHALL NOT read the course folder through its shell.

#### Scenario: Start an assignment
- **WHEN** the owner presses Start on an assignment with a saved page and a PDF
- **THEN** both texts are stored as material SourceItems, the agent receives them through `assessment.files`, and an annotation quoting the rubric passes the citation check

#### Scenario: Start a quiz
- **WHEN** the owner presses Start on a quiz at level L1
- **THEN** the conversation opens with the quiz link, and no saved file is needed

### Requirement: Parallel jobs are opt-in
Routed jobs of one course SHALL run one at a time unless `sync.parallel` is set above 1, in which case up to that many run together, each told to open its own Edge window (#206).

#### Scenario: Default sequential
- **WHEN** `sync.parallel` is not set
- **THEN** routed jobs of a course run one after another
