# Android app

The Android app (`android/`) has two device roles, chosen on first launch:

- **Main tablet** runs the same backend as the desktop app: the POS API on `:3001`, the KDS server
  on `:3002`, and the Server App on `:3003`, all on `0.0.0.0`, so other devices on the Wi-Fi connect
  to the tablet as they would to the Windows PC. The tablet itself shows the POS in a full-screen
  WebView.
- **Screen** runs no server. It shows one page of a main device (the Android main tablet or the
  desktop app) full screen: the waiter app, the kitchen display, or the POS.

## Device roles

`LauncherActivity` (the app icon) opens `SetupActivity` until a role is saved, then `MainActivity`
for a main tablet or `ScreenActivity` for a Screen. An install whose `flo-data/flo.db` already
exists counts as a main tablet. The role is kept in the `albaik-pos-mode` shared preferences
(`AppMode`), and the app icon's "Change device role" shortcut reopens the setup. Choosing Screen
stops `NodeService`; the main-tablet data stays on the device.

A Screen picks what it shows, which fixes the page and the main device's port for it:

| Role | Page | Port |
| --- | --- | --- |
| Waiter app | `/server-standalone/` | Server App (`3003`) |
| Kitchen display | `/kds-standalone/` | KDS server (`3002`) |
| POS | `/` | POS API (`3001`) |

It finds the main device in one of three ways:

- **Wi-Fi discovery.** The Android main tablet registers an `_http._tcp` service named `Flo` with
  `NsdManager` once the servers are up, with the same TXT keys as the desktop app's Bonjour record
  (`version`, `kds`, `kds_port`, `server_app`, `server_app_port`). `ServerDiscovery` lists every
  `Flo` service on the network, so a Screen finds a desktop main device the same way.
- **QR code.** Any of the POS's own QR links (`http://<ip>:<port>`, shown in Settings) gives the
  host; the port comes from the role.
- **Typed address.**

The setup saves the device only after the role's page answers. `ScreenActivity` then shows that
page with [`webview-shim.js`](../../android/app/src/main/assets/webview-shim.js) only, so the page
runs as a browser client. It checks the main device every 20 seconds; after two misses, a failed
page load, or a lost network, it shows "Reconnecting", retries every 3 seconds, reloads the page
when the main device answers, and after five failed retries looks for the saved `Flo` service again
in case the main device's address changed.

## Process model

One Android process holds both halves:

- **The shell** (Java, `android/app/src/main/java/com/albaik/pos/`) owns the screen, the foreground
  service, file pickers, printing, and the Android Keystore.
- **The backend** runs on [nodejs-mobile](https://github.com/digidem/nodejs-mobile) (`libnode.so`,
  Node 24) on a dedicated thread. Its entry is
  [`main/android/entry.ts`](../../main/android/entry.ts). It loads no Electron module;
  `tests/android-runtime.test.ts` runs it with `electron` unresolvable.

Node can start only once per process. If it stops while the POS is on screen, the shell shows a
Restart button. If it stops while nobody is looking, `NodeService` ends the process so Android
restarts the sticky service and the servers come back.

The pinned runtime versions live at the top of
[`android/scripts/stage-node-project.sh`](../../android/scripts/stage-node-project.sh): the
nodejs-mobile release and the `better-sqlite3` Android prebuild, which must equal the installed
`better-sqlite3` version (the script refuses to stage otherwise).

## Startup

1. On a main tablet, `MainActivity` starts `NodeService`, a `specialUse` foreground service with a
   persistent notification. It holds a partial wake lock, a low-latency Wi-Fi lock, and a multicast
   lock. `BootReceiver` also starts it after a reboot and after an app update; on a Screen it does
   nothing.
2. `NodeRuntime` unpacks `assets/nodejs-project.zip` into the app's files directory when the
   installed APK changed, copies the `better-sqlite3` binary for the device ABI into place, and
   starts Node with the environment `main/android/bootstrap.ts` reads.
