# M2 authorization and Q1 compatibility (Issue D)

The behavior specification remains `openspec/changes/v1-protocol/specs/assessment-autonomy/`.
This implementation covers tasks 4.1–4.4. Transport wiring, evidence publication and serialized
fill/submit/confirmation orchestration remain E–I; no browser or submit adapter is installed.

## Authority and lifecycle

`SharedAuthorization` implements the issue-A authorization port and exposes owner recording services.
`Q1AuthorizationStore` is the active file adapter: policy, grant and exact binding records are read
and written in the original private Q1 directory through `QuizFiles`. There is no SQLite migration,
activation flag, duplicate canonical record, deletion or fallback authority. Existing snapshots,
materials, proposal/revision records, approvals and logs stay where they are. Existing Q1 functions
use the same authorization decision rule and files; review preflight now also rechecks the recorded
policy/grant hashes. Owner recording/review keeps Q1's TTY confirmation, and real-read prerequisites
keep their specific 2026-10-12 attestation and repository-private verification.

Hosts supply an `IdentityMap` with explicit canonical course IDs ↔ Ed course IDs and canonical
assessment IDs ↔ complete Q1 bindings. Mapping must be one-to-one on both sides, including the Ed
course/lesson pair. No course title is accepted as mapping evidence. Missing, ambiguous or mismatched
mapping/records deny the affected action. The map is host configuration, not request authority.
Production identity records are not available in this checkout; none are inferred or created.

Policy/grant references hash the existing validated private records, retaining Q1's references rather
than hashing their canonical translations. Canonical recording receipts report the requested canonical
IDs; recording aliases translate through the explicit map and return their original Q1 receipt.
A grant is activated only with its exact binding. Existing bindings are not rewritten on grant updates. New grants are saved before a missing binding
is activated, so an old orphan cannot gain permission during a failed replacement. Post-install
durability or partial activation failures report `UNCERTAIN`. An orphan grant, mismatched binding or partial log
fails closed. Lowering the existing grant to L0/L1 revokes answering authority without deleting history.
L0/L1 study assistance needs no policy/grant; L2–L4 requires both, within the cap, with exact course,
assessment and trusted category. Exams and unknown categories cannot authorize above L1.

The adapter has no migration to resume or roll back. A future backend requires a separate approved
migration/retention/rollback decision and must switch authority atomically while retaining Q1 evidence.
Do not silently fall back to another backend after an adapter failure.

## Host wiring

Construct `Q1AuthorizationStore(files, identityMap)`, `DurableAudit(files)` and
`SharedAuthorization(store, audit)`; inject the service as `context.authorization`. Its `services`
port mounts only `policy.record` and `grant.record` (including the registry's Q1 aliases). Compose
other write services explicitly in H/I; unsupported writes fail unavailable. Owner recording rechecks
a host-established `OwnerInteraction`, even when invoked outside the dispatcher, holds the shared
Q1 mutation lock, records intent before publication and records outcome before returning success.
Hosts must establish actual owner interaction; an agent argument is never a capability.

`AutoSubmitSettings` is an optional host persistence port, deliberately without a new file/table
schema in D. No port means auto-submit is false and changing it is unavailable. Only an explicit,
audited owner action can call `setAutoSubmit`; the boolean removes no authorization gate and never
creates an L4 grant. H must consume this setting only at its confirmed submission boundary. Durable
production settings wiring is pending the host's approved settings backend; test settings are synthetic.

`DurableAudit.record` validates strict safe metadata and fsyncs the existing append-only audit log.
`list` reads both issue-A audit records and Q1 version-1 lines without modifying history. Legacy Ed
assessment references remain provider-qualified rather than being guessed into canonical identities;
legacy line IDs are stable hashes. Q1-specific review metadata remains in the original log.
`QuizFiles.readLog` uses the same private-path, ownership, link, size and permissions checks as record
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

## Verification

Fixtures are synthetic and live only in private temporary directories. Tests cover the authorization
matrix, revocation, missing/malformed records, exact maps, orphan activation, privacy-safe separate
journals, pre-mutation audit failure, completion uncertainty, wrong-target receipts and the complete
Q1 policy/binding/grant/snapshot/proposal/revision/review/log chain. Source/page/attempt review and
citation checks remain Q1's responsibility; passing these tests does not verify a real course policy,
owner approval, browser fill, university endpoint or production acceptance.

Recorded TDD and review evidence:

- Initial red: `npx vitest run test/protocol/authorization.test.ts`, exit 1: shared service module
  did not yet exist (no tests executed).
- Behavioral red: `npx vitest run test/protocol/recording-boundary.test.ts`, exit 1: all 3 tests
  failed (wrong policy/grant receipt targets were accepted; outcome recording failure returned INTERNAL).
- Q1 behavioral red: stale-policy and stale-grant approval tests both reached the downstream callback;
  an L1 recording without policy was refused. Each now passes.
- Review regression red: verified target refs were missing on authorization denial; updating an existing
  grant unnecessarily rewrote the binding. Both behaviors were reproduced and corrected.
- Final targeted green: `npx vitest run test/quiz/files.test.ts test/protocol test/quiz`, exit 0:
  19 files, 269 tests passed, including directory-durability and partial-publication uncertainty.
- Fresh-context read-only review: ready to merge for 4.1–4.4 after the above correctness fixes;
  review did not rerun tests or inspect any owner data.
- Final `npm run check`, exit 0: TypeScript passed; 68 test files passed; 714 tests passed,
  2 existing tests skipped (716 total).
- `openspec validate v1-protocol --strict` and `git diff --check`, exit 0. No dependency, CI,
  transport, database schema, handoff or decision-file change. No commit or publication performed.

Tasks 4.1–4.4 are checked; 4.5 and the whole change's integration/acceptance/archive remain unchecked.
