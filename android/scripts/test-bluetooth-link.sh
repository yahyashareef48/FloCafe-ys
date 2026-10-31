#!/usr/bin/env bash
# Runs the Bluetooth printer connection checks on a plain JVM (no device or Android SDK needed).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
javac -Xlint:all -Werror -d "$out" \
  "$here/app/src/main/java/com/albaik/pos/BluetoothLink.java" \
  "$here/tests/BluetoothLinkCheck.java"
java -ea -cp "$out" com.albaik.pos.BluetoothLinkCheck
