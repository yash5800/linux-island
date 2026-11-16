---
name: island-gnome-extension
description: Modify the Island GNOME Shell extension (dynamic island for the top bar) — add tabs, settings, live activities or styling, and test it safely without logging out. Use when working in the yash5800/linux-island repo or on ~/.local/share/gnome-shell/extensions/island@nexa.local.
---

# Island — GNOME Shell Dynamic Island

A single GNOME Shell extension (ESM, GNOME 45+ module format) that draws one
always-on-top black capsule at the top centre of the screen and replaces the
top-bar clock. No build step, no bundler, no dependencies beyond the shell.

## Files

| File | Role |
|---|---|
| `extension.js` | Tiny loader the shell caches. Watches `impl.js` and `stylesheet.css` and hot-reloads them (unique `?g=` query busts the module cache). |
| `impl.js` | Everything else: `Island` class (UI, state, timers) and `IslandImpl` (shell hooks, notification takeover). ~3k lines. |
| `stylesheet.css` | St theme. One visual system: black surface, 12 px type ramp, radii 8/12/18/26. |
| `metadata.json` | uuid `island@nexa.local`, `shell-version` must list only tested shells. |

Live install path: `~/.local/share/gnome-shell/extensions/island@nexa.local/`.
Working copy: `~/Projects/island-extension/`.

## Rules that keep it working

- **Never add a build step.** The shell imports these files directly.
- `extension.js` is cached for the whole login; `impl.js` is not. Anything in
  `extension.js` only takes effect after logout. Put logic in `impl.js`.
- Edit `impl.js` or `stylesheet.css` → the island reloads in ~350 ms. Verify
  with `journalctl --user -b -o cat _COMM=gnome-shell | grep island`.
- Only one island instance may exist. `IslandImpl.enable()` destroys
  `globalThis.__island` first; keep that guard or duplicate capsules appear.
- Every actor added to `Main.uiGroup` must be destroyed in `Island.destroy()`,
  and every `GLib.timeout_add` must go through `this._addTimer()` so it is
  cleared on reload.
- `_setMode()` animates `_capsule` x/width/height. Never reposition inside a
  mode switch — that was the old sideways glitch. The frame is pinned once.
- Panel height is measured (`_measurePanelHeight`, clamp 250–470). Do not
  hardcode heights for new tabs; add an entry to `PANEL_HEIGHTS` only as a
  fallback.
- Animations use `this._dur(ms)`, which divides by the user's speed setting.
  Never use raw durations.

## Data sources

| Feature | Source |
|---|---|
| Battery % / state | UPower `DisplayDevice` (same number as the top bar) |
| Battery health/cycles | UPower battery device via `EnumerateDevices` → `/battery_*` |
| CPU / memory / disk / net | `/proc/stat`, `/proc/meminfo`, `Gio.File.query_filesystem_info`, `/proc/net/dev` |
| Weather | Open-Meteo, coords from `~/.config/dynamic-island/config.json` (`weather.latitude/longitude`) |
| Music | MPRIS over the session bus |
| Notifications | `MessageTray.Source.prototype.addNotification` patch + banner suppression |
| Clipboard | `St.Clipboard` polled every 2 s, JSON at `~/.local/share/island-gnome/clipboard.json` |

Settings: `GLib.get_user_config_dir()/island-gnome/settings.json`, defaults in
`DEFAULT_SETTINGS`. Add a key there **and** an `addToggle(...)` line in
`_renderSettings` to expose it.

## Recipes

**New tab**: add `{id, label}` to `TABS`, add `battery: this._buildXView()` in
`_buildPanel`'s `this._views`, add `this._xView = this._views.x`, handle the id
in `_selectTab` if it needs a refresh, and give it a `PANEL_HEIGHTS` entry.

**New live activity**: call `this._liveActivity({title, body, gicon, duration,
target, onActivate})`. The queue serialises events; do not build a second alert
capsule.

**New setting**: key in `DEFAULT_SETTINGS`, `addToggle(key, title, sub)` in
`_renderSettings`, then read `this._settings.key` where it matters and call
`this._refreshX()` from `_applySettings()` if it changes live UI.

**New metric row**: reuse the `island-meter` / `island-track` / `island-fill`
classes and animate width with `ease()`. Bars always mean "used". Skip the
animation when the value changed < 0.5% so idle jitter does not shimmer.

## Testing

The live session is Wayland: pointer injection does not reach it, so hover and
click cannot be driven from a script. Test interaction in a headless shell:

```sh
# isolated gnome-shell + extension, screenshot via screencast
/tmp/islanddev/run.sh 6 panel battery     # mode: panel|compact|peek|alert
```

The harness copies the extension into its own XDG roots, so its settings
toggles cannot touch the real config (settings use `XDG_CONFIG_HOME` since
`v2`). To screenshot the real session, use `org.gnome.Shell.Screencast`; the
`Screenshot` DBus method is denied.

Always run `node --check impl.js` before reloading, then confirm the journal
shows `impl loaded` with no `JS ERROR`.

## Publishing

`metadata.json` needs a licence file in the zip root and a `url`. Bump
`version` on every extensions.gnome.org upload. Zip the **contents** of the
extension folder (files at the root, no wrapper directory).
