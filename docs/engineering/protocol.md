# Protocol (M2) reference

How the implemented `v1-protocol` seams fit together, for M2 integration and M3 consumers.
Behaviour is specified in `openspec/changes/v1-protocol/` (until archived, then `openspec/specs/`);
this file describes the code. Section letters (A–H) match the change's task groups. Group I (production wiring) is not merged yet.

| Concern | Code | Section |
| --- | --- | --- |
| Command contracts, registry, dispatcher, fakes | `src/protocol/contracts.ts`, `registry.ts`, `context.ts`, `fakes.ts` | 1 |
| Current-state reads and trusted evidence | `src/protocol/reads.ts`, `src/store/queries.ts`, `src/store/accepted-records.ts` | 2 |
| Exact citation validation | `src/citations/exact.ts`, `src/protocol/citations.ts` | 3 |
| Authorization, audit, run journal, Q1 compatibility | `src/protocol/authorization.ts`, `audit.ts` | 4 |
| CLI transport | `src/protocol/cli.ts` | 5 |
| HTTP transport | `src/protocol/http.ts` | 6 |
| MCP transport | `src/protocol/mcp.ts` | 7 |
| Validated study writes | `src/protocol/writes.ts`, `study-writes.ts` | 8 |

## 1. Contracts and registry (A)

The specification remains `openspec/changes/v1-protocol/`. This guide describes the implemented
contract seam for M3 and subsequent M2 issues; it does not select production storage or transports.

- `src/protocol/contracts.ts`: the keyed `contracts` table, `CommandName`, `CommandInput<N>`
  (wire input, including omitted defaults), `ParsedCommandInput<N>` and `CommandOutput<N>`.
  `envelopeSchema(name)` validates the corresponding success/failure envelope. Failure codes and
  retryability reuse `errors.ts`; no new wire error codes were introduced.
- `src/protocol/registry.ts`: `Registry`, `RegistryEntry`, `createRegistry`, `dispatch`, and
  explicit `adaptLegacyHandler`. Entries contain exactly name/input/output/handler/level.
- `src/protocol/context.ts`: host-injected repository, service, evidence, authorization, privacy,
  owner interaction and audit/run ports. Repository access never opens SQLite
  from a handler. Only trusted host code creates this context; request fields cannot create it.
- `src/protocol/fakes.ts`: independent synthetic `examples`, `FakeRepository`, `FakeServices`,
  `createFakeRegistry` and `createFakeContext`.

A minimal fake-data consumer:

```ts
import { contracts, envelopeSchema, type CommandInput } from '../../src/protocol/contracts.js';
import { dispatch } from '../../src/protocol/registry.js';
import { createFakeContext, createFakeRegistry, examples } from '../../src/protocol/fakes.js';

const registry = createFakeRegistry();
const context = createFakeContext();
const request: CommandInput<'courses.list'> = examples['courses.list'].input;
const response = await dispatch(registry, 'courses.list', request, context);
envelopeSchema('courses.list').parse(response);
if (response.ok) {
  const page = contracts['courses.list'].output.parse(response.data);
  // page.items, page.evidence, page.coverage.gaps; page.nextCursor when continuation exists.
}
```

New list cursors are bounded opaque base64url-compatible tokens. Clients echo them unchanged and
never derive offsets or identities from them. A missing `nextCursor` means there is no continuation.
Repository implementations own token validity and filter binding; fake repositories return cloned
fixed examples and deliberately do not implement production filtering/paging.

Study writes use cited claim units; breakdown uses a strict, bounded copy of M1 Task with its
existing refinements.

Source evidence text is validated without trimming or other normalization. Its hash and citation
UTF-16 offsets refer to the exact redacted text returned by the trusted evidence service. The same
rule applies to `sources.get`, material items and evidence embedded in paginated reads.

`policy.record` returns `{ recorded: 'policy', policyRef, courseId, status, cap, recordedAt }`;
`grant.record` returns `{ recorded: 'grant', grantRef, courseId, assessmentId, category, level,
recordedAt }`. References are SHA-256 digests of the recorded policy/grant supplied by the trusted
recording service; timestamps are ISO UTC datetimes from that service's recording event. Metadata
describes the current recorded state, not permission to fill or submit. Prohibited policy receipts
require cap 1; allowed/owner-attested receipts require cap 2–4. Production record/hash/time resolution
remains D.

