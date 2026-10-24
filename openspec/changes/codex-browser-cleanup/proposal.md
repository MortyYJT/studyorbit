## Why

The owner decided that Codex works in their own signed-in Edge and fills but never submits; the final submit button stays with the owner (#167, #173). Since C-1 and C-2, nothing uses the project's resident Edge: Codex reads and acts through its own computer use, sync is an agent job, and sign-in problems are reported by the job (`sync.status.blocked`). The resident browser, our Playwright browser tools, the submit-confirmation flow and the API capture transports are dead weight that still ships a separate browser profile, a remote-debugging port and a Playwright dependency. This change, sub-project C-3, removes them.

## What Changes

- **BREAKING:** delete the resident browser (`coursework browser start|stop|status`, `browser.status`, `browser.signin`, `browser.view`, `browser.image`), our agent browser tools (`browser.open|read|click|fill|select|submit|screenshot`), the submit-confirmation flow (`confirmation.list`, `confirmation.decide`, `autonomy.confirmation.set`, the Agent-page confirmation card and its "needs you" item, tool-step screenshots and "view in Edge"), the Canvas/Ed capture transports and the page-capture profile code.
- **BREAKING:** `source.fetch` (code reading a page through the resident browser) is replaced by `source.record`: the agent submits a Canvas or Ed page URL, its title and the text it read (one call per PDF page), stored as a SourceItem of kind `material` marked as copied by the agent, redacted, size-bounded; discussion threads stay refused. Citations keep working against these sources. This partly overturns #109 ("the agent SHALL NOT supply source text").
- Frontend: the avatar status panel loses the "bring sign-in page to front" button and per-site browser state; sign-in problems come only from the last sync run; the Agent page loses the confirmation card.
- `autonomy.check` stays as an agent-readable check (the workspace rules tell Codex to check its level); no code path depends on it any more.
- Tables stay (additive rule #107): `pending_confirmations` and old tab records are no longer written.
- Dependencies: remove `playwright` (and `unpdf` if nothing else uses it).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `resident-browser`, `agent-browser-tools`, `page-capture`, `ed-capture`: every requirement removed (spec folders deleted at archive).
- `revision`: `source.record` replaces `source.fetch`; the revision skill no longer checks `browser.status`.
- `command-registry`: resident sign-in removed; agent tool list without `browser.*`.
- `web-ui`: no sign-in button, no confirmation card, no pending-confirmation item.
- `agent-chat`: tool policy names `source.record`, no `browser.*`.
- `assessment-autonomy`: `autonomy.check` advisory; browser-write audit removed (history readable).
- `validated-agent-writes`: graded answers entered by Codex, never submitted by it.
- `domain-model`: SourceItem gains optional `copiedBy`; `confirmBeforeSubmit` and PendingConfirmation are historical.
- `protocol-reads`: no pending-confirmation reads.
- `local-store`: removed features' directories left in place, no longer written.
- `agent-chat`: adapter events and conversation parts without confirmations and screenshots (historical parts readable).

## Impact

- Code removed: `src/browser/**`, `src/capture/**`, `src/revision/source-fetch.ts`, `src/revision/source-transport.ts`, `src/protocol/browser-*.ts`, browser registry entries and CLI, `src/sync/ed-scope.ts` if unused, the K1 sign-in button, the K4 confirmation card, their tests; `playwright` dependency (and `unpdf` if unused).
- Code added: `source.record` (in `src/revision/`), its contract and tests.
- Kept: `redaction.ts` (used by `source.record`), tables (`pending_confirmations`, tab records) unwritten, historical audit rows readable.
