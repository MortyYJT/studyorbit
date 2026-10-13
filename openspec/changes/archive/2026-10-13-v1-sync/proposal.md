## Why

M1 turns the selected-course captures into trustworthy local coursework state: assessments, deadlines, weights, grades and citable materials, with an incremental change stream. The approved [v1 design sections 2, 3, 5 and 7](../../../docs/engineering/v1-technical-design.md) and [decisions #52–#80](../../../note/decisions.md) define the scope; raw snapshots alone cannot safely serve an agent.

## What Changes

- Start with an owner-login-gated Canvas student-session spike. Prove same-origin `/api/v1` JSON GETs inside the logged-in page work; if authenticated reads are blocked, stop and ask before any HTML fallback (#58). Never use a self-issued token.
- Sync only saved selected courses. Read Canvas assignments, assignment groups, the owner's submissions/grades, modules and files; reuse the merged Ed JSON transport and Q1 lesson/question contracts, with no `view` parameter (#52).
- Keep raw snapshots and downloaded course-material PDFs in private `.local/` storage; use unpdf for per-page text and page citations (#74).
- Normalize into existing domain entities and deterministically redact before normalized persistence or model exposure: author/people names, emails, student numbers, phones, owner rules and a staff-name allow-list (#60).
- Compare semantic fields against current-state tables, atomically append `created` / `updated` / `deleted` events to `change_event`, and expose `changes --since <cursor>` with a monotonic cursor (#59). Incomplete coverage must not cause false deletion.
- Record start/end, attempted pages/requests, failures and per-source coverage in the run ledger. Preserve Q1 citation, policy/grant and append-only audit behavior; M2 owns their full replacement (#80).
- **BREAKING:** remove `ical` from `SourceItem.platform` in `src/domain/schemas.ts` and the domain-model specification together (#77, #80); no iCal source or node-ical dependency.

## Capabilities

### New Capabilities

- `coursework-sync`: selected-course Canvas/Ed ingestion, normalization, privacy boundary and owner-login-gated checks.
- `course-materials`: private PDF downloads and redacted per-page citable text.
- `sync-changes`: deterministic field comparison, complete-scope deletion and cursor reads.
- `sync-runs`: durable operational ledger and honest per-source coverage.

### Modified Capabilities

- `domain-model`: remove iCal; refine Change operations and Run coverage only as authorized by M1.
- `local-store`: atomic current-state/event publication and durable monotonic cursor allocation, including deletion of current rows.

The available baselines are the unarchived `v1-foundation` and `capture-selection-ed` deltas; `openspec/specs/` does not yet exist. Reconcile and archive dependencies before applying these MODIFIED deltas to current truth.

## Impact

- Planned code: sync adapters/handlers, reused `src/capture/` interfaces, `src/domain/schemas.ts`, repository/migrations in `src/store/`, minimal CLI wiring and wholly synthetic `test/` fixtures. This request writes planning artifacts only.
- Use section 3 dependencies only: existing Node 24/TypeScript/zod/commander/Playwright/Vitest and the pre-approved unpdf. No ORM, external fetch client, OCR, node-ical, new protocol codes, CI or deployment changes.
- M1 depends on S0. Q1 integration is conditional on its implementation being available; no duplicate Ed transport or weakened safety gates. M2 registry/MCP/HTTP, UI, scheduling and assessment writes/submission are out of scope. Model needs beyond the design are open questions, not implicit extensions.
