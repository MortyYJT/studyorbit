# Shared citation service (v1-protocol issue C)

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

`src/quiz/citations.ts` remains the Q1 facade, retaining its exports, strict version-1 answer
and trusted-source shapes, question provenance, statement coverage, conservative material reuse
checks and prompt-only limitation. It translates already trusted Q1 text/page evidence into
`validateCitation`; `FileEvidence` continues to check snapshot hashes, question locators and
course-scoped private materials. Attribution checks run across full answer/rationale fields
so statement splitting cannot hide an explicit material attribution (#84).

Issue H must compose authorization, privacy, durable audit/run recording and publication-time
revision rechecks. This service alone neither publishes nor proves the correctness of a claim.
Real M1 evidence adapters remain issue B; persistence/transport/layout changes are out of scope.
