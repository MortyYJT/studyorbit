## Why

M1 supplies local coursework state, while Q1 already has a small, separate authorization and proposal workflow. M2 needs one validated command boundary for external agents and M3, with stable contracts that unblock parallel sync, protocol and UI development (#76).

## What Changes

- Define one registry entry `{ name, input: zod, output: zod, handler, level }`; generate commander CLI subcommands, official SDK stdio MCP tools and loopback `node:http` `/api/<name>` routes from it.
- Merge command schemas/contracts first as issue A, independent of real browser access and production handlers, so M3 can use schema-valid fake data.
- Expose bounded, redacted reads of M1 courses, assessments, tasks, sources/material pages, changes and run metadata, plus stored revision material and proposals.
- Validate agent breakdown, revision-note, practice-question and quiz-answer writes; resolve trusted sources, apply #63 citation matching and record failed writes in the run ledger.
- Generalize course AI policies, exact per-assessment grants and append-only audits; absorb Q1's local records and helpers without breaking its CLI, trusted evidence or exact-revision review.
- Expose fill and submit as distinct commands, requiring L3 and L4 respectively. L4 defaults to explicit owner confirmation; an explicitly enabled per-course auto-submit setting is the documented exception. M4 owns the real Ed submit endpoint, so M2 must refuse unsupported submission without side effects.
- Keep all reasoning external, credentials outside model reach, exams capped at L1 and prohibited courses capped at L1. Check private visibility before pushing answering/submission implementation (#57).

## Capabilities

### New Capabilities

- `command-registry`: shared zod contracts, dispatcher and generated CLI/MCP/HTTP transports.
- `protocol-reads`: bounded model-safe reads over M1 state and validated local revision/proposal records.
- `validated-agent-writes`: cited breakdown, revision notes, practice questions and assessment proposals.
- `assessment-autonomy`: policies, grants, audit, Q1 transition and separate fill/submit gates.

### Modified Capabilities

None. `openspec/specs/` is absent in this checkout. The unarchived `v1-foundation`, `v1-sync` and `ed-quiz-assist` deltas are the working baselines; their safety, envelope, citation and review obligations remain in force. Reconcile archive order before implementation closeout rather than duplicating their requirements as current truth.

## Impact

Planned implementation touches protocol/CLI wiring, repository-backed reads and private operational persistence, with synthetic Vitest fixtures. Runtime additions are limited to pre-approved `@modelcontextprotocol/sdk` (stdio); reuse Node 24, strict TypeScript, zod, commander, Playwright and `node:sqlite`. No HTTP framework, model client or unapproved dependency is needed.

This request creates planning artifacts only; it changes no source, tests, package/lock files, CI, deployment or handoff, performs no live writes and makes no commit. The approved design sections 2–8 and decisions #56–#80 govern it. Decisions #81 and #84 (Q1 redaction and citation provenance) are preserved; the design's open choices are settled by #85.
