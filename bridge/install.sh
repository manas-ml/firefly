#!/usr/bin/env bash
# Install the Firefly Mac bridge as a launchd agent for the current user.
# It starts with an EMPTY allowlist: every call is rejected until you edit
#   ~/Library/Application Support/Firefly/config.json
# and add exact names of shortcuts that live in the Shortcuts folder "Agent".
set -euo pipefail

[[ "$(uname)" == "Darwin" ]] || { echo "The bridge only runs on macOS."; exit 1; }
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$HOME/Library/Application Support/Firefly"
PLIST="$HOME/Library/LaunchAgents/com.firefly.bridge.plist"
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "Node.js 22.18+ is required (brew install node)."; exit 1; }

mkdir -p "$DIR" && chmod 700 "$DIR"
if [[ ! -s "$DIR/bridge.token" ]]; then
  (umask 077 && openssl rand -hex 32 > "$DIR/bridge.token")
fi
[[ -f "$DIR/config.json" ]] || echo '{ "allowlist": [] }' > "$DIR/config.json"

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#__NODE__#$NODE#" -e "s#__REPO__#$REPO#" -e "s#__DIR__#$DIR#" "$REPO/bridge/com.firefly.bridge.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/com.firefly.bridge" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

# Make the token available to the agent container as a Docker secret.
mkdir -p "$REPO/secrets" && cp "$DIR/bridge.token" "$REPO/secrets/mac_bridge_token" && chmod 644 "$REPO/secrets/mac_bridge_token"

cat <<MSG
Bridge installed and listening on 127.0.0.1:7072 (empty allowlist: everything is rejected).

To enable it:
  1. In the Shortcuts app, create a folder named "Agent" and put shortcuts there.
  2. Add their exact names to $DIR/config.json, e.g. { "allowlist": ["Turn on desk lamp"] }
  3. In .env set MAC_BRIDGE_URL=http://host.docker.internal:7072 and run: make restart
Every call from the agent still asks you on Telegram first.
MSG
