#!/bin/bash
# Installs the Anvil daemons. Run as root, after 'make build'.
#
# Building is deliberately left to 'make build' as your normal user: running
# swift build under sudo leaves a root-owned .build directory that then breaks
# every subsequent non-root build.
set -euo pipefail

cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
    echo "error: run with sudo — installing a LaunchDaemon needs root." >&2
    echo "  make build && sudo ./install.sh" >&2
    exit 1
fi

BUILD_DIR=".build/release"
SUPPORT="/Library/Application Support/Anvil"
BIN="$SUPPORT/bin"

for binary in anvild anvil-watchdog; do
    if [ ! -x "$BUILD_DIR/$binary" ]; then
        echo "error: $BUILD_DIR/$binary not found. Run 'make build' first (as your normal user)." >&2
        exit 1
    fi
done

echo "==> Checking for an active session"
if [ -f "$SUPPORT/state.json" ]; then
    echo "warning: a session may be active. Reinstalling mid-session is fine —"
    echo "         the deadline lives in state.json and is picked back up."
fi

echo "==> Installing binaries to $BIN"
mkdir -p "$BIN"
install -m 755 -o root -g wheel "$BUILD_DIR/anvild" "$BIN/anvild"
install -m 755 -o root -g wheel "$BUILD_DIR/anvil-watchdog" "$BIN/anvil-watchdog"
chown root:wheel "$SUPPORT" "$BIN"
# 0755, not 0700: nothing here is user-writable, but public-state.json has to stay
# readable so the menu bar app can draw a countdown without elevation.
chmod 755 "$SUPPORT" "$BIN"

echo "==> Writing launchd jobs"
write_plist() {
    local label="$1" program="$2" log="$3" path="/Library/LaunchDaemons/$1.plist"
    cat > "$path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$label</string>
    <key>ProgramArguments</key>
    <array>
        <string>$program</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardErrorPath</key>
    <string>$log</string>
    <key>StandardOutPath</key>
    <string>$log</string>
</dict>
</plist>
PLIST
    chown root:wheel "$path"
    chmod 644 "$path"
}

write_plist "com.cjverma.anvild" "$BIN/anvild" "/var/log/anvild.log"
write_plist "com.cjverma.anvil-watchdog" "$BIN/anvil-watchdog" "/var/log/anvil-watchdog.log"

echo "==> Loading"
# Booting out first makes this safe to re-run over an existing install.
launchctl bootout system/com.cjverma.anvild 2>/dev/null || true
launchctl bootout system/com.cjverma.anvil-watchdog 2>/dev/null || true
sleep 1
launchctl bootstrap system /Library/LaunchDaemons/com.cjverma.anvild.plist
launchctl bootstrap system /Library/LaunchDaemons/com.cjverma.anvil-watchdog.plist

sleep 1
echo
if launchctl print system/com.cjverma.anvild >/dev/null 2>&1; then
    echo "anvild is running."
else
    echo "warning: anvild did not start. Check /var/log/anvild.log" >&2
fi
if launchctl print system/com.cjverma.anvil-watchdog >/dev/null 2>&1; then
    echo "anvil-watchdog is running."
else
    echo "warning: anvil-watchdog did not start. Check /var/log/anvil-watchdog.log" >&2
fi

echo
echo "Installed. Copy dist/Anvil.app to /Applications and launch it."
echo "Recovery, if you ever need it: reboot holding Shift (Safe Mode) — macOS does"
echo "not load third-party LaunchDaemons there — then run ./uninstall.sh --force."
