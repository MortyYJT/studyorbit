Implementation follows this change as the sole M2 spec. Each implementation increment starts with a meaningful failing test on independently synthetic fixtures in `test/`, records red evidence, implements the smallest passing behavior and records targeted green output. No real course captures, passwords, tokens, profiles or redacted real quiz content enter fixtures. Every issue ends with a fresh-context read-only correctness/requirements review and `bash .claude/check.sh` (= `npm run check`) output. Review, live acceptance and archive are gates, not manufactured failing tests.

Claude resolves/records Open choices under #79, creates one GitHub issue/standalone clone per group, commits/pushes/opens PRs/merges after review and CI. Codex implements on `codex/<topic>` and never commits. Check actual private visibility before pushing answering/submitting implementation (#57). No unapproved dependencies, CI/deployment edits or destructive data migration. Any domain/storage change beyond the approved design/change needs owner approval. No milestone dates are invented. These tasks describe future implementation; this draft changes only `openspec/changes/v1-protocol/` and never `note/handoff.md`.

| Issue | Deliverable | Merge dependencies | Synthetic implementation seam |
| --- | --- | --- | --- |
| A | Registry, zod command schemas/contracts and dispatcher | M1 schemas already merged; contract choices O1/O2 (settled by #85) | Fake repositories/services/action adapters; no browser or transport dependency |
| B | M1/accepted-record reads and evidence lookup | A; relevant M1 store/material interfaces for real integration; O4 | Fake current state/evidence repositories |
| C | Shared #63 citation service | A | Trusted synthetic question/text/PDF-page providers |
| D | Policy/grant/audit and Q1 record compatibility | A; O3/O4 | Fake owner interaction, private temp records/audit sinks |
| E | Generated commander CLI and Q1 aliases | A | Stub registry handlers; existing Q1 CLI contracts |
| F | Generated loopback HTTP adapter | A; O5 | Stub registry/services and local synthetic HTTP requests |
| G | Official SDK stdio MCP adapter | A | Fake commands and synthetic stdio client |
| H | Validated writes and independent fill/submit gates | B, C, D; O2/O6; delivered Q1 issue D for real fill integration | Fake evidence, versioned persistence, review and action adapters |
| I | Full integration, acceptance and closeout | B–H; relevant M1/Q1 deliveries | Integrated synthetic workflow plus explicit owner read-only acceptance |

**Parallel release point:** A must merge first. After A, sync, protocol (B–H) and M3 UI (fake data against A) can run as at most three Codex lines in separate clones under one Claude coordinator (#76). B–G can be implemented and reviewed independently using A's fakes; no issue imports an unmerged peer implementation. H composes the interfaces only after B/C/D merge. E/F/G production wiring to H is finished in I; their own PRs do not promise unavailable real handlers. Upstream delivery is an integration gate, never a reason to bypass safety or stall independent synthetic TDD.

## 1. Issue A — Command registry and zod schemas/contracts first

Scope: shared protocol contracts/dispatcher and synthetic fakes; no production repository, browser, CLI/MCP/HTTP implementation. Covers `command-registry` contract/envelope requirements and schemas for all four capabilities.

- [x] 1.1 Reconcile merged M1 domain/envelope/Q1 interfaces and decisions (including #81 and #84). Apply the O1/O2 selections recorded in #85 when fixing command names, new record shapes and cursor contracts. Record baseline check output; no speculative domain migration.
- [x] 1.2 Write failing tests for duplicate/unknown commands, strict input/output schemas, existing error/envelope compatibility and all proposed read/write/policy/grant/review/fill/submit contracts; implement `{ name, input, output, handler, level }`, inferred types, registry interfaces and schema-valid fake examples. Preserve Q1 proposal/review shapes and minimum L0–L4 semantics.
- [x] 1.3 Write failing dispatcher tests for one execution, output validation, bounded safe envelope, privacy/authorization service invocation, safe pre-handler denials and legacy envelope adaptation; implement a transport-independent dispatcher with injected trusted context. Ensure owner authority cannot be parsed from request data.
- [x] 1.4 Write failing contract-consumer tests showing M3 fake reads, study writes and proposal/action outcomes validate without M1 ingestion, a real browser or later issues; publish interface/examples for repositories, evidence, owner interactions, audits and action adapters. Include unavailable adapter behavior without inventing endpoint support.
- [ ] 1.5 Run targeted green, fresh-context review, project check and diff/privacy checks; provide outputs for Claude's A PR. **Merge A before parallel sync/protocol/M3 work**, and hand off the exact contracts through files/GitHub.

## 2. Issue B — Bounded current-state reads and trusted evidence

Depends on A; O4 before identity translation. Scope: repository query interfaces/implementations and read handlers. No transport/business write code. Real PDF/run coverage depends on those M1 deliveries; synthetic implementation does not.

- [x] 2.1 Write failing synthetic repository tests for bounded filtered course/assessment/task/source/material/run reads, accepted revision/practice/proposal queries through A's interface, missing evidence and safe continuation; implement queries behind `src/store/` without changing M1 domain schemas. A/D can supply accepted-record repository fakes until the actual adapter exists.
- [x] 2.2 Write failing handler tests for trusted source-text provenance, PDF page/hash/locator resolution, missing/unsupported coverage and Q1/M1 source mapping; implement read/evidence adapters with verified O4 translation, never name-based course merging or raw capture exports.
- [x] 2.3 Write failing tests for sensitive sentinels across entity fields, locators, URLs, change snapshots and errors; reuse deterministic M1 redaction and withhold unsafe output. Mount the existing changes handler while preserving exclusive cursors and oversized-event behavior; expose actual ledger measurements only.
- [ ] 2.4 Run targeted green, fresh-context review and project check; document which M1 material/sync/run paths are integrated versus pending, with no live-read claim from fixtures.

## 3. Issue C — Shared deterministic citation service

Depends on A. Scope: reusable citation/evidence validation and Q1 compatibility facade; no persistence layout or transport changes. Covers #63 and quiz provenance requirements.

- [x] 3.1 Write failing synthetic tests for NFKC, quote/whitespace normalization, empty/nonmember quotes, original UTF-16 ranges, repeated fragments, source hash and PDF page/locator mismatch; extract the shared exact-substring validator with trusted evidence injection, preserving existing Citation fields/private metadata.
- [x] 3.2 Write failing tests for every breakdown step/note claim/practice explanation needing target-scoped evidence, invented source text/offsets and wrong-course sources; implement claim validation using A's selected O2 structures, no fuzzy matching or model calls.
- [x] 3.3 Write failing Q1 regressions for own-question citation, material statements in answer/rationale, statement coverage and prompt-only limitations; keep existing conservative provenance safeguards and verified locator adapters. Test stale trusted hashes and preserve evidence limitations without claiming answer truth.
- [ ] 3.4 Run targeted green, fresh-context review and project check; publish the shared service contract for H and preserve Q1 consumer compatibility.

## 4. Issue D — Full authorization/audit service and Q1 compatibility

Depends on A; settle O3/O4 first. Scope: course policy, grants, safe audit/run integration interfaces and private operational adapter. No agent answers or browser mutations.

- [x] 4.1 Write failing policy/grant matrix tests for allowed/prohibited/dated attestation, absent policy, course cap, exact assessment binding, exams/unknown classification, L0/L1 versus L2–L4 and revocation; implement shared authorization and owner-only recording, including an explicit default-off auto-submit course setting without granting L4.
- [x] 4.2 Write failing synthetic audit/run tests for safe intent/outcome/denial refs, no rejected prose/credentials, read audit compatibility, citation failures, pre-mutation failure and append-only persistence; implement injectable durable record services separate from operational run measurements. Local publication must not claim success if required recording fails.
- [x] 4.3 Write failing private temp-directory tests over Q1 version-1 policy/grant/binding/prerequisite/snapshot/proposal/review/log fixtures, unsafe paths/symlinks, malformed records and interrupted activation; implement selected O3 adapter/migration with one authority per target, retained history/revisions/hashes and no deletion/escalation. If migration selected, add resumable duplicate-prevention/backup/atomic activation tests and record rollback/lifecycle before changing schema.
- [x] 4.4 Write failing Q1 real-prerequisite scoping, ambiguous provider mapping, policy/grant hash and stale-review tests; implement compatibility facades used by existing Q1 functions, retaining TTY-only owner actions and that workflow's specific attestation/date.
- [ ] 4.5 Run targeted green, fresh-context review, project check and privacy diff; document active backend/adapter lifecycle and unresolved identity records without editing/deleting owner data.

## 5. Issue E — Generated CLI and legacy aliases

Depends on A only for independent implementation; I connects real B/D/H handlers. Scope: commander adapter and synthetic CLI tests.

- [x] 5.1 Write failing registry-driven subcommand/help/flag tests with strict input coercion, file-input limits, unknown commands and stdout/stderr separation; generate CLI dispatch from A contracts, retaining one JSON envelope and existing Q1 flags/names.
- [x] 5.2 Write failing regressions for `quiz read/policy/grant/prerequisites/propose/review`, malformed files/help, non-TTY owner refusal and no credential prompts; implement aliases to the same entries, not duplicate handlers. Keep existing capture entry point separate until a registry-compatible upstream handler exists; no change to its authentication behavior.
- [ ] 5.3 Run targeted green, fresh-context review and project check using injected handlers; report production handler integration pending I rather than silently disabling legacy commands.

## 6. Issue F — Generated local HTTP transport

Depends on A; O5 before implementation, O6 before owner-confirmation wiring. Scope: built-in `node:http` and synthetic local HTTP tests, no UI, deployment or framework.

- [ ] 6.1 Record exact method/body/status/size/timeout conventions, Host/Origin checks, non-browser client authorization and owner capability bootstrap from O5. Write failing tests for loopback-only binding, generated known routes, malformed JSON, unknown paths/methods, request/body bounds and cleanup; implement the generic adapter.
- [ ] 6.2 Write failing security tests for cross-origin browser requests, forged Host/owner fields, unauthorized writes/owner actions and secrets in responses; implement selected checks with no wildcard CORS, credential exports or model assertions treated as owner approval.
- [ ] 6.3 Write failing dispatcher parity tests for success/schema errors/auth denials/oversized output and exactly one handler execution using fakes; implement safe envelope/status mapping without business logic.
- [ ] 6.4 Run targeted green, fresh-context review and project check; record loopback/security evidence and pending B/D/H integration. Do not serve M3 assets or modify CI/deployment in this issue.

## 7. Issue G — Official SDK stdio MCP transport

Depends on A only. Scope: MCP adapter plus synthetic stdio client tests. The sole new runtime package is pre-approved `@modelcontextprotocol/sdk` from design section 3 (#62/#69); no install occurs in this documentation task.

- [ ] 7.1 Write failing SDK-client tests for initialization, registry-derived discovery/input schema, calling commands and runtime refinement failures; implement `coursework mcp` with official SDK stdio and injected handlers, no custom protocol handshake or separate business registry.
- [ ] 7.2 Write failing tests for framing/diagnostic separation, sanitized failures/64 KiB command-envelope bounds, disconnect cleanup and forged owner privilege; implement error/result mapping and host-owned context with no credential prompts or grants from MCP arguments.
- [ ] 7.3 Run targeted green, fresh-context review, project check and dependency/license review; report standalone transport evidence and pending production wiring. Hermes mounting/scheduling remains M4.

## 8. Issue H — Validated writes and separate action gates

Depends on B/C/D; O2/O6 before relevant implementation. Scope: validated command handlers/versioned operational persistence, exact-review integration and fake fill/submit adapters. Real fill integration depends on Q1 issue D delivery; real submit adapter is M4, never a guessed endpoint in H.

- [x] 8.1 Write failing synthetic breakdown/revision/practice tests for structured citations, level/target/privacy checks, stale sources, concurrent replacement, durable failure recording and prior-state preservation; implement validated writes through repositories/services with no direct SQL/model calls.
- [x] 8.2 Write failing quiz-proposal regressions using shared B/C/D services for exact question/material coverage, revision/source bindings and legacy receipt compatibility; route proposals and review preflight through unified services, never treating saved answers as submitted state.
- [x] 8.3 Write failing fake-action tests for L3-only fill, current grants/policies and exact review/page/attempt identity, unsupported controls, locks and stale/revoked authorization; implement separate fill command. Integrate only a delivered Q1 adapter, preserving no submit clicks/calls and passive-observation semantics.
- [x] 8.4 Write failing fake-submit tests for L4 only, single-use owner confirmation bound to exact filled revision/target/authorization, stale/replayed/cross-target approvals and explicit default-off per-course auto-submit; implement O6 lifecycle, serialized preflight and safe unavailable adapter refusal. No real Ed submission request is constructed here.
- [x] 8.5 Write failing tests for audit failure before action, local publication/ledger failure, partial fill, external action/outcome uncertainty and zero blind retries; implement accurate safe outcomes without fictitious rollback or status/grade inference. Keep every grant/fill/submit attempt audited.
- [ ] 8.6 Run targeted green, fresh-context review and project check; Claude verifies private visibility before any answering-code push. Report real fill pending if Q1 unavailable and real L4 submit deferred to M4.

## 9. Issue I — Integration, acceptance and closeout

Depends on B–H and delivered upstream interfaces for the paths being accepted. Scope: final production registry wiring, synthetic integration tests and English usage/acceptance docs. No new product scope or unapproved dependency.

- [ ] 9.1 Write failing end-to-end synthetic CLI/MCP/HTTP tests over actual shared services: M1 reads/evidence → cited study/proposal write → owner review → L3 fake fill → L4 fake-confirmed submit/unavailable real adapter; include prohibited/exam/missing-policy/stale-review denials, migration compatibility and privacy sentinels. Wire delivered handlers once; mount M1 sync when available and preserve its upstream safety contracts.
- [ ] 9.2 Run fresh-context read-only integration review, `bash .claude/check.sh`, `npm run build`, `npx openspec validate v1-protocol --strict` and diff/privacy/dependency checks; record exact outputs and unresolved live coverage. Claude handles CI/PR/merge; synthetic SDK/HTTP success is not owner acceptance or Ed endpoint verification.
- [ ] 9.3 Deliver a 3–5 step owner acceptance checklist using the exact implemented names/flags chosen in A: (1) read local courses/assessments and resolve a cited source/page, expecting redacted evidence and explicit gaps; (2) send equivalent read via CLI/MCP/HTTP, expecting equivalent data and correct framing; (3) save a local cited study write/proposal and deliberately invalid citation, expecting accepted revision then rejection with preserved prior state/ledger failure; (4) check a denied policy/grant/exam or stale action and audit refs, expecting zero remote mutation; (5) verify submit without confirmed authorization/verified adapter is refused, expecting default confirmation and no network write. Use synthetic data for action probes; real local-data checks stay private. Any real fill/submit needs separate explicit owner authorization, never implicit from this checklist.
- [ ] 9.4 Obtain actual owner pass/failure for permitted acceptance; mark live auth/browser fill and all real M4 submit behavior pending when untested. Login/MFA and remote writes remain owner gates; no model password handling or Canvas-token fallback.
- [ ] 9.5 After review/check/CI and actual acceptance, reconcile current-truth foundation/M1/Q1 archives, sync this change's additive requirements and archive through the coordinator workflow. Do not tick pending safety/acceptance tasks from fixture success. This draft does not perform archive, commit or handoff changes.
