#!/usr/bin/env bash
# Build the zip that goes to extensions.gnome.org.
#
# The working folder in ~/.local/share/gnome-shell/extensions is a dev build:
# extension.js hot-reloads impl.js and stylesheet.css on save. That loader is
# a development harness, not something to ship — reviewers reject it, and it
# re-imports the whole module on every save. This script writes a plain
# extension.js that imports impl.js once, then zips the five files EGO wants
# at the root of the archive.
#
# usage: tools/build-release.sh   ->  dist/island@nexa.local.zip
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=island@nexa.local
DIST="$ROOT/dist"
STAGE="$DIST/$UUID"

rm -rf "$STAGE" "$DIST/$UUID.zip"
mkdir -p "$STAGE"

cp "$ROOT/impl.js" "$ROOT/stylesheet.css" "$ROOT/metadata.json" "$ROOT/LICENSE" "$STAGE/"

cat > "$STAGE/extension.js" <<'EOF'
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import Island from './impl.js';

// Release entry point: a plain static import. The development folder uses a
// cache-busting dynamic import plus file monitors to reload on save; none of
// that belongs in a shipped extension. GNOME Shell loads stylesheet.css from
// the extension directory itself, so there is nothing to do here for CSS.
export default class IslandExtension extends Extension {
    enable() {
        this._island = new Island();
        this._island.enable();
    }

    disable() {
        this._island?.disable();
        this._island = null;
    }
}
EOF

cd "$STAGE"
zip -q -r "$DIST/$UUID.zip" .
cd "$ROOT"

echo "built $DIST/$UUID.zip"
unzip -l "$DIST/$UUID.zip"
