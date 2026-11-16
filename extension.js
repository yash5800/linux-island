import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// GNOME Shell 45+ caches extension ES modules for the whole session, so
// editing a file and toggling the extension off/on keeps running the old
// code. This module is the only one the shell has to cache: it loads the
// real code from impl.js with a unique query string, which the module cache
// treats as a new module. Saving impl.js therefore reloads the island live.
//
// Both impl.js and stylesheet.css are watched. The shell caches the parsed
// theme as well, so a CSS-only edit used to be invisible until logout; the
// loader reloads the stylesheet from disk on every change.
const LOG = (...a) => console.log('[island]', ...a);

const QUIET_MS = 350;

export default class IslandExtension extends Extension {
    enable() {
        this._impl = null;
        this._pending = 0;
        this._gen = 0;
        this._monitors = [];
        this._load(++this._gen);

        for (const name of ['impl.js', 'stylesheet.css']) {
            try {
                const file = Gio.File.new_for_path(
                    GLib.build_filenamev([this.path, name]));
                const monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
                monitor.connect('changed', () => this._scheduleReload(name));
                this._monitors.push(monitor);
            } catch (e) {
                LOG(`file monitor failed for ${name}`, e);
            }
        }
    }

    _scheduleReload(name = 'impl.js') {
        this._changedFile = name;
        if (this._pending)
            GLib.source_remove(this._pending);
        this._pending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QUIET_MS, () => {
            this._pending = 0;
            this._reload();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _reload() {
        LOG(`reloading ${this._changedFile ?? 'impl.js'}`);
        // Two saves inside the 350 ms quiet window used to start two loads.
        // The first unload cleared _impl before the first load had assigned
        // it, so that island was never disabled and its capsule stayed on
        // screen beside the new one. A generation token makes the newest
        // load the only one allowed to install an instance.
        const gen = ++this._gen;
        this._reloadStylesheet();
        this._unload();
        await this._load(gen);
    }

    // Unload and re-add stylesheet.css so the shell re-parses it from disk.
    _reloadStylesheet() {
        try {
            const file = Gio.File.new_for_path(
                GLib.build_filenamev([this.path, 'stylesheet.css']));
            const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            theme.unload_stylesheet(file);
            theme.load_stylesheet(file);
        } catch (e) {
            LOG('stylesheet reload failed', e);
        }
    }

    _unload() {
        try {
            this._impl?.disable();
        } catch (e) {
            LOG('impl disable failed', e);
        }
        this._impl = null;
    }

    async _load(gen) {
        try {
            const url = `file://${this.path}/impl.js?g=${Date.now()}`;
            const mod = await import(url);
            if (gen !== this._gen)
                return;
            this._impl = new mod.default();
            this._impl.enable();
            LOG('impl loaded');
        } catch (e) {
            LOG('impl load failed', e);
        }
    }

    disable() {
        if (this._pending) {
            GLib.source_remove(this._pending);
            this._pending = 0;
        }
        for (const monitor of this._monitors)
            monitor.cancel();
        this._monitors = [];
        this._unload();
    }
}
