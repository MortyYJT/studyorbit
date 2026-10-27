## 1. Extension

- [x] 1.1 `extension/manifest.json` (MV3, pinned `key`, two host permissions, `alarms` permission), `extension/background.js` (connect, hello, 20 s heartbeat, 1 min alarm reconnect, `read` with URL allow-list), `extension/README.md` (load unpacked steps)

## 2. Bridge (TDD)

- [x] 2.1 `src/sync/extension-bridge.ts`: WebSocket server on `node:http` upgrade, origin check, one connection, `read(url)` with 5 s timeout and immediate failure when disconnected, port-in-use reported as unavailable
- [x] 2.2 Tests with Node's global `WebSocket` client: wrong origin refused, request/response round trip, timeout, no connection, frames over 125 and 65535 bytes

## 3. Layer 0 in the pipeline (TDD)

- [x] 3.1 The course list stage calls the bridge and `SyncJobs.capture({ page: 'courses', text })`; no agent job for the course list; signed-out and failure set `coursesUnavailable`
- [x] 3.2 Run record entry `{ kind: 'courses', via: 'extension', ms, outcome, reason? }`
- [x] 3.3 Start the bridge with the process that runs syncs (`coursework ui`)

## 4. Verify

- [ ] 4.1 `npm run check` exit 0
- [ ] 4.2 Owner's Edge: load the extension, run a sync, the record shows the extension entry and its duration
