## Why

The last full sync (2026-10-27) took 21 minutes for four courses: 33 separate Codex jobs, each starting its own agent, opening and closing its own Edge window, and copying the page through computer use. The course list job alone cost about 200,000 input tokens and 4 computer-use steps. A layer-0 experiment on the owner's signed-in Edge read the same Canvas course list through a small browser extension in 233 ms (fetch) plus 2 ms (parse), with no model and no tab (decision #219).

## What changes

- A Manifest V3 browser extension (`extension/`) reads Canvas API pages with the owner's signed-in browser session. Code never sees a cookie and uses no token; the browser attaches its own session to the request.
- The extension keeps an idle WebSocket connection to a local bridge on `127.0.0.1:47613`, opened by the coursework process. It acts only when code sends a read request, which happens only when the owner starts a sync (#221).
- Layer 0 of every sync reads the course list through the extension instead of a Codex job (#220). An unchanged list keeps the saved selection; new courses appear for selection as they do today.
- When the extension is not connected, not signed in, or does not answer in time, the course list is unavailable for that run and the saved selection is used (#222). No Codex fallback.
- Installation: Codex installs the unpacked extension into the owner's Edge through computer use (#220). The extension ID is pinned by a public key in the manifest so the bridge can check the connection's origin.

## Out of scope

- Reading `tabs`, `groups` or any other page through the extension (later layers, after this one is trusted).
- The Codex install flow itself (a later change); for now the extension is loaded manually or by Codex following `extension/README.md`.
- Publishing to the Edge Add-ons store.

## Impact

- New: `extension/`, `src/sync/extension-bridge.ts` (minimal WebSocket server on `node:http`, no new dependency).
- Changed: the course list stage in `src/sync/agent-job.ts`; the course list job in `src/agent/jobs/` is no longer started.
- Supersedes the clipboard capture of the `courses` page in the `layered-sync` change; `tabs` and `groups` still use Codex.