3. The entry installs the Android [platform host](runtime-and-lifecycle.md#platform-host), connects
   to the shell's bridge, and starts the same services as the desktop `initialize()`: database,
   POS API, KDS server, Server App, and printer initialisation. Telemetry, PostHog, cloud sync,
   Google Drive and scheduled backups are never started on Android.
4. Node sends `ready` with the three ports. The shell then loads `http://127.0.0.1:3001/` and
   advertises the POS on the network.

`MainActivity` and `ScreenActivity` share `WebShellActivity`: both keep the screen on while visible
and hide the system bars. `MainActivity` also asks once to be exempted from battery optimisation.

## Where data lives

| Data | Location |
| --- | --- |
| `flo.db`, `logs/main.log`, `master-pin.enc`, the WhatsApp auth directory | `flo-data/` in the app's no-backup files directory (`FLO_ANDROID_USER_DATA`) |
| The documents folder (crash reports only) | `Documents/AlBaikPOS` in shared storage when it is writable, otherwise the app's own documents folder (`FLO_ANDROID_DOCUMENTS`) |
| Crash reports: `crash-*.txt` (Java stack, written as the app dies) and `exit-*.txt` (Android's reason for an abnormal end, including native and WebView renderer crashes, plus the last printing steps from `logs/native.log` and the tail of `main.log`, which on Android also receives console output, written on the next start, Android 11+) | `logs/` in the documents folder above and in `flo-data/`, by `PosApplication` |
| The 32-byte secret-storage key | `secret-key.bin` in the no-backup files directory, wrapped by a non-exportable Android Keystore AES key |

`android:allowBackup` is `false`, so Android cloud backup never copies the database. Uninstalling
the app deletes `flo-data/`.

### No backups and no cloud

The Android app keeps no copy of the store's data; the store wipes its sales data daily. Under the
Android platform host (`platformId() === 'android'`):

- `createBackup()` is refused (`ERR_BACKUPS_DISABLED`), so manual backups, the database download,
  daily local backups and Google Drive backups all fail before writing anything, and the
  automatic and local backup switches read as off and cannot be turned on.
- The pre-migration backup is skipped, and a reset or currency reset deletes its own copy once it
  commits. The short-lived recovery copy a reset or restore uses to roll back an interrupted
  replacement is kept until that replacement finishes, as on desktop.
- At startup, `removeKeptBackups()` deletes `flo-backup-*.db` files an earlier build left in
  `flo-data/backups`.
- Offline mode is always on (`isOfflineModeLocked()`), so there is no FloPOS cloud registration or
  sync, Google Drive or WhatsApp; `PUT /api/settings/offline-mode` with `false` answers `409`.
  Restore from a backup file the operator brings still works.

Secrets the desktop app seals with Electron `safeStorage` (master PIN, JWT secret file, Google Drive
tokens) are sealed with AES-256-GCM under the Keystore-wrapped key
([`main/platform/keyed-safe-storage.ts`](../../main/platform/keyed-safe-storage.ts)). They cannot be
decrypted on another device.

## The native bridge

Node and the shell talk over an abstract Unix socket with newline-delimited JSON
([`main/android/native-bridge.ts`](../../main/android/native-bridge.ts) and `ShellBridge.java`). The
shell accepts a connection only from its own UID, and only after Node presents the per-launch token
passed in its environment. `bootstrap.ts` removes the token and the secret key from `process.env`
once read.

| Direction | Message | Purpose |
| --- | --- | --- |
| Node to shell | `ready`, `failed` events | Startup result and the server ports |
| Node to shell | `openExternal`, `pickFile`, `confirm` | Links, the restore file picker, the schema-mismatch confirmation |
| Node to shell | `printerList`, `printerSend`, `rasterRender` | USB and Bluetooth printer discovery, raw ESC/POS jobs, raster units |
| Shell to Node | `hostAction` | The renderer's database, settings, and diagnostics actions |
| Shell to Node | `shutdown` | Drains the servers and closes the database |

## The `electronAPI` shim

On a main tablet the shell injects, at document start and into the POS origin only,
[`webview-shim.js`](../../android/app/src/main/assets/webview-shim.js) and then
[`electron-api-shim.js`](../../android/app/src/main/assets/electron-api-shim.js), the Android
stand-in for `main/preload.ts`. Both post to the shell through an `AlBaikNative` WebView message
channel limited to the trusted origin and the main frame. They make no network calls of their own.

| Methods | Android behaviour |
| --- | --- |
| `backupDatabase`, `restoreBackup`, `pickRestoreFile`, `dbHealthCheck`, `dbApplySafeFixes`, `dbInitialize`, `getMasterPinStatus`, `getSettings`, `setSetting`, `getKdsInfo`, `getAppInfo`, `getLogTail`, `reportRendererError`, `openWhatsAppShare`, `getPrinters` | `hostAction` to [`main/android/host-action-routes.ts`](../../main/android/host-action-routes.ts), which calls the same [`main/host-actions.ts`](../../main/host-actions.ts) functions as Electron IPC. `backupDatabase` is refused on Android (see [No backups and no cloud](#no-backups-and-no-cloud)). |
| `openKdsWindow` | Shows the KDS page in an in-page overlay |
| `getPostHogBootstrap` | `{ enabled: false }` |
| `getUpdateStatus`, `checkForUpdates`, `downloadUpdate`, `restartAndInstall`, `onUpdateStatus` | Report `store-managed`; Android updates by installing a new APK |
| `windowReady`, `windowAction`, `getWindowState`, `onWindowStateChanged`, `setThemeEffective`, `getApplicationMenu`, `openApplicationMenu`, `onMenuAction` | Safe no-ops; the window is always full screen and has no menu |
| `getStatus` | Absent. The renderer draws the desktop title bar when it exists. |
| `rasterizePrintDocument`, `rasterizeKotDocument` | Absent. They serve the WebUSB path, and a WebView has no WebUSB. |
| `saveHtmlAsPdf` | Absent. The renderer falls back to printing, and the Android print dialog offers "Save as PDF". |
| `getBetaChannel`, `setBetaChannel`, `getAutoUpdateCheck`, `setAutoUpdateCheck` | Absent, so the update toggles report unsupported |

`tests/android-electron-api-shim.test.ts` pins this coverage against `main/preload.ts`.

Because a WebView has no pop-up windows, `window.print()`, or downloads, `webview-shim.js`, which
both roles inject:

- shows `window.open('')` documents (browser-mode bills, slips, menus) in an in-page overlay with
  Print and Close. Print sends the document to `HtmlPrinter`, which opens the Android print dialog;
  the overlay closes when that dialog closes, returning to the POS.
- opens `window.open()` links to other hosts outside the app, and links to the shown server inside
  the overlay.
- hands `<a download>` blobs (exports) to the system "save as" dialog.

## Printing

The Android [platform host](runtime-and-lifecycle.md#platform-host) supplies `printers` and
`rasterRenderer`, which [`main/printers/thermal.ts`](../../main/printers/thermal.ts) uses in place of
the operating-system spooler and the Electron raster window. Everything else in the
[print pipeline](printing.md) runs unchanged, so a job's bytes match the desktop app's for the same
printer settings (`tests/android-printing.test.ts` compares bill, KOT, shift-close Z, and
day-close Z output with the desktop raw TCP path).

- **Network printers** print from the backend over raw TCP, as on desktop.
- **USB and Bluetooth printers** are reached through `PrinterHub` in the foreground service, so
  jobs print with the screen off. Printer detection in Settings > Printers lists USB devices with a
  printer-class or vendor-specific bulk OUT endpoint as `<product> (USB <vid>:<pid>)`, and paired
  Bluetooth devices that look like printers as `<name> (Bluetooth <address>)`. Either is saved as a
  `usb` printer under that name, and the name is how a job finds its device. USB jobs are sent by
  bulk transfer; Android asks once for permission, and plugging the printer in offers an "Always"
  choice that keeps it. Bluetooth jobs are sent over SPP (RFCOMM) and need the "Nearby devices"
  permission. A `usb` printer whose name has neither tag (for example one saved by the Windows app)
  prints to the single attached USB printer, and fails with a message when there is not exactly one.
- **No `Intl.Segmenter` in Node.** The nodejs-mobile ICU data has no break-iterator rules, and
  `Intl.Segmenter#segment` crashes the whole app instead of throwing, so the shared print width
  helpers (`shared/print/width.ts`) split graphemes with their own fallback when
  `process.platform` is `android`. `/format-probe` runs every ICU feature the backend uses on the
  device, and the smoke test runs it.
- **Raster text.** Text the printer's code page cannot encode, such as the rupee sign on a generic
  58 mm profile or Arabic-script item names, is drawn by `RasterSurface`: a hidden WebView running
  the backend's `rasterRendererHtml()` page behind
  [`raster-host.js`](../../android/app/src/main/assets/raster-host.js), the Android counterpart of
  `main/raster-preload.ts`. `tests/android-raster-surface.test.ts` runs that page and script in
  Chromium.
- **WebUSB** printers do not work in the Android WebView.

With no thermal printer configured, the renderer's browser print path goes through the overlay and
Android print service described above.

## Building

```sh
npm run build
npm run build:frontend
bash android/scripts/stage-node-project.sh
cd android && ./gradlew assembleDebug
```

The staging script packs `dist/`, `frontend/out/`, and production `node_modules` (without
desktop-only native payloads, documentation, and type declarations) into the app assets, and fetches
the pinned runtime binaries. Gradle produces one APK per ABI (`arm64-v8a`, `x86_64`) in
`android/app/build/outputs/apk/`.

### Signing and updates

Android installs a new APK over an existing one only when both are signed with the same key and the
new `versionCode` is not lower. Otherwise the old app has to be uninstalled first, and uninstalling
deletes `flo-data/`, the tablet's database. When the `ALBAIK_KEYSTORE_PATH`,
`ALBAIK_KEYSTORE_PASSWORD`, `ALBAIK_KEY_ALIAS`, and `ALBAIK_KEY_PASSWORD` environment variables are
set, [`android/app/build.gradle`](../../android/app/build.gradle) signs both debug and release builds
with that key, so either installs over the other.

The `Android` workflow ([`.github/workflows/android.yml`](../../.github/workflows/android.yml)) reads
the key from these repository secrets:

| Secret | Value |
| --- | --- |
| `ALBAIK_ANDROID_KEYSTORE_BASE64` | The keystore file, base64-encoded |
| `ALBAIK_ANDROID_KEYSTORE_PASSWORD` | The keystore password |
| `ALBAIK_ANDROID_KEY_ALIAS` | The key alias |
| `ALBAIK_ANDROID_KEY_PASSWORD` | The key password |

To create the key once, on any computer with a JDK:

```sh
keytool -genkeypair -keystore albaik-release.jks -alias albaik -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 albaik-release.jks
```

Keep `albaik-release.jks` and its passwords outside the repository. A lost key means the next APK
cannot install as an update.

With the secrets set, the workflow uploads `Al-Baik-POS-Android-debug` and
`Al-Baik-POS-Android-release` APKs, gives every run a higher `versionCode` (the `package.json`
version followed by the run number), and checks that all APKs carry the same certificate. Without
them it signs with a key made for that run, warns that its APKs cannot be updated in place, and
publishes only the debug APKs.

### CI checks

The workflow runs the x86_64 debug APK in an emulator and inspects the live WebView over the
DevTools protocol ([`android/scripts/ci-smoke.sh`](../../android/scripts/ci-smoke.sh)): the servers
and their bind addresses, the shims, the raster surface, a print job to an unanswered Bluetooth
address (it must reach the connect step without closing the app), a refused backup that leaves no
file on the device's shared storage, the system save and print screens, an update to the release APK that must reopen the
existing database, a forced crash that must leave both crash reports, and Screen mode against a
stand-in main device, including reconnecting after it goes away.
