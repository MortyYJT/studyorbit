## ADDED Requirements

### Requirement: Narrow browser bridge
Collectors SHALL use the browser only through a `BrowserBridge` with the operations open (background tab, previously active tab restored), state (`loading`, `ready`, `redirect` by URL prefix), read and close. Read SHALL accept only the kinds `same-origin-json` and `body-text`, each mapped to one constant expression; no operation SHALL accept JavaScript text from a caller. Open SHALL refuse a URL whose origin is not the configured Canvas origin or an origin of the active framework source. No bridge SHALL call a cookie, storage, network-interception or download API. The shared page loop SHALL keep today's limits: 20 s to load, 250 ms polling, two read attempts 500 ms apart, and closing the tab in all cases.

#### Scenario: Foreign origin
- **WHEN** a collector asks the bridge to open `https://example.org/` while the Canvas origin is `https://canvas.example.edu`
- **THEN** open throws before any browser call

#### Scenario: Signed out
- **WHEN** the opened tab's URL stops matching the expected prefix
- **THEN** state returns `redirect`, nothing is read, and the tab is closed

### Requirement: AppleScript bridges for Edge and Chrome on macOS
On macOS the bridges `edge-applescript` and `chrome-applescript` SHALL run today's AppleScript with the application name taken from a fixed map (`Microsoft Edge`, `Google Chrome`), never from settings text. Before opening a tab they SHALL check that the application is running and otherwise fail with 「请先打开 <浏览器> 并登录」 without launching it. Errors about JavaScript from Apple Events SHALL name the chosen browser and its menu path. These bridges SHALL be unavailable on other platforms.

#### Scenario: Chrome chosen
- **WHEN** the browser setting is `chrome-applescript`
- **THEN** every generated script addresses `application "Google Chrome"` and no script addresses Edge

#### Scenario: Browser not open
- **WHEN** Chrome is not running
- **THEN** the collector fails with the not-open message, Chrome is not started, and the course gets the Canvas placeholder

### Requirement: Experimental CDP bridge for Windows and Linux
The bridges `cdp-chrome` and `cdp-edge` SHALL launch the installed browser (from the `browserPath` setting or known install locations) with `--remote-debugging-pipe` and a dedicated profile directory under `.local/browser/` (created owner-only), and SHALL NOT open a debugging port. They SHALL send only `Target.createTarget`, `Target.attachToTarget`, `Target.getTargetInfo`, `Target.closeTarget`, `Runtime.evaluate` with the constant expressions, and `Browser.close`; any other method SHALL throw before sending. When the profile is already in use they SHALL fail with 「StudyOrbit 专用浏览器已在运行，请先关闭它」. The browser SHALL be closed when the collector finishes, fails or is cancelled. `npm run browser:login` SHALL open the dedicated profile without the pipe for the owner to sign in. The settings page and docs SHALL label these bridges experimental and not verified on Windows or Linux.

#### Scenario: Disallowed method
- **WHEN** code asks the CDP bridge to send `Network.getAllCookies`
- **THEN** it throws and nothing is written to the pipe

#### Scenario: Launch arguments
- **WHEN** the CDP bridge launches Chrome on Windows
- **THEN** the arguments contain `--remote-debugging-pipe` and `--user-data-dir=<project>\.local\browser\cdp-chrome`, and none contains `--remote-debugging-port`

#### Scenario: Signed out in the dedicated profile
- **WHEN** the Canvas tab redirects during CDP collection
- **THEN** the collector fails with 「请运行 npm run browser:login 登录后重试」
