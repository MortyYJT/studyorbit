## Context

After C-1 and C-2 (both archived) Codex reads and acts in the owner's own Edge through its computer use, and sync is an agent job that reports blocked platforms. The resident Edge (separate profile, remote debugging), our Playwright browser tools, the submit-confirmation flow, the Canvas/Ed capture transports and `source.fetch` are unused or redundant. The owner decided Codex fills but never submits (#173) and accepted no code guardrails on screen actions (#168).

## Goals / Non-Goals

**Goals:** delete the resident browser stack and the confirmation flow; keep citations working through an agent-recorded source; keep historical data readable; drop the Playwright dependency.

**Non-Goals:** long-term memory (C-4); stronger verification of agent-copied text (#166, later); deleting tables (#107).

## Decisions

### 1. `source.record` replaces `source.fetch` (#187)
Without a browser of our own, code cannot fetch a page. Codex reads the page in the owner's Edge and calls `source.record { courseId, url, title, text, page? }`. Code validates the origin (Canvas, Ed) and that the URL belongs to the course (its Canvas or Ed course id from `course.sources`, as `source.fetch` did), refuses discussion-thread URLs (same patterns), bounds the text to 100,000 characters per page, redacts it with the existing deterministic redactor (emails, phones, student numbers, named-student patterns; classmates' names are not found without a structured author list, accepted under #168), and stores a SourceItem of kind `material` with `facts`-free JSON, a content hash and a `copiedBy: 'agent'` marker in its `readState`-like metadata (an optional field on SourceItem). Citation verification is unchanged: quotes must be exact substrings of stored text. Alternative kept for later: Codex saves a PDF into its workspace and code extracts the text with `unpdf` (stronger provenance; needs a file hand-off).

### 1a. Helpers move first
`courseEvidence`, `courseEvidenceSnapshot`, `materialIdentity`, `materialMetadata` and `sourceURL` live in `source-fetch.ts` but serve annotations, reads, the store and the revision service; they move to a kept module (for example `src/revision/sources.ts`) before `source-fetch.ts` is deleted.

### 1b. Confirm-before-submit switch
With no confirmation flow, `autonomy.confirmation.set`, the course-page select and `confirmBeforeSubmit` in `autonomy.read` go; the stored field stays for history.

### 2. What is deleted
`src/browser/**`, `src/capture/**`, `src/revision/source-fetch.ts` and `source-transport.ts`, `src/protocol/browser-tools.ts`, `browser-confirmations.ts`, `browser-http.ts`, the `browser.*` and `confirmation.*` registry entries and `coursework browser` CLI, the K1 sign-in button and per-site browser state, the K4 `ConfirmationCard` and the needs-you confirmation item, tool-step screenshots and "view in Edge" with the `browser.view` / `browser.image` routes and the "Browser tools" journal conversation, `COURSEWORK_MCP_PROFILE` filtering (nothing to hide), and their tests. `src/sync/ed-scope.ts` goes if nothing imports it after the deletions. `redaction.ts` stays.

### 3. What stays
Tables (`pending_confirmations`, tab records) stay unwritten; historical audit rows with browser outcomes stay readable; `autonomy.check` stays as an advisory read the workspace rules ask Codex to use; the e2e test drops the browser steps and keeps the rest of the flow.

### 4. Dependencies
Remove `playwright` from `package.json` and the lockfile; remove `unpdf` only if `source.record` does not use it (it does not in this change). Removing a dependency needs no approval; `npm ci` must still pass.

## Risks / Trade-offs

- [An agent can record text a page does not contain and cite it] → accepted at D level (#166, #187); sources are marked as agent-copied and shown so in the frontend; quotes still must match the recorded text exactly.
- [No code guardrail on submitting] → accepted (#168); workspace rule "stop before final submit" (#173).
- [Large deletion breaks hidden imports] → TypeScript build and the full check catch them; delete in one PR with the import graph checked.

## Migration Plan

Merge; old rows stay readable. Rollback: revert the PR.

## Open Questions

None blocking.
