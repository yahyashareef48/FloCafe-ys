#!/usr/bin/env bash
# Packs the compiled backend, the static frontend, and production node_modules
# into app/src/main/assets for the Android shell, and fetches the pinned
# nodejs-mobile runtime and better-sqlite3 Android binaries.
# Prerequisites: `npm run build` and `npm run build:frontend`.
set -euo pipefail

NODE_MOBILE_VERSION="24.20.0-0"
BETTER_SQLITE3_VERSION="13.0.3"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ANDROID="$ROOT/android"
WORK="$ANDROID/build/node-stage"
STAGE="$WORK/nodejs-project"
LIBNODE="$ANDROID/app/libnode"
ASSETS="$ANDROID/app/src/main/assets"

test -f "$ROOT/dist/main/android/entry.js" || { echo "Run npm run build first" >&2; exit 1; }
test -f "$ROOT/frontend/out/index.html" || { echo "Run npm run build:frontend first" >&2; exit 1; }

installed_b3="$(node -p "require('$ROOT/node_modules/better-sqlite3/package.json').version")"
if [ "$installed_b3" != "$BETTER_SQLITE3_VERSION" ]; then
  echo "better-sqlite3 is $installed_b3 but the Android prebuild is pinned to $BETTER_SQLITE3_VERSION" >&2
  exit 1
fi

rm -rf "$STAGE" "$ASSETS/nodejs-project.zip" "$ASSETS/node-native"
mkdir -p "$STAGE/frontend" "$ASSETS"
cp -R "$ROOT/dist" "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGE/"
cp -R "$ROOT/frontend/out" "$STAGE/frontend/out"
find "$STAGE/dist" \( -name '*.map' -o -name '*.d.ts' \) -delete

(cd "$STAGE" && npm ci --omit=dev --ignore-scripts --engine-strict=false --no-audit --no-fund)

NM="$STAGE/node_modules"
# Desktop-only native payloads; sharp is an optional, lazily imported Baileys dependency.
rm -rf "$NM/sharp" "$NM/@img" "$NM/better-sqlite3/prebuilds" "$NM/better-sqlite3/deps" "$NM/better-sqlite3/src"
# Files Node never loads at runtime. Licence files are kept.
find "$NM" -type f \( -name '*.md' -o -name '*.markdown' -o -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.ts.map' \) -delete
find "$NM" -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example -o -name examples -o -name .github \) -prune -exec rm -rf {} +

for pair in arm64-v8a:android-arm64 x86_64:android-x64; do
  abi="${pair%%:*}"
  target="${pair##*:}"
  mkdir -p "$ASSETS/node-native/$abi"
  curl -fsSL "https://github.com/digidem/better-sqlite3-nodejs-mobile/releases/download/${BETTER_SQLITE3_VERSION}/better-sqlite3-${BETTER_SQLITE3_VERSION}-${target}.tar.gz" \
    | tar -xz -C "$ASSETS/node-native/$abi" ./better_sqlite3.node
done

if [ ! -f "$LIBNODE/.version" ] || [ "$(cat "$LIBNODE/.version")" != "$NODE_MOBILE_VERSION" ]; then
  rm -rf "$LIBNODE" && mkdir -p "$LIBNODE" "$WORK"
  curl -fsSL -o "$WORK/libnode.zip" \
    "https://github.com/digidem/nodejs-mobile/releases/download/v${NODE_MOBILE_VERSION}/nodejs-mobile-android-${NODE_MOBILE_VERSION}.zip"
  unzip -q "$WORK/libnode.zip" -d "$LIBNODE"
  rm -rf "$LIBNODE/bin/armeabi-v7a"
  echo "$NODE_MOBILE_VERSION" > "$LIBNODE/.version"
fi

(cd "$STAGE" && zip -qr -X "$ASSETS/nodejs-project.zip" .)
echo "Staged $(find "$STAGE" -type f | wc -l) files, $(du -sh "$ASSETS/nodejs-project.zip" | cut -f1) zipped"
