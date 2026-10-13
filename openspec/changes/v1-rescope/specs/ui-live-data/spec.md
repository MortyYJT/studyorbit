## ADDED Requirements

### Requirement: Read-only local view over real data
`coursework ui` SHALL serve the existing prototype page from the same loopback process as the HTTP transport and open it in the system browser, printing the URL if opening fails. The page SHALL load courses, assessments with effective values and their origins, platform items, the grade projection and the current plan only through the registry's L0 read commands over HTTP, and SHALL show nothing from the prototype's built-in sample data once real data loads. Settings edits, if offered, SHALL go through the owner settings command; all other views are read-only. The server SHALL bind `127.0.0.1` only and keep the HTTP Host/Origin checks.

#### Scenario: Real data replaces samples
- **WHEN** the store holds one synthetic course with two items and the owner opens the UI
- **THEN** the calendar shows those two items and none of the prototype's sample courses

#### Scenario: Empty store
- **WHEN** the store is empty
- **THEN** the page says no data has been synced yet and how to run `coursework sync`, instead of showing samples

### Requirement: Evidence and gaps are visible
Every agent- or sync-derived value shown in the UI SHALL show its origin and allow opening its citation quote. Unknown weights, unknown exam classification, overflow and unestimated work SHALL be displayed as such, never hidden or filled with defaults.

#### Scenario: Unknown weight
- **WHEN** an assessment has no effective weight
- **THEN** the UI shows the weight as unknown and the grade projection as unavailable for that reason
