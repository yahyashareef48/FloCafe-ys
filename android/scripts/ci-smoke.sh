#!/usr/bin/env bash
# CI smoke test: installs the x86_64 debug APK on a running emulator, waits for the
# on-device servers, and inspects the live POS WebView over Chrome DevTools.
set -uo pipefail
APK="$1"
OUT="${2:-android-smoke}"
RELEASE_APK="${3:-}"
PKG=com.albaik.pos
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT"

adb logcat -c || true
adb install -r -g "$APK"
adb shell am start -W -n "$PKG/.MainActivity" --ez albaik.debug.mainMode true
for port in 3001 3002 3003; do adb forward tcp:$port tcp:$port; done

ok=0
for i in $(seq 1 240); do
  if curl -fsS -m 2 http://127.0.0.1:3001/api/health > "$OUT/health.json" 2>/dev/null; then ok=1; echo "health OK after ${i}s"; break; fi
  sleep 1
done

{
  echo "health_ok=$ok"
  for port in 3001 3002 3003; do
    echo "port_${port}=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:$port/)"
  done
  echo "kds_standalone=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3002/kds-standalone/)"
  echo "server_standalone=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3003/server-standalone/)"
  echo "--- listening sockets (00000000 = all interfaces, 0100007F = loopback) ---"
  adb shell cat /proc/net/tcp | awk 'NR > 1 && $4 == "0A" { print $2 }'
} | tee "$OUT/summary.txt"

checks=1
if [ "$ok" = 1 ]; then
  # The Bluetooth print check needs the radio on; the emulator has a virtual adapter.
  adb shell cmd bluetooth_manager enable >/dev/null 2>&1 || adb shell svc bluetooth enable >/dev/null 2>&1 || true
  for i in $(seq 1 15); do [ "$(adb shell settings get global bluetooth_on | tr -d '\r')" = 1 ] && break; sleep 1; done
  echo "bluetooth_on=$(adb shell settings get global bluetooth_on | tr -d '\r')"
  sleep 10
  pid="$(adb shell pidof "$PKG" | tr -d '\r')"
  adb forward tcp:9222 "localabstract:webview_devtools_remote_${pid}"
  node "$SCRIPTS/cdp-check.cjs" 9222 | tee "$OUT/webview-checks.txt"
  checks=${PIPESTATUS[0]}
fi

update_checks=0
if [ "$checks" = 0 ] && [ -n "$RELEASE_APK" ]; then
  echo "--- Updating to the release APK keeps the tablet's data ---"
  update_checks=1
  # Kept for the native crash report at the end; the update check reads a fresh log.
  adb logcat -d > "$OUT/logcat-before-update.txt" || true
  adb logcat -c || true
  if adb install -r "$RELEASE_APK"; then
    # The role is already saved as main tablet, so the launcher opens the POS directly.
    adb shell am start -W -n "$PKG/.LauncherActivity"
    for i in $(seq 1 120); do
      if curl -fsS -m 2 http://127.0.0.1:3001/api/health > /dev/null 2>&1; then echo "release health OK after ${i}s"; break; fi
      sleep 1
    done
    sleep 2
    adb logcat -d > "$OUT/logcat-release.txt" || true
    if grep -q 'Schema up to date' "$OUT/logcat-release.txt" && ! grep -q 'Schema: v0' "$OUT/logcat-release.txt"; then
      echo "PASS the release update opened the existing database"
      update_checks=0
    else
      echo "FAIL the release update did not reuse the existing database"
      grep -E 'AlBaikNode.*\[DB\]' "$OUT/logcat-release.txt" | head -20
    fi
    curl -fsS -m 5 http://127.0.0.1:3001/api/health > /dev/null || { echo "FAIL the release build did not start the POS server"; update_checks=1; }
    # Back to the debug build (same key) for the Screen checks, which use debug-only launch options.
    adb install -r "$APK" || update_checks=1
  else
    echo "FAIL the release APK did not install over the debug APK (different signing key?)"
  fi
fi

