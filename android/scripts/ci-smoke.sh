#!/usr/bin/env bash
# CI smoke test: installs the x86_64 debug APK on a running emulator, waits for the
# on-device servers, and inspects the live POS WebView over Chrome DevTools.
set -uo pipefail
APK="$1"
OUT="${2:-android-smoke}"
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
  sleep 10
  pid="$(adb shell pidof "$PKG" | tr -d '\r')"
  adb forward tcp:9222 "localabstract:webview_devtools_remote_${pid}"
  node "$SCRIPTS/cdp-check.cjs" 9222 | tee "$OUT/webview-checks.txt"
  checks=${PIPESTATUS[0]}
fi

adb exec-out screencap -p > "$OUT/screen.png" || true
adb logcat -d > "$OUT/logcat-full.txt" || true
grep -E 'AlBaik|AndroidRuntime|FATAL' "$OUT/logcat-full.txt" > "$OUT/logcat-app.txt" || true
tail -n 120 "$OUT/logcat-app.txt"

for port in 3001 3002 3003; do
  hex="$(printf '%04X' $port)"
  grep -q "00000000:$hex" "$OUT/summary.txt" || { echo "port $port is not listening on all interfaces"; exit 1; }
done
[ "$ok" = 1 ] && [ "$checks" = 0 ]
