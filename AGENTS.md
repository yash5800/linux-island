# Agent guide — linux-island

This repo is a GNOME Shell extension. The detailed, reusable skill lives in
[`SKILL.md`](SKILL.md); read that first. This file is the short contract.

## Ground rules

- No build step, no dependencies. The shell imports `impl.js` and
  `stylesheet.css` directly.
- `extension.js` is cached for the whole login. Put behaviour in `impl.js`.
- Run `node --check impl.js` before every reload.
- Verify with `journalctl --user -b -o cat _COMM=gnome-shell | grep island`;
  a reload prints `impl loaded` and must not print `JS ERROR`.
- Never leave more than one island alive: `IslandImpl.enable()` must destroy
  `globalThis.__island` first.
- Destroy every actor you add to `Main.uiGroup`, and schedule timers only
  through `this._addTimer()` so a reload clears them.
- Animate with `this._dur(ms)`, never raw milliseconds.
- Bars mean "used"; label them `used / total · percent`.

## Where things live

`impl.js` is one file on purpose. Find sections by their comment banners:

```
// ---------- build ----------
// ---------- mode ----------
// ---------- music engine ----------
// ---------- battery device ----------
// ---------- weather ----------
// ---------- notifications ----------
```

Class `Island` = UI and state. Class `IslandImpl` = shell hooks, implemented at
the bottom of the file.

## Before changing structure

- New tab: `TABS`, `this._views`, `_selectTab` refresh case, `PANEL_HEIGHTS`.
- New setting: `DEFAULT_SETTINGS`, `addToggle()` in `_renderSettings`, then
  `_applySettings()` for live application.
- New live activity: `this._liveActivity({...})` — the queue already
  serialises them.
- New metric: reuse `island-meter` / `island-track` / `island-fill`.

## Testing

```sh
tools/run-headless.sh 6 panel battery
```

Runs an isolated gnome-shell with the extension, screenshots it through the
screencast API and writes `frame.png` under `.test/out/`. The live session is
Wayland, so real pointer hover/click cannot be scripted there.

## Commits

Small, focused commits. Mention the GNOME version you tested in the message
body when behaviour depends on it.
