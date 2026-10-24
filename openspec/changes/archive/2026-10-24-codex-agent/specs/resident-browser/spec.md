## MODIFIED Requirements

### Requirement: Agent browser actions are visible
Code that clicks or types on the owner's behalf SHALL go through one helper that brings the window to the front, outlines the target element in red, waits one second, and then acts (#98). The helper SHALL refuse to act on an element that is not visible. Agents that use our browser tools SHALL get the same rule through those tools, and through them SHALL read raw pages only where the privacy red line allows it: quiz and workshop pages may be read unredacted (#112), and discussion pages are never read raw. Read-only API calls are exempt. The Codex agent, which acts on the owner's own Edge through its computer-use feature and not through our tools, is outside this rule: its on-screen actions are not outlined, delayed or audited by our code, and what it sees is not redacted (accepted by the owner, #168); it is instructed to stop before any final submit (#173). Removing the resident browser and these tools is sub-project 3 (`codex-browser-cleanup`).

#### Scenario: Highlighted click
- **WHEN** code clicks a synthetic button through the helper
- **THEN** the button is outlined, at least one second passes, and then exactly one click happens

#### Scenario: Hidden target
- **WHEN** the target element is not visible
- **THEN** the helper refuses without clicking and reports the reason
