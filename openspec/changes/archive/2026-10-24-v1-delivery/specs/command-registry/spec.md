## MODIFIED Requirements

### Requirement: Generated CLI keeps one envelope
Commander subcommands SHALL dispatch through the registry. JSON mode SHALL print exactly one envelope on stdout with diagnostics on stderr. Owner-only commands SHALL require a trusted owner interaction. Autonomy settings (policy, course default level, overrides, confirm-before-submit) and submit confirmations SHALL be accepted only from the frontend's owner session over HTTP (#122). Other owner commands (planning settings, owner annotations and verdicts, estimates, start times, manual tasks, actual time, conversation deletion, resident sign-in `browser.signin`) SHALL be accepted from the frontend's owner session or a TTY. Every other call, including every MCP call and every call from the chat agent, SHALL get a safe refusal and SHALL never prompt for credentials or invent approval.

#### Scenario: Agent attempts an owner command
- **WHEN** a non-TTY caller without the owner session invokes the course level command
- **THEN** it receives a safe refusal and nothing is stored

#### Scenario: TTY cannot change levels
- **WHEN** the owner runs the course level command in a terminal
- **THEN** it is refused with a message pointing to the frontend

## ADDED Requirements

### Requirement: Owner brings resident sign-in to the front
`browser.signin` SHALL accept only `{ site: canvas | ed }` from the frontend's owner session over HTTP or a TTY (#160, task 11.6). It SHALL use the resident profile, focus an existing sign-in tab for that provider (including the university's Canvas SSO app), or open the provider's fixed sign-in entry URL (`https://canvas.lms.unimelb.edu.au/login/saml` or `https://edstem.org/au/login`) and focus it if none exists. Other resident tabs SHALL remain unchanged and the selected tab SHALL stay open after the command disconnects. The command SHALL never read, type or return credentials, inspect form contents or read browser storage. It SHALL return only `{ site, status }`, where `status` uses the `SiteStatus` structure from `status.ts`; a recognized sign-in URL means `signedOut`, and an unverified redirect means `unknown`, never an invented `signedIn`.

#### Scenario: Untrusted caller cannot touch tabs
- **WHEN** a non-TTY caller without the owner session invokes `browser.signin`
- **THEN** it receives a safe refusal before any resident connection or tab operation

#### Scenario: Existing sign-in tab
- **WHEN** the owner invokes `browser.signin` for a site and a resident tab is already on that site's sign-in page
- **THEN** that tab is brought to the front without navigating it or opening a new tab

#### Scenario: No sign-in tab
- **WHEN** the owner invokes `browser.signin` for a site and no resident tab is on that site's sign-in page
- **THEN** code opens the site's fixed sign-in entry URL in the resident profile and brings the new tab to the front, leaving it open for manual sign-in

#### Scenario: Canvas SSO redirect
- **WHEN** a Canvas sign-in tab is already on the university's Canvas SSO app URL
- **THEN** the owner command focuses that tab without creating or navigating a tab; unrelated SSO apps and lookalike origins are not selected

#### Scenario: Concurrent owner clicks
- **WHEN** concurrent owner requests for the same site arrive in one host while opening sign-in
- **THEN** they share one operation and open at most one tab

### Requirement: The chat agent gets agent commands only
The registry SHALL be able to build an in-process MCP tool set for the chat agent that contains the L0 reads, the validated agent writes, `source.fetch` and the browser tools, and no owner-only command. It SHALL NOT contain `sync.run` (sync is started only by the owner, #128) or `audit.record`: audit entries for browser writes are written by the browser tools themselves, so an agent cannot record or forge an owner confirmation. The MCP stdio server SHALL likewise no longer list `audit.record`, and SHALL list the browser tools, so external agents (US-5) also act on Canvas and Ed only through code that checks, highlights and audits. Calls through it SHALL run with an agent context that can never carry owner authority, whatever the input says.

#### Scenario: Tool list
- **WHEN** the chat agent's tool list is built
- **THEN** it contains `autonomy.check` and `browser.submit` and does not contain `audit.record`, `sync.run`, `browser.signin`, or any autonomy settings, confirmation or planning settings command; MCP stdio likewise excludes `browser.signin`
