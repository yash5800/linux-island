#!/usr/bin/env bash
# Install Island into the current user's GNOME Shell.
set -euo pipefail

UUID=island@nexa.local
SRC=$(cd "$(dirname "$0")" && pwd)
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
for f in extension.js impl.js stylesheet.css metadata.json LICENSE; do
    [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DEST/$f"
done

echo "Installed to $DEST"
if command -v gnome-extensions >/dev/null; then
    gnome-extensions enable "$UUID" 2>/dev/null || true
    echo "Extension enabled. Log out and back in once if the top bar looks unchanged."
fi
