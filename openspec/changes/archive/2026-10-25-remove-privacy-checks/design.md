## Context

Privacy checks live in two modules. `src/sync/redaction.ts` holds the deterministic redactor: it masks emails, phones, student numbers and named-student patterns, and refuses (`unsafeSource()`, code `SOURCE_UNAVAILABLE`) text with control characters, `<`/`>` outside prose, credential syntax or bad URL escapes. `src/protocol/read-privacy.ts` (`protectRead`) walks every read output, refuses personal-data keys and local paths, and runs the redactor on each string. They are called from dispatch (`privacy.protect` in `production.ts`), the read service (`TrustedStoreEvidence.protect`), study writes, memory text and the facts brief, `source.record`, and the fakes.

Because any refusal fails the whole read, one stored group name with `=>` emptied `assessments.list` and the week view. The owner removed all privacy checks (#191).

## Goals / Non-Goals

**Goals:**
- No redaction and no privacy refusal anywhere; stored text comes back as stored.
- The `=>` group name reads back, and the week view loads with the data already in the owner's store, without a re-sync.
- Citation integrity is unchanged.

**Non-Goals:**
- No change to the AI-policy enum or how Codex classifies policies (deferred by the owner).
- No data migration: text redacted earlier stays redacted.
- No change to `source.record` URL rules (discussion, announcement, authentication and off-origin URLs stay refused). Those decide what counts as a revision source, not privacy.

## Decisions

1. **Delete both modules, not a flag.** A switch would keep about 200 lines of unused code and tests that drift. Removing them matches the decision and leaves less to maintain. The alternative, removing only the `<`/`>` rule, was offered and declined.
2. **Keep the integrity refusals in `reads.ts`.** `TrustedStoreEvidence` checks for duplicate matches, hash mismatches, course or provenance mismatches and page locators. These protect citation truth, not privacy. They keep the `SOURCE_UNAVAILABLE` code, so `unsafeSource()` moves to a small local helper (or `errors.ts`) under a name that does not mention privacy.
3. **Keep plain-text hygiene where it is about format, not privacy.** NFKC normalization, size limits and removing invisible format characters from agent-copied text stay, so citation matching behaves the same as before.
4. **`privacyScope` disappears from the options.** `createProductionProtocol`, `MemoryService`, `ConversationService`, `collectBrief` and `TrustedStoreEvidence` lose the parameter. Its one known gap (no classmate list was ever passed) goes away with it.
5. **Tests.** Delete redaction and privacy tests. Rewrite tests that asserted masking so they assert that text passes through unchanged, where a spec scenario requires it. Add one regression test: an assessment whose group name contains `=>` is returned by `assessments.list`.

## Risks / Trade-offs

- Classmates' names, emails, peer answers and any credential that appears on a page can now reach the model and the local database. The owner accepted this (#191).
- The repository rule that browser profiles, keys and unredacted course data never enter the repo or test fixtures still applies to commits. Only runtime checks are removed.
- AGENTS.md and the v1 technical design still describe the old red line until this change updates them. Tasks include both.