crash_checks=1
if [ "$checks" = 0 ]; then
  echo "--- A crash leaves a report in Documents/AlBaikPOS/logs ---"
  wait_health() { for i in $(seq 1 120); do curl -fsS -m 2 http://127.0.0.1:3001/api/health > /dev/null 2>&1 && return 0; sleep 1; done; return 1; }
  logs=/sdcard/Documents/AlBaikPOS/logs
  adb shell rm -rf "$logs"
  adb shell am start -W -n "$PKG/.LauncherActivity" > /dev/null
  wait_health
  # By pid: the package name also matches the WebView renderer, which the app survives.
  adb shell am crash "$(adb shell pidof "$PKG" | tr -d '\r')"
  sleep 3
  adb shell am start -W -n "$PKG/.LauncherActivity" > /dev/null
  wait_health
  sleep 3
  adb shell ls "$logs" | tee "$OUT/crash-logs.txt"
  adb shell 'cat '"$logs"'/exit-*.txt' > "$OUT/exit-report.txt" 2>/dev/null || true
  head -n 8 "$OUT/exit-report.txt"
  if grep -q '^crash-' "$OUT/crash-logs.txt" && grep -q '^exit-' "$OUT/crash-logs.txt" && grep -q 'End of the POS server log' "$OUT/exit-report.txt" \
    && grep -q 'bluetooth: connecting to 00:11:22:AA:BB:CC' "$OUT/exit-report.txt" && grep -q 'printViaUSB called' "$OUT/exit-report.txt"; then
    echo "PASS a crash is saved, and the next start records how the app ended with the printing steps and server log"
    crash_checks=0
  else
    echo "FAIL no crash report was saved"
  fi
  curl -fsS -m 5 http://127.0.0.1:3001/api/health > /dev/null || { echo "FAIL the POS server did not come back after the crash"; crash_checks=1; }
  adb shell am force-stop "$PKG"
fi

screen_checks=1
if [ "$checks" = 0 ]; then
  echo "--- Screen mode against a stand-in main device on the CI host (10.0.2.2) ---"
  node "$SCRIPTS/fake-main-server.cjs" 3902 > "$OUT/fake-main.log" 2>&1 &
  fake=$!
  sleep 1
  adb shell am start -W -n "$PKG/.LauncherActivity" --es albaik.debug.screen "KITCHEN,10.0.2.2,3902"
  sleep 8
  pid="$(adb shell pidof "$PKG" | tr -d '\r')"
  adb forward tcp:9223 "localabstract:webview_devtools_remote_${pid}"
  node "$SCRIPTS/cdp-screen-check.cjs" 9223 http://10.0.2.2:3902 | tee "$OUT/screen-checks.txt"
  screen_checks=${PIPESTATUS[0]}
  adb exec-out screencap -p > "$OUT/screen-mode.png" || true

  echo "--- The Screen reconnects when the main device comes back ---"
  kill "$fake"
  sleep 50
  adb exec-out screencap -p > "$OUT/screen-reconnecting.png" || true
  before="$(grep -c 'GET /kds-standalone/ page' "$OUT/fake-main.log")"
  node "$SCRIPTS/fake-main-server.cjs" 3902 >> "$OUT/fake-main.log" 2>&1 &
  fake=$!
  sleep 15
  after="$(grep -c 'GET /kds-standalone/ page' "$OUT/fake-main.log")"
  kill "$fake"
  echo "page requests before=$before after=$after"
  if [ "$after" -le "$before" ]; then echo "FAIL the Screen did not reload the page after the main device returned"; screen_checks=1; fi
fi

adb exec-out screencap -p > "$OUT/screen.png" || true
adb logcat -d > "$OUT/logcat-full.txt" || true
grep -E 'AlBaik|AndroidRuntime|FATAL|Fatal signal|DEBUG +:|ActivityManager.*com\.albaik\.pos|libc +:.*com\.albaik' "$OUT/logcat-full.txt" | grep -v s_glBindAttribLocation > "$OUT/logcat-app.txt" || true
tail -n 120 "$OUT/logcat-app.txt"
for log in "$OUT/logcat-before-update.txt" "$OUT/logcat-full.txt"; do
  [ -f "$log" ] && grep -q 'Fatal signal' "$log" || continue
  echo "--- Native crash in the app process ($(basename "$log")) ---"
  grep -E 'Fatal signal|F DEBUG|F libc' "$log" | head -n 120
done

for port in 3001 3002 3003; do
  hex="$(printf '%04X' $port)"
  grep -q "00000000:$hex" "$OUT/summary.txt" || { echo "port $port is not listening on all interfaces"; exit 1; }
done
[ "$ok" = 1 ] && [ "$checks" = 0 ] && [ "$update_checks" = 0 ] && [ "$crash_checks" = 0 ] && [ "$screen_checks" = 0 ]
