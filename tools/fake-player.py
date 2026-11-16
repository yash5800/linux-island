#!/usr/bin/env python3
"""Minimal MPRIS player for the headless harness.

The live Wayland session has no pointer injection and the harness has no
media player, so this registers org.mpris.MediaPlayer2.fake on the harness's
private bus to render the media face with real metadata.
"""
import gi
import os

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

XML = """
<node>
  <interface name="org.mpris.MediaPlayer2">
    <property name="Identity" type="s" access="read"/>
    <property name="CanQuit" type="b" access="read"/>
  </interface>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Stop"/>
    <method name="Seek">
      <arg name="Offset" type="x" direction="in"/>
    </method>
    <method name="SetPosition">
      <arg name="TrackId" type="o" direction="in"/>
      <arg name="Position" type="x" direction="in"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="CanControl" type="b" access="read"/>
    <property name="Rate" type="d" access="read"/>
    <property name="Volume" type="d" access="read"/>
    <property name="LoopStatus" type="s" access="read"/>
    <property name="Shuffle" type="b" access="read"/>
    <property name="MinimumRate" type="d" access="read"/>
    <property name="MaximumRate" type="d" access="read"/>
  </interface>
</node>
"""

TITLE = os.environ.get("FAKE_TITLE", "The Eliminating Angel")
ALBUM = os.environ.get("FAKE_ALBUM", "Metavoid")
ARTIST = os.environ.get("FAKE_ARTIST", "Lustmord")
LENGTH_US = int(float(os.environ.get("FAKE_LENGTH", "236")) * 1_000_000)
START_US = int(float(os.environ.get("FAKE_POSITION", "42")) * 1_000_000)
ART = os.environ.get("FAKE_ART", "")

state = {"playing": os.environ.get("FAKE_PAUSED", "0") != "1",
         "position": START_US}


def metadata():
    meta = {
        "mpris:trackid": GLib.Variant("o", "/org/mpris/MediaPlayer2/Track/1"),
        "xesam:title": GLib.Variant("s", TITLE),
        "xesam:album": GLib.Variant("s", ALBUM),
        "xesam:artist": GLib.Variant("as", [ARTIST]),
        "mpris:length": GLib.Variant("x", LENGTH_US),
    }
    if ART:
        meta["mpris:artUrl"] = GLib.Variant("s", ART)
    return meta


def props():
    return {
        "PlaybackStatus": GLib.Variant("s", "Playing" if state["playing"] else "Paused"),
        "Metadata": GLib.Variant("a{sv}", metadata()),
        "Position": GLib.Variant("x", state["position"]),
        "CanPlay": GLib.Variant("b", True),
        "CanPause": GLib.Variant("b", True),
        "CanGoNext": GLib.Variant("b", True),
        "CanGoPrevious": GLib.Variant("b", True),
        "CanSeek": GLib.Variant("b", True),
        "CanControl": GLib.Variant("b", True),
        "Rate": GLib.Variant("d", 1.0),
        "Volume": GLib.Variant("d", 0.7),
        "LoopStatus": GLib.Variant("s", "None"),
        "Shuffle": GLib.Variant("b", False),
        "MinimumRate": GLib.Variant("d", 1.0),
        "MaximumRate": GLib.Variant("d", 1.0),
    }


def on_method(conn, sender, path, iface, method, params, invocation):
    name = method.split(".")[-1]
    if name in ("PlayPause",):
        state["playing"] = not state["playing"]
        emit(conn, {"PlaybackStatus": props()["PlaybackStatus"]})
    elif name == "Play":
        state["playing"] = True
        emit(conn, {"PlaybackStatus": props()["PlaybackStatus"]})
    elif name == "Pause":
        state["playing"] = False
        emit(conn, {"PlaybackStatus": props()["PlaybackStatus"]})
    elif name == "Next":
        state["position"] = 0
        emit(conn, {"Position": GLib.Variant("x", 0)})
    elif name == "Previous":
        state["position"] = 0
        emit(conn, {"Position": GLib.Variant("x", 0)})
    invocation.return_value(None)


def emit(conn, changed):
    conn.emit_signal(
        None,
        "/org/mpris/MediaPlayer2",
        "org.freedesktop.DBus.Properties",
        "PropertiesChanged",
        GLib.Variant("(sa{sv}as)", ("org.mpris.MediaPlayer2.Player", changed, [])),
    )


def main():
    node = Gio.DBusNodeInfo.new_for_xml(XML)
    conn = Gio.bus_get_sync(Gio.BusType.SESSION, None)

    def get_property(connection, sender, path, iface, prop):
        if iface == "org.mpris.MediaPlayer2":
            if prop == "Identity":
                return GLib.Variant("s", "Fake Player")
            return GLib.Variant("b", False)
        return props().get(prop)

    for iface in node.interfaces:
        conn.register_object(
            "/org/mpris/MediaPlayer2",
            iface,
            on_method,
            get_property,
            None,
        )
    Gio.bus_own_name_on_connection(conn, "org.mpris.MediaPlayer2.fake", 0, None, None)
    GLib.MainLoop().run()


if __name__ == "__main__":
    main()