The owner commands are policy and grant recording.
They require `context.owner.assertOwner` even though their registry minimum is L0. Every dispatch
also calls the injected authorization service. Study write commands call the injected
evidence service. Production services must perform the corresponding publication/action safety
checks; registry levels and schema success do not grant authorization or verify citations.

Fake contexts are fixture hosts only: their authorization/evidence services are permissive test
stubs and `owner: true` selects a host-side fake capability, never a wire field. Fake services log
cloned inputs and return fixed schema-valid receipts; they do not claim durable publication.
Fake privacy uses the existing default-on redactor. Inject the actual trusted scope in production.
Audit and run sinks receive only safe command/run/phase/code metadata from the dispatcher; their
ports also allow optional target/revision/policy/grant references resolved by trusted D/H services.
Unknown requested command text is withheld from envelopes and journals.

Dispatcher failures preserve existing error codes/retryability while replacing raw messages with
safe diagnostics (`AUTH_EXPIRED` still directs the user to sign in). Final metadata is applied
before serialization is checked against the existing 64 KiB bound, including multibyte text.
Invalid output is withheld, and output is validated again after the injected privacy boundary.

## 2. Reads and trusted evidence (B)

The authoritative requirements are `openspec/changes/v1-protocol/`, tasks 2.1–2.3.
Issue B adds a read implementation for Issue A's `ProtocolRepository`; it creates no transport,
write path, authorization/citation service, dependency, domain field, table or migration.

### Mounting and continuation

A trusted host assigns `new StoreProtocolReads(store, evidence, ports)` to `context.repository`.
Use `TrustedStoreEvidence(store, { privacyScope, metadata })` for evidence. Inject the harvested
identity scope from ingestion; do not feed request data into that configuration. The read boundary
uses M1 `createRedactor` without an owner bypass or staff allow-list. The existing dispatcher still
validates contracts, invokes authorization/audit/run ports and constructs the final envelope.
Those services are independent and are not supplied by this read adapter.

`src/store/queries.ts` defines a separate `CurrentStateReader` capability implemented by
`SqliteRepository.query`. Keeping this capability separate avoids changing existing M1 write-only
repository consumers. Queries validate limits (1–500), strict collection-specific filters, and use
bound SQL values. They read current tables, order by id, and fetch at most limit + 1 rows. Cursors
encode a version-independent filter digest and the last key; they are neither credentials nor
snapshots. Clients echo them unchanged. Changed filters, malformed/noncanonical cursors and
unsupported token lengths fail safely. Concurrent insertions before the consumed key are outside
that continuation; refresh from the start to see them. No offset paging or schema migration occurs.

Protocol entity/material lists build fitting prefixes, with continuation at the last consumed key.
A first oversized item fails with `LIMIT_EXCEEDED`; later oversized items remain pending. The
new-list budget reserves 1 KiB for envelope metadata. Material page filters are bound into the
cursor separately from SQL criteria: page metadata lives in the trusted evidence port, not a new
M1 column. A page can contain no material items but still have a continuation when scanned sources
have a different page or unsupported coverage. Continue until `nextCursor` is absent.

### Trusted evidence and O4

Only a host supplies `EvidenceMetadata` records. Each binds a canonical source id, exact course id,
provider, exact text SHA-256, locator, optional one-based page, and optional legacy source alias.
The adapter checks the binding against the current M1 source row and hash. Multiple matches,
legacy aliases colliding with an existing canonical row, stale hashes, mismatched course/provider,
and contradictory page/locator values fail closed. No course code/title comparison or automatic
cross-provider merging exists. The canonical M1 course/source identities remain authoritative.

Only metadata-proven `page:N` or `page N` becomes `page N`. A material without verified metadata reports unsupported
coverage, rather than guessing a PDF page from a title or URL. Non-material normalized M1 sources
can use their canonical id as locator. Hashes cover the exact returned text, including whitespace;
M1 `contentHash` covers other fields and is deliberately not used as a citation text hash. Persisted
source text requiring further redaction is withheld so existing offsets/hashes cannot silently drift.
Source lookup never opens a raw capture or private material file.

Tasks resolve their recorded citation source ids in their course. Course/assessment schemas lack
source links; an optional trusted `entitySources` port can supply explicit links. Otherwise reads
report `MISSING_EVIDENCE`. Incomplete course assessment enumeration reports `INCOMPLETE`.
The adapter reports provenance/coverage, not citation membership or answer correctness (Issue C).

