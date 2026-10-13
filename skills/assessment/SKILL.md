---
name: assessment
description: Assist with a recorded assessment using graded autonomy, visible browser actions and safe audit metadata.
---

# Assessment assistance

1. Identify the exact stored assessment ID and the level needed for the requested work:
   L0 read; L1 explain or study; L2 draft; L3 fill for owner review; L4 fill and submit.
   Call `autonomy.check {assessmentId, level}` first. Stop on `denied`, any failed envelope,
   or unavailable audit. Do not reinterpret denial or retry at a lower level to perform the same action.
   Request that the owner records missing course policy or exact grants in their own terminal;
   never call owner-only commands through MCP, invent consent, or record it for the owner.
2. Exams never run above L1. Unknown assessment kind may be an exam and also stops L2+.
   L0/L1 do not permit graded answers disguised as practice. Every extracted claim cites source text.
3. Check `browser.status`. If signed out or unknown, stop and ask the owner to sign in by hand.
   Use the resident browser attach helper (`src/browser/attach.ts`); never launch a separate
   profile, read credentials or type passwords. Close only tabs opened by this operation.
4. Quiz and workshop pages may be read unredacted because they normally contain no classmates'
   data (#112). If peer answers or classmates' details appear, redact that part before it reaches
   a model. Never read discussion pages directly; use only already-redacted protocol sources.
5. Before each browser write, recheck permission for the exact assessment and required level.
   For L3, leave submission to the owner. For L4 submission, list **every answer** in chat,
   including every choice and free-text response, and wait for the owner's explicit confirmation
   of those answers (#97). Silence, a grant, a previous confirmation, or a general request to help
   is not submission confirmation. If any answer changes, list all answers again and obtain
   fresh confirmation. Never submit without it.
6. Code paths use `highlightThenClick` in `src/browser/highlight.ts` for each click (#98).
   An agent using its own browser tools must follow the same visible rule through its host tools:
   bring the window/tab to the front, outline the visible target in red, wait at least one second,
   recheck visibility and click exactly once. Stop the write if these steps cannot be performed.
7. Immediately after **each** browser write on Canvas or Ed, call
   `audit.record {assessmentId, level, action, outcome, confirmation?}`.
   Use action `fill`, `submit` or `other`; outcome `success`, `failure` or `uncertain` reflects
   the observed result, never a guess. Include `confirmation: "owner-chat"` after chat approval
   (or `owner-ui` / `owner-terminal` only when that actual method was used).
   L4 submit without confirmation is stored as `violation`, even if success was claimed.
   Never include answers, prose, quotes, names, emails, credentials, raw errors or page content
   in audit arguments. If recording fails, stop further writes and report the audit gap and
   actual browser state; do not repeat the browser write to retry recording.

## Command examples

CLI equivalents (one JSON envelope each):

```sh
coursework autonomy check --assessment-id assessment-a --level 3 --json
coursework audit record --assessment-id assessment-a --level 3 --action fill --outcome success --json
coursework audit record --assessment-id assessment-a --level 4 --action submit --outcome success --confirmation owner-chat --json
```

These commands check permission and record agent-reported actions. They do not fill or submit,
verify answers, or intercept browser clicks. Follow this skill for every assessment operation.
