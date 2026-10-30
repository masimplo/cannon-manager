#!/bin/bash
# Stops G5040 Manager and removes its login item. Optionally also removes the capture printer
# and makes the direct queue the default again: pass --remove-printer.
set -uo pipefail
LABEL=com.masimplo.g5040-manager
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "Stopped $LABEL"
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" && echo "Removed login item"
if [ "${1:-}" = "--remove-printer" ]; then
  lpoptions -d Canon_G5000_series >/dev/null && echo "Default printer: Canon_G5000_series"
  lpadmin -x Canon_G5040_Manager && echo "Removed printer Canon_G5040_Manager"
fi
