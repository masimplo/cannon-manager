#!/bin/bash
# Started by the LaunchAgent at login. Finds Node 22+ (mise first, then Homebrew) so a Node
# upgrade doesn't break the login item, then runs the app from the repo folder.
cd "$(dirname "$0")/.." || exit 1
NODE="$("$HOME/.local/bin/mise" which node 2>/dev/null)"
[ -x "$NODE" ] || NODE=/opt/homebrew/bin/node
[ -x "$NODE" ] || NODE=/usr/local/bin/node
exec "$NODE" src/server.js
