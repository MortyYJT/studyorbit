## Why

The first real per-course sync stored COMP20003 with a grading group named `Lecture Participation = Token Streak => Flexible assessments`. Import accepted it, but the read-side privacy check refuses any non-prose string containing `<` or `>`, and one refused string fails the whole read, so `assessments.list` returned `SOURCE_UNAVAILABLE` and the week view was empty. The owner decided (#191) to remove all privacy checks and accept the risk: course data rarely carries classmates' details, and the refusals cost more than they protect.

## What Changes

- **BREAKING (policy):** Remove deterministic redaction and privacy refusals everywhere: classmate names, emails, student numbers, phone numbers, credential-like text, local file paths, markup characters (`<` `>`), control characters and personal-data keys. Text is stored and returned as given (NFKC normalization and size bounds stay).
- Source evidence returned by reads loses its `redacted: true` marker, which no longer holds.
- Remove the redactor (`src/sync/redaction.ts`) and the read-privacy layer (`src/protocol/read-privacy.ts`), the `privacyScope` option, and the dispatch-time `privacy.protect` step.
- Memory text (agent and owner), the facts brief and `source.record` material are no longer redacted.
- Keep citation integrity: source id, course binding, provider origin, content hash and locator checks, and exact normalized substring citations, still refuse mismatches.
- Update the AGENTS.md privacy red line to record #191.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `protocol-reads`: drop "Every read respects the model privacy boundary"; reads return stored text without redaction or withholding.
- `command-registry`: dispatch no longer applies redaction before returning the envelope.
- `domain-model`: SourceItem `text` is stored as recorded, not "already redacted".
- `agent-annotations`: citations match a stored SourceItem, no longer described as redacted.
- `long-term-memory`: agent and owner memory text and the facts brief are not redacted.
- `revision`: `source.record` stores the agent's text without redaction.
- `validated-agent-writes`: writes keep schema, binding, authorization and citation checks but no privacy check.

## Impact

- Code: `src/sync/redaction.ts`, `src/protocol/read-privacy.ts` (deleted); `src/protocol/{reads,production,fakes,study-writes,registry}.ts`, `src/memory/{service,brief}.ts`, `src/agent/conversations.ts`, `src/revision/source-record.ts`.
- Tests: privacy and redaction tests are deleted or rewritten; one new test reproduces the `=>` group-name bug.
- Data: no schema change. Previously stored text stays as it was (already redacted where it was redacted).
- Risk accepted by the owner: classmates' details and anything else on a page Codex reads can reach the model and the local database.