`src/store/accepted-records.ts` supplies the read-only accepted-record port for D's eventual
backend. Hosts may inject synthetic A/D adapters now. B revalidates accepted output schemas,
course/week/revision filters, requested page bounds and supplied source evidence, and
withholds accepted prose that would change under redaction. Accepted adapters own their opaque
filter-bound continuation. Missing revision/practice adapters return `UNSUPPORTED` coverage;
B does not create file/SQLite accepted persistence or manufacture accepted records. D audit reads
have an explicit optional port; absent audit reports unsupported. Authentication expiry
retains `AUTH_EXPIRED` through Issue A, with no password prompt or token fallback.

### Integrated and pending paths

- Integrated: M1 current courses/assessments/tasks/source items and run tables in SQLite; existing
  M1 deterministic redactor; A contracts/ReadCommand/registry dispatch.
- Integrated through injected trusted seams: canonical/legacy source identity and PDF page metadata,
  explicit entity-source links, accepted revision/practice reads and audit ports.
- Pending: real M1 PDF extraction/private page metadata producer (absent in this checkout), Canvas
  material ingestion, completed sync orchestration/run finalization, D's accepted/audit private-file
  compatibility backend and identity-map producer.
  Existing stored run measurements are returned unchanged; historical missing measurements stay
  absent. No time, request, cost or extraction-accuracy value is estimated by reads.
- Not verified: live Canvas/Ed, real PDF extraction, production identity records, browser/authentication
  acceptance, CI, transports or deployment. All new fixture data is independently synthetic.

## 3. Citation validation (C)

`src/citations/exact.ts` provides `validateCitation(input, trusted)` and the unchanged Q1
`hash` / `normalizeCitation` helpers. The input is the existing strict Citation shape:
`sourceItemId`, `quote`, `locator`. Trusted evidence contains those source identifiers,
the original redacted `text`, its SHA-256 `sourceHash`, and optional verified `page`.
Do not obtain that evidence from request fields. Invalid quotes, identifiers, locators,
metadata or stale text hashes throw the safe `CITATION_MISMATCH` error.

Matching uses NFKC on both strings, unified single/double quotation characters and collapsed
whitespace, with a nonempty, case-sensitive exact substring. It chooses the first occurrence.
Offsets are zero-based UTF-16 indices into the original trusted text, with exclusive `end`.
Grapheme mapping retains combining characters, surrogate pairs and compatibility expansions;
a match inside an expanded grapheme maps to that entire original grapheme. Hashes cover the
original redacted text, not its normalized projection. A supplied trusted PDF page must agree
with `page:N`; the study adapter also rejects page locators without a verified page number.

`StudyCitationService` in `src/protocol/citations.ts` accepts a host-injected
`StudyEvidenceProvider.resolve(target)`. The provider independently resolves the canonical
course/assessment binding, current `sourceRevision` and target-scoped `SourceEvidenceSchema`
records. A breakdown request's claimed course must be checked against the assessment's actual
course by this provider, not echoed from the request. Course study targets need no assessment.
The service verifies the returned target/revision, rejects duplicate or wrong-course sources,
and validates every Task step, revision claim and practice explanation under issue A's schemas.
It never consumes request-supplied source text, offsets, hashes or PDF page assertions.

`validate(command, input)` returns ordered `units` (text and verified citations), flattened
`citations` and a provenance-only `limitations` notice. It does not modify the input or persist
records. `check(command, input)` implements issue A's EvidenceService seam for the three study
writes only; unsupported commands fail with `SOURCE_UNAVAILABLE`. Compose with other evidence
adapters rather than installing it as a permissive all-command service.

H (section 8) composes authorization, privacy, durable audit/run recording and publication-time
revision rechecks. This service alone neither publishes nor proves the correctness of a claim.
Real M1 evidence adapters remain issue B; persistence/transport/layout changes are out of scope.

## 4. Authorization and audit (D)

The behavior specification remains `openspec/changes/v1-protocol/specs/assessment-autonomy/`.
This implementation covers tasks 4.1–4.4. Transport wiring and evidence publication remain pending.

### Authority and lifecycle

