#!/bin/bash
# Assembles dist/Anvil.app around the SwiftPM-built executable.
#
# There is no .xcodeproj on purpose: a hand-authored pbxproj is fragile and this
# app needs nothing Xcode provides beyond a bundle layout and an Info.plist.
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD_DIR=".build/release"
APP="dist/Anvil.app"

if [ ! -x "$BUILD_DIR/AnvilApp" ]; then
    echo "error: $BUILD_DIR/AnvilApp not found. Run 'make build' first." >&2
    exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cp "$BUILD_DIR/AnvilApp" "$APP/Contents/MacOS/Anvil"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>Anvil</string>
    <key>CFBundleDisplayName</key>
    <string>Anvil</string>
    <key>CFBundleIdentifier</key>
    <string>com.cjverma.Anvil</string>
    <key>CFBundleExecutable</key>
    <string>Anvil</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSMinimumSystemVersion</key>
    <string>13.0</string>
    <!-- Menu bar only: no dock icon, no app switcher entry. -->
    <key>LSUIElement</key>
    <true/>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

# Ad-hoc signature. Enough for a locally built app on your own Mac; a Developer ID
# is only needed to run this on someone else's machine.
codesign --force --sign - "$APP" 2>/dev/null || \
    echo "note: ad-hoc codesign failed, the app will still run locally"

echo "built $APP"
