#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
task_arch="${1:-$(uname -m)}"
case "$task_arch" in arm64|x86_64) ;; *) echo 'Supported architectures: arm64, x86_64'; exit 1;; esac
mkdir -p build
python3 Scripts/fetch-dependencies.py "$task_arch"
npm --prefix Bridge ci --ignore-scripts --no-audit --no-fund
task_app="$PWD/build/Contas Codex.app"
mkdir -p "$task_app/Contents/MacOS" "$task_app/Contents/Resources/bin" "$task_app/Contents/Resources/Bridge" "$task_app/Contents/Resources/Licenses"
task_sdk=$(xcrun --sdk macosx --show-sdk-path)
xcrun --sdk macosx swiftc -O -sdk "$task_sdk" -target "$task_arch-apple-macos26.0" \
  -framework AppKit -framework SwiftUI -framework Combine -framework ServiceManagement \
  Sources/*.swift -o "$task_app/Contents/MacOS/ContasCodex"
xcrun --sdk macosx swiftc -O -sdk "$task_sdk" -target "$task_arch-apple-macos26.0" \
  -framework AppKit Launcher/main.swift -o "$task_app/Contents/Resources/bin/ClaudeLauncher"
xcrun swift Scripts/make-icon.swift "$PWD/build/Accounts.iconset"
iconutil -c icns build/Accounts.iconset -o Resources/Accounts.icns
cp Info.plist "$task_app/Contents/Info.plist"
cp Resources/Accounts.icns "$task_app/Contents/Resources/"
cp "build/dependencies/$task_arch/node" "build/dependencies/$task_arch/cli-proxy-api" "$task_app/Contents/Resources/bin/"
cp "build/dependencies/$task_arch/NODE-LICENSE" "build/dependencies/$task_arch/CLIPROXYAPI-LICENSE" "$task_app/Contents/Resources/Licenses/"
cp "build/dependencies/$task_arch/provenance.json" "$task_app/Contents/Resources/"
for task_file in model-catalog.mjs model-adapter.mjs pool-controller.mjs pool-router.mjs pool-service.mjs runtime.mjs setup.mjs accounts.html package.json; do
  cp "Bridge/$task_file" "$task_app/Contents/Resources/Bridge/"
done
mkdir -p "$task_app/Contents/Resources/Bridge/node_modules"
cp -R Bridge/node_modules/bcryptjs "$task_app/Contents/Resources/Bridge/node_modules/"
cp LICENSE THIRD_PARTY_NOTICES.md "$task_app/Contents/Resources/Licenses/"
for task_binary in node cli-proxy-api ClaudeLauncher; do codesign --force --sign - --timestamp=none "$task_app/Contents/Resources/bin/$task_binary"; done
codesign --force --sign - --timestamp=none "$task_app"
codesign --verify --deep --strict "$task_app"
echo "Built: $task_app"
