## ADDED Requirements

### Requirement: Prove Canvas student-session JSON reads first
M1 SHALL begin with a synthetic-tested spike followed by an owner-login-gated read-only check of assignments, assignment groups, owner submissions/grades, modules and files through same-origin `/api/v1` GET inside the managed Canvas page using browser-session credentials. It MUST NOT use a self-issued token, bearer header, external HTTP client or all-student submission enumeration. The spike SHALL verify JSON structure and pagination coverage, retain raw data only in private local storage and record content-free status/type evidence. Missing login/login redirect/401/403 SHALL return `AUTH_EXPIRED` with owner login/MFA guidance and no credential prompting or auth retry. Persistently blocked authenticated reads SHALL stop Canvas implementation and require asking the owner before HTML parsing.

#### Scenario: Authenticated student spike
- **WHEN** the owner has logged in and required selected-course student GETs return usable JSON
- **THEN** the spike records measured readable collections and field/types, with raw JSON only under the private data directory

#### Scenario: Owner login needed
- **WHEN** the spike has no valid login or encounters login redirect/401/403
- **THEN** it reports `AUTH_EXPIRED`, performs no password/MFA handling, and leaves live proof unverified

#### Scenario: Authenticated reads blocked
- **WHEN** a confirmed logged-in student session still cannot read required JSON collections
- **THEN** Canvas implementation stops and asks the owner before any HTML fallback, without treating synthetic tests as live proof

### Requirement: Sync selected courses with bounded session transports
Sync SHALL reuse saved source-qualified selection, managed-profile browser identity/lock/lifecycle and the shared limiter. Missing/invalid non-TTY selection SHALL return `INVALID_INPUT` before browser launch; empty selection SHALL schedule no reads. All discovery/bootstrap/API/pagination/PDF attempts including failures SHALL share the 300-attempt cap, at least one second after completed attempts including snapshot writes, and no automatic retry. Canvas JSON data requests and their pagination SHALL be same-origin `/api/v1` GETs scoped to selected courses, with no credential-bearing URL, off-origin redirect or loop. PDF GETs SHALL instead follow `course-materials` selected-link, same-origin session and shared-limiter rules; their paths need not be under `/api/v1`. Ed SHALL reuse the merged `EdTransport` with page-local `authToken:au`/`x-token`, courses-only `/api/user`, selected lesson/attempt/referenced-slide reads, first thread-list page and resources. It MUST omit `view`, avoid renewal/Bearer/cookie-only fallback and never expose auth material. Provider expiry SHALL stop only that provider and report `AUTH_EXPIRED`; other source gaps SHALL be sanitized. Raw JSON SHALL remain private with safe metadata, never logs or model envelopes. All owned tabs/listeners/locks SHALL be released on exit.

#### Scenario: Saved scope and Ed reuse
- **WHEN** synthetic selection includes Canvas 101 and Ed 202 but not course 303
- **THEN** no 303 detail is requested, Ed uses the existing no-view transport and no token/auth header reaches files or output

#### Scenario: Missing and empty selection
- **WHEN** non-TTY sync has no valid saved selection, or has a valid empty selection
- **THEN** the former returns `INVALID_INPUT` without launch/reads and the latter schedules no reads without prompting

#### Scenario: Unsafe pagination
- **WHEN** a Canvas next link is off-origin, credential-bearing, cyclic or for an unselected course
- **THEN** no unsafe request starts and the affected collection reports incomplete coverage

#### Scenario: Expired source and shared cap
- **WHEN** Ed expires while Canvas is usable, or the shared budget reaches 300 attempts
- **THEN** expiry stops only Ed, Canvas can continue within budget, and no 301st attempt or automatic retry occurs

#### Scenario: View refusal and cleanup
- **WHEN** an Ed slide refuses no-view reads or a run is canceled/fails
- **THEN** unavailable coverage is recorded without `view=1`, prior artifacts remain and owned resources are released

