## Context

This change refines the approved v1 design sections 2, 3, 4, 5, 6, M2 in section 7 and section 8, and decisions #56, #57, #62–#64, #69, #76, #79 and #80. It also preserves #81 (Q1 redaction) and #84 (Q1 citation provenance), and its open choices are settled by #85. The config's iCal/no-L4 statements are obsolete under #56/#77; this change does not edit config or handoff. No milestone dates are introduced.

Observed implementation in this checkout:

| Area | Existing code and boundary | M2 treatment |
| --- | --- | --- |
| Envelope | `src/protocol/envelope.ts`, `errors.ts`: `coursework.agent/v1`, run id/duration, sanitized errors, 64 KiB maximum | Preserve compatibility; validate command data before constructing one envelope, adapting envelope-returning handlers without double wrapping. |
| M1 | `src/domain/schemas.ts`, `src/store/repository.ts`, `src/sync/changes-handler.ts`: M1 entities, atomic batches, exclusive change cursor; no general listing API yet | Reuse schemas and changes semantics; extend repository queries in issue B, never open SQLite from transport handlers. Sync/material/run integration remains subject to actual M1 delivery. |
| Privacy | `src/sync/redaction.ts`, `privacy-boundary.ts`; Q1 read uses deterministic redaction | Use M1's boundary before model exposure; source hashes and approval staleness track redacted text, not raw snapshots. |
| Q1 policy/grants | `src/quiz/policy.ts`: version-1 Ed course/lesson binding, policy union, level 0–4 grant; `authorize` currently accepts required level 2 or 3 only | Generalize across providers without matching by course title or manufacturing assessment classification; add a distinct L4 gate. |
| Q1 records/audit | `files.ts`, `audit.ts`, `proposals.ts`: private JSON, `audit.jsonl`, `runs.jsonl`, locking, symlink checks, intent/outcome/denial, atomic versioned proposals | Absorb via a compatibility repository adapter; preserve all history and hashes. Choose eventual persistence under Open choices. |
| Q1 evidence | `citations.ts`, `proposals.ts`: trusted read snapshots/material files, normalized quote checks, raw UTF-16 offsets/end, source hash, question-specific citation and answer/rationale statement coverage | Extract shared citation service; keep quiz-specific provenance checks and evidence limitations. Q1 uses `page:N`; M1 design uses `page N`, requiring explicit trusted-locator translation. |
| Q1 review/CLI | `review.ts`, `cli.ts`: TTY owner recording; exact revision/page/attempt approval, stale-source guards; `quiz read/policy/grant/prerequisites/propose/review` | Keep syntax, envelope names, file input and owner-terminal constraints. No model boolean can stand in for owner approval. Fill/observation are planned Q1 issue D, absent here; consume their interface when delivered. |

`openspec/specs/` is absent. Unarchived foundation, sync and Q1 deltas are baselines to reconcile, not proof of complete/live implementations. Only pre-approved section-3 dependencies are allowed; this draft installs none.

## Goals / Non-Goals

**Goals:** issue-A contracts unblock three development lines; one deterministic command registry powers CLI, MCP and HTTP; safe reads over M1; validated cited writes; full course/assessment authorization and audit; compatible Q1 transition; separate fill/submit gates; synthetic TDD and explicit owner acceptance.

**Non-Goals:** model calls, M3 UI/calendar/EDF/chat/grading/weak-topic features, M4 scheduling or Ed submission-endpoint discovery/replay, new sync scrapers, iCal, password/login implementation, arbitrary SQL/filesystem tools, multi-user/network hosting, CI/deployment changes, real assessment execution during development, or silently changing M1 domain schemas. This drafting request changes only this change directory and does not archive it.

## Decisions

### One registry and one dispatcher (#30, #62, #64)

Every entry is exactly `{ name, input: zod, output: zod, handler, level }`. A handler receives parsed input and injected execution context, returns command data, and owns no transport formatting. Context supplies repositories, trusted evidence, authorization/audit services and an owner interaction capability. Those capabilities are established by trusted host code, never deserialized from agent arguments. Help/flag mappings and legacy aliases derive from contract metadata keyed to the same entry; they are not another handler registry.

The dispatcher checks name/input, command level and target authorization, executes once, validates output, applies the privacy boundary and bounded envelope serialization. Writes also validate citations before storage and audit before mutation. Invalid output is a safe failure, not an export of the handler's raw value. Domain failures keep existing error/retry semantics; new error codes or wire changes require explicit contract resolution in A. Unknown commands never dispatch. Validation/authorization failures are recorded safely even when no trusted target exists.

