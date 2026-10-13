## Context

This is M1 in [v1 technical design sections 2, 3, 5 and 7](../../../docs/engineering/v1-technical-design.md), governed by [decisions #52–#80](../../../note/decisions.md). The approved pipeline is capture → private raw snapshots → normalize → redact → diff → SQLite current state, append-only `change_event` and run ledger. Code never calls a model.

At drafting time, `src/capture/ed-transport.ts` and the selection/limiter/snapshot modules exist following the merged Ed transport work. `capture-selection-ed` still has outstanding integration/acceptance/archive tasks; reconcile those before implementation integration. `openspec/specs/` is absent, so `v1-foundation` supplies domain/local-store baselines and `capture-selection-ed` supplies selection/Ed contracts. Q1 `ed-quiz-assist` is a planning dependency for quiz shape and safety compatibility, not evidence that its code or real checks have shipped. Its design's statement that transport was absent is historical.

Current schemas include `ical`, specialized Change kinds and a minimal Run. The repository upserts entities and allocates `seq` in `changes`, but has no complete-scope reconciliation/deletion method. M1 refines only the Change operations/table and run measurements authorized by #59 and section 7. Course/Assessment/Task/Citation shapes remain unchanged; unmet mapping needs stay open questions.

## Goals / Non-Goals

**Goals:** prove student-session Canvas JSON reads first; selected Canvas/Ed synchronization; private PDF download and per-page text; deterministic redaction; validated source-linked entities; field comparison and honest deletion; durable cursor and measured ledger; preserve Q1 behavior; synthetic TDD and owner-login-gated acceptance.

**Non-Goals:** HTML fallback without owner decision, new token provisioning, model calls, quiz answering/filling/submission, new assessment kinds, guessed weights or grades, automatic cross-provider course merging, OCR, external-host file downloads, command registry/MCP/HTTP/UI, scheduling, full M2 policy/grant/audit replacement, CI/deployment edits or dependencies beyond section 3. No code, live reads, archive or Git operations are performed by this drafting request.

## Decisions

### 1. Prove Canvas session reads before implementing its production adapter (#58)

Issue A is the first implementation task: a bounded spike harness, tested red/green using synthetic page responses, then a real read-only check on an owner-authenticated managed profile. Inside a Canvas page on the validated selected origin, use same-origin GET `/api/v1/...` with browser credentials, no bearer header or self-issued token. Probe assignments, assignment_groups, the owner's submission/grade reads, modules and files. Verify actual readable field/types and pagination, not just HTTP 200. Capture only safe status/type/coverage evidence in the repository; raw course JSON stays private. No all-student submission endpoint or people-directory crawl.

No usable login, a login redirect, or 401/403 reports `AUTH_EXPIRED` with owner login/MFA guidance and no password prompt or retry. A 403 can be a permissions failure: if the owner confirms a valid student login and it persists, treat it as blocked spike evidence, stop and ask before HTML parsing. Authenticated non-JSON/refused/missing required reads also block the Canvas adapter; synthetic success does not pass the spike. Independent synthetic work can continue while login is pending.

Reject external HTTP clients/token provisioning because #58 explicitly selects page-local browser authentication. Do not implement `coursework login` here; if a separate login command exists, it must retain the masked TTY-only in-memory password rule and `AUTH_EXPIRED` for agent calls. This sync only consumes an existing session; MFA and login remain owner actions.

### 2. Reuse S0 selection, profile lifecycle and bounded transport (#52/#54)

Use saved source-qualified selection, existing browser detection/profile identity and exclusive lock. Non-TTY missing/invalid selection returns `INVALID_INPUT` before launching or reading; an empty saved selection schedules nothing. Do not select or merge courses by matching names/codes. One scheduler enforces ≥1 second between completed attempts (including snapshot writes) and subsequent starts, at most 300 attempts across discovery, bootstrap, Canvas/Ed reads, pagination and PDF requests; no automatic retries. Cap/cancel preserves completed private artifacts and reports gaps. All owned tabs/listeners/locks are released on all exit paths.

Canvas reads paginate only through validated same-origin `/api/v1` next links confined to the selected course and endpoint; refuse credential-bearing URLs, loops, off-origin redirects and unselected details. Keep raw JSON with safe endpoint/time/status metadata. Follow no redirects automatically. Separate provider failures: Ed expiry does not fail Canvas, and Canvas expiry does not fail Ed.

Ed calls the merged `EdTransport`, never a second authentication implementation. Existing page-context `authToken:au`/`x-token` remains page-local; no Bearer, cookie-only fallback, token renewal or auth export. Retain courses-only `/api/user` snapshots, selected lessons, attempt details/referenced slides, first thread page (`limit=30&sort=new`) and resources. Omit `view` entirely and record missing no-view coverage. Reuse Q1's recognized lesson/question identities when available; do not infer unsupported shapes. M1 adds PDF material ingestion after resource discovery without broadening the capture command's endpoint coverage, content-lesson expansion or thread pagination.

Reject redoing Ed capture and unbounded crawls: merged safety contracts and budgets already exist.

### 3. Normalize only facts representable by existing entities

Adapters validate raw JSON with zod before using it, assign stable provider/origin/external-id-qualified identities and retain source/locator bindings in private operational metadata. Every extracted claim has source text; SourceItem stores redacted textual evidence for source-derived assessment fields, including structured dates/weights/scores with endpoint/field locators. Do not create citations whose quotes are absent from trusted text. Keep provider courses distinct unless an already-approved explicit mapping exists.

Canvas assignment groups supply weights, assignments supply deadlines and materials, submissions supply the owner's recorded status/score, and modules/files supply material links. Ed uses documented observed dates (`effective_due_at` where present, otherwise `due_at`) and explicit submission evidence; Q1 supplies recognized quiz structure. Scores become percentages only with verified finite positive denominators. Missing scores remain absent; missing required weights or unsupported grading/group weighting block Assessment publication with a coverage gap. Never evenly divide a group weight, set a missing weight to zero, classify an unknown quiz as non-exam, infer hurdles/finals, or invent `assessmentsComplete`. Preserve owner-managed modules/tasks and explicitly supplied fields; only adapter-owned fields/entities are reconciled. Record unsupported data as safely redacted source evidence where possible, without claiming a complete assessment model.

Reject adding fields to accommodate every remote structure: design-approved Course/Assessment/SourceItem/Citation remain the contract. Specific weighting/classification/mapping needs are open questions before implementation.

### 4. Deterministic privacy boundary and Q1 compatibility (#60/#80)

Collect names from nested author/people fields across the validated scope before redacting free text. Deterministically remove these names, emails, student numbers and phone patterns, with validated owner rules and a staff-name allow-list stored privately. Staff allow-list applies to names only, never tokens/contact identifiers. Redact all textual fields that can persist or escape: titles, names, text, URLs/locators, before/after payloads, material pages and errors. Suppress author profiles and unrelated student data rather than publishing sanitized profiles. Hash only redacted semantic text; withhold content if safety cannot be established. Raw snapshots/PDFs are local exceptions, never model-facing paths or data. Default-on redaction cannot be bypassed by an agent; owner configuration cannot disable the model privacy boundary.

Replace Q1's minimal redactor through a reusable deterministic interface and regression tests, keeping stable question/source references and trusted citation lookup. Existing question/material citation obligations, NFKC/whitespace/quote matching, locator/offset/page checks, explicit policy/L2–L3 grant gates, exam restrictions, exact-review invalidation and append-only safe audit all remain. If new redacted text changes a source hash, old approval becomes stale; do not silently rewrite or reapprove a proposal. M1 does not migrate grants or rewrite audit history; M2 owns full grant/audit replacement. If Q1 has not shipped, implement the shared boundary and test a synthetic Q1 consumer instead of inventing its persistence format.

Reject model-based redaction because #13/#60 require deterministic, testable rules.

### 5. PDFs stay private, page text stays citable (#74)

Download only PDF links established by selected Canvas files/modules or Ed resources over authenticated page-context GETs on their validated provider origin. If a provider link requires an external/CDN redirect, report the material gap and an open question; no external client or token handoff. Use private `<data dir>/materials/` (default `.local/materials/`), owner-only access, generated safe filenames, atomic writes and traversal/symlink confinement. Validate status and PDF content; bounded download/extraction failure yields a gap without replacing previous usable text. Do not trust remote filenames, execute attachments or dump malformed payloads.

Use only pre-approved unpdf, retaining ordered one-based page numbers, including empty pages. Represent each redacted page as an existing `SourceItem` of kind `material`, with a stable external identity derived from provider file id plus page number. Existing Citation uses that `sourceItemId`, a verbatim redacted quote and a `page N` locator; validated offsets/hashes remain private operational metadata as in Q1. No PDF entity, Citation fields or OCR dependency. Image-only PDFs retain empty page evidence and report unavailable text rather than invented extraction. Completed extraction is required before page replacement/deletion.

Reject concatenating all pages without boundaries because page-level citations must resolve deterministically.

### 6. Current state and changes publish together (#59)

Compare canonical validated redacted semantic fields, not whole raw responses or `fetchedAt`. Normalize dates/numeric representations and insignificant source ordering; unchanged input emits no event even with a new capture time. For an existing entity, compare every owned domain field including removal of an optional due/score. Emit one `updated` event with before/after redacted snapshots reflecting all field differences; `created` has only after, `deleted` only before. Preserve `entity`, `entityId`, `at` and store-owned `seq`. No new `changedFields` or event-sourcing aggregate is needed.

Track completeness per provider/course/collection, not only per run. Delete only adapter-owned entities absent from a fresh authoritative complete enumeration of that exact scope. Auth failure, malformed data, skipped endpoints, page cap, bounded first-page threads, canceled reads, failed PDF extraction and deselection are not deletion evidence. Successful independent scopes can publish while failed scopes keep prior state. Compare and publish current-state upserts/deletions and events in one repository transaction against the current state at commit, avoiding stale diffs or duplicates from concurrent writers.

Migrate `changes` to the section 2/7 `change_event` concept, retaining all historic seq values and mapping existing `item.added` → `created`, `item.removed` → `deleted`, and specialized update kinds → `updated` without inventing history. Keep append-only history and durable allocation inside the transaction; committed cursor values are never reset/reused across restart or entity deletion. No-op/rolled-back batches do not expose a cursor or partial state. Current state remains authoritative; event replay is not a read dependency.

`coursework sync --json` is a thin reusable validated handler plus CLI, not a second registry. `coursework changes --since <cursor> --json` uses an exclusive nonnegative cursor (0 for start), ascending records and bounded page size, with next cursor equal to the last returned seq (or input cursor for empty results). An event too large for 64 KiB returns `LIMIT_EXCEEDED`, never a skipped event or cursor advance. Reuse `coursework.agent/v1` and existing errors; M2 mounts these handlers in its registry later.

Reject raw-hash-only diffs (lose field meaning), rebuilding the store (loses cursor history), and treating partial absence as deletion (corrupts local state).

### 7. Run ledger measures attempts and coverage, not guessed success

Persist a safe start record before network work in the private operational ledger and finalize the existing Run on every normal failure/success/cancel path. Refine Run only with section 7's measured pages/requests, failures and per-source coverage; retain id/command/start/end/steps/outcome/error/cost fields. Start records are not invalid unfinished Run entities: missing completion is explicitly interrupted/unverified after crash, never synthesized success. `steps` remains an actual operation count; no model cost is invented.

Coverage distinguishes planned/attempted/completed/skipped/failed/not-started collections and auth/cap/cancel causes. Record only safe references, outcome codes and counts, no names, question/answer text, quotes, raw errors or credentials. A partial run finalizes as `error` with its concrete code while retaining committed successful scopes; CLI returns a failure envelope with recovery guidance and run id, detailed safe coverage stays in the ledger. Start-ledger failure prevents a new run; completion-ledger failure after commit reports uncertainty and preserves committed events, never claims rollback. Q1 citation failures continue to reach the ledger through the compatible adapter. These measurements are the only basis for reported performance/resume numbers.

Reject overwriting append-only audit with operational run summaries: Q1 audit has different safety semantics and remains intact.

## Risks / Trade-offs

- [Canvas student permissions/pagination unknown] → spike first; owner login gate; blocked authenticated reads require owner decision before HTML fallback.
- [Remote grading structures exceed Assessment] → preserve source evidence, mark incomplete and ask about the concrete mapping/model need; no guessed percentages.
- [Ed transport is merged but live acceptance/Q1 shapes are incomplete] → reconcile S0, synthetic contracts and owner-login-gated structure checks; no `view=1` or inferred compatibility.
- [Partial reads could look like removal] → per-scope complete-enumeration prerequisite; first-page threads cannot prove deletion.
- [Redaction changes break prior quotes/review] → trusted redacted lookup, stable ids, source hashes, stale approval rejection; preserve grants and append-only audit.
- [Materials redirect off-origin or contain scanned pages] → explicit gaps; no token transfer, OCR or invented text.
- [Crash between private artifacts and database publication] → artifacts are not proof of current state; transactional state/events and durable start ledger; unfinished runs stay unverified.

## Migration Plan

1. Reconcile S0 merged code and unarchived baselines. Complete the spike before Canvas production adapter approval; do independent synthetic work while owner login is pending. No milestone dates are invented (#67).
2. Add only design-authorized Change/Run refinements and repository migrations with synthetic upgrade/rollback-failure tests. Preserve current entities, event seq and historical runs; version existing specialized kinds to generic operations without rewriting semantic history.
3. Remove `ical` in schema and domain spec together. Preflight any legacy iCal rows; if found, stop with safe guidance and ask how to retain/remove them. Do not silently discard or relabel them, reset the database or bypass schema validation. No data deletion is authorized by this draft.
4. Integrate capture → normalize → redact → reconcile and PDF/Q1 compatibility adapters; verify and review each issue. Rollback disables new sync handlers, preserves local files/state/events/audit and uses a private pre-migration backup where needed; older binaries refuse newer DB versions. Do not automatically downgrade or delete data.
5. Claude closes implementation with fresh-context review, project check/build and strict validation, CI/merge, actual owner acceptance and dependency archive ordering (`v1-foundation`, `capture-selection-ed`, then affected M1 specs). Reconcile any Q1 source bindings before archiving M1. This drafting request does not archive changes or edit `note/handoff.md`.

## Open Questions

- Do student-session `/api/v1` reads for all required Canvas collections and pagination work? Which exact owner-only grade read is permitted? Resolve the spike after owner login; blocked reads require asking before HTML fallback.
- How do actual Canvas group grading rules and Ed weights map to one required Assessment percentage? Unknown/missing weights, exam/final/hurdle classification or cross-provider identity mapping remain incomplete; any needed additional domain field/entity requires a separate decision before implementation.
- Do selected material links stay on-provider, or require external/CDN redirects? Such downloads stay blocked until a scoped approved transport design exists; no new dependency is implied.
- Are there legacy iCal rows? Retention/removal is an owner decision, not an automatic destructive migration.
- Does shipped Q1 expose reusable redactor/source/ledger interfaces with stable question identities? Resolve from merged code; if a replacement needs a new shared Citation/Assessment field, table or grant/audit migration beyond M1, list the concrete need and defer it to M2/owner review.

Change operations/table and measured run coverage are explicitly described by sections 2/7 and #59; all other model/storage extensions are excluded, even if convenient for normalization.