`SharedAuthorization` implements the issue-A authorization port and exposes owner recording services.
`Q1AuthorizationStore` is the active file adapter: policy, grant and exact binding records are read
and written in the original private Q1 directory through `ProtocolFiles`. There is no SQLite migration,
activation flag, duplicate canonical record, deletion or fallback authority. Existing snapshots,
materials, proposal/revision records, approvals and logs stay where they are. Owner recording uses a host-established owner interaction.

Hosts supply an `IdentityMap` with explicit canonical course IDs ↔ Ed course IDs and canonical
assessment IDs ↔ complete Q1 bindings. Mapping must be one-to-one on both sides, including the Ed
course/lesson pair. No course title is accepted as mapping evidence. Missing, ambiguous or mismatched
mapping/records deny the affected action. The map is host configuration, not request authority.
Production identity records are not available in this checkout; none are inferred or created.

Policy/grant references hash the existing validated private records, retaining Q1's references rather
than hashing their canonical translations. Canonical recording receipts report the requested canonical
IDs; A grant is activated only with its exact binding. Existing bindings are not rewritten on grant updates. New grants are saved before a missing binding
is activated, so an old orphan cannot gain permission during a failed replacement. Post-install
durability or partial activation failures report `UNCERTAIN`. An orphan grant, mismatched binding or partial log
fails closed. Lowering the existing grant to L0/L1 revokes answering authority without deleting history.
L0/L1 study assistance needs no policy/grant; L2–L4 requires both, within the cap, with exact course,
assessment and trusted category. Exams and unknown categories cannot authorize above L1.

The adapter has no migration to resume or roll back. A future backend requires a separate approved
migration/retention/rollback decision and must switch authority atomically while retaining Q1 evidence.
Do not silently fall back to another backend after an adapter failure.

Passing the synthetic tests does not verify a real course policy, owner approval, browser fill,
university endpoint or production acceptance.

### Host wiring

Construct `Q1AuthorizationStore(files, identityMap)`, `DurableAudit(files)` and
`SharedAuthorization(store, audit)`; inject the service as `context.authorization`. Its `services`
port mounts only `policy.record` and `grant.record`. Compose
other write services explicitly in H/I; unsupported writes fail unavailable. Owner recording rechecks
a host-established `OwnerInteraction`, even when invoked outside the dispatcher, holds the shared
Q1 mutation lock, records intent before publication and records outcome before returning success.
Hosts must establish actual owner interaction; an agent argument is never a capability.

`DurableAudit.record` validates strict safe metadata and fsyncs the existing append-only audit log.
`list` reads both issue-A audit records and Q1 version-1 lines without modifying history. Legacy Ed
assessment references remain provider-qualified rather than being guessed into canonical identities;
legacy line IDs are stable hashes. Q1-specific review metadata remains in the original log.
`ProtocolFiles.readLog` uses the same private-path, ownership, link, size and permissions checks as record
reads and refuses malformed or truncated logs. Paginated `audit.list` repository wiring remains I/B;
D supplies validated records, not a second command registry.

`DurableRuns` appends existing RunSchema records to the separate runs journal. It measures local start
and completion timestamps; its own workflow has zero internal steps. It does not invent pages,
requests, costs, accuracy or ingestion coverage. An intent probes durable ledger availability before
mutation. Citation failures are recorded as safe error codes, with no rejected text.

The dispatcher collects optional target/version references from the trusted authorization service.
Intent recording failure prevents handler execution. A successful write followed by required audit
or ledger completion failure returns `UNCERTAIN` with `retryable: false`, preserves the actual state,
and never invokes the handler again. Inspect private state before another attempt. `UNCERTAIN` is an
additive failure code supported by the common envelope, audit schemas and legacy adaptation. Reads
still report recording failure without claiming a mutation. Wrong-target policy/grant receipts are
withheld as `INTERNAL`; a recording receipt itself never authorizes an action.

## 5. Generated CLI (E)

`parseProtocolCLI(args, { registry, context, stdout, stderr, isTTY })` in
`src/protocol/cli.ts` generates nested Commander commands from registered dotted names
(`courses.list` becomes `coursework courses list`). Fields become kebab-case flags; numbers
and explicit `true`/`false` booleans are strictly decoded, structured fields take JSON, and
Zod remains authoritative for defaults, bounds and refinements. Discriminated-union fields
are collected without choosing a variant. `--input <path>` supplies a strict JSON object
instead of field flags; it accepts regular files only and bounds both stat and actual read
to 4 MiB. `--json` is accepted; every generated invocation emits one bounded JSON envelope,
including help as `{ usage }`, and safe diagnostics use stderr.

