## 1. Regression test first

- [x] 1.1 Add a failing test: a stored assessment whose `group.name` is `Lecture Participation = Token Streak => Flexible assessments` is returned by `assessments.list` (today it fails with `SOURCE_UNAVAILABLE`)
- [x] 1.2 Add a failing test: a synthetic classmate name and email in a stored record and in an owner memory come back unchanged from the read and from `memory.list`

## 2. Remove the privacy layer

- [x] 2.1 Move the integrity error helper used by `TrustedStoreEvidence` out of `src/sync/redaction.ts` (keep code `SOURCE_UNAVAILABLE`, rename it so it does not mention privacy)
- [x] 2.2 Delete `src/sync/redaction.ts` and `src/protocol/read-privacy.ts`
- [x] 2.3 Remove `privacy.protect` from dispatch and `production.ts`, and `protect` from `TrustedStoreEvidence` and the read service, including the revision/practice "changed by protection" check
- [x] 2.4 Remove redaction from `src/memory/service.ts` (keep the 500-character bound and control-character stripping), `src/memory/brief.ts` and `src/revision/source-record.ts` (keep URL rules, size limit and invisible-character stripping)
- [x] 2.5 Remove the privacy hook from `src/protocol/study-writes.ts` and `src/protocol/fakes.ts`
- [x] 2.6 Remove the `privacyScope` option from `createProductionProtocol`, `MemoryService`, `ConversationService`, `collectBrief` and `TrustedStoreEvidence`

## 3. Tests and docs

- [x] 3.1 Delete redaction and privacy tests; rewrite masking assertions that a modified spec scenario still covers into pass-through assertions; keep citation-integrity tests
- [x] 3.2 Update the AGENTS.md privacy red line to record #191, and the redaction parts of `docs/engineering/v1-technical-design.md`
- [x] 3.3 Run `bash .claude/check.sh` and confirm exit 0

## 4. Real check

- [ ] 4.1 With the owner's existing store, `assessments.list` for COMP20003 succeeds and the week view loads in the browser