### Requirement: Normalize only evidenced domain facts
Sync SHALL validate untrusted responses and normalized entities with zod and use stable provider/origin/external identities. Every extracted claim SHALL retain trusted source text and locator evidence in redacted SourceItems/private operational bindings. It SHALL map assignments, explicit grading/weight evidence, due dates, owner scores/status, modules/files and recognized Ed lesson structure without adding Course/Assessment/Task/Citation fields. Effective Ed due dates SHALL take precedence over base due dates when present. Scores SHALL become percentages only with verified finite positive denominators. Missing required weights, unsupported grading rules or unknown assessment classification SHALL produce coverage gaps rather than fabricated values. Sync MUST NOT guess exam/final/hurdle status, evenly divide group weight, set missing weight to zero, merge providers by name/code, declare `assessmentsComplete` without explicit evidence or overwrite owner-managed tasks/modules/fields.

#### Scenario: Stable factual normalization
- **WHEN** synthetic verified data supplies a weight, owner score denominator, effective due date and submission evidence
- **THEN** repeated normalization produces the same identities and validated facts with redacted source-text provenance

#### Scenario: Unsupported model need
- **WHEN** a source lacks required weight or its grading/classification cannot be represented without guessing or a new field
- **THEN** safe source evidence is retained where possible, Assessment publication is withheld, coverage is incomplete and the concrete model need becomes an open question

#### Scenario: Owner and provider identity preservation
- **WHEN** Canvas and Ed share a course code and an existing task/module contains owner input
- **THEN** provider identities stay distinct absent an approved mapping and sync does not overwrite owner-owned data

### Requirement: Redact deterministically before normalized persistence and model access
Redaction SHALL be default-on and deterministic, harvesting nested author/people names before processing scope text, combining email/student-number/phone patterns, validated private owner rules and a staff-name allow-list. It SHALL strip classmates' identifiers from all persisted/exposed textual fields, URLs/locators, material pages and change payloads, suppress unnecessary profiles and hash only redacted semantic text. Staff-name exceptions MUST NOT exempt contact identifiers or secrets. Unsafe/unverifiable data SHALL be withheld, with sanitized errors. Raw snapshots/PDFs SHALL remain private exceptions, never model data. Agent calls MUST NOT bypass this boundary or invoke a model for redaction.

#### Scenario: Nested authors and free text
- **WHEN** synthetic later records identify names appearing in earlier titles/text/URLs, alongside email/student-number/phone sentinels
- **THEN** the whole validated scope is redacted before normalized writes/events/output and none of the identifiers survive

#### Scenario: Owner rule and staff allow-list
- **WHEN** synthetic text includes a configured private identifier and an allow-listed staff name with a contact address
- **THEN** the rule removes the identifier, the staff name is retained and its contact address is removed deterministically

#### Scenario: Redaction cannot be verified
- **WHEN** input/configuration is malformed or model safety cannot be established
- **THEN** no unsafe normalized value or event is published and no raw fallback or redaction bypass is offered

### Requirement: Preserve Q1 safety during M1 integration
The shared redaction/source/ledger boundary SHALL preserve `ed-quiz-assist` stable question/source identities, trusted redacted source lookup, answered-question and material citation obligations, NFKC/whitespace/quote matching, validated locator/offset/page metadata and safe citation-failure ledger entries. Existing policy/per-assessment grant caps, exam restrictions, exact-revision review and append-only audit SHALL remain enforced. Changed source text/hash SHALL invalidate stale review before fill. M1 MUST NOT rewrite audit history, manufacture grants/approval, add submission behavior or implement M2's grant/audit migration. If Q1 code is unavailable, integration SHALL be verified against a synthetic consumer without claiming shipped Q1 compatibility.

#### Scenario: Q1 citation and source replacement
- **WHEN** shared redaction changes a synthetic question's trusted source text
- **THEN** unchanged valid references still resolve, citation mismatches reject with `CITATION_MISMATCH`, safe failures reach the ledger and stale review is rejected with `CONFLICT`

#### Scenario: Authorization and audit preserved
- **WHEN** M1 integrates with a synthetic Q1 consumer with revoked grant, prohibited policy, exam or unavailable pre-mutation audit
- **THEN** Q1 still denies the relevant write/fill and prior grants/append-only audit are not rewritten