Owner entries need a host TTY and owner capability; CLI flags cannot provide either.
No CLI adapter prompts for credentials. New command ports remain explicitly unmounted
(`SOURCE_UNAVAILABLE`) until Issue I.

## 6. Loopback HTTP (F)

`src/protocol/http.ts` exports `startHttpTransport`, `HttpOptions`, `HttpTransport` and
`httpStatus`. Inject the same registry and trusted context used by `dispatch`; the adapter selects
no production repository/service. The returned host handle has `origin`, `capabilityFile` and an
idempotent asynchronous `close()`. Read the capability file only in a trusted local client and
supply it in `X-Coursework-Capability` for mutations and owner commands. Do not serialize the host
handle, expose the file/token to a model, or log that header. Ordinary reads use JSON POST too.
Exact security, limits, timeouts and status conventions are recorded in the OpenSpec design's
“Issue F: selected HTTP conventions (O5)” section. No CLI entry point, UI or production mounting
is supplied. Actual shared B/D/H service and O6 integration remains issue I/H work.

## 7. Stdio MCP (G)

Run `coursework mcp` (after `npm run build`, `node dist/cli.js mcp`) and configure an MCP
client to launch that command over stdio. The server is the official
`@modelcontextprotocol/sdk` `McpServer` with `StdioServerTransport`; there is no custom
handshake. Stdout carries only newline-delimited JSON-RPC frames; startup, per-call failure
codes and shutdown diagnostics go to stderr, and stray `console.log` output is redirected
there. The process exits cleanly when the client closes stdin. Inbound frames are bounded to
the same 4 MiB as CLI `--input`.

`createMcpServer({ registry, context, stderr, version })` and `runMcpStdio({ ..., stdin,
stdout })` in `src/protocol/mcp.ts` generate one tool per registry entry with the same dotted
name. Each `inputSchema` is `z.toJSONSchema(entry.input, { io: 'input' })`; union roots are
wrapped as `type: object`. The advertised schema is a hint only: the SDK does not validate
arguments, and every `tools/call` runs `dispatch()` exactly once, so zod refinements,
authorization, evidence, privacy and the 64 KiB envelope bound stay authoritative. The result
is one text content item holding the `coursework.agent/v1` envelope, with `isError` set on
failure. Unknown tools return `NOT_FOUND` for command `unknown`; raw errors and input are not
echoed.

The host-owned context is passed without its `owner` capability, so policy and grant recording
commands are always refused
with `INVALID_INPUT`; no argument can grant owner authority and nothing prompts for credentials.
The executable still uses the fail-closed `unavailableCLIContext` (`SOURCE_UNAVAILABLE`) until
Issue I wires production ports. Hermes mounting/scheduling remains M4.

## 8. Validated study writes (H)

- `ComposedServices` and `ComposedEvidence` (`src/protocol/writes.ts`) route each write command to its owning
  service and evidence check explicitly; an unrouted command fails `SOURCE_UNAVAILABLE` instead of being accepted.
- `StudyWriteService` (`src/protocol/study-writes.ts`) accepts cited breakdown, revision-note and practice writes
  through the shared citation validator (section 3) against host-provided, target-scoped evidence. The evidence
  provider resolves the course, so a mismatched `task.courseId` is rejected. The previous accepted record is kept by
  compare-and-swap. `InMemoryStudyRecordStore` is the only store; durable tables need owner approval.

## Resident browser (issue #87)

Run `coursework browser start` in the owner's terminal, sign in to Canvas and Ed by hand,
then use `coursework browser status`. `coursework browser stop` closes the managed browser.
Start/stop are owner-only registry entries, hidden from MCP and refused from non-TTY CLI calls.
Status is L0 on CLI, MCP (`browser.status`) and the existing HTTP transport
(`POST /api/browser.status` with `{}`); it requires no owner capability. Other production
ports remain unmounted until protocol integration.

