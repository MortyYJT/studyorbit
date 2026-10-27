## Context

The layer-0 experiment (`experiment/layer0/`, not merged) proved the read path: the extension's service worker calls `fetch(coursesUrl, { credentials: 'include' })`, gets HTTP 200 with the `while(1);`-prefixed JSON, and the existing `parseCanvasCourses` returns the candidates. Measured on 2026-10-27: fetch 233 ms, parse 2 ms, 5 courses, 4 skipped (non-course enrolments, expected).

## Decisions

### D1. Browser extension, not CDP, AppleScript or cookie reading (#219)
Works the same on Windows and macOS. CDP needs a separate browser profile (the managed profile removed in C-3). AppleScript is macOS only. Reading cookie stores fights app-bound encryption on Windows and is close to bypassing browser security.

### D2. WebSocket bridge, extension connects out (#221)
The coursework process listens on `127.0.0.1:47613` and accepts one WebSocket from the extension. MV3 service workers stay alive while a WebSocket exchanges messages at least every 30 s, so the extension sends a heartbeat every 20 s. When the connection drops or the bridge is not running, the extension retries through `chrome.alarms` once a minute; it opens no page. Implemented with `node:http` `upgrade` and RFC 6455 text frames (masking, 7/16/64-bit lengths, ping/pong, close); no new dependency.

Protocol (JSON text frames):
- bridge → extension: `{ "id": "<uuid>", "type": "read", "url": "<allowed Canvas API URL>" }`
- extension → bridge: `{ "id": "<uuid>", "status": <http status>, "finalUrl": "<response.url>", "text": "<body>" }` or `{ "id", "error": "<message>" }`
- extension → bridge: `{ "type": "hello", "version": "<manifest version>" }` on connect, `{ "type": "ping" }` as heartbeat.

### D3. Origin check and URL allow-list
The manifest carries a fixed public `key`, so the extension ID is always `hjllbhkpkhffpbjkdpfigdnlaalopaij`. The bridge accepts an upgrade only when `Origin` is `chrome-extension://hjllbhkpkhffpbjkdpfigdnlaalopaij`, and only from `127.0.0.1`. The extension reads only URLs that start with `https://canvas.lms.unimelb.edu.au/api/v1/`, refuses anything else, and never writes (GET only).

### D4. Signed-out and failure handling (#222)
A response is a sign-in page when `finalUrl` is not under `https://canvas.lms.unimelb.edu.au/api/` or the status is not 200. The bridge waits at most 5 s for a connected extension's answer; with no connection it fails at once. Any failure marks the course list unavailable for the run (`coursesUnavailable`), and the pipeline continues with the saved selection, as a failed course list job does today. The run record keeps one `courses` job entry with `via: "extension"`, duration in ms, and the failure reason when there is one.

### D5. Same storage path as today
The bridge result goes to `SyncJobs.capture({ jobId, page: 'courses', text })`, which already parses, offers candidates, keeps earlier selections and never stores raw text.

## Risks

- Edge may show a "developer mode extensions" warning on start (not verified).
- If Canvas changes the course API or its session cookie policy, the read fails loudly (unavailable), never silently.
- Any local process could try to connect; the origin check stops ordinary local processes, not a malicious local program that forges headers (accepted: same trust level as the local UI server).
