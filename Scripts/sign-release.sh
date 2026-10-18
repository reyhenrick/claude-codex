#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

[ "$#" -le 1 ] || { echo 'Usage: Scripts/sign-release.sh [dist-directory]' >&2; exit 1; }
[ "${CI:-}" != true ] && [ "${GITHUB_ACTIONS:-}" != true ] || { echo 'Sign releases locally with the private key in Keychain.' >&2; exit 1; }
RELEASE_DIRECTORY="${1:-$PWD/dist}"
SPARKLE_DISTRIBUTION=$(./Scripts/fetch-sparkle.sh)
GENERATOR="$SPARKLE_DISTRIBUTION/bin/generate_appcast"
[ ! -e "$RELEASE_DIRECTORY/appcast.xml" ] || { echo 'This directory already includes a signed feed. Package a new release before signing again.' >&2; exit 1; }
./Scripts/verify-release.sh "$RELEASE_DIRECTORY"

STAGING=$(mktemp -d "$PWD/build/.signed-release.XXXXXX")
trap 'rm -rf "$STAGING"' EXIT
ARCHIVES="$STAGING/archives"
OUTPUT="$STAGING/output"
mkdir -p "$ARCHIVES" "$OUTPUT" "$STAGING/unpacked"
for artifact in ClaudeCodex-macOS.dmg ClaudeCodex-macOS.zip release-metadata.json SHA256SUMS.txt; do
    cp "$RELEASE_DIRECTORY/$artifact" "$OUTPUT/$artifact"
done
./Scripts/verify-release.sh "$OUTPUT"
/usr/bin/ditto -x -k "$OUTPUT/ClaudeCodex-macOS.zip" "$STAGING/unpacked"
APP="$STAGING/unpacked/Claude Codex.app"
INFO="$APP/Contents/Info.plist"
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO")
BUILD_NUMBER=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$INFO")
PUBLIC_KEY=$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$INFO")
REQUIRE_SIGNED_FEED=$(/usr/libexec/PlistBuddy -c 'Print :SURequireSignedFeed' "$INFO")
[ "$REQUIRE_SIGNED_FEED" = true ] || { echo 'The application must require signed feeds.' >&2; exit 1; }
cp "$OUTPUT/ClaudeCodex-macOS.zip" "$ARCHIVES/ClaudeCodex-macOS.zip"
/usr/bin/python3 - "$VERSION" "$PWD/RELEASE_NOTES.md" "$ARCHIVES/ClaudeCodex-macOS.txt" <<'PY'
from pathlib import Path
import sys

version, source, output = sys.argv[1:]
notes = Path(source).read_text().strip()
if not notes.startswith(f"# Claude Codex {version}\n"):
    raise SystemExit("Release notes must describe the packaged version.")
Path(output).write_text(notes + '\n')
PY
"$GENERATOR" --account com.henrick.codex-accounts.sparkle \
    --download-url-prefix "https://github.com/reyhenrick/claude-codex/releases/download/v$VERSION/" \
    --link 'https://github.com/reyhenrick/claude-codex' --embed-release-notes \
    --maximum-deltas 0 --maximum-versions 1 --versions "$BUILD_NUMBER" \
    -o "$ARCHIVES/appcast.xml" "$ARCHIVES"
cmp -s "$OUTPUT/ClaudeCodex-macOS.zip" "$ARCHIVES/ClaudeCodex-macOS.zip" || { echo 'The archive changed during signing.' >&2; exit 1; }
cp "$ARCHIVES/appcast.xml" "$OUTPUT/appcast.xml"
xcrun swift Scripts/verify-update.swift "$OUTPUT/appcast.xml" "$OUTPUT/ClaudeCodex-macOS.zip" "$PUBLIC_KEY" "$BUILD_NUMBER" "$VERSION"
./Scripts/verify-release.sh --metadata "$APP" "$OUTPUT/ClaudeCodex-macOS.dmg" "$OUTPUT/ClaudeCodex-macOS.zip" "$OUTPUT/appcast.xml" \
    > "$OUTPUT/release-metadata.json"
(
    cd "$OUTPUT"
    shasum -a 256 ClaudeCodex-macOS.dmg ClaudeCodex-macOS.zip release-metadata.json appcast.xml > SHA256SUMS.txt
)
./Scripts/verify-release.sh --require-feed "$OUTPUT"
for artifact in appcast.xml release-metadata.json SHA256SUMS.txt; do
    mv "$OUTPUT/$artifact" "$RELEASE_DIRECTORY/$artifact"
done
./Scripts/verify-release.sh --require-feed "$RELEASE_DIRECTORY"
echo "Signed update artifacts: $RELEASE_DIRECTORY"
echo 'Update signatures verify the feed and ZIP. Apple signing and notarization remain recorded separately in release-metadata.json.'