CLI is commander-generated, with one stdout JSON envelope and stderr diagnostics. `coursework mcp` runs official SDK stdio, reserving stdout for MCP framing. Tools derive their advertised input schemas from zod; runtime zod refinements still run even when not expressible in JSON Schema. HTTP uses one generated `/api/<name>` dispatch path on `node:http`, bound only to `127.0.0.1`. The selected HTTP method/status/security choices must be settled before F. Neither binding to localhost nor a request field authenticates an owner. Owner-only commands reject model calls; registering them is not granting permission.

Alternative: three separate handler sets. Rejected because safety checks and contracts would drift. HTTP frameworks and hand-built MCP handshakes are unnecessary and outside the approved selection.

### Contract surface before production handlers (#76)

Issue A exports input/output zod schemas, inferred types, envelope schemas, registry/dispatcher interfaces and fake implementations. It does not wait for all M1 ingestion, migrations, Q1 fill or HTTP/MCP wiring. Later issues inject implementations; M3 uses the same schemas on synthetic data immediately after A merges. Exact command names and new record layouts are recommendations under Open choices until recorded by the coordinator.

The required logical surface and proposed names are:

| Commands (proposed) | Required input/output contract | Minimum level / restriction |
| --- | --- | --- |
| `courses.list`, `assessments.list`, `tasks.list` | Bounded filters/page cursor; existing domain entities with resolvable source evidence and explicit coverage gaps | L0 |
| `sources.get`, `materials.list` | Trusted source id or course/page filters; redacted text, hash, locator/page and provenance; no raw path | L0 |
| `changes`, `runs.list` | Existing exclusive sequence cursor and limit for changes; bounded run filters; actual measured metadata | L0 |
| `revision.list`, `practice.list`, `proposals.get` | Course/week or assessment/revision filters; accepted records, citation evidence and limitations | L0 |
| `breakdown.write` | Assessment/source revision, existing Task-compatible steps/estimates and per-step citations; stored reference/revision and verified citation metadata | L1 for organizational steps, never assessment answers |
| `revision.write`, `practice.write` | Course/week, structured source-derived claim units and citations; stored reference/revision and evidence | L1 for study assistance, never disguised graded answers |
| `quiz.propose` | Existing Q1 version/binding/sourceRevision/answer/rationale/citation/statements shape; revision/sourceRevision/evidence receipt | L2; grant and course policy |
| `quiz.read`, `quiz.review`, `quiz.prerequisites` | Existing Q1 targets, review revision/page/attempt and private prerequisite records; existing output shapes | L0 read; review/prerequisites owner-only, not authorization bypasses |
| `policy.record`, `grant.record`, `audit.list` | Policy evidence/attestation/date/cap, exact assessment grant or safe audit pagination; recorded reference/current metadata | Owner-only for recording; safe audit read L0 |
| `quiz.fill`, `quiz.submit` | Exact assessment/proposal/source revision and page/attempt identity; actual action outcome or explicit unavailable result | L3 / L4, separate preflights |

Registry level is the minimum requirement, not a permission to override course/assessment rules. Existing `quiz.policy` and `quiz.grant` map to the shared owner-recording handlers. `quiz.prerequisites` retains its special real-Q1 attestation/date constraint only for Q1; M2 does not apply that historical date to every course. Registry mounting of M1 `sync` occurs when its handler exists, preserving its own browser/audit prerequisites; M2 does not implement sync or assert it is available. M3-only commands are not invented here.

Contracts must specify required/optional fields, strict input validation, positive safe limits, cursor semantics, source/revision references, stable failure codes and schema-valid examples. A preserves the current 64 KiB envelope limit and Q1 names/arguments. Cursor representation for new lists is an open choice; `changes` retains its existing exclusive numeric sequence behavior, including no skipping oversized events.

### Trusted source validation for all agent writes (#63)

Agent supplies claims and quotes, never trusted source text, accepted offsets, policy identity or approval authority. Resolve redacted source text via repository/evidence adapters in the target course/assessment. NFKC-normalize both sides, unify whitespace and quote characters, then require a nonempty exact substring. Store source id, checked offsets, source hash and PDF page; preserve the existing Citation fields and keep validation metadata with the accepted operational record. No fuzzy matching or guessed PDF pages.

