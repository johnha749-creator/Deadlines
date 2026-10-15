# Deadline for desktop

This folder turns the Deadline web app in `../app/` (`index.html`, `config.js`, `programs.json`, `assets/`, `src/`) into a desktop app for Windows, macOS and Linux. It uses [Electron](https://www.electronjs.org/), which bundles Chromium, so the page's HTML, JavaScript and WebGL run unchanged.

The desktop version can also do one thing the web page cannot: sign in to Canvas with an access token and sync assignments directly. A web page can't call the Canvas API because of CORS, but the desktop app makes those calls from its own process.

## Rebuild (one command)

```bash
bash desktop/build.sh
```

Run it from the repo root. That's all. It writes these files to `dist/`:

| File | For |
|---|---|
| `Deadline-<version>-win-x64.zip` | Windows 10/11 (64-bit). Unzip it and run `Deadline\Deadline.exe` |
| `Deadline-<version>-mac-arm64.zip` | Macs with Apple silicon (M1 and later) |
| `Deadline-<version>-mac-x64.zip` | Intel Macs |
| `Deadline-<version>-linux-x64.zip` | Linux (64-bit). Unzip it and run `Deadline/deadline` |
| `SHA256SUMS.txt` | Checksums of the zips |

The script always packages whatever `app/index.html`, `app/config.js`, `app/programs.json`, `app/assets/` and `app/src/` currently contain, so after the web app changes you just run it again. It also copies any other file or folder in `app/` that the page references with a relative URL.

Options:

- `--platforms=linux,win,mac` builds only the listed platforms.
- `--skip-test` skips the tests.
- `--config=<file>` ships that file as `config.js` instead of `app/config.js` (handy for a test build against another Supabase project).
- `DEADLINE_DIST_DIR=/some/dir` writes the zips there instead of `dist/`.
- `DEADLINE_BUILD_DIR=/some/dir` changes where the heavy work happens (by default the session scratchpad, otherwise `$TMPDIR/deadline-desktop-build`). `node_modules`, the Electron downloads and the unpacked apps all stay there, never in the project folder.
- To bump the version, change `"version"` in `package.json`.

What you need: Node 22.12 or newer, `curl`, `zip` and `unzip`, plus `xvfb-run` if you want the Linux smoke test. Windows icons and version info are written with pure JavaScript (resedit), so Wine isn't needed. On Linux x64 the script downloads [rcodesign](https://github.com/indygreg/apple-platform-rs) 0.29.0 (the download is checked against a pinned sha256) and uses it to ad-hoc sign the macOS apps.

### What the build does

1. Renders `icon.svg` into `.icns` (macOS), `.ico` (Windows) and PNGs (`scripts/icons.mjs`).
2. Stages the app: `main.js`, `preload.js`, `canvas-api.js`, `web-page.js`, `self-test.js`, and the web files under `web/` (including `config.js` and `src/account.js`, the accounts client). `index.html` gets wrapped into a full document with `<!doctype html>`, `<meta charset="utf-8">` and a viewport meta, because it is written in artifact form. The build stops if `config.js` holds a Supabase secret (`service_role`) key.
3. Downloads the Electron 44 zips with curl and checks them against the sha256 list in the `electron` npm package. Then it packages each platform with `@electron/packager` into an `app.asar`.
4. Turns off the Electron fuses the app doesn't use: `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`, and loading code from outside `app.asar`.
5. Ad-hoc signs both macOS apps with rcodesign, after the fuses are set.
6. Zips everything into `dist/`, keeping macOS symlinks and executable bits.
7. Runs the tests:
   - `test/canvas-api.test.js` runs 15 Canvas tests against a mock Canvas server: validation, pagination, mapping, time zones, 401s, network errors, redirects, and a check that the token is never sent to another host.
   - `test/web-page.test.js` runs 5 tests of the CSP and `config.js` handling: nothing added for an empty `config.js`, only the project's origin added for a real one, plain-http and broken values left out with a warning, and secret keys recognized.
   - `test/verify-packages.mjs` unzips every package and checks its layout, the web files inside `app.asar`, the icons, the Windows version info, the macOS Info.plist, CPU architecture and signature, and the fuses. It then launches the Linux app twice under a virtual display to check that the page loads, `fetch('programs.json')` works, localStorage survives a relaunch, WebGL is available, the CSP is enforced, outside links go to the system browser, and the Canvas bridge works end to end. It also checks accounts: with an empty `config.js` nothing extra is allowed and there are no account screens; with a Supabase project in it, the CSP allows that project (and nothing else) and the page reaches it. Setting `DEADLINE_SELF_TEST_SIGNIN_USER` and `DEADLINE_SELF_TEST_SIGNIN_PASS` (an existing test account) makes the first launch sign in through the app's own form and add a deadline (`DEADLINE_SELF_TEST_ADD_TITLE`, `DEADLINE_SELF_TEST_ADD_DUE`), and the second launch check that it opens still signed in. The report is saved to `$DEADLINE_BUILD_DIR/verify/report.json`, with screenshots next to it.

## Installing it (for students)

The app isn't signed with a paid Apple or Microsoft certificate, so the first launch shows a warning. That's expected. You only have to get past it once.

### Windows

1. Download `Deadline-1.0.0-win-x64.zip`.
2. Right-click the zip, choose **Extract All…**, and pick a folder, for example `Documents` or `C:\Users\<you>\Apps`. Don't run the app from inside the zip; extract it first.
3. Open the extracted `Deadline` folder and double-click **Deadline.exe**.
4. If Windows shows **"Windows protected your PC"** (SmartScreen), click **More info**, then **Run anyway**.
5. Optional: right-click `Deadline.exe` → **Send to** → **Desktop (create shortcut)**, or pin it to Start or the taskbar once it's running.

### macOS

1. Download the zip for your Mac. On Apple silicon (M1, M2, M3, M4…) that's `Deadline-1.0.0-mac-arm64.zip`; on Intel, `Deadline-1.0.0-mac-x64.zip`. To check which you have, open  → **About This Mac** and look at "Chip".
2. Double-click the zip to unzip it, then drag **Deadline.app** into **Applications**.
3. First launch:
   - **macOS 14 Sonoma and earlier:** right-click (or Control-click) Deadline.app, choose **Open**, then click **Open** in the dialog.
   - **macOS 15 Sequoia and later:** double-click Deadline.app. When the warning appears ("Apple could not verify…"), click **Done**. Then open **System Settings → Privacy & Security**, scroll to the Security section, click **Open Anyway** next to "Deadline was blocked…", and confirm with your password.
4. From then on it opens normally from Launchpad, Spotlight or the Dock.

If macOS says the app "is damaged and can't be opened", the download was quarantined in a way the steps above don't clear. Run this once in Terminal and open the app again:
`xattr -dr com.apple.quarantine /Applications/Deadline.app`

### Linux

Unzip it and run `Deadline/deadline`. Some distributions block the Chromium sandbox (Ubuntu 24.04 and later, for example). If the app exits with a sandbox error, run this once from the folder you unzipped into:
`sudo chown root Deadline/chrome-sandbox && sudo chmod 4755 Deadline/chrome-sandbox`

### Updating and your data

To update, download the new zip and replace the old app. Your list is kept separately, in the app's data folder, so updating doesn't lose it:

- Windows: `%APPDATA%\Deadline`
- macOS: `~/Library/Application Support/Deadline`
- Linux: `~/.config/Deadline`

## How it works

- **Loading the page.** The page is served from `app://deadline/index.html` through a privileged custom scheme (standard, secure, fetch-enabled), so it has a stable origin. Relative `fetch('programs.json')` works and localStorage persists between launches. The scheme handler only serves files inside the bundled `web/` folder and blocks path tricks like `../`. It also supports byte ranges, so audio and video can seek.
- **Window.** 1280×820 by default, at least 420×560, and it remembers its size and position. It stays hidden until the first paint (or 2.5 s at most), and its background is the painting's sky blue (`#6E9BD1`), so there's no white flash. The title is "Deadline".
- **Lockdown.** The renderer has `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`, and webviews are disabled. Permission requests are denied except clipboard writes, fullscreen and notifications. On Windows and Linux there's no menu. macOS keeps a minimal App/Edit/View/Window menu so ⌘C, ⌘V and ⌘Q work. Reload and DevTools only appear in development (`npm start`, or with `DEADLINE_DEV=1`).
- **Links.** `http(s)` and `mailto:` links, whether they come from `target="_blank"`, `window.open` or a plain link, open in the system browser. Navigating the app window away from `app://deadline/` is blocked.
- **Content-Security-Policy.** Sent as a header with every page:
  - `script-src` allows only the app's own files plus sha256 hashes of the page's inline `<script>` blocks, computed at load time, so the page can change freely. Remote scripts are blocked.
  - `style-src` allows the app, inline styles and `fonts.googleapis.com`.
  - `font-src` allows the app, `data:` and `fonts.gstatic.com`.
  - Images, media and workers are limited to the app plus `data:`/`blob:`. Fetch (`connect-src`) is too, plus the Supabase project named in `config.js` when accounts are on. With empty values in `config.js` nothing is added.
  - Objects are blocked entirely.
  - If the page ever adds inline `onclick=` handlers, the build warns and `script-src` falls back to `'unsafe-inline'`. It also warns if the page loads a script from a CDN; copy that script into `src/` instead.
- **WebGL.** Uses the GPU when one is available. Software WebGL (SwiftShader) is allowed as a fallback on laptops whose GPU Chromium blocklists, which is safe because the app only shows its own bundled content.
- **Offline.** Everything works offline except the Google Fonts, which fall back to system fonts. Signed in, the list opens from what's saved on the laptop and syncs when the connection is back.

## Accounts

The laptop app uses the same accounts as the website and the iPhone version. When `app/config.js` has the Supabase project URL and publishable key, the app shows **Sign in / Create account**, and the list syncs with the phone. The CSP lets the page reach that one project, and it reads `config.js` both at build time (for `csp.txt`) and when the app starts (`web-page.js` `buildCsp`). With empty values the app works exactly as before, with no account screens. Sign-in uses plain `fetch` from the page (CORS is allowed by Supabase), so the main process isn't involved. The session and the saved list live in the app's localStorage, like the rest of the data.

## Canvas bridge (for the page)

The page already uses it. In the laptop app the Canvas tab opens with **Connect your Canvas account** (address + access token), then shows **Sync now** and **Disconnect** once connected, and the app syncs quietly every time it opens. Synced items go through the same `mergeCanvas()` as the `.ics` import, so deleted items stay deleted and an assignment that came in through both routes (their ids differ) is matched on title + due date and kept once. In the browser none of this shows.

On desktop, the page gets `window.deadlineDesktop`. In the browser artifact it's `undefined`, so check for it first:

```js
if (window.deadlineDesktop?.isDesktop) {
  const { platform, version, canvas } = window.deadlineDesktop;   // platform: "win32" | "darwin" | "linux"

  await canvas.connect({ baseUrl: "school.instructure.com", token });
  //   -> { ok: true, userName: "Alex", baseUrl: "https://school.instructure.com", remembered: true }
  //   -> { ok: false, error: "Canvas did not accept that access token…", code: "unauthorized" }

  await canvas.status();
  //   -> { connected: true, baseUrl, userName, lastSync: "2026-10-13T05:00:00.000Z" | null, remembered }
  //   -> { connected: false }

  await canvas.sync();
  //   -> { ok: true, items: [...], lastSync, pages, truncated }
  //   -> { ok: false, error, code }

  await canvas.disconnect();   // -> { ok: true }
}
```

Each item looks like this:

```js
{ uid: "canvas-api-assignment-101", title: "Lab report: enzymes", due: "2026-10-14", time: "23:59",
  course: "AP Biology", link: "https://school.instructure.com/courses/7/assignments/101",
  type: "assignment", submitted: true }
```

- **Dates:** `due` and `time` are in the computer's local time zone. `time` is `""` for all-day events, and items without a date are skipped.
- **Date range:** a sync covers 14 days back to 180 days ahead (`GET /api/v1/planner/items`). It follows `Link: rel="next"` pages, up to 20 pages of 100 items.
- **Merging:** the page should merge items by `uid`, the same way it merges the `.ics` import.

**Error `code`s:** `bad_url`, `insecure_url`, `bad_token`, `unauthorized` (401: token wrong or expired; a 401 during sync also disconnects), `forbidden` (403), `not_canvas`, `redirect`, `server` (5xx), `http`, `timeout`, `network`, `not_connected`. Every error also has a plain-English `error` string you can show as is.

**Addresses:** anything like `school.instructure.com` or `https://school.instructure.com/courses/12` is accepted and reduced to `https://host`. Plain `http://` is refused, except for `localhost`, which the tests use.

**Token handling.** The token goes to the main process once, in `connect`, and is never handed back to the page. It's stored encrypted with Electron `safeStorage`, which uses the macOS Keychain, Windows DPAPI, or libsecret/KWallet on Linux, in `canvas-connection.json` in the data folder. If no OS keychain is available (some Linux setups), the token is kept in memory for that session only and `remembered` is `false`. The token is only ever sent to the Canvas host the student entered. Pagination links that point to another host are ignored.

**How a student gets a token:** in Canvas, open **Account → Settings**, scroll to **Approved Integrations**, click **+ New Access Token**, give it a name, and copy the token. Some schools turn this off; then the `.ics` calendar import is the fallback.

## Development

```bash
cd desktop
npm install        # on your own machine (node_modules stays out of the build)
npm start          # runs the app straight from ../app/ with reload + DevTools (Electron downloads itself the first time)
npm test           # Canvas bridge tests (node --test test/web-page.test.js runs the CSP / config.js tests)
```

## Files

| File | What it is |
|---|---|
| `main.js` | Electron main process: `app://` scheme, window, CSP, link handling, permissions, Canvas IPC, token storage |
| `preload.js` | Exposes `window.deadlineDesktop` through `contextBridge` |
| `canvas-api.js` | Canvas client (pure Node; `fetch` is injected): URL/token checks, pagination, item mapping, error messages |
| `web-page.js` | Wraps the artifact-form `index.html`, reads `config.js`, and builds the CSP (also used by `web/build-site.mjs`) |
| `self-test.js` | Smoke test, active only with `DEADLINE_SELF_TEST=1` (used by the build) |
| `icon.svg` | App icon source (calendar tile with a cherry blossom) |
| `build.sh`, `scripts/build.mjs`, `scripts/icons.mjs` | The build |
| `test/` | Mock Canvas server, Canvas tests, package checks |

## Known limits

- **Unsigned.** The apps aren't signed with a Developer ID or Authenticode certificate, and they aren't notarized, so the first launch shows the warnings described above. Removing them for good needs an Apple Developer account ($99/year, then sign and notarize) and a Windows code-signing certificate.
- **Not tried on real hardware.** The Windows and macOS builds were checked structurally on Linux (layout, icons, metadata, architecture, signature bindings) but not launched on real Windows or Mac machines. Only the Linux build was actually run (headless).
- **Keychain prompt.** macOS may ask once to allow "Deadline Safe Storage" in the Keychain after an update, because each ad-hoc build has a new signature.
