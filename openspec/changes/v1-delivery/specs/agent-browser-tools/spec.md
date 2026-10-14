## ADDED Requirements

### Requirement: Browser tools act only on Canvas and Ed through the resident browser
The agent's browser tools SHALL be: `browser.open` (navigate a tool-owned tab), `browser.read` (page text and a list of visible interactive targets with stable references), `browser.screenshot`, `browser.click`, `browser.fill`, `browser.select` and `browser.submit`. They SHALL attach to the resident browser (see `resident-browser`) and act only in tabs they opened, and SHALL accept only URLs on the validated Canvas and Ed origins. Login pages, the frontend's origin, other local addresses and off-origin redirects SHALL be refused. Tools SHALL never read, type or return passwords or one-time codes; a sign-in page SHALL return `AUTH_EXPIRED` and ask the owner to sign in by hand.

#### Scenario: Frontend origin
- **WHEN** the agent asks `browser.open` for the frontend's local address
- **THEN** it is refused and no tab opens

#### Scenario: Signed out
- **WHEN** `browser.open` lands on the university sign-in page
- **THEN** the tool returns `AUTH_EXPIRED` and types nothing

### Requirement: Reads respect the privacy boundary
`browser.read` SHALL return quiz, lesson and workshop pages unredacted (#112), except any part that shows other students' answers or details, which SHALL be redacted. Discussion threads and replies SHALL be refused. Every other page SHALL pass the deterministic redaction before it is returned. Read output SHALL be bounded and SHALL NOT include cookies, tokens or hidden form values.

#### Scenario: Discussion thread
- **WHEN** the agent asks to read an Ed discussion thread
- **THEN** the tool refuses and returns nothing from the page

#### Scenario: Announcement page
- **WHEN** the agent reads a synthetic Canvas announcement naming a classmate
- **THEN** the returned text has a redaction marker in place of the name

### Requirement: Every write is checked, visible and audited
`browser.click`, `browser.fill`, `browser.select` and `browser.submit` SHALL each name the target assessment. Before acting, code SHALL run the autonomy check for that assessment (see `assessment-autonomy`) and SHALL refuse when it is denied, when the audit writer is unavailable, or when the tab's page is not on that assessment's course on the same platform. Each allowed write SHALL bring the tab to the front, outline the visible target in red, wait at least one second, recheck that the target is visible and act exactly once (#98). After acting, code SHALL append one audit record with the assessment, level, action, observed outcome (`success`, `failure` or `uncertain`) and, for a submit, how the owner confirmed it. Answers and page text SHALL NOT be stored in audit records. If the audit append fails after the action, the tool SHALL report the actual or uncertain state and SHALL NOT repeat the action.

#### Scenario: Denied check
- **WHEN** the agent calls `browser.fill` for an assessment whose effective level is L0
- **THEN** nothing is typed, a denial is audited, and the tool returns the denial reason

#### Scenario: Wrong course page
- **WHEN** the agent calls `browser.click` naming assessment `a-1` of course X while the tab shows course Y
- **THEN** the click is refused before any highlight

#### Scenario: Visible click
- **WHEN** an allowed click runs on a synthetic page
- **THEN** the target is outlined, at least one second passes, one click happens and one audit record is appended

### Requirement: Submission waits for the owner's confirmation
`browser.submit` SHALL take the assessment and a summary of every answer the agent entered. When the course requires confirmation (the default, #121), code SHALL store a pending confirmation with the summary and a screenshot, show it in the conversation and in "needs you", and wait for the owner's decision in the frontend. Only an owner "confirm" from the frontend's owner session SHALL release the click; "cancel", a timeout or a server restart SHALL leave the page unsubmitted and tell the agent so. A pending confirmation SHALL be used at most once. When the owner has switched confirmation off for that course, the submit SHALL proceed after the checks and be audited with confirmation `not-required`. Code cannot verify that the summary matches the page; the screenshot and the "view in Edge" link let the owner check.

#### Scenario: Owner confirms
- **WHEN** the agent submits a granted quiz and the owner presses "confirm submit" in the frontend
- **THEN** the submit click happens once and the audit record names confirmation `owner-ui`

#### Scenario: Owner cancels
- **WHEN** the owner presses "cancel"
- **THEN** no submit click happens, the agent is told it was cancelled, and the audit records a cancelled submit

#### Scenario: Agent cannot confirm itself
- **WHEN** a confirmation is attempted through MCP or any request without the frontend's owner session
- **THEN** it is refused and the pending confirmation stays pending

### Requirement: Browser steps are visible in the conversation
Every browser tool call SHALL appear as a step in the conversation with the tool, the target description, the outcome and, for writes, a screenshot taken after the action, plus a "view in Edge" link that brings the resident browser's tab to the front (#137).

#### Scenario: Step list
- **WHEN** the agent opens a quiz, fills two answers and asks to submit
- **THEN** the conversation shows four steps in order, the last one waiting for confirmation
