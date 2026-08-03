#!/bin/bash
# Removes the Anvil daemons and undoes everything they touched.
#
# Refuses to run while a session is active. That refusal is friction, not
# security: you are root, you can pass --force. It exists so that removing Anvil
# is never something you do without noticing.
set -uo pipefail

cd "$(dirname "$0")"

if [ "$(id -u)" -ne 0 ]; then
    echo "error: run with sudo." >&2
    exit 1
fi

SUPPORT="/Library/Application Support/Anvil"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

if [ -f "$SUPPORT/state.json" ] && [ "$FORCE" -eq 0 ]; then
    ENDS=$(python3 -c "import json;print(json.load(open('$SUPPORT/state.json'))['endsAt'])" 2>/dev/null || echo "unknown")
    NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if [[ "$ENDS" > "$NOW" ]]; then
        echo "A session is active until $ENDS."
        echo
        echo "That is the whole point of this tool. If you are certain:"
        echo "    sudo ./uninstall.sh --force"
        exit 1
    fi
fi

echo "==> Stopping daemons"
launchctl bootout system/com.cjverma.anvil-watchdog 2>/dev/null || true
launchctl bootout system/com.cjverma.anvild 2>/dev/null || true
sleep 1
# The pair resurrects each other, so kill any survivor before removing the plists.
killall -9 anvild anvil-watchdog 2>/dev/null || true

echo "==> Removing launchd jobs"
rm -f /Library/LaunchDaemons/com.cjverma.anvild.plist
rm -f /Library/LaunchDaemons/com.cjverma.anvil-watchdog.plist

echo "==> Cleaning /etc/hosts"
if grep -q "^# >>> anvil" /etc/hosts 2>/dev/null; then
    python3 - <<'PY'
import re
path = "/etc/hosts"
with open(path) as fh:
    lines = fh.readlines()
out, inside = [], False
for line in lines:
    stripped = line.strip()
    if stripped == "# >>> anvil":
        inside = True
        continue
    if stripped == "# <<< anvil":
        inside = False
        continue
    if not inside:
        out.append(line)
with open(path, "w") as fh:
    fh.writelines(out)
PY
    dscacheutil -flushcache
    killall -HUP mDNSResponder 2>/dev/null || true
fi

echo "==> Restoring pf"
pfctl -a anvil -F rules 2>/dev/null || true
pfctl -a anvil -t anvil_blocked -T flush 2>/dev/null || true
if [ -f "$SUPPORT/pf.conf.orig" ]; then
    cp "$SUPPORT/pf.conf.orig" /etc/pf.conf
    pfctl -f /etc/pf.conf 2>/dev/null || true
fi
rm -f /etc/pf.anchors/anvil

echo "==> Restoring browser policies"
for plist in /Library/Managed\ Preferences/com.google.Chrome.plist \
             /Library/Managed\ Preferences/com.brave.Browser.plist \
             /Library/Managed\ Preferences/com.microsoft.Edge.plist \
             /Library/Managed\ Preferences/com.vivaldi.Vivaldi.plist; do
    encoded=$(echo "$plist" | tr '/' '_')
    if [ -f "$SUPPORT/policy-backups/$encoded" ]; then
        cp "$SUPPORT/policy-backups/$encoded" "$plist"
    elif [ -f "$SUPPORT/policy-backups/$encoded.absent" ]; then
        rm -f "$plist"
    fi
done
FIREFOX="/Applications/Firefox.app/Contents/Resources/distribution/policies.json"
encoded=$(echo "$FIREFOX" | tr '/' '_')
if [ -f "$SUPPORT/policy-backups/$encoded" ]; then
    cp "$SUPPORT/policy-backups/$encoded" "$FIREFOX"
elif [ -f "$SUPPORT/policy-backups/$encoded.absent" ]; then
    rm -f "$FIREFOX"
fi

echo "==> Removing state"
rm -rf "$SUPPORT"
rm -f /var/run/anvil.sock

echo
echo "Anvil removed. Your presets in ~/Library/Application Support/Anvil were kept."