The implementation launches the detected executable with a custom managed profile and an
OS-selected CDP port bound to `127.0.0.1`. It reads `DevToolsActivePort`, records private
`browser.json` (0600), and transfers `profiles/default.lock` to the browser PID. A detached
observer removes dead resident state and the lock after browser exit; start/status also
recover dead state. Start returns the same private host endpoint on reuse, while its protocol
receipt includes only `running`, `browser` and `startedAt`. Stop retains ownership if the
process does not exit. No fallback is selected: custom-profile CDP is the shipped mechanism;
actual platform behavior still requires the owner's live check (task 3.5).

Browser selection reuses the capture detector and `COURSEWORK_BROWSER`. Browser CLI failures
exit 1, invalid overrides exit 2, and locked profiles exit 3 with the holder PID. Recovery
messages are restricted to known detector messages; arbitrary exceptions are withheld.
The endpoint is never part of an envelope or log. Cookies and Ed tokens stay inside pages.

`withResidentBrowser` attaches with Playwright `chromium.connectOverCDP` (`noDefaults: true`),
exposes only creation of owned tabs, closes those tabs in a finally block, and disconnects
without closing the resident context. A missing resident returns one `AUTH_EXPIRED` envelope
with `coursework browser start` in its recovery message. It launches and prompts nothing.
Consumers must return only validated, privacy-safe data through their registry contracts.

Status uses a fresh owned page for each provider and returns `canvas` and `ed`, each with
`state` (`signedIn`, `signedOut`, `unknown`) and `checkedAt`. Signed-out sites also carry
an `AUTH_EXPIRED` hint for manual sign-in. Canvas checks same-origin GET `/api/v1/users/self`
with session cookies. Ed checks the page's regional `authToken:au|us|eu` and GET `/api/user`
with `x-token`, following the retained Ed transport rules. The host's Ed region defaults to
`au` and is injectable. Redirects and auth failures report signed out; unavailable checks
report unknown independently. Bodies are never read. Explicit navigations and API checks
use the shared injectable request limiter; no check renews a token or fills credentials.

`highlightThenClick(page, target, clock)` fronts the page, sets a red outline, waits at least
one second, rechecks visibility and clicks once. Hidden targets are refused. This helper
provides visibility, not assessment authorization: callers still need the course policy,
assessment grant and audit required by the autonomy specification.

Synthetic tests cover lifecycle, exit observation, detection errors, attachment ownership,
site checks, CLI/MCP and the HTTP routing callback without opening a socket, and highlighted
clicks. They do not establish real-browser CDP compatibility, actual loopback binding,
manual window visibility, university endpoint behavior or overnight session lifetime.

## Production composition after v1-rescope

`createProductionProtocol` mounts the real SQLite current-state reader, canonical owner policy/grant
files, append-only audit and separate run journals for CLI, MCP and loopback HTTP. Browser status
uses the resident attach path; lifecycle commands remain owner-terminal only. Missing study write
ports fail closed until the revision milestone installs durable study storage. No fill/submit gates,
Q1 services, proposal services or change-event adapters are mounted.

Canonical policy/grant files use `protocol-policy-<hash>` and `protocol-grant-<hash>` names inside
the existing private protocol file directory. SQLite supplies exact course/assessment identity and
classification. Legacy Q1 records remain unchanged and cannot activate canonical grants: the owner
must re-record policy and grants. Recording a level-zero grant revokes higher-level permission.

`autonomy.check` is L0 and accepts `{assessmentId, level}`. L0/L1 do not require answering grants;
L2–L4 require a recorded policy and exact grant within the course cap. Exams and unknown kinds
are denied above L1. Each valid check writes safe decision metadata with policy/grant hashes and
returns `{decision, reason}`; failed audit returns `denied` / `audit-unavailable`.

`audit.record` accepts only structural assessment IDs, L0–L4, action `fill|submit|other`, outcome
`success|failure|uncertain|violation`, and optional confirmation `owner-chat|owner-ui|owner-terminal`.
L4 submit without confirmation is recorded as `violation`. Its single action entry shares the
transport run ID and contains no answer text. These commands report agent actions, not code gates.
The assessment skill is at `skills/assessment/SKILL.md`.

Owner authority is established by the transport, never by request fields: CLI requires stdin and
stderr TTYs; MCP hides and refuses owner commands. HTTP strips host owner authority and grants only
`planning.settings.record` via its local capability token. That command is not mounted yet, so
production HTTP still refuses it. Future `annotation.owner.record` and `planning.settings.record`
are reserved owner-only names; registering other owner commands must extend `ownerCommands`.
