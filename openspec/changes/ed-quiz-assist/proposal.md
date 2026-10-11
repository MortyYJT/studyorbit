## Why

Q1 must be ready for the owner to test on a real Ed quiz by **2026-10-23**, ahead of the quiz deadline on 2026-10-25. Decisions [#56, #57 and #75](../../../note/decisions.md) authorize a cited proposal and terminal review workflow followed by L3 page filling, with submission performed by the owner.

## What Changes

- Read selected-course quiz questions from Ed lesson JSON through the `capture-selection-ed` transport; expose redacted questions and source references through a bounded agent read envelope. Never send `view=1`.
- Accept external-agent answer proposals with checked source-text citations and save them privately under `.local/`, tied to the assessment. Our code never calls a model.
- Let the owner review a specific proposal revision in the terminal; require that approval before filling.
- Fill supported answers into the open quiz page on the managed Playwright profile, subject to recorded course AI policy and a per-assessment L3 grant, with append-only auditing. Never click submit or invoke a submission endpoint.
- Passively observe the owner's submission request and save only sanitized method, path and body shape under `.local/` for future M4 work; never save tokens, auth headers or answer values.
- Use synthetic fixtures only in `test/`. End implementation with a Claude-run real structure check on the owner's profile, returning `AUTH_EXPIRED` gracefully when signed out.

## Capabilities

### New Capabilities

- `ed-quiz-assist`: bounded read, locally validated cited proposals, terminal review, policy/grant-gated L3 filling, audit and sanitized owner-submission observation.

### Modified Capabilities

None. `openspec/specs/` is absent in this checkout; the unarchived `v1-foundation` and `capture-selection-ed` deltas are the available baselines. This change consumes their envelope/profile/selection/transport contracts without changing their requirements. Reconcile baselines before implementation and archive after the dependencies.

## Impact

- Planned implementation: `src/quiz/`, CLI wiring, existing protocol helpers and private local record handling; synthetic tests under `test/`. Reuse Node 24, strict TypeScript, zod, commander, Playwright and Vitest; no new dependency, CI/deployment change or SQLite migration.
- Follow [v1 technical design sections 2–4, 6 and 7](../../../docs/engineering/v1-technical-design.md). Use validated command handlers reusable by M2's registry; MCP/HTTP/UI and L4 implementation remain later milestones.
- Ed transport availability is a merge dependency, not a claim about this checkout. Course policy and private-repository prerequisites must be verified before real Q1 reads; private visibility must be verified again by Claude before pushing answering code (#57).
- Scope is planning artifacts only in this request. Real quiz use, login/MFA, issue creation, implementation, submission and Git operations are not performed here.