Validate every breakdown step, revision-note claim and practice explanation. Quiz proposals must additionally cite their exact question and course material for every material-derived statement in answer and rationale, preserving Q1 statement coverage and prompt-only evidence indicators. Quote membership establishes provenance, not logical correctness; deterministic checks cannot prove arbitrary paraphrase truth. No accepted source-derived unit may omit evidence. Citation failure yields `CITATION_MISMATCH`, leaves the previous revision untouched and reaches the run ledger and audit with safe metadata. All writes pass schema, target, redaction and citation checks before storage; reject or withhold content when safe persistence/exposure cannot be established. No agent directly mutates tables.

### Policies, grants and action boundaries (#56, #57, #80)

Policy records are allowed/prohibited with quote and location, or dated owner attestation if no document exists; prohibited cap is L1. L2–L4 require a recorded policy and an exact assessment grant not exceeding its cap. Exam assessments never exceed L1; unknown classification cannot authorize L2+. Organizational study writes at L1 must not answer graded assessments. Course/week revision records do not imply grants for any assessment.

Owner-only policy/grant recording cannot be performed through an agent's MCP call or a forged HTTP flag. HTTP owner approval, if provided for M3, must use the trusted interaction mechanism selected before F/H. Changing policy, grant, proposal, source, page or attempt invalidates prior incompatible approvals. Recheck current policy and grant immediately before fill/submit under an exclusive assessment action boundary; an earlier check cannot authorize a later changed target.

Fill requires at least L3 and Q1's exact reviewed revision, checks current page/attempt, and never submits. Submit requires L4 and confirmation bound to the exact filled revision/target; default is owner confirmation. An explicit owner-enabled per-course auto-submit switch only removes this confirmation, not other gates, and is audited. M2 exposes and tests the submit gate on fake adapters but has no verified Ed endpoint implementation; absent adapter evidence it fails safely before network mutation. M4 supplies the real adapter from sanitized Q1 observations, separately reviewed/authorized. Never retry uncertain submission automatically.

Append-only audit records grants, policy changes, proposals, approvals, fills, submits and denials with safe command/run/target/revision/policy/grant references and intent/outcome phases. Intent failure prevents mutation; local writes publish only with durable required records. External actions cannot promise transactional rollback: completion-record failure reports actual/uncertain state and prevents blind retries. Operational run ledger is distinct from authorization audit; neither contains answers, quotes, credentials or classmates' data.

No self-issued Canvas tokens; browser credentials remain page-local, models never see/type passwords, MFA is the owner's action, and non-TTY authentication expiry returns `AUTH_EXPIRED`. Existing masked TTY-only deterministic login, if present later, is not exposed as a model credential tool. Every extracted claim retains source text evidence. Real course data/profile/keys remain outside Git and fixtures; private visibility must be rechecked by Claude before pushing L3/L4 answering code, regardless of the historic #78 note.

## Risks / Trade-offs

- [A premature persistence decision blocks parallel work] → interfaces and fake repositories merge first; settle only contract-affecting choices before A, backend layout before D.
- [Q1 and M1 identities/locators differ] → explicit source-qualified mapping and adapter translation; reject ambiguous mapping, retain raw records privately and invalidate stale approvals.
- [Loopback service is reachable by malicious web pages] → enforce selected local request authorization/Origin/Host strategy before mutation; no wildcard CORS or bearer secrets in model output.
- [Source text changes during a write/review] → check trusted revisions at publication/action boundary; conflict preserves previous accepted state.
- [Q1 fill and M1 materials are not delivered yet] → fake contract adapters first; integration remains blocked on the actual upstream issue, not on synthetic success.
- [Literal citations are mistaken for answer correctness] → retain evidence limitations; no automated correctness claim or invented metrics.
- [Stale baseline] → each issue reconciles the merged M1/Q1 interfaces and current decisions before implementation.

## Migration Plan

1. Contract-affecting Open choices are settled by #85. A merges schemas/fakes; sync, protocol and M3 then proceed in separate clones, up to three lines under #76.
2. Add shared repository/evidence/authorization interfaces. Validate Q1 version-1 records and append-only logs using existing private permissions/lock/path safeguards. Map Ed identities explicitly; no reset, deletion, silent level escalation or automatic course merging.
3. Prefer an initial compatibility adapter over destructive copying. If a backend migration is selected, use private backup, versioned resumable import with stable record/event identities, duplicate prevention, verified counts/hashes and atomic activation. Invalid records or ambiguous identities block only the affected target with safe guidance. Preserve original files and audit history; never auto-delete them. Policy/grant hashes remain meaningful; a semantically changed source/binding requires new review rather than rewriting approval.
4. Route Q1 CLI aliases and registry handlers through the same services. Preserve exact review and real-Q1 prerequisite checks, supported/unsupported coverage, citation metadata and evidence limitations. Integrate delivered Q1 fill without replacing its owner-submits behavior.
5. Enable CLI/MCP/HTTP only after parity and privacy tests. Rollback disables new transports/adapter activation and restores the validated legacy reader against preserved files; newer record versions must be refused by older binaries, not reinterpreted. Never downgrade/reset SQLite or erase audit entries.
6. Fresh-context review, project check/build, strict OpenSpec validation and actual owner acceptance precede closeout/archive. Reconcile foundation/M1/Q1 current-truth archive order first. No archive, handoff edit or Git operation occurs in this draft.

