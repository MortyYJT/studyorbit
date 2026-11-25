## REMOVED Requirements

### Requirement: Synthetic question set with gold answers
**Reason**: The evaluation measured the self-built chat, which is deleted.
**Migration**: The synthetic courses under `test/fixtures/qa/` stay where the tool tests use them. DeepTutor is validated by hand with recorded token counts (`docs/deeptutor.md`).

### Requirement: Deterministic grader
**Reason**: Its only caller, the chat evaluation runner, is deleted.
**Migration**: None.

### Requirement: Runner compares context mode and tool mode
**Reason**: Both modes belong to the self-built chat.
**Migration**: None.

### Requirement: Before and after results are recorded
**Reason**: No further runs are possible.
**Migration**: `docs/eval-chat-qa.md` stays as the record of the old system, marked "superseded by DeepTutor" at its top.
