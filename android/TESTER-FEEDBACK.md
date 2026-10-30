# Android port: tester feedback tracker

Issues reported by the owner while testing Android builds. Each one must be
fixed and re-tested on a device before the port is called done.

| # | Reported | Build | Issue | Status | Phase |
| --- | --- | --- | --- | --- | --- |
| 1 | 2026-10-30 | x86_64 spike, Pixel Tablet emulator, API 37 | After placing an order the app is stuck on the browser "Print Bill" page with no way back. Printing must never navigate away from the POS; until native printing exists the POS must return to the order screen after the bill. Cause: `frontend/src/lib/printer/web-print.ts` opens the bill with `window.open`, which the Android WebView loads in the same view. Fix: the shim shows the bill in an in-page overlay; Print opens the Android print dialog and the overlay closes back to the POS when it ends (emulator-checked in CI). With a USB or Bluetooth thermal printer added in Settings > Printers, bills print directly and the overlay is not used. | Fixed, needs device re-test | 2 (no trap), 3 (thermal print) |
| 2 | 2026-10-30 | same | The Android title bar ("Al Baik POS (spike)") takes space at the top. The app must be full-screen / immersive with no title bar. Fix: no action bar theme, system bars hidden, and the shim omits `getStatus` so the POS draws no desktop title bar (emulator-checked in CI). | Fixed, needs device re-test | 2 |
| 3 | 2026-10-30 | same | Amounts show `$` instead of `₹`. Likely cause: fresh empty database on an `en-US` emulator, so the setup wizard defaulted to US (currency comes only from the wizard). Must confirm the imported Windows `flo.db` shows `₹` and its settings. | Needs check | 5 |

Working as reported in the same test: app starts, POS loads, an order can be placed, and the bill is generated.
