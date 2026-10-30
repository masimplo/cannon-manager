#!/bin/bash
# Builds and installs ~/Applications/G5040 Manager.app (opens the UI; posts notifications).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO/build/G5040 Manager.app"
DEST="$HOME/Applications/G5040 Manager.app"
rm -rf "$OUT" && mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
xcrun swiftc -O "$REPO/macos/main.swift" -o "$OUT/Contents/MacOS/G5040Manager" -framework AppKit -framework UserNotifications
cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>com.masimplo.g5040-manager.app</string>
  <key>CFBundleName</key><string>G5040 Manager</string>
  <key>CFBundleDisplayName</key><string>G5040 Manager</string>
  <key>CFBundleExecutable</key><string>G5040Manager</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
# Icon: the printer's own picture if it can be fetched, otherwise no custom icon.
ICONSRC="$REPO/build/printer_icon.png"
HOST=$(sed -n 's/.*"host": *"\([^"]*\)".*/\1/p' "$REPO/data/config.json" 2>/dev/null || true)
if [ -n "$HOST" ] && curl -sf -m 5 -o "$ICONSRC" "http://$HOST/icon/printer_icon_large.png"; then
  SET="$REPO/build/AppIcon.iconset"; rm -rf "$SET"; mkdir -p "$SET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICONSRC" --out "$SET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) "$ICONSRC" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$SET" -o "$OUT/Contents/Resources/AppIcon.icns"
fi
codesign --force --sign - --identifier com.masimplo.g5040-manager.app "$OUT"
mkdir -p "$HOME/Applications"
rm -rf "$DEST" && cp -R "$OUT" "$DEST"
echo "Installed $DEST"
