# Coursework Canvas Reader

1. Open `edge://extensions` in the Edge profile where you use Canvas.
2. Enable **Developer mode**.
3. Choose **Load unpacked**, then select this repository's `extension/` folder.
4. Confirm the extension ID is `hjllbhkpkhffpbjkdpfigdnlaalopaij`.
5. Sign in to Canvas yourself, then start `coursework ui` and run a sync.

The extension connects to `127.0.0.1:47613` and retries once a minute when disconnected.
It reads the Canvas course API only when a sync requests it, using the browser's existing
session. It opens no tabs and reads no cookies or tokens. Keep Edge running during syncs.
If the extension is unavailable or Canvas is signed out, sync keeps the saved course selection.
After updating these files, choose **Reload** on the extension card.
