#!/usr/bin/env bash
# Run the extension in an isolated headless GNOME Shell, open a mode/tab and
# screenshot it. The real session is Wayland, where a script cannot inject
# pointer events, so interaction is verified here instead.
#
# usage: tools/run-headless.sh [seconds] [mode] [tab]
#        mode: panel | compact | peek | alert | notify
#        tab : notifications | music | system | battery | timer | weather | clips | settings
#
# Requires: gnome-shell, dbus-run-session, python3-gobject, ffmpeg.
# Writes .test/out/frame.png (and cap.mp4).
set -euo pipefail

SECS=${1:-6}
MODE=${2:-panel}
TAB=${3:-}
UUID=island@nexa.local
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUN="$ROOT/.test"
EXT="$RUN/data/gnome-shell/extensions/$UUID"

rm -rf "$RUN/data" "$RUN/config" "$RUN/cache" "$RUN/out"
mkdir -p "$EXT" "$RUN/config" "$RUN/cache" "$RUN/out"
cp "$ROOT/impl.js" "$ROOT/extension.js" "$ROOT/stylesheet.css" "$ROOT/metadata.json" "$EXT/"

python3 - "$EXT/impl.js" "$MODE" "$TAB" <<'PY'
import sys

path, mode, tab = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
anchor = "        this._refreshTimer();"
if anchor not in src:
    sys.exit("anchor not found in impl.js - update tools/run-headless.sh")

body = ""
if mode == "notify":
    body = (
        "            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {\n"
        "                this._onNotification({title: 'Build finished', "
        "body: 'The release is ready to install', source: {title: 'OpenBot'}});\n"
        "                return GLib.SOURCE_REMOVE;\n"
        "            });\n"
    )
else:
    body = "            this._setMode('%s');\n" % mode
    if tab:
        body += "            this._selectTab('%s');\n" % tab

hook = (
    "        this._refreshTimer();\n"
    "        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {\n"
    + body
    + "            return GLib.SOURCE_REMOVE;\n"
    "        });"
)
open(path, "w").write(src.replace(anchor, hook, 1))
PY

cat > "$RUN/inner.sh" <<EOS
export XDG_DATA_HOME=$RUN/data
export XDG_CONFIG_HOME=$RUN/config
export XDG_CACHE_HOME=$RUN/cache
export XDG_RUNTIME_DIR=\${XDG_RUNTIME_DIR:-/run/user/\$(id -u)}
gsettings set org.gnome.shell enabled-extensions "['$UUID']" 2>/dev/null || true
gsettings set org.gnome.shell disabled-extensions "[]" 2>/dev/null || true
gsettings set org.gnome.shell disable-user-extensions false 2>/dev/null || true
gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x800 > $RUN/shell.log 2>&1 &
SH=\$!
sleep 8
gdbus call --session --dest org.gnome.Shell.Extensions \\
  --object-path /org/gnome/Shell/Extensions \\
  --method org.gnome.Shell.Extensions.EnableExtension '$UUID' > $RUN/enable.txt 2>&1 || true
sleep 3
python3 $ROOT/tools/screencast.py $SECS $RUN/out/cap > $RUN/cast.txt 2>&1 || true
sleep 2
kill \$SH 2>/dev/null || true
wait \$SH 2>/dev/null || true
EOS

dbus-run-session -- bash "$RUN/inner.sh" || true

grep -iE "\[island\]|JS ERROR|TypeError" "$RUN/shell.log" | tail -10 || true

CAP=$(ls "$RUN"/out/cap.* 2>/dev/null | head -1)
if [ -n "${CAP:-}" ] && command -v ffmpeg >/dev/null; then
    ffmpeg -y -loglevel error -sseof -0.3 -i "$CAP" -frames:v 1 "$RUN/out/frame.png" 2>/dev/null || true
fi
[ -f "$RUN/out/frame.png" ] && echo "frame: $RUN/out/frame.png"
