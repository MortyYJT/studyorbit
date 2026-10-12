# Protocol read adapter (Issue B)

The authoritative requirements are `openspec/changes/v1-protocol/`, tasks 2.1–2.3.
Issue B adds a read implementation for Issue A's `ProtocolRepository`; it creates no transport,
write path, authorization/citation service, dependency, domain field, table or migration.

## Mounting and continuation

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

`changes` mounts the existing `changesHandler` with a local size-bounded pass, followed by a protected, remeasured prefix. Its numeric cursor
remains exclusive, ascending and unchanged on empty results. The existing oversized first/later
behavior is retained. Unsafe snapshots fail without returning an advanced cursor. Source URLs and
locators, entity fields, run diagnostics, before/after snapshots and adapter failures all pass the
read boundary. Private paths, hidden solutions and raw/person objects are withheld. Redacting
identity/locator/hash fields would break their meaning, so those records are withheld instead.

## Trusted evidence and O4

Only a host supplies `EvidenceMetadata` records. Each binds a canonical source id, exact course id,
provider, exact text SHA-256, locator, optional one-based page, and optional legacy source alias.
The adapter checks the binding against the current M1 source row and hash. Multiple matches,
legacy aliases colliding with an existing canonical row, stale hashes, mismatched course/provider,
and contradictory page/locator values fail closed. No course code/title comparison or automatic
cross-provider merging exists. The canonical M1 course/source identities remain authoritative.

Only metadata-proven `page:N` or `page N` becomes `page N`; Q1 proposal citation locators and
proposal/review hashes remain unchanged. A material without verified metadata reports unsupported
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
course/week/revision/assessment filters, requested page bounds and supplied source evidence, and
withholds accepted prose that would change under redaction. Accepted adapters own their opaque
filter-bound continuation. Missing revision/practice adapters return `UNSUPPORTED` coverage;
missing proposal adapters fail with `SOURCE_UNAVAILABLE`. B does not create file/SQLite accepted
persistence or manufacture accepted records. Q1 live reads and D audit reads have explicit optional
ports; absent Q1 fails unavailable and absent audit reports unsupported. Authentication expiry
retains `AUTH_EXPIRED` through Issue A, with no password prompt or token fallback.

## Integrated and pending paths

- Integrated: M1 current courses/assessments/tasks/source items and run tables in SQLite; existing
  M1 change ledger/handler; M1 deterministic redactor; A contracts/ReadCommand/registry dispatch.
- Integrated through injected trusted seams: canonical/legacy source identity and PDF page metadata,
  explicit entity-source links, accepted revision/practice/proposal reads, audit and Q1 read ports.
- Pending: real M1 PDF extraction/private page metadata producer (absent in this checkout), Canvas
  material ingestion, completed sync orchestration/run finalization, D's accepted/audit private-file
  compatibility backend and identity-map producer, and production managed-profile Q1 read mounting.
  Existing stored run measurements are returned unchanged; historical missing measurements stay
  absent. No time, request, cost or extraction-accuracy value is estimated by reads.
- Not verified: live Canvas/Ed, real PDF extraction, production identity records, browser/authentication
  acceptance, CI, transports or deployment. All new fixture data is independently synthetic.

## Verification evidence

- Red: `npx vitest run test/store/reads.test.ts` exited 1: `db.query is not a function`.
- Green after queries: the same command exited 0, 1 test passed.
- Red: `npx vitest run test/protocol/reads.test.ts` exited 1: read adapter module absent.
- Green targeted: `npx vitest run test/protocol/reads.test.ts test/store/reads.test.ts` exited 0,
  2 files / 15 tests passed. These cover real in-memory SQLite plus synthetic trusted/accepted ports.
- Independent review initially found encoded private-path and flat person-snapshot leaks. Two
  behavioral regression tests failed before fixes and passed afterward. Round 2 returned ready to
  merge. An additional oversized-event regression failed with the wrong privacy error before the
  two-pass changes integration restored `LIMIT_EXCEEDED` and passed.
- Focused independent review of the final changes integration: ready to merge; independent
  targeted rerun: 2 files / 15 tests passed.
- Final `npm run check`: exit 0; TypeScript passed, 68 test files passed, 704 tests passed,
  2 skipped. `openspec validate v1-protocol --strict` and `git diff --check`: exit 0.