## Open choices

**Selected (decision #85, Claude autonomous under #79, pending owner review):** O1 (a), O2 (a), O3 (a), O4 (a), O5 (a), O6 (a) with (b) as the CLI interaction. O7 is resolved: #84 is recorded (Q1 citation provenance: statements that name a material as their source must cite it; unattributed paraphrase is accepted only as prompt-sourced and labelled as an evidence limitation), and this design already preserves it through Q1 statement coverage and evidence limitations. None of these selections touches a red line, adds a dependency or authorizes a live write. The table keeps the options for the owner's review.

| ID / decision gate | Options | Recommended option and reason |
| --- | --- | --- |
| O1 — before A: command naming and new-list paging | (a) dotted names, nested CLI aliases, explicit per-list cursor; (b) flat names and offset paging; (c) resource-specific free-form routes | (a): matches existing Q1 envelope names and one `/api/<name>` mapping. Define opaque stable cursors for new lists while retaining numeric `changes`; minimizes transport divergence. |
| O2 — before A/D: new record/claim contracts and levels | (a) separate structured claim units for notes/practice, existing Task for breakdown, Q1 answer shape; (b) generic text documents with citation arrays; (c) extend all M1 domain schemas | (a): meaningful per-claim citation validation and fake-data contracts without destabilizing M1. Fix field layouts in A; owner approval required if a domain/schema change exceeds approved scope. Keep L1 study content distinct from L2 graded drafts. |
| O3 — before D: policy/grant/proposal/audit persistence | (a) shared service with Q1 file compatibility first, repository interfaces and later versioned SQLite migration; (b) immediate complete SQLite migration; (c) permanent separate Q1/full-M2 stores | (a): avoids blocking Q1 on unapproved table layouts; one authority per target, no dual writes. D documents the adapter lifecycle; any later migration is a separately recorded decision, not an indefinite second implementation. |
| O4 — before B/D: cross-provider assessment and PDF locator mapping | (a) explicit verified identity map plus legacy locator adapter; (b) migrate/rename all Q1 ids now; (c) merge by course code/title | (a): keeps exact proposal/review hashes meaningful and never guesses course equivalence. Translate only metadata-proven `page:N` / `page N`; ambiguous mappings fail closed. |
| O5 — before F: HTTP request/security convention | (a) JSON POST for every command, exact Host/Origin checks and owner-session capability for mutations; (b) GET reads/POST writes with same protections; (c) loopback alone | (a): one route convention and consistent zod inputs; reject browser cross-origin requests and require trusted local authorization. Specify non-browser client credentials, bootstrap, limits and status mapping before implementation; never treat caller-supplied owner flags as authority. |
| O6 — before H/F: exact L4 confirmation lifecycle | (a) server-issued single-use confirmation bound to filled revision/page/attempt and policy/grant versions; (b) confirm anew in owner TTY for each action; (c) client boolean | (a) for M3 compatibility, with (b) as CLI interaction: stale/replayed confirmation is rejectable. Define expiry and consumption before H; (c) cannot prove owner confirmation. Auto-submit remains explicit per-course owner configuration, default off. |
| O7 — decision #84 reconciliation | Resolved: #84 is recorded and consistent with this design | `quiz.propose` keeps Q1's #84 provenance rule unchanged; shared citation service in C must not weaken it. |

### Issue F: selected HTTP conventions (O5)

The standalone host API `startHttpTransport({ registry, context, port?, capabilityDirectory? })`
uses built-in `node:http` only. It always listens on IPv4 `127.0.0.1`; port defaults to zero
(ephemeral). Routes are looked up directly in the injected registry: exact `POST /api/<name>`
with no query, URL decoding, path aliases, UI assets or discovery endpoint. The body is one
UTF-8 JSON value validated by the dispatcher. Empty, malformed and invalid UTF-8 bodies fail.
Require `Content-Type: application/json` (optional `; charset=utf-8`); reject content encodings.
Fixed-length and chunked bodies are both bounded before dispatch.

| Bound | Convention |
| --- | --- |
| URL | 1,024 characters; larger returns 414 |
| Headers | Node parser maximum 8 KiB; maximum 64 received header fields; overflow returns 431 |
| Request body | 64 KiB, declared and streamed bytes; overflow returns 413 |
| Response | Existing dispatcher envelope maximum 64 KiB, including final metadata |
| Connections / active requests | 64 connections; 32 active requests; excess requests return 503; connections over the limit are dropped |
| Timeouts | 5 s incomplete headers (Node parser, 250 ms checking interval), 5 s total body receipt, 10 s socket inactivity and Node total request receipt |
| Execution | No deadline race, retry or cancellation claim for a running handler; context ports own action deadlines. Disconnected handlers still count against the active limit until completion |
| Cleanup | `close()` is idempotent, stops accepting requests, destroys tracked sockets and removes this process's capability directory. It does not roll back or cancel an already dispatched handler |

Body timeout returns 408; parser header/total-request timeouts use Node's native 408 and close.
Every application reply is one JSON envelope, `Cache-Control: no-store`, `nosniff` and
`Connection: close`; no keepalive or CORS headers. Parser malformed framing returns a safe 400
envelope; parser timeout and connection rejection are transport failures, not command outcomes.
Unsupported method returns 405 (`Allow: POST`), unsupported media/encoding 415, unknown route 404,
unsafe Host/Origin or missing mutation capability 403. These transport failures use safe existing
`INVALID_INPUT`/`NOT_FOUND`/`LIMIT_EXCEEDED`/`LOCKED` codes and command `unknown`, without echoing
request text. Dispatcher envelopes pass through unchanged, apart from checking for the host's
own capability leak. Dispatcher HTTP mapping: success 200; `INVALID_INPUT` 400; `NOT_FOUND` 404;
`CONFLICT` 409; `AUTH_EXPIRED` 401; `SOURCE_UNAVAILABLE` 503; `LOCKED` 423;
`CITATION_MISMATCH` 422; `LIMIT_EXCEEDED` 413; `INTERNAL`/`UNCERTAIN` 500. An unavailable action
reported as command data remains HTTP 200, rather than inventing a different command outcome.

Security is checked before collecting bodies or invoking dispatch. Require exactly one Host equal
to `127.0.0.1:<actual-port>`. If Origin is present, require exactly one equal to the actual
`http://127.0.0.1:<actual-port>` origin; `null`, different schemes/ports and duplicate headers fail.
If Sec-Fetch-Site is present, only one `same-origin` or `none` is allowed. There is no OPTIONS
preflight allowance or wildcard CORS. Non-browser reads may omit Origin; loopback alone gives
no write or owner authority.

Chosen trusted local authorization: a new random 256-bit capability per server process, kept
only in memory and a unique `.local/http-*/capability` file (0600), inside a 0700 directory.
The default parent is `.local/`; a trusted host may supply another private storage parent for
standalone use/tests. Refuse symlink components and parents owned by a different user, create
exclusively, and clean up on startup failure/close. Never reuse a previous process's file/token.
After a hard crash, any stale file is inert and may be removed by the owner; no automatic deletion
of another process's directories. Capability file location is returned only to the embedding host,
never via HTTP. The trusted owner client reads that file privately and supplies
`X-Coursework-Capability` for L1–L4 commands and all `ownerCommands`, including their L0 aliases.
Keep it away from model arguments, responses and logs. This capability trusts the OS account and
clients to which the owner deliberately delegates it; it does not isolate hostile same-user code.

Compare the single header in constant time; duplicate credentials are invalid. HTTP always strips
any owner port on the supplied context, then establishes its own owner capability only after
verification. Top-level `owner`, `context`, `trustedContext` and `confirmed` fields are rejected;
strict command schemas remain authoritative for all other fields. The capability is an outer gate,
never a substitute for recorded policy/grant/evidence/confirmation checks in the dispatcher and
injected services. The adapter logs nothing, does not pass headers to ports, and withholds any
serialized envelope accidentally containing its own token. Privacy of all other service output
continues through the existing dispatcher privacy boundary.

O6 is deliberately not implemented by F: `confirmationToken` remains strict command input passed
to H's serialized submit boundary, whose server-issued single-use token must bind the exact filled
revision/target/policy/grant. A capability is not L4 consent. No issue-F confirmation issuer, browser
login, production repository mounting or real assessment action is added.
