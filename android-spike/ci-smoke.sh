#!/usr/bin/env bash
# Throwaway Phase 0 spike: install the x86_64 APK on the emulator and probe the three servers.
set -uo pipefail
APK="$1"
OUT="${2:-spike-results}"
mkdir -p "$OUT"
adb logcat -c || true
adb install -r "$APK"
adb shell am start -n com.albaik.pos.spike/.MainActivity
adb forward tcp:3001 tcp:3001
adb forward tcp:3002 tcp:3002
adb forward tcp:3003 tcp:3003

ok=0
for i in $(seq 1 240); do
  if curl -fsS -m 2 http://127.0.0.1:3001/api/health > "$OUT/health.json" 2>/dev/null; then ok=1; echo "health OK after ${i}s"; break; fi
  sleep 1
done

{
  echo "health_ok=$ok"
  for p in 3001 3002 3003; do
    echo "port_${p}_root=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:$p/)"
  done
  echo "kds_standalone=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3002/kds-standalone/)"
  echo "server_standalone=$(curl -s -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1:3003/server-standalone/)"
  echo "--- listening sockets (0.0.0.0 = 00000000) ---"
  adb shell cat /proc/net/tcp /proc/net/tcp6 | grep -E ':0BB9|:0BBA|:0BBB' | grep ' 0A ' || true
} | tee "$OUT/summary.txt"

sleep 5
adb logcat -d > "$OUT/logcat-full.txt" || true
grep -E 'AlBaikNode|AndroidRuntime|DEBUG' "$OUT/logcat-full.txt" > "$OUT/logcat-node.txt" || true
tail -n 150 "$OUT/logcat-node.txt"
[ "$ok" = 1 ]
