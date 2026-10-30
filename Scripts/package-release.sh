#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

APP="$PWD/build/products.noindex/Claude Codex.app"
[ -d "$APP" ] || { echo 'Run ./build.sh first.' >&2; exit 1; }
./Scripts/verify-release.sh --app "$APP"
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")
STAGING=$(mktemp -d "$PWD/build/.release.XXXXXX")
trap 'rm -rf "$STAGING"' EXIT
DISK="$STAGING/disk"
OUTPUT="$STAGING/output"
mkdir -p "$DISK" "$OUTPUT"
/usr/bin/ditto -c -k --norsrc --keepParent "$APP" "$OUTPUT/ClaudeCodex-macOS.zip"
/usr/bin/ditto "$APP" "$DISK/Claude Codex.app"
ln -s /Applications "$DISK/Applications"
cp "$APP/Contents/Resources/Accounts.icns" "$DISK/.VolumeIcon.icns"
xcrun SetFile -a C "$DISK"
hdiutil create -quiet -volname "Claude Codex $VERSION" -srcfolder "$DISK" -fs HFS+ -format UDZO \
    "$OUTPUT/ClaudeCodex-macOS.dmg"
if [ "${SIGNING_IDENTITY:--}" != '-' ]; then
    codesign --force --sign "$SIGNING_IDENTITY" --timestamp "$OUTPUT/ClaudeCodex-macOS.dmg"
fi
./Scripts/verify-release.sh --metadata "$APP" "$OUTPUT/ClaudeCodex-macOS.dmg" "$OUTPUT/ClaudeCodex-macOS.zip" \
    > "$OUTPUT/release-metadata.json"
(
    cd "$OUTPUT"
    shasum -a 256 ClaudeCodex-macOS.dmg ClaudeCodex-macOS.zip release-metadata.json > SHA256SUMS.txt
)
./Scripts/verify-release.sh "$OUTPUT"
mkdir -p dist
for artifact in ClaudeCodex-macOS.dmg ClaudeCodex-macOS.zip release-metadata.json SHA256SUMS.txt; do
    mv "$OUTPUT/$artifact" "dist/$artifact"
done
if [ -e dist/appcast.xml ]; then
    rm dist/appcast.xml
fi
echo "Verified downloads: $PWD/dist"
echo 'These local packages have no signed update feed. Run ./Scripts/sign-release.sh before publishing.'
echo 'These scripts do not submit builds for Apple notarization. See release-metadata.json for actual signing and ticket status.'
