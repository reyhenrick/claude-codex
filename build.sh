#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
[ "$#" -eq 0 ] || { echo 'Usage: ./build.sh (always builds arm64 + x86_64)' >&2; exit 1; }
mkdir -p build
python3 Scripts/check-localizations.py
SPARKLE_DISTRIBUTION=$(./Scripts/fetch-sparkle.sh)
cmp "$SPARKLE_DISTRIBUTION/LICENSE" Resources/Sparkle-LICENSE.txt
for architecture in arm64 x86_64; do
    python3 Scripts/fetch-dependencies.py "$architecture"
done
npm --prefix Bridge ci --ignore-scripts --no-audit --no-fund
STAGING=$(mktemp -d "$PWD/build/.stage.XXXXXX")
trap 'rm -rf "$STAGING"' EXIT
APP="$STAGING/Claude Codex.app"
SDK=$(xcrun --sdk macosx --show-sdk-path)
SIGNING_ARGS=(--force --sign "${SIGNING_IDENTITY:--}")
if [ "${SIGNING_IDENTITY:--}" = '-' ]; then
    SIGNING_ARGS+=(--options 0 --timestamp=none)
else
    echo 'Developer ID runtime entitlements for bundled Node are not configured; use ad-hoc signing.' >&2
    exit 1
fi
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bin" "$APP/Contents/Resources/Bridge/node_modules" "$APP/Contents/Resources/Licenses" "$APP/Contents/Frameworks"
for architecture in arm64 x86_64; do
    SWIFT_FLAGS=(-O -sdk "$SDK" -target "$architecture-apple-macos26.0")
    xcrun --sdk macosx swiftc "${SWIFT_FLAGS[@]}" \
        -framework AppKit -framework SwiftUI -framework Combine -framework ServiceManagement \
        -F "$SPARKLE_DISTRIBUTION" -framework Sparkle -Xlinker -rpath -Xlinker '@executable_path/../Frameworks' \
        Sources/*.swift -o "$STAGING/ClaudeCodex-$architecture"
    xcrun --sdk macosx swiftc "${SWIFT_FLAGS[@]}" -framework AppKit \
        Sources/Localization.swift Sources/BridgeAuthorization.swift Launcher/*.swift -o "$STAGING/ClaudeLauncher-$architecture"
    xcrun --sdk macosx clang -O2 -Wall -Wextra -Werror -isysroot "$SDK" -target "$architecture-apple-macos26.0" \
        Launcher/BridgeService.c -o "$STAGING/BridgeService-$architecture"
    xcrun --sdk macosx swiftc "${SWIFT_FLAGS[@]}" -parse-as-library -framework AppKit \
        Sources/UpdatePolicy.swift Recovery/main.swift -o "$STAGING/UpdateRecovery-$architecture"
done
xcrun lipo -create "$STAGING/ClaudeCodex-arm64" "$STAGING/ClaudeCodex-x86_64" -output "$APP/Contents/MacOS/ClaudeCodex"
xcrun lipo -create "$STAGING/ClaudeLauncher-arm64" "$STAGING/ClaudeLauncher-x86_64" -output "$APP/Contents/Resources/bin/ClaudeLauncher"
xcrun lipo -create "$STAGING/BridgeService-arm64" "$STAGING/BridgeService-x86_64" -output "$APP/Contents/Resources/bin/BridgeService"
xcrun lipo -create "$STAGING/UpdateRecovery-arm64" "$STAGING/UpdateRecovery-x86_64" -output "$APP/Contents/Resources/bin/UpdateRecovery"
for binary in node cli-proxy-api; do
    xcrun lipo -create "build/dependencies/arm64/$binary" "build/dependencies/x86_64/$binary" -output "$APP/Contents/Resources/bin/$binary"
done
xcrun swift Scripts/make-icon.swift "$STAGING/Accounts.iconset"
iconutil -c icns "$STAGING/Accounts.iconset" -o "$APP/Contents/Resources/Accounts.icns"
cp Info.plist "$APP/Contents/Info.plist"
for locale in en pt es fr de it; do
    /usr/bin/ditto "Resources/$locale.lproj" "$APP/Contents/Resources/$locale.lproj"
done
/usr/bin/ditto "$SPARKLE_DISTRIBUTION/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"
cp Resources/Sparkle-LICENSE.txt dependencies.json "$APP/Contents/Resources/"
for license in NODE-LICENSE CLIPROXYAPI-LICENSE; do
    cmp "build/dependencies/arm64/$license" "build/dependencies/x86_64/$license"
    cp "build/dependencies/arm64/$license" "$APP/Contents/Resources/Licenses/"
done
python3 - "$APP/Contents/Resources/provenance.json" <<'PYTHON'
from pathlib import Path
import json, sys
entries = [entry for arch in ('arm64', 'x86_64') for entry in json.loads(Path(f'build/dependencies/{arch}/provenance.json').read_text())]
Path(sys.argv[1]).write_text(json.dumps(entries, indent=2) + '\n')
PYTHON
for source in Bridge/*.mjs; do
    case "$source" in *.test.mjs) continue ;; esac
    cp "$source" "$APP/Contents/Resources/Bridge/"
done
cp Bridge/package.json Bridge/package-lock.json "$APP/Contents/Resources/Bridge/"
/usr/bin/ditto Bridge/node_modules/bcryptjs "$APP/Contents/Resources/Bridge/node_modules/bcryptjs"
cp LICENSE THIRD_PARTY_NOTICES.md "$APP/Contents/Resources/Licenses/"
SPARKLE_FRAMEWORK="$APP/Contents/Frameworks/Sparkle.framework"
codesign "${SIGNING_ARGS[@]}" "$SPARKLE_FRAMEWORK/Versions/B/XPCServices/Installer.xpc"
codesign "${SIGNING_ARGS[@]}" --preserve-metadata=entitlements "$SPARKLE_FRAMEWORK/Versions/B/XPCServices/Downloader.xpc"
codesign "${SIGNING_ARGS[@]}" "$SPARKLE_FRAMEWORK/Versions/B/Autoupdate"
codesign "${SIGNING_ARGS[@]}" "$SPARKLE_FRAMEWORK/Versions/B/Updater.app"
codesign "${SIGNING_ARGS[@]}" "$SPARKLE_FRAMEWORK"
for binary in node cli-proxy-api ClaudeLauncher BridgeService UpdateRecovery; do
    codesign "${SIGNING_ARGS[@]}" "$APP/Contents/Resources/bin/$binary"
done
codesign "${SIGNING_ARGS[@]}" "$APP"
./Scripts/verify-release.sh --app "$APP"
if [ -e 'build/Claude Codex.app' ]; then
    mkdir -p build/previous
    mv 'build/Claude Codex.app' "build/previous/ClaudeCodex-$(date -u +%Y%m%dT%H%M%SZ)-$$.app"
fi
mv "$APP" 'build/Claude Codex.app'
echo "Built and verified: $PWD/build/Claude Codex.app"
echo 'Create local downloads with ./Scripts/package-release.sh.'
