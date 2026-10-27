## ADDED Requirements

### Requirement: Extension reads Canvas API pages with the browser session
The project SHALL ship a Manifest V3 extension in `extension/` whose manifest pins the extension ID with a public `key`, requests host permissions only for `https://canvas.lms.unimelb.edu.au/*` and `http://127.0.0.1/*`, and uses no content script. On a `read` request it SHALL issue one GET with `credentials: 'include'` to the requested URL only when the URL starts with `https://canvas.lms.unimelb.edu.au/api/v1/`, and reply with the status, the final URL and the body text. It SHALL open no tab or window. Project code SHALL read no cookie and use no token.

#### Scenario: Disallowed URL
- **WHEN** the extension receives a `read` request for `https://canvas.lms.unimelb.edu.au/courses/1`
- **THEN** it replies with an error and sends no request

### Requirement: Local bridge
The coursework process that runs syncs SHALL listen on `127.0.0.1:47613` for one WebSocket connection whose `Origin` is the pinned extension origin, and SHALL refuse any other origin. It SHALL send read requests only during a sync run, wait at most 5 s for each answer, and fail at once when no extension is connected. If the port is in use, the bridge SHALL report itself unavailable and syncs SHALL continue.

#### Scenario: Wrong origin
- **WHEN** a client opens a WebSocket to the bridge with `Origin: http://example.com`
- **THEN** the upgrade is refused

#### Scenario: No extension
- **WHEN** a sync starts and no extension is connected
- **THEN** the course list is unavailable for that run within 1 s and the run continues with the saved selection

### Requirement: Layer 0 reads the course list through the extension
Every sync run SHALL start by asking the extension for the `courses` API page and passing the text to the existing course capture path, which offers candidates and keeps earlier selections. No agent job SHALL be started for the course list. A non-200 status or a final URL outside `https://canvas.lms.unimelb.edu.au/api/` SHALL count as signed out. The run record SHALL contain one `courses` entry with `via: "extension"`, its duration in ms, and the failure reason when it failed.

#### Scenario: Unchanged course list
- **WHEN** the extension returns the same courses as the previous run
- **THEN** the saved selection is kept and the run goes on to the selected courses without asking the owner

#### Scenario: Signed out
- **WHEN** the extension's reply has final URL `https://canvas.lms.unimelb.edu.au/login/saml`
- **THEN** no candidate is stored, the course list is unavailable for that run, and the record says signed out
