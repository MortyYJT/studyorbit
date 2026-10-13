## ADDED Requirements

### Requirement: One resident managed browser
`coursework browser start` SHALL launch the browser chosen by `page-capture` "Detect the browser" on the managed profile `<data dir>/profiles/default` as a long-running headed process with remote debugging bound to `127.0.0.1` on a free port. While it runs, it SHALL hold the profile lock and write its endpoint and process id to `<data dir>/browser.json` with owner-only permissions (0600). `coursework browser stop` SHALL close it, remove `browser.json` and release the lock. If a live resident browser already exists, `start` SHALL return its existing endpoint rather than launch a second one. A stale `browser.json` whose process is gone SHALL be cleared. The debugging port MUST NOT bind any non-loopback address.

#### Scenario: Start once
- **WHEN** the owner runs `coursework browser start` twice
- **THEN** one browser process runs, both calls report the same loopback endpoint, and `browser.json` is readable only by the owner

#### Scenario: Stale endpoint file
- **WHEN** `browser.json` names a process that no longer exists
- **THEN** `start` clears it and the lock, then launches a new browser

#### Scenario: Stop
- **WHEN** the owner runs `coursework browser stop`
- **THEN** the browser closes, `browser.json` is removed and the profile lock is released

### Requirement: Code and agents attach instead of launching
Every command that needs the signed-in profile (sync, status, the revision skill) SHALL attach to the resident browser through its loopback endpoint and SHALL open and close only its own tabs, never closing tabs it did not open. If no resident browser runs, a non-interactive command SHALL return `AUTH_EXPIRED` with a hint to run `coursework browser start`, without launching a browser or prompting. Attaching MUST NOT export cookies, tokens or the endpoint to a model-facing output.

#### Scenario: Attach for sync
- **WHEN** a resident browser runs and `coursework sync` starts
- **THEN** sync reads through a new tab in that browser and closes only that tab when done

#### Scenario: No resident browser
- **WHEN** no resident browser runs and an agent calls a command that needs the profile
- **THEN** it returns one `AUTH_EXPIRED` envelope telling the owner to start the browser, and nothing is launched

### Requirement: Session status per site
`coursework browser status` SHALL report, for Canvas and Ed separately, `signedIn`, `signedOut` or `unknown`, using read-only same-origin checks: a Canvas `/api/v1/users/self` GET with the page's own session, and the presence of Ed's regional page token plus an Ed `/api/user` GET. It SHALL return only these states and a checked-at time, never response bodies, names or tokens. A signed-out site SHALL carry an `AUTH_EXPIRED` hint for the owner to sign in by hand. Status checks SHALL count toward the shared rate limiter. A model never sees or types passwords, and status MUST NOT prompt for or fill credentials.

#### Scenario: Canvas expired, Ed signed in
- **WHEN** the Canvas check redirects to a login page and the Ed check returns 200
- **THEN** status reports Canvas `signedOut` with a sign-in hint and Ed `signedIn`, and no body content appears in the output

### Requirement: Agent browser actions are visible
Code that clicks or types on the owner's behalf SHALL go through one helper that brings the window to the front, outlines the target element in red, waits one second, and then acts (#98). The helper SHALL refuse to act on an element that is not visible. Agents that operate the browser directly SHALL follow the same rule through the assessment skill. An agent SHALL read raw pages directly only where the privacy red line allows it; reading quiz or workshop pages without redaction depends on the owner confirming decision #96, and discussion pages are never read raw. Read-only API calls are exempt.

#### Scenario: Highlighted click
- **WHEN** code clicks a synthetic button through the helper
- **THEN** the button is outlined, at least one second passes, and then exactly one click happens

#### Scenario: Hidden target
- **WHEN** the target element is not visible
- **THEN** the helper refuses without clicking and reports the reason
