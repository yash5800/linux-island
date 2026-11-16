#!/usr/bin/env python3
"""Record the session for N seconds through GNOME's screencast API.

Usage: screencast.py <seconds> <output-basename>

Writes <output-basename>.mp4. The shell's org.gnome.Shell.Screenshot method is
denied to unprivileged callers on a normal session; Screencast is not.
"""
import sys
import time

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib  # noqa: E402


def main():
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 5.0
    out = sys.argv[2] if len(sys.argv) > 2 else "capture"

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    def call(method, params=None):
        return bus.call_sync(
            "org.gnome.Shell.Screencast",
            "/org/gnome/Shell/Screencast",
            "org.gnome.Shell.Screencast",
            method,
            params,
            None,
            Gio.DBusCallFlags.NONE,
            -1,
            None,
        )

    ok, fname = call("Screencast", GLib.Variant("(sa{sv})", (out, {})))
    print(f"recording: {ok} {fname}")
    time.sleep(seconds)
    print("stop:", call("StopScreencast"))


if __name__ == "__main__":
    main()
