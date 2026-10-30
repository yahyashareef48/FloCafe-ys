#!/usr/bin/env bash
# Throwaway Phase 0 spike: stage the built backend + frontend as an Android asset.
# Usage: android-spike/stage-node-project.sh <arm64-v8a|x86_64>
set -euo pipefail

ABI="${1:?abi}"
NODE_MOBILE_VERSION="24.20.0-0"
BETTER_SQLITE3_VERSION="13.0.3"
case "$ABI" in
  arm64-v8a) B3_TARGET=android-arm64 ;;
  x86_64) B3_TARGET=android-x64 ;;
  *) echo "unsupported abi $ABI" >&2; exit 1 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SPIKE="$ROOT/android-spike"
WORK="$SPIKE/build"
STAGE="$WORK/nodejs-project"
LIBNODE="$SPIKE/app/libnode"
ASSETS="$SPIKE/app/src/main/assets"

test -f "$ROOT/dist/main/server.js" || { echo "run npm run build first" >&2; exit 1; }
test -f "$ROOT/frontend/out/index.html" || { echo "run npm run build:frontend first" >&2; exit 1; }

rm -rf "$STAGE" "$ASSETS"
mkdir -p "$STAGE/frontend" "$WORK" "$ASSETS"
cp -R "$ROOT/dist" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/dev-server.js" "$STAGE/"
cp -R "$ROOT/frontend/out" "$STAGE/frontend/out"
find "$STAGE/dist" -name '*.map' -delete

(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --engine-strict=false --no-audit --no-fund)

# Desktop-only native payloads; sharp is an optional, lazily imported Baileys dependency.
rm -rf "$STAGE/node_modules/sharp" "$STAGE/node_modules/@img" \
  "$STAGE/node_modules/better-sqlite3/prebuilds" "$STAGE/node_modules/better-sqlite3/deps" \
  "$STAGE/node_modules/better-sqlite3/src"
B3_DIR="$STAGE/node_modules/better-sqlite3/build/Release"
mkdir -p "$B3_DIR"
curl -fsSL "https://github.com/digidem/better-sqlite3-nodejs-mobile/releases/download/${BETTER_SQLITE3_VERSION}/better-sqlite3-${BETTER_SQLITE3_VERSION}-${B3_TARGET}.tar.gz" \
  | tar -xz -C "$B3_DIR"
test -f "$B3_DIR/better_sqlite3.node"

if [ ! -f "$LIBNODE/bin/$ABI/libnode.so" ]; then
  rm -rf "$LIBNODE" && mkdir -p "$LIBNODE"
  curl -fsSL -o "$WORK/libnode.zip" \
    "https://github.com/digidem/nodejs-mobile/releases/download/v${NODE_MOBILE_VERSION}/nodejs-mobile-android-${NODE_MOBILE_VERSION}.zip"
  unzip -q "$WORK/libnode.zip" -d "$LIBNODE"
fi

(cd "$STAGE" && zip -qr -X "$ASSETS/nodejs-project.zip" .)
du -sh "$STAGE" "$ASSETS/nodejs-project.zip"
