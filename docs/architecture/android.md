# Android main tablet

The Android app (`android/`) runs the same backend as the desktop app on a tablet: the POS API on
`:3001`, the KDS server on `:3002`, and the Server App on `:3003`, all on `0.0.0.0`, so other devices
on the Wi-Fi connect to the tablet as they would to the Windows PC. The tablet itself shows the POS
in a full-screen WebView.

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

1. `MainActivity` starts `NodeService`, a `specialUse` foreground service with a persistent
   notification. It holds a partial wake lock, a low-latency Wi-Fi lock, and a multicast lock.
   `BootReceiver` also starts it after a reboot and after an app update.
2. `NodeRuntime` unpacks `assets/nodejs-project.zip` into the app's files directory when the
   installed APK changed, copies the `better-sqlite3` binary for the device ABI into place, and
   starts Node with the environment `main/android/bootstrap.ts` reads.
3. The entry installs the Android [platform host](runtime-and-lifecycle.md#platform-host), connects
   to the shell's bridge, and starts the same services as the desktop `initialize()`: database,
   POS API, cloud sync, Google Drive, local backup, KDS server, Server App, and printer
   initialisation. Telemetry and PostHog are never started on Android.
4. Node sends `ready` with the three ports. The shell then loads `http://127.0.0.1:3001/`.

`MainActivity` keeps the screen on while it is visible, hides the system bars, and asks once to be
exempted from battery optimisation.

## Where data lives

| Data | Location |
| --- | --- |
| `flo.db`, pre-migration backups, `logs/main.log`, `master-pin.enc`, the WhatsApp auth directory | `flo-data/` in the app's no-backup files directory (`FLO_ANDROID_USER_DATA`) |
| Daily local backups (`FloCafe/Backups`) and manual backups (`FloCafe/Manual Backups`) | `Documents/AlBaikPOS` in shared storage when it is writable, otherwise the app's own documents folder (`FLO_ANDROID_DOCUMENTS`) |
| The 32-byte secret-storage key | `secret-key.bin` in the no-backup files directory, wrapped by a non-exportable Android Keystore AES key |

`android:allowBackup` is `false`, so Android cloud backup never copies the database. Uninstalling
the app deletes `flo-data/`; backups in shared `Documents/AlBaikPOS` remain.

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
| Shell to Node | `hostAction` | The renderer's database, settings, and diagnostics actions |
| Shell to Node | `shutdown` | Drains the servers and closes the database |

## The `electronAPI` shim

The shell injects
[`android/app/src/main/assets/electron-api-shim.js`](../../android/app/src/main/assets/electron-api-shim.js)
at document start, into the POS origin only, as the Android stand-in for `main/preload.ts`. It posts
to the shell through an `AlBaikNative` WebView message channel limited to that origin and the main
frame. It makes no network calls of its own.

| Methods | Android behaviour |
| --- | --- |
| `backupDatabase`, `restoreBackup`, `pickRestoreFile`, `dbHealthCheck`, `dbApplySafeFixes`, `dbInitialize`, `getMasterPinStatus`, `getSettings`, `setSetting`, `getKdsInfo`, `getAppInfo`, `getLogTail`, `reportRendererError`, `openWhatsAppShare`, `getPrinters` | `hostAction` to [`main/android/host-action-routes.ts`](../../main/android/host-action-routes.ts), which calls the same [`main/host-actions.ts`](../../main/host-actions.ts) functions as Electron IPC. A successful `backupDatabase` also offers the system "save as" dialog for a copy. |
| `openKdsWindow` | Shows the KDS page in an in-page overlay |
| `getPostHogBootstrap` | `{ enabled: false }` |
| `getUpdateStatus`, `checkForUpdates`, `downloadUpdate`, `restartAndInstall`, `onUpdateStatus` | Report `store-managed`; Android updates by installing a new APK |
| `windowReady`, `windowAction`, `getWindowState`, `onWindowStateChanged`, `setThemeEffective`, `getApplicationMenu`, `openApplicationMenu`, `onMenuAction` | Safe no-ops; the window is always full screen and has no menu |
| `getStatus` | Absent. The renderer draws the desktop title bar when it exists. |
| `rasterizePrintDocument`, `rasterizeKotDocument` | Absent. They serve the WebUSB path, and a WebView has no WebUSB. |
| `saveHtmlAsPdf` | Absent. The renderer falls back to printing, and the Android print dialog offers "Save as PDF". |
| `getBetaChannel`, `setBetaChannel`, `getAutoUpdateCheck`, `setAutoUpdateCheck` | Absent, so the update toggles report unsupported |

`tests/android-electron-api-shim.test.ts` pins this coverage against `main/preload.ts`.

Because a WebView has no pop-up windows, `window.print()`, or downloads, the shim also:

- shows `window.open('')` documents (browser-mode bills, slips, menus) in an in-page overlay with
  Print and Close. Print sends the document to `HtmlPrinter`, which opens the Android print dialog;
  the overlay closes when that dialog closes, returning to the POS.
- opens `window.open()` links to other origins outside the app.
- hands `<a download>` blobs (exports) to the system "save as" dialog.

## Printing

Receipts and KOTs sent to a network printer print from the backend over raw TCP exactly as on
desktop. The `usb` (operating-system spooler) and `webusb` transports do not work on Android. With no
thermal printer configured, the renderer's browser print path goes through the overlay and Android
print service described above.

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
`android/app/build/outputs/apk/`. The `Android` workflow
([`.github/workflows/android.yml`](../../.github/workflows/android.yml)) builds both and runs the
x86_64 APK in an emulator, inspecting the live WebView over the DevTools protocol
([`android/scripts/ci-smoke.sh`](../../android/scripts/ci-smoke.sh)).
