#!/usr/bin/env bash
# Rebuilds every Deadline desktop package (from the web app in app/) into dist/.
#   bash desktop/build.sh                       # Windows, macOS (arm64 + x64), Linux, then tests
#   bash desktop/build.sh --platforms=linux     # just one platform
#   bash desktop/build.sh --skip-test           # skip the tests
#   bash desktop/build.sh --config=test.js      # ship this config.js instead of app/config.js
#   DEADLINE_DIST_DIR=/some/dir bash desktop/build.sh   # write the zips somewhere else
# Heavy work (node_modules, Electron downloads, unpacked apps) happens in $DEADLINE_BUILD_DIR.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH_DEFAULT="/tmp/claude-0/-home-claude/bb04c244-41f8-5f69-9881-20ded28db9e3/scratchpad/desktop-build"
if [ -z "${DEADLINE_BUILD_DIR:-}" ]; then
  if [ -d "$(dirname "$SCRATCH_DEFAULT")" ]; then DEADLINE_BUILD_DIR="$SCRATCH_DEFAULT"; else DEADLINE_BUILD_DIR="${TMPDIR:-/tmp}/deadline-desktop-build"; fi
fi
export DEADLINE_BUILD_DIR
mkdir -p "$DEADLINE_BUILD_DIR/tooling" "$DEADLINE_BUILD_DIR/cache/electron" "$DEADLINE_BUILD_DIR/tools"
echo "[build.sh] build dir: $DEADLINE_BUILD_DIR"

SKIP_TEST=0
for a in "$@"; do [ "$a" = "--skip-test" ] && SKIP_TEST=1; done

# Node 22.12+ (required by @electron/packager).
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if (a<22||(a===22&&b<12)) { console.error("Node 22.12 or newer is required (found "+process.versions.node+")"); process.exit(1); }'
command -v zip >/dev/null || { echo "The zip command is required." >&2; exit 1; }

# Build tooling (Electron, packager, fuses, icon renderer), reinstalled only when package.json changes.
TOOLING="$DEADLINE_BUILD_DIR/tooling"
if ! cmp -s "$HERE/package.json" "$TOOLING/package.json" || [ ! -d "$TOOLING/node_modules/@electron/packager" ]; then
  echo "[build.sh] installing build tooling"
  cp "$HERE/package.json" "$TOOLING/package.json"
  (cd "$TOOLING" && electron_config_cache="$DEADLINE_BUILD_DIR/cache/electron" npm install --no-audit --no-fund --loglevel=error)
fi

# rcodesign (Apple code signing that runs on Linux) for ad-hoc signing the macOS apps.
RCODESIGN_VERSION="0.29.0"
RCODESIGN_SHA256="dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002"
if [ -z "${RCODESIGN:-}" ]; then
  if command -v rcodesign >/dev/null; then
    RCODESIGN="$(command -v rcodesign)"
  elif [ -x "$DEADLINE_BUILD_DIR/tools/rcodesign" ]; then
    RCODESIGN="$DEADLINE_BUILD_DIR/tools/rcodesign"
  elif [ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ]; then
    echo "[build.sh] downloading rcodesign $RCODESIGN_VERSION"
    TGZ="$DEADLINE_BUILD_DIR/tools/apple-codesign.tar.gz"
    if curl -sSfL -o "$TGZ" "https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign%2F${RCODESIGN_VERSION}/apple-codesign-${RCODESIGN_VERSION}-x86_64-unknown-linux-musl.tar.gz" \
      && echo "$RCODESIGN_SHA256  $TGZ" | sha256sum -c --quiet -; then
      tar xzf "$TGZ" -C "$DEADLINE_BUILD_DIR/tools" --strip-components=1 "apple-codesign-${RCODESIGN_VERSION}-x86_64-unknown-linux-musl/rcodesign"
      chmod +x "$DEADLINE_BUILD_DIR/tools/rcodesign"
      RCODESIGN="$DEADLINE_BUILD_DIR/tools/rcodesign"
    else
      echo "[build.sh] could not get rcodesign; macOS apps will be unsigned" >&2
    fi
    rm -f "$TGZ"
  fi
fi
export RCODESIGN="${RCODESIGN:-}"

node "$HERE/scripts/build.mjs" "$@"

if [ "$SKIP_TEST" = 0 ]; then
  echo "[build.sh] Canvas bridge and CSP / config.js tests"
  node --test "$HERE/test/canvas-api.test.js" "$HERE/test/web-page.test.js"
  echo "[build.sh] package checks and Linux smoke test"
  node "$HERE/test/verify-packages.mjs"
fi
