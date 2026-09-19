# Development and releases

Citropy packages Linux x64 as an AppImage and macOS as a zip of `Citropy.app` for arm64 and x64. Building requires Node.js 22.18 or later, npm, Git, and the system tools needed to compile node-pty. The packaged app includes Electron and its own Node runtime. Users still install and sign in to their chosen provider CLI.

The macOS build is ad-hoc signed, without an Apple certificate, and the app is not notarized. Ad-hoc signing is what Apple Silicon requires to run. The app installs through `scripts/install.sh`, which unpacks it without the quarantine flag, because Gatekeeper blocks a browser-downloaded copy on macOS 15 and later. macOS builds cannot use the Electron updater, so the app's update button runs the same installer. Buying an Apple Developer ID later needs three changes together: a real `mac.identity` with `CSC_LINK`, the hardened runtime turned back on with the Electron entitlements, and notarization credentials. The installer script and the app's update path do not change.

Lemon builds use a prerelease version like `0.2.1-lemon.42`, one patch above the current stable version, so they sort above the release they came from. The app detects the channel from its version string. They install as `Citropy Lemon` with their own bundle identifier, data directory (`~/.citropy-lemon`), Electron profile, and port 4179, which lets stable and Lemon run side by side. Lemon updates always go through the installer on every platform, and the installer reopens the app when it finishes.

## Development

Run `npm ci`, then `npm run desktop:dev` for the desktop or `npm run dev` for the web interface. Vite serves the interface at `http://127.0.0.1:5177` and proxies to the development backend at port 4178. Ordinary builds use port 4177.

Development uses `~/.citropy-dev` for conversations, settings, terminals, and built-in skills. Its Electron profile is `Citropy Dev` under the operating system's application-data directory. Production uses `~/.citropy` and the `Citropy` desktop profile. Development does not migrate existing Loom or Citropy data. Provider CLI credentials and user-installed skills still belong to their providers and remain shared.

`CITROPY_DATA_DIR`, `CITROPY_DESKTOP_DATA`, `CITROPY_PORT`, and `CITROPY_UI_PORT` override the corresponding defaults. Give additional development instances distinct paths and backend/frontend ports. An occupied frontend port causes startup to fail instead of connecting to a different instance. Do not point development at your production data.

Live-update status, server restart, and provider-event diagnostics appear only in development. Mode is fixed at startup. Packaged builds reject requests to enable development tools and do not collect provider-event diagnostics. Resource usage remains available in both modes.

`npm run desktop:install` installs a normal source-checkout launcher. Build the interface first with `npm run build`. `npm run desktop:install -- --dev` installs a separate **Citropy Dev** launcher with live updates. Neither command installs the AppImage.

## Local release check

```sh
npm ci
npx playwright install --with-deps chromium
npm run typecheck
npm test
npm audit --omit=dev --audit-level=high
npm run desktop:package
npm run desktop:smoke
```

The desktop tests require Xvfb, xdotool, D-Bus, Python's dbus and GI modules, GStreamer base/good plugins, and GdkPixbuf. The GitHub workflow lists the Ubuntu packages.

Packaging writes the AppImage, `latest-linux.yml`, and the unpacked app to `release/`. The smoke check launches the AppImage with temporary data and verifies startup, shutdown, development restrictions, release contents, and settings at two window widths. Its screenshots also go in `release/`. It does not start a model conversation or consume provider usage.

On macOS, `npm run desktop:package -- --mac` writes `Citropy-<version>-arm64.zip`, `Citropy-<version>-x64.zip`, and `latest-mac.yml`. The zips contain an ad-hoc signed `Citropy.app`; `desktop/smoke-mac.mjs` unpacks both with `ditto`, verifies each signature with `codesign`, checks both main binaries and the node-pty files with `lipo` for the right architecture, and launches the host architecture to check startup and SIGTERM shutdown. The architecture list lives in `desktop/electron-builder.yml`; the packaging command does not narrow it.

The package includes the application license and bundled font licenses. Source tests, development launchers, Vite, Playwright, local state, and environment files are excluded. The source repository deliberately keeps `private: true` in package.json to prevent accidental npm publication; this does not restrict GitHub releases.

## GitHub release

Every push and pull request runs type checking, tests, a production dependency audit, installer script checks, AppImage packaging, and the packaged smoke check on Linux, plus a macOS package build, smoke check, and a run of the installer against a locally served release. Successful runs upload the AppImage, update manifest, and SHA-256 checksums as the `linux-x64` artifact and the macOS zips as the `mac-package` artifact.

Pushing to `main` also runs the **Lemon** workflow. It runs the same checks first, then builds every platform from that commit with a version like `0.2.1-lemon.42`, writes `version.json` with that version, and refreshes the rolling `lemon` prerelease. Installers download the zips and `version.json` first and `SHA256SUMS` last, so a half-finished publish shows up as a checksum failure rather than a mismatched install. `scripts/install.sh --channel=lemon` installs it. Lemon releases are automatic and never touch the stable `v<version>` tags.

Releases start from the Actions tab with the **Release** workflow. Enter the version to ship, for example `0.2.0`, and run it from `main`. The workflow refuses anything other than `main`, a version that does not look like `X.Y.Z`, a version that is not greater than the current one, and a tag that already exists. It then runs the same checks, builds Linux and macOS in parallel with that version, and only after both builds pass it commits the version bump, pushes the `v<version>` tag, and opens a **draft** GitHub release. A failed build leaves the repository untouched.

Inspect the draft, then publish it. Publishing is a separate action; ordinary commits and tags do not publish releases.

Keep the AppImage and `latest-linux.yml` together in the published release so the in-app updater can find and verify the download, and keep the zips plus `SHA256SUMS` together so `scripts/install.sh` can find and verify its download. The Linux installer extracts the menu icon from the AppImage it just downloaded. Neither build is signed by a certificate authority. The checksum detects changed downloads but does not replace release signing.

## Context size

New MCP connections advertise `ask_user`, `tool_help`, and `run_tool`. Claude also receives its required approval bridge. `tool_help` returns the existing schemas for one category; `run_tool` dispatches the selected operation through the existing permission, workspace ownership, and cancellation checks. No code evaluation is involved. The full tool list remains visible in the workspace Tools panel.

Existing direct calls continue to work. Existing provider sessions may retain previously loaded schemas until they reconnect. Third-party MCP servers and provider-native tools keep their own context behavior.
