import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const LOG = (...a) => console.log('[island]', ...a);

const MODES = {
    // Notch, not pill: the compact capsule hangs from the screen edge and
    // only its bottom corners are rounded. 30 px keeps it inside the 32 px
    // shell panel so it cannot bleed into an app below.
    compact: {width: 320, height: 30, radius: 16, style: 'island-compact'},
    // The expanded face is a wide, short slab: media on the left, calendar
    // (or the active tab) on the right, exactly like the reference notch.
    panel: {width: 640, height: 236, radius: 36, style: 'island-panel'},
    alert: {width: 392, height: 82, radius: 20, style: 'island-alert'},
};

// The panel hugs its tab: a dashboard does not need the same vertical space
// as the music player. Height animates on tab change, like the real thing.
const PANEL_HEIGHTS = {
    notifications: 300,
    music: 236,
    system: 286,
    battery: 330,
    timer: 280,
    weather: 390,
    clips: 300,
    settings: 360,
};

// An empty tab should not sit in a half-empty capsule: the panel height
// follows what the tab actually has to show.
const panelHeight = (tab, island) => {
    if (tab === 'music' && island && !island._activePlayer?.())
        return 236;
    if (tab === 'notifications' && island && island._feed?.length === 0)
        return 250;
    if (tab === 'clips' && island && island._clips?.length === 0)
        return 250;
    return PANEL_HEIGHTS[tab] ?? MODES.panel.height;
};

const DURATION = 280;

// Fixed footprint of the overlay, sized for the largest mode (panel). The
// panel itself is clamped to 470 px tall; the frame has to be at least that
// tall plus the top inset or a tall tab runs past its parent's allocation.
const FRAME = {width: 720, height: 500};
// Distance from the top of the monitor to the capsule. The notch modes sit
// flush with the screen edge; only floating alerts use an inset.
const CAP_TOP = 2;
const TABS = [
    {id: 'notifications', label: 'Alerts', icon: 'preferences-system-notifications-symbolic'},
    {id: 'music', label: 'Music', icon: 'audio-x-generic-symbolic'},
    {id: 'system', label: 'System', icon: 'computer-symbolic'},
    {id: 'battery', label: 'Battery', icon: 'battery-good-symbolic'},
    {id: 'timer', label: 'Timer', icon: 'alarm-symbolic'},
    {id: 'weather', label: 'Weather', icon: 'weather-clear-symbolic'},
    {id: 'clips', label: 'Clips', icon: 'edit-copy-symbolic'},
    {id: 'settings', label: 'Settings', icon: 'preferences-system-symbolic'},
];

// get_user_config_dir(), not home + '.config': it honours XDG_CONFIG_HOME,
// so a test shell with its own config root cannot overwrite the real one.
const SETTINGS_FILE = GLib.build_filenamev([
    GLib.get_user_config_dir(), 'island-gnome', 'settings.json',
]);
// Clipboard history persists on disk, not in RAM: quitting or crashing the
// shell never loses it, and the file is the single source of truth.
const CLIPS_FILE = GLib.build_filenamev([
    GLib.get_user_data_dir(), 'island-gnome', 'clipboard.json',
]);
const MAX_CLIPS = 30;
const MAX_CLIP_CHARS = 2000;
// Clip cards size to their text; the list viewport stops growing at this
// height and scrolls instead. Rows must never be cut by a fixed row height:
// a wrapped clip is taller than one line, and a hard 46 px slot clipped it.
const CLIP_VIEW_MAX = 200;
// `.island-clip-list` spacing.
const CLIP_GAP = 8;
// Full-width tabs (clips never shares the slab with the player column):
// 640 panel - 32 root padding - 20 card padding - 60 buttons - 12 gaps.
const CLIP_TEXT_W = 514;
const NET_FULL_RATE = 10e6;

const DEFAULT_SETTINGS = {
    clock24: false,
    showWeather: true,
    showBattery: true,
    showMusic: true,
    liveBattery: true,
    liveDevices: true,
    batteryTab: true,
    // Opt-in. Reading the clipboard is a privacy-sensitive act, so a fresh
    // install never does it until the user turns history on (Clips tab or
    // Settings). An existing settings.json keeps whatever it already has.
    saveClips: false,
    accent: 'blue',
    speed: 'normal',
    pixelStyle: 'spark',
    wallpaperBackground: false,
    wallpaperBlur: 12,
    wallpaperUri: '',
    collapseMs: 420,
};

const SPEED = {slow: 0.65, normal: 1, fast: 1.55};
const ACCENTS = ['blue', 'violet', 'green', 'amber'];

// Each sprite is a small, hand-drawn 9x9 pixel animation. `.` is empty,
// `x` is the theme color, and `#` is its bright highlight.
const PIXEL_STYLES = {
    spark: [
        ['....#....', '.........', '..x...x..', '...x.x...', 'x...#...x', '...x.x...', '..x...x..', '.........', '....#....'],
        ['...x#x...', '..x...x..', '.x.....x.', 'x..x.x..x', '#...x...#', 'x..x.x..x', '.x.....x.', '..x...x..', '...x#x...'],
        ['.xx.#.xx.', 'x..x.x..x', 'x.......x', '.x.x.x.x.', '#...#...#', '.x.x.x.x.', 'x.......x', 'x..x.x..x', '.xx.#.xx.'],
        ['.........', '....#....', '..x...x..', '.........', 'x...#...x', '.........', '..x...x..', '....#....', '.........'],
    ],
    anime: [
        ['....###..', '..#######', '.########', '###...###', '##.#.#.##', '.#######.', '..##.##..', '..#####..', '.##...##.'],
        ['....###..', '..#######', '.########', '###...###', '##.#.#.##', '.#######.', '..##.##..', '.#######.', '##.....##'],
        ['...#####.', '..#######', '.########', '###...###', '##.#.#.##', '.#######.', '..##.##..', '..#####..', '.##...##.'],
        ['....###..', '..#######', '.########', '###...###', '##.#.#.##', '.#######.', '..##.##..', '.#######.', '##.....##'],
    ],
    car: [
        ['.........', '...xxxxx.', '..xxxxxxx', '.xx.###.x', 'xxxxxxxxx', 'xx.xxx.xx', '.##...##.', '.........', '.........'],
        ['.........', '...xxxxx.', '..xxxxxxx', '.xx.###.#', 'xxxxxxxxx', 'xx.xxx.xx', '.##...##.', '.........', '.........'],
        ['.........', '...xxxxx.', '..xxxxxxx', '.xx.###.x', 'xxxxxxxxx', 'xx.xxx.xx', '.##...##.', '..x....x.', '.........'],
        ['.........', '...xxxxx.', '..xxxxxxx', '.xx.###.#', 'xxxxxxxxx', 'xx.xxx.xx', '.##...##.', '..x....x.', '.........'],
    ],
    cyberpunk: [
        ['....#....', '...x#x...', '..x.#.x..', '.x..#..x.', 'xxxxxxxxx', '.x..#..x.', '..x.#.x..', '...x#x...', '....#....'],
        ['....x....', '...x#x...', '..x.#.x..', '.x..#..x.', 'xx#xxx#xx', '.x..#..x.', '..x.#.x..', '...x#x...', '....x....'],
        ['.........', '...x#x...', '..x.#.x..', '.x..#..x.', 'xxxxxxxxx', '.x..#..x.', '..x.#.x..', '...x#x...', '.........'],
        ['....x....', '...x#x...', '..x.#.x..', '.x..#..x.', 'xx#xxx#xx', '.x..#..x.', '..x.#.x..', '...x#x...', '....x....'],
    ],
};

function loadSettings() {
    try {
        const [ok, data] = GLib.file_get_contents(SETTINGS_FILE);
        if (!ok)
            return {...DEFAULT_SETTINGS};
        return {...DEFAULT_SETTINGS, ...JSON.parse(new TextDecoder('utf-8').decode(data))};
    } catch (e) {
        return {...DEFAULT_SETTINGS};
    }
}

function saveSettings(settings) {
    try {
        GLib.mkdir_with_parents(GLib.path_get_dirname(SETTINGS_FILE), 0o755);
        GLib.file_set_contents(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (e) {
        LOG('could not save settings', e);
    }
}

const MPRIS_XML = `<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="SetPosition">
      <arg name="TrackId" type="o" direction="in"/>
      <arg name="Position" type="x" direction="in"/>
    </method>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="CanSeek" type="b" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Position" type="x" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
  </interface>
</node>`;

let _mprisIface = null;
function mprisInterface() {
    if (!_mprisIface) {
        const node = Gio.DBusNodeInfo.new_for_xml(MPRIS_XML);
        _mprisIface = node.lookup_interface('org.mpris.MediaPlayer2.Player');
    }
    return _mprisIface;
}

const WEATHER_CODES = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle',
    55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
    61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain',
    67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
    77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers',
    82: 'Violent showers', 85: 'Snow showers', 86: 'Snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};

const WEATHER_GLYPH = {
    0: '☀', 1: '🌤', 2: '⛅', 3: '☁', 45: '🌫', 48: '🌫',
    51: '🌦', 53: '🌦', 55: '🌦', 56: '🌧', 57: '🌧', 61: '🌧',
    63: '🌧', 65: '🌧', 66: '🌧', 67: '🌧', 71: '🌨', 73: '🌨',
    75: '❄', 77: '❄', 80: '🌦', 81: '🌦', 82: '⛈', 85: '🌨',
    86: '🌨', 95: '⛈', 96: '⛈', 99: '⛈',
};

const WEATHER_ICON = {
    0: 'weather-clear-symbolic', 1: 'weather-few-clouds-symbolic',
    2: 'weather-few-clouds-symbolic', 3: 'weather-overcast-symbolic',
    45: 'weather-fog-symbolic', 48: 'weather-fog-symbolic',
    51: 'weather-showers-scattered-symbolic', 53: 'weather-showers-scattered-symbolic',
    55: 'weather-showers-symbolic', 56: 'weather-showers-symbolic',
    57: 'weather-showers-symbolic', 61: 'weather-showers-scattered-symbolic',
    63: 'weather-showers-symbolic', 65: 'weather-showers-symbolic',
    66: 'weather-showers-symbolic', 67: 'weather-showers-symbolic',
    71: 'weather-snow-symbolic', 73: 'weather-snow-symbolic',
    75: 'weather-snow-symbolic', 77: 'weather-snow-symbolic',
    80: 'weather-showers-scattered-symbolic', 81: 'weather-showers-scattered-symbolic',
    82: 'weather-storm-symbolic', 85: 'weather-snow-symbolic',
    86: 'weather-snow-symbolic', 95: 'weather-storm-symbolic',
    96: 'weather-storm-symbolic', 99: 'weather-storm-symbolic',
};

function readText(path) {
    try {
        const [ok, data] = GLib.file_get_contents(path);
        if (!ok)
            return '';
        return new TextDecoder('utf-8').decode(data);
    } catch (e) {
        return '';
    }
}

function pad(n) {
    return String(n).padStart(2, '0');
}

// Top-bar style: 9:41 AM (no leading zero, like the system clock).
function fmtTime(date, clock24 = false) {
    if (clock24)
        return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const h24 = date.getHours();
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const suffix = h24 < 12 ? 'AM' : 'PM';
    return `${h12}:${pad(date.getMinutes())} ${suffix}`;
}

function fmtDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const m = Math.floor(s / 60);
    return `${m}:${pad(s % 60)}`;
}

// Compact date: "Nov 16"
function fmtDateShort(date) {
    return `${date.toLocaleDateString(undefined, {month: 'short'})} ${date.getDate()}`;
}

function fmtDate(date) {
    return date.toLocaleDateString(undefined, {weekday: 'long', day: 'numeric', month: 'short'});
}

function bytesToGb(bytes) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

function label(text, style) {
    return new St.Label({text, style_class: style, y_align: Clutter.ActorAlign.CENTER});
}

class Island {
    constructor() {
        this._settings = loadSettings();
        this._mode = 'compact';
        this._hovered = false;
        this._feed = [];
        this._clips = [];
        this._lastClip = '';
        this._clipWatchId = 0;
        this._clipFitId = 0;
        this._unseen = 0;
        // The first hover opens the reference face: player left, calendar
        // right. Tabs stay where the user leaves them after they pick one.
        this._tab = 'music';
        this._timers = [];
        this._stageSignals = [];
        this._weather = null;
        this._weatherMetric = 'temperature';
        this._weatherUnit = 'c';
        this._weatherChartPoints = [];
        this._cpuPrev = null;
        this._netPrev = null;
        this._alertUntil = 0;
        this._alertTarget = null;
        this._activities = [];
        this._battPrev = null;
        this._btDevices = new Map();
        this._btSeen = new Set();
        this._timerMinutes = 25;
        this._timerRemaining = 25 * 60000;
        this._timerTotal = this._timerRemaining;
        this._timerRunning = false;
        this._timerTickerId = 0;
        this._timerEndAt = 0;
        this._currentArtUrl = null;
        this._wallpaperSettingsSignals = [];
        this._wallpaperSettings = null;
        this._wallpaperRenderUri = null;
        this._wallpaperRenderKey = null;
        this._wallpaperCurrentUri = null;
        this._wallpaperDialog = null;

        this._session = new Soup.Session({timeout: 12});
        this._session.user_agent = 'island-gnome-extension/1.0';

        this._buildUI();
        this._buildCompact();
        this._buildPanel();
        this._buildAlert();

        this._loadClips();
        this._renderClips();
        this._startClipWatch();

        this._capsule.add_child(this._compact);
        this._capsule.add_child(this._panel);
        this._capsule.add_child(this._alert);

        this._showOnly(this._compact);
        this._applySettings();

        this._capsule.connect('notify::hover', () => this._onHoverChanged());
        // Child scroll views still receive the wheel first; stopping it on
        // the capsule keeps the event out of the shell panel (workspace
        // scroll) once the tab content has nothing left to scroll.
        this._capsule.connect('scroll-event', () => Clutter.EVENT_STOP);
        // Only the collapsed capsule toggles the panel. Presses inside the
        // open panel reach this too (events bubble), and the old handler
        // treated every tab click as "close", so the panel vanished instead
        // of switching tabs.
        this._capsule.connect('button-press-event', () => {
            if (this._mode === 'panel')
                return Clutter.EVENT_PROPAGATE;
            // Tapping a notification banner opens the app that sent it;
            // other live activities open the tab they belong to.
            if (this._mode === 'alert' && this._alertActivate) {
                const activate = this._alertActivate;
                this._alertActivate = null;
                this._alertTarget = null;
                let opened = false;
                try {
                    opened = activate();
                } catch (e) {
                    LOG('activity activate failed', e.message);
                }
                if (opened) {
                    this._setMode('compact');
                    return Clutter.EVENT_STOP;
                }
                // Nothing to open (e.g. notify-send): show the notification
                // list instead of swallowing the tap.
                this._tab = 'notifications';
                this._setMode('panel');
                return Clutter.EVENT_STOP;
            }
            if (this._mode === 'alert' && this._alertTarget)
                this._tab = this._alertTarget;
            this._setMode('panel');
            return Clutter.EVENT_STOP;
        });
        this._capsule.connect('enter-event', () => {
            this._hovered = true;
            this._onHoverChanged();
            return Clutter.EVENT_PROPAGATE;
        });
        this._capsule.connect('leave-event', () => {
            this._hovered = false;
            this._onHoverChanged();
            return Clutter.EVENT_PROPAGATE;
        });

        this._monitorId = Main.layoutManager.connect('monitors-changed', () => this._place());
        this._place();

        this._addTimer(1000, () => {
            this._tickClock();
            if (this._settings.showMusic)
                this._pollMusic();
        });
        // Sample CPU and network every second whether or not the System tab
        // is open. Rates are deltas between samples, so sampling only while
        // visible meant the first number you saw was averaged over however
        // long the tab had been closed - the classic "0 KB/s, then a jump".
        this._addTimer(1000, () => {
            if (this._mode === 'panel' && this._tab === 'system')
                this._refreshSystem();
            else
                this._sampleSystem();
        });
        this._addTimer(600000, () => this._refreshWeather());

        this._tickClock();
        this._refreshSystem(true);
        this._refreshWeather();
        this._setupMpris();
        this._setupPower();
        this._setupBatteryDevice();
        this._addTimer(5000, () => {
            if (this._tab === 'battery')
                this._refreshBatteryView();
        });
        this._watchBluetooth();
        this._addTimer(7000, () => this._checkBatteryActivity());
        this._refreshTimer();
        this._setPreset(25);




    }

    // ---------- build ----------

    _buildUI() {
        // The frame never moves and never resizes: it is a transparent, full
        // size box pinned once at the top centre of the monitor. The pill grows
        // and shrinks inside it, and Clutter's BinLayout re-centres it on every
        // frame, so the island cannot drift sideways mid-animation.
        this._frame = new St.Widget({
            // FixedLayout, not BinLayout: BinLayout always centred the pill
            // vertically inside the frame, which put it in the middle of the
            // screen. Here every child position is explicit.
            layout_manager: new Clutter.FixedLayout(),
            reactive: false,
            width: FRAME.width,
            height: FRAME.height,
        });

        this._capsule = new St.Widget({
            style_class: 'island',
            reactive: true,
            track_hover: true,
            layout_manager: new Clutter.BinLayout(),
            clip_to_allocation: true,
            width: MODES.compact.width,
            height: MODES.compact.height,
            x: Math.round((FRAME.width - MODES.compact.width) / 2),
            y: 0,
            opacity: 255,
        });
        this._capsule.add_style_class_name(MODES.compact.style);

        this._wallpaper = new St.Widget({
            style_class: 'island-wallpaper',
            reactive: false,
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            x_expand: true,
            y_expand: true,
        });
        this._wallpaperTint = new St.Widget({
            style_class: 'island-wallpaper-tint',
            reactive: false,
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            x_expand: true,
            y_expand: true,
        });
        this._capsule.add_child(this._wallpaper);
        this._capsule.add_child(this._wallpaperTint);
        try {
            this._wallpaperSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
            for (const key of ['picture-uri', 'picture-uri-dark']) {
                const id = this._wallpaperSettings.connect(`changed::${key}`, () => this._refreshWallpaper());
                this._wallpaperSettingsSignals.push(id);
            }
        } catch (e) {
            LOG('desktop wallpaper setting unavailable', e.message);
        }
        this._refreshWallpaper();

        this._frame.add_child(this._capsule);
        Main.uiGroup.add_child(this._frame);
    }

    _refreshWallpaper() {
        if (!this._wallpaper || !this._capsule)
            return;

        let uri = null;
        let wallpaperFile = null;
        const candidates = [this._settings.wallpaperUri];
        for (const key of ['picture-uri-dark', 'picture-uri']) {
            try {
                candidates.push(this._wallpaperSettings?.get_string(key));
            } catch (e) {}
        }
        for (const candidate of candidates) {
            try {
                if (!candidate?.startsWith('file://'))
                    continue;
                const file = Gio.File.new_for_uri(candidate);
                if (!file.query_exists(null))
                    continue;
                const info = file.query_info('standard::content-type', Gio.FileQueryInfoFlags.NONE, null);
                if (info.get_content_type()?.startsWith('image/')) {
                    uri = file.get_uri();
                    wallpaperFile = file;
                    break;
                }
            } catch (e) {}
        }

        const enabled = !!uri && !!this._settings.wallpaperBackground;
        this._wallpaper.visible = enabled;
        this._wallpaperTint.visible = enabled;
        const blur = Math.max(0, Math.min(24, Number(this._settings.wallpaperBlur) || 0));
        const renderKey = enabled && uri ? `${uri}:${blur}` : null;
        if (renderKey !== this._wallpaperRenderKey) {
            this._wallpaperRenderKey = renderKey;
            this._wallpaperRenderUri = enabled && uri
                ? this._prepareWallpaperImage(wallpaperFile, uri, blur)
                : null;
        }
        const renderUri = enabled ? this._wallpaperRenderUri : null;
        if (renderUri !== this._wallpaperCurrentUri) {
            this._wallpaperCurrentUri = renderUri;
            // GFile returns an encoded URI, so quotes and spaces in paths
            // cannot escape the CSS url() value. The source is pre-scaled to
            // the capsule's maximum size so animation frames do not resample
            // a multi-megapixel desktop image.
            this._wallpaper.style = renderUri
                ? `background-image: url("${renderUri}"); background-size: cover; background-position: center; background-repeat: no-repeat;`
                : '';
        }
        if (enabled)
            this._capsule.add_style_class_name('island-wallpaper-on');
        else
            this._capsule.remove_style_class_name('island-wallpaper-on');
    }

    _prepareWallpaperImage(file, sourceUri, blurRadius) {
        const sourcePath = file?.get_path?.();
        if (!sourcePath)
            return sourceUri;
        try {
            const info = file.query_info(
                'time::modified,time::modified-usec,standard::size', Gio.FileQueryInfoFlags.NONE, null);
            const stamp = `${info.get_attribute_uint64('time::modified')}:` +
                `${info.get_attribute_uint32('time::modified-usec')}:${info.get_size()}`;
            const digest = GLib.compute_checksum_for_string(
                GLib.ChecksumType.SHA256, `${sourceUri}:${stamp}:blur-${blurRadius}:rounded-v1`, -1).slice(0, 20);
            const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'island-gnome', 'wallpapers']);
            const cachePath = GLib.build_filenamev([cacheDir, `${digest}.png`]);
            if (!GLib.file_test(cachePath, GLib.FileTest.EXISTS)) {
                GLib.mkdir_with_parents(cacheDir, 0o755);
                const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(sourcePath, 640, 470, true);
                const radius = Math.round(blurRadius / 2);
                const output = radius > 0 ? this._blurWallpaperPixbuf(pixbuf, radius) : pixbuf;
                output.savev(cachePath, 'png', [], []);
            }
            return GLib.filename_to_uri(cachePath, null);
        } catch (e) {
            LOG('wallpaper downscale failed', e.message);
            return sourceUri;
        }
    }

    _blurWallpaperPixbuf(pixbuf, radius) {
        const width = pixbuf.get_width();
        const height = pixbuf.get_height();
        const stride = pixbuf.get_rowstride();
        const channels = pixbuf.get_n_channels();

        const boxPass = (input, r, horizontal) => {
            const output = new Uint8Array(input.length);
            const lineLength = horizontal ? width : height;
            const lineCount = horizontal ? height : width;
            const diameter = r * 2 + 1;
            const sums = new Float64Array(channels);
            const offset = (line, position) => horizontal
                ? line * stride + position * channels
                : position * stride + line * channels;

            for (let line = 0; line < lineCount; line++) {
                sums.fill(0);
                for (let i = -r; i <= r; i++) {
                    const idx = offset(line, Math.max(0, Math.min(lineLength - 1, i)));
                    for (let c = 0; c < channels; c++)
                        sums[c] += input[idx + c];
                }

                for (let position = 0; position < lineLength; position++) {
                    const idx = offset(line, position);
                    for (let c = 0; c < channels; c++)
                        output[idx + c] = Math.round(sums[c] / diameter);
                    const leaving = offset(line, Math.max(0, position - r));
                    const entering = offset(line, Math.min(lineLength - 1, position + r + 1));
                    for (let c = 0; c < channels; c++)
                        sums[c] += input[entering + c] - input[leaving + c];
                }
            }
            return output;
        };

        let pixels = new Uint8Array(pixbuf.get_pixels());
        for (let pass = 0; pass < 3; pass++) {
            pixels = boxPass(pixels, radius, true);
            pixels = boxPass(pixels, radius, false);
        }
        const bytes = GLib.Bytes.new(pixels);
        return GdkPixbuf.Pixbuf.new_from_bytes(
            bytes, pixbuf.get_colorspace(), pixbuf.get_has_alpha(),
            pixbuf.get_bits_per_sample(), width, height, stride);
    }

    _closeWallpaperRequest(request) {
        if (!request)
            return;
        if (request.responseSignalId) {
            Gio.DBus.session.signal_unsubscribe(request.responseSignalId);
            request.responseSignalId = 0;
        }
        if (!request.handle || request.closeSent)
            return;
        request.closeSent = true;
        Gio.DBus.session.call(
            'org.freedesktop.portal.Desktop', request.handle,
            'org.freedesktop.portal.Request', 'Close', null, null,
            Gio.DBusCallFlags.NONE, 1000, null,
            (connection, result) => {
                try {
                    connection.call_finish(result);
                } catch (e) {
                    // The portal may already have closed the request.
                }
            });
    }

    _setWallpaper(uri, enabled) {
        this._settings.wallpaperUri = uri;
        this._settings.wallpaperBackground = enabled;
        saveSettings(this._settings);
        this._applySettings();
        if (this._tab === 'settings')
            this._renderSettings();
    }

    _chooseWallpaper() {
        if (this._wallpaperDialog || this._destroyed)
            return;

        const connection = Gio.DBus.session;
        const token = `island_wallpaper_${GLib.get_monotonic_time()}`;
        const sender = (connection.get_unique_name() ?? '').replace(/^:/, '').replace(/\./g, '_');
        const expectedHandle = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
        const request = {handle: expectedHandle, expectedHandle, responseSignalId: 0,
            closeSent: false, done: false};
        this._wallpaperDialog = request;

        try {
            // Subscribe before OpenFile: a fast portal response can arrive
            // before the method callback returns its handle.
            request.responseSignalId = connection.signal_subscribe(
                'org.freedesktop.portal.Desktop',
                'org.freedesktop.portal.Request', 'Response', null,
                null, Gio.DBusSignalFlags.NONE,
                (conn, senderName, path, iface, signal, parameters) => {
                    if (path !== request.expectedHandle && path !== request.handle)
                        return;
                    if (request.responseSignalId) {
                        conn.signal_unsubscribe(request.responseSignalId);
                        request.responseSignalId = 0;
                    }
                    request.done = true;
                    request.handle = null; // Response closes the portal request.
                    if (this._wallpaperDialog === request)
                        this._wallpaperDialog = null;
                    if (this._destroyed)
                        return;

                    try {
                        const response = parameters.get_child_value(0).get_uint32();
                        if (response !== 0)
                            return; // The user dismissed the chooser.
                        const values = parameters.get_child_value(1);
                        const uris = values.lookup_value(
                            'uris', new GLib.VariantType('as'))?.get_strv() ?? [];
                        const uri = uris[0];
                        if (!uri?.startsWith('file://')) {
                            LOG('choose a local wallpaper image');
                            return;
                        }
                        const file = Gio.File.new_for_uri(uri);
                        const info = file.query_info(
                            'standard::content-type', Gio.FileQueryInfoFlags.NONE, null);
                        if (!info.get_content_type()?.startsWith('image/')) {
                            LOG('wallpaper selection is not an image');
                            return;
                        }
                        this._setWallpaper(uri, true);
                    } catch (e) {
                        LOG('wallpaper selection failed', e.message);
                    }
                });

            connection.call(
                'org.freedesktop.portal.Desktop',
                '/org/freedesktop/portal/desktop',
                'org.freedesktop.portal.FileChooser', 'OpenFile',
                new GLib.Variant('(ssa{sv})', [
                    '', 'Choose Island wallpaper',
                    {handle_token: new GLib.Variant('s', token)},
                ]),
                new GLib.VariantType('(o)'),
                Gio.DBusCallFlags.NONE, -1, null,
                (bus, result) => {
                    try {
                        const [handle] = bus.call_finish(result).deep_unpack();
                        if (request.done)
                            return; // The response signal already handled this request.
                        request.handle = handle;
                        if (this._destroyed || this._wallpaperDialog !== request) {
                            this._closeWallpaperRequest(request);
                            return;
                        }
                    } catch (e) {
                        request.done = true;
                        request.handle = null;
                        if (request.responseSignalId) {
                            bus.signal_unsubscribe(request.responseSignalId);
                            request.responseSignalId = 0;
                        }
                        if (this._wallpaperDialog === request)
                            this._wallpaperDialog = null;
                        if (!this._destroyed)
                            LOG('wallpaper picker unavailable', e.message);
                    }
                });
        } catch (e) {
            request.done = true;
            request.handle = null;
            if (request.responseSignalId) {
                connection.signal_unsubscribe(request.responseSignalId);
                request.responseSignalId = 0;
            }
            this._wallpaperDialog = null;
            LOG('wallpaper picker unavailable', e.message);
        }
    }

    _shell() {
        return new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });
    }

    _buildCompact() {
        const box = this._shell();
        box.add_style_class_name('island-compact-body');

        this._pixelStyle = null;
        this._pixelFrames = [];
        this._pixel = new St.BoxLayout({vertical: true, style_class: 'island-pixel',
            y_align: Clutter.ActorAlign.CENTER});
        this._pixelCells = [];
        for (let r = 0; r < 9; r++) {
            const rowBox = new St.BoxLayout({style_class: 'island-pixel-row'});
            for (let c = 0; c < 9; c++) {
                const cell = new St.Widget({style_class: 'island-pixel-cell'});
                rowBox.add_child(cell);
                this._pixelCells.push(cell);
            }
            this._pixel.add_child(rowBox);
        }
        this._pixelFrame = 0;
        this._setPixelStyle(this._settings.pixelStyle, false);
        this._paintPixelFrame(0);

        const row = new St.BoxLayout({style_class: 'island-compact-row'});
        this._dot = new St.Widget({style_class: 'island-dot', y_align: Clutter.ActorAlign.CENTER});
        this._dateCompact = label('', 'island-date-compact');
        this._sepCompact = label('·', 'island-sep-compact');
        this._clockCompact = label('--:--', 'island-clock-small');
        this._clockCompact.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._tempCompact = label('', 'island-mini');
        this._chargeChip = new St.BoxLayout({
            style_class: 'island-charge-chip',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._chargeIcon = new St.Icon({
            icon_name: 'battery-charging-symbolic',
            icon_size: 15,
            style_class: 'island-charge-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._chargeText = label('', 'island-charge-text');
        this._chargeChip.add_child(this._chargeText);
        this._chargeChip.add_child(this._chargeIcon);
        this._chargeChip.hide();
        this._badge = new St.Label({text: '', style_class: 'island-badge', y_align: Clutter.ActorAlign.CENTER});
        this._badge.hide();

        this._compactArt = new St.Bin({style_class: 'island-mini-art', y_align: Clutter.ActorAlign.CENTER});
        this._compactArtIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 13,
            style_class: 'island-mini-art-icon',
        });
        this._compactArt.set_child(this._compactArtIcon);
        this._compactArt.hide();

        this._eq = new St.BoxLayout({style_class: 'island-eq', y_align: Clutter.ActorAlign.CENTER});
        this._eqBars = [];
        for (let i = 0; i < 3; i++) {
            const bar = new St.Widget({
                style_class: 'island-eq-bar',
                y_align: Clutter.ActorAlign.END,
                width: 3,
                height: 6,
            });
            this._eq.add_child(bar);
            this._eqBars.push(bar);
        }
        this._eq.hide();

        row.add_child(this._pixel);
        row.add_child(this._dot);
        row.add_child(this._compactArt);
        row.add_child(this._dateCompact);
        row.add_child(this._sepCompact);
        row.add_child(this._clockCompact);
        row.add_child(new St.Widget({x_expand: true}));
        row.add_child(this._eq);
        row.add_child(this._chargeChip);
        row.add_child(this._tempCompact);
        row.add_child(this._badge);
        box.add_child(row);
        this._compact = box;
        this._startPixelAnim();
    }

    _buildPanel() {
        const box = this._shell();
        box.add_style_class_name('island-panel-body');

        // The expanded face is one wide slab, not a tall dashboard: a player
        // on the left and the active face on the right, the two halves of the
        // reference notch. The tab dock is a slim row along the bottom edge.
        const root = new St.BoxLayout({
            vertical: true,
            style_class: 'island-panel-root',
        });

        const split = new St.BoxLayout({
            style_class: 'island-panel-split',
            x_expand: true,
            y_expand: true,
        });

        this._mediaCol = new St.BoxLayout({
            vertical: true,
            style_class: 'island-media-col',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._panelDivider = new St.Widget({
            style_class: 'island-panel-divider',
            y_expand: true,
        });
        this._sideCol = new St.BoxLayout({
            vertical: true,
            style_class: 'island-side-col',
            x_expand: true,
            y_expand: true,
            width: 305,
        });

        this._views = {
            notifications: this._buildNotificationsView(),
            music: this._buildMusicView(),
            system: this._buildSystemView(),
            timer: this._buildTimerView(),
            weather: this._buildWeatherView(),
            battery: this._buildBatteryView(),
            clips: this._buildClipsView(),
            settings: this._buildSettingsView(),
        };
        this._calendar = this._buildCalendarView();
        this._lyrics = this._buildLyricsView();
        this._lyrics.visible = false;
        this._mediaCol.add_child(this._views.music);

        // The side sheet scrolls when a tab is taller than the notch (long
        // notification lists, Settings) instead of clipping its last row.
        this._scroll = new St.ScrollView({
            style_class: 'island-scroll',
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            enable_mouse_scrolling: true,
        });
        this._scroll.set_child(this._sideCol);

        this._sideCol.add_child(this._calendar);
        this._sideCol.add_child(this._lyrics);
        for (const id of ['notifications', 'system', 'battery', 'timer', 'weather', 'clips', 'settings']) {
            const view = this._views[id];
            view.visible = false;
            this._sideCol.add_child(view);
            view.connect('notify::visible', () => {
                if (view.visible && view.opacity < 255) {
                    view.ease({
                        opacity: 255,
                        duration: this._dur(190),
                        mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                    });
                }
            });
        }

        split.add_child(this._mediaCol);
        split.add_child(this._panelDivider);
        split.add_child(this._scroll);
        // Slim icon dock instead of a big clock/weather header: the card is
        // for content (music, alerts, system), and the compact capsule
        // already carries the time. Eight 16 px glyphs cost one 24 px row.
        // It rides the top edge of the notch, as in the reference.
        const tabs = new St.BoxLayout({
            style_class: 'island-tabs',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._tabButtons = {};
        for (const t of TABS) {
            const b = new St.Button({
                style_class: 'island-tab',
                reactive: true,
                can_focus: false,
                accessible_name: t.label,
            });
            b.set_child(new St.Icon({
                icon_name: t.icon,
                icon_size: 16,
                style_class: 'island-tab-icon',
            }));
            b.connect('enter-event', () => {
                this._selectTab(t.id);
                return Clutter.EVENT_PROPAGATE;
            });
            // Keep scrolls over the dock from leaking into the shell panel.
            b.connect('scroll-event', () => Clutter.EVENT_STOP);
            this._tabButtons[t.id] = b;
            tabs.add_child(b);
        }
        root.add_child(tabs);
        root.add_child(split);

        box.add_child(root);
        this._panel = box;
        this._panelRoot = root;
        this._notifView = this._views.notifications;
        this._systemView = this._views.system;
        this._weatherView = this._views.weather;
        this._musicView = this._views.music;
        this._timerView = this._views.timer;
        this._batteryView = this._views.battery;
        this._clipsView = this._views.clips;
        this._settingsView = this._views.settings;
        // An empty feed must not leave the "Recent / Clear all" toolbar on
        // screen: the first render decides that from the feed length.
        this._renderFeed();
        this._selectTab('music');
    }

    _buildAlert() {
        const box = this._shell();
        box.add_style_class_name('island-alert-body');
        const row = new St.BoxLayout({style_class: 'island-alert-row'});
        this._alertIcon = new St.Icon({icon_size: 22, y_align: Clutter.ActorAlign.CENTER});
        this._alertIcon.hide();
        const textBox = new St.BoxLayout({vertical: true, style_class: 'island-alert-text'});
        this._alertTitle = new St.Label({text: '', style_class: 'island-alert-title', width: 300, y_align: Clutter.ActorAlign.CENTER});
        this._alertTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._alertBody = new St.Label({text: '', style_class: 'island-alert-body-text', width: 300, y_align: Clutter.ActorAlign.CENTER});
        this._alertBody.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._alertTitle);
        textBox.add_child(this._alertBody);
        row.add_child(this._alertIcon);
        row.add_child(textBox);
        box.add_child(row);
        this._alert = box;
    }

    _buildNotificationsView() {
        const view = new St.BoxLayout({vertical: true, style_class: 'island-view',
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL, x_expand: true});
        // Toolbar: small caption on the left, ghost "Clear all" on the right.
        // Hidden with the empty state; shown as soon as a row exists.
        this._notifBar = new St.BoxLayout({style_class: 'island-bar', x_expand: true});
        this._notifBar.add_child(label('Recent', 'island-bar-caption'));
        this._notifBar.add_child(new St.Widget({x_expand: true}));
        const clear = new St.Button({style_class: 'island-mini-btn', reactive: true, can_focus: false});
        clear.set_child(new St.Label({text: 'Clear all', style_class: 'island-mini-label'}));
        clear.connect('clicked', () => this._clearAllNotifications());
        this._notifBar.add_child(clear);
        view.add_child(this._notifBar);
        this._notifEmpty = label('No notifications yet', 'island-empty');
        this._notifEmpty.x_align = Clutter.ActorAlign.CENTER;
        this._notifEmpty.y_align = Clutter.ActorAlign.CENTER;
        this._notifEmpty.y_expand = true;
        view.add_child(this._notifEmpty);
        this._notifList = new St.BoxLayout({vertical: true, style_class: 'island-notif-list', x_expand: true});
        view.add_child(this._notifList);
        return view;
    }


    // ---------- music view ----------

    _buildMusicView() {
        const view = new St.BoxLayout({vertical: true, style_class: 'island-view',
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL, x_expand: true});

        this._musicEmpty = new St.BoxLayout({
            vertical: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            height: 150,
            style_class: 'island-music-empty',
        });
        const emptyIcon = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 30,
            style_class: 'island-empty-icon',
            x_align: Clutter.ActorAlign.CENTER,
        });
        const emptyTitle = label('Nothing playing', 'island-empty-title');
        emptyTitle.x_align = Clutter.ActorAlign.CENTER;
        const emptySub = label('Start a track and it appears here', 'island-empty-sub');
        emptySub.x_align = Clutter.ActorAlign.CENTER;
        this._musicEmpty.add_child(emptyIcon);
        this._musicEmpty.add_child(emptyTitle);
        this._musicEmpty.add_child(emptySub);

        // Reference notch media card: big rounded cover on the left, title
        // and artist beside it, seek bar and times at the bottom of the text
        // column, transport centred under that column. The right half of the
        // panel is the lyrics pane (see _buildLyricsView).
        this._musicBody = new St.BoxLayout({vertical: true, style_class: 'island-music', x_expand: true});

        const ART = 92;
        const NAME_W = 138;
        const head = new St.BoxLayout({style_class: 'island-music-head', x_expand: true});
        this._artBin = new St.Bin({style_class: 'island-art', width: ART, height: ART,
            x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER});
        this._art = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 32, style_class: 'island-art-icon'});
        this._artBin.set_child(this._art);

        const textBox = new St.BoxLayout({vertical: true, style_class: 'island-music-text',
            x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.FILL});
        // Fixed text column: an ellipsized label still reports its full
        // natural width, which would otherwise stretch the whole capsule.
        this._musicTitle = new St.Label({text: '', style_class: 'island-music-title', width: NAME_W});
        this._musicTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._musicArtist = new St.Label({text: '', style_class: 'island-music-artist', width: NAME_W});
        this._musicArtist.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const names = new St.BoxLayout({vertical: true, style_class: 'island-music-names', x_expand: true});
        names.add_child(this._musicTitle);
        names.add_child(this._musicArtist);
        this._btnShuffle = this._controlButton('media-playlist-shuffle-symbolic',
            () => this._toggleShuffle(), 'island-ctl-plain island-ctl-mini', 14);
        this._btnShuffle.accessible_name = 'Shuffle';
        const top = new St.BoxLayout({style_class: 'island-music-top', x_expand: true});
        top.add_child(names);
        top.add_child(this._btnShuffle);
        textBox.add_child(top);

        // Bar and times sit at the bottom of the cover, like the reference.
        textBox.add_child(new St.Widget({y_expand: true}));
        this._seek = new St.Bin({style_class: 'island-music-seek',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER, reactive: true});
        this._musicTrack = new St.Widget({style_class: 'island-music-track',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._musicFill = new St.Widget({style_class: 'island-music-fill', width: 0});
        this._musicTrack.add_child(this._musicFill);
        this._seek.add_child(this._musicTrack);
        this._seek.connect('button-press-event', (a, ev) => this._seekEvent(ev, false));
        this._seek.connect('motion-event', (a, ev) => {
            if (this._seeking)
                return this._seekEvent(ev, false);
            return Clutter.EVENT_PROPAGATE;
        });
        this._seek.connect('button-release-event', (a, ev) => this._seekEvent(ev, true));
        this._musicElapsed = label('0:00', 'island-music-time');
        this._musicRemaining = label('0:00', 'island-music-time');
        this._musicRemaining.x_align = Clutter.ActorAlign.END;
        const times = new St.BoxLayout({style_class: 'island-music-times', x_expand: true});
        times.add_child(this._musicElapsed);
        times.add_child(new St.Widget({x_expand: true}));
        times.add_child(this._musicRemaining);
        const progBox = new St.BoxLayout({vertical: true, style_class: 'island-music-prog', x_expand: true});
        progBox.add_child(this._seek);
        progBox.add_child(times);
        textBox.add_child(progBox);
        this._musicProg = progBox;

        head.add_child(this._artBin);
        head.add_child(textBox);
        this._musicBody.add_child(head);

        // Transport is centred under the text column, not the whole card:
        // that is where the eye lands in the reference.
        const controls = new St.BoxLayout({style_class: 'island-controls', x_expand: true});
        const indent = new St.Widget({width: ART, y_expand: true});
        const ctl = new St.BoxLayout({style_class: 'island-controls-box', x_expand: true});
        this._btnPrev = this._controlButton('media-skip-backward-symbolic', () => this._musicCall('Previous'), 'island-ctl-plain', 20);
        this._btnPlay = this._controlButton('media-playback-start-symbolic', () => this._musicCall('PlayPause'), 'island-ctl-play', 26);
        this._btnNext = this._controlButton('media-skip-forward-symbolic', () => this._musicCall('Next'), 'island-ctl-plain', 20);
        ctl.add_child(new St.Widget({x_expand: true}));
        ctl.add_child(this._btnPrev);
        ctl.add_child(this._btnPlay);
        ctl.add_child(this._btnNext);
        ctl.add_child(new St.Widget({x_expand: true}));
        controls.add_child(indent);
        controls.add_child(ctl);
        this._musicBody.add_child(controls);

        view.add_child(this._musicEmpty);
        view.add_child(this._musicBody);

        this._lyricsCache = new Map();
        this._lyricsToken = 0;
        this._lyricsKey = null;
        this._lyricsData = null;
        this._lyricIndex = -2;
        this._musicPos = 0;
        return view;
    }

    // The right half of the music face: five lyric lines with the current
    // one lit. Fetched from LRCLIB when the face is open; no network call is
    // made for a track that is not on screen.
    _buildLyricsView() {
        const view = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'island-lyrics',
            x_expand: true,
            y_expand: true,
        });
        const lines = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});
        lines.add_child(new St.Widget({y_expand: true}));
        this._lyricRows = [];
        for (let i = 0; i < 5; i++) {
            const row = new St.Label({
                text: '',
                width: 285,
                height: 27,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'island-lyric',
            });
            row.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.clutter_text.line_wrap = false;
            row.opacity = 0;
            lines.add_child(row);
            this._lyricRows.push(row);
        }
        lines.add_child(new St.Widget({y_expand: true}));
        view.add_child(lines);
        this._lyricsMsg = new St.Label({
            text: '',
            style_class: 'island-lyrics-msg',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._lyricsMsg.visible = false;
        view.add_child(this._lyricsMsg);
        return view;
    }

    // The right half of the reference notch: current month, a three-day
    // strip with today highlighted, and the full date. There is no calendar
    // backend in the extension, so it states the date rather than inventing
    // events.
    _buildCalendarView() {
        const view = new St.BoxLayout({vertical: true, style_class: 'island-calendar',
            x_align: Clutter.ActorAlign.FILL, x_expand: true});

        this._calMonth = label('', 'island-cal-month');
        this._calDays = new St.BoxLayout({style_class: 'island-cal-days', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        const calTop = new St.BoxLayout({style_class: 'island-cal-top', x_expand: true});
        calTop.add_child(this._calMonth);
        calTop.add_child(this._calDays);
        view.add_child(calTop);

        this._calCells = [];
        for (let i = 0; i < 3; i++) {
            const cell = new St.BoxLayout({vertical: true, style_class: 'island-cal-cell', x_expand: true});
            const num = label('', 'island-cal-num');
            const dow = label('', 'island-cal-dow');
            num.x_align = Clutter.ActorAlign.CENTER;
            dow.x_align = Clutter.ActorAlign.CENTER;
            cell.add_child(num);
            cell.add_child(dow);
            this._calDays.add_child(cell);
            this._calCells.push({cell, num, dow});
        }

        view.add_child(new St.Widget({style_class: 'island-cal-divider', x_expand: true}));
        this._calToday = label('', 'island-cal-today');
        view.add_child(this._calToday);

        this._refreshCalendar();
        return view;
    }

    _refreshCalendar() {
        if (!this._calCells)
            return;
        const now = GLib.DateTime.new_now_local();
        // Month and strip only change at midnight; skip the relayout until
        // the day actually rolls over.
        const key = now.format('%Y-%m-%d');
        if (this._calDay === key)
            return;
        this._calDay = key;
        this._calMonth.text = now.format('%B');
        for (let i = 0; i < this._calCells.length; i++) {
            const d = now.add_days(i - 1);
            const c = this._calCells[i];
            c.num.text = d.format('%d');
            c.dow.text = d.format('%a');
            if (i === 1)
                c.cell.add_style_class_name('island-cal-cell-today');
            else
                c.cell.remove_style_class_name('island-cal-cell-today');
        }
        this._calToday.text = now.format('%A, %d %B');
    }

    _controlButton(iconName, onClick, extraClass, iconSize = 22) {
        const btn = new St.Button({style_class: `island-ctl ${extraClass ?? ''}`, reactive: true, can_focus: false});
        const icon = new St.Icon({icon_name: iconName, icon_size: iconSize, style_class: 'island-ctl-icon'});
        btn.set_child(icon);
        btn.connect('clicked', () => onClick());
        btn._icon = icon;
        return btn;
    }

    // ---------- timer view ----------

    _buildTimerView() {
        const view = new St.BoxLayout({vertical: true, style_class: 'island-view',
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL, x_expand: true});

        const presets = new St.BoxLayout({style_class: 'island-presets', x_align: Clutter.ActorAlign.CENTER});
        this._presetButtons = {};
        for (const m of [1, 5, 10, 25]) {
            const b = new St.Button({style_class: 'island-chip', reactive: true, can_focus: false});
            b.set_child(new St.Label({text: `${m} min`, style_class: 'island-chip-label'}));
            b.connect('clicked', () => this._setPreset(m));
            this._presetButtons[m] = b;
            presets.add_child(b);
        }
        view.add_child(presets);

        this._timerBig = new St.Label({text: '25:00', style_class: 'island-timer-big',
            x_align: Clutter.ActorAlign.CENTER});
        view.add_child(this._timerBig);

        this._timerTrack = new St.Widget({style_class: 'island-track island-timer-track',
            x_align: Clutter.ActorAlign.FILL});
        this._timerTrack.set_width(576);
        this._timerFill = new St.Widget({style_class: 'island-fill', width: 0});
        this._timerTrack.add_child(this._timerFill);
        view.add_child(this._timerTrack);

        const row = new St.BoxLayout({style_class: 'island-timer-actions', x_align: Clutter.ActorAlign.CENTER});
        this._timerToggle = new St.Button({style_class: 'island-pill-btn island-pill-primary', reactive: true, can_focus: false});
        this._timerToggleLabel = new St.Label({text: 'Start', style_class: 'island-pill-label'});
        this._timerToggle.set_child(this._timerToggleLabel);
        this._timerToggle.connect('clicked', () => this._timerAction());
        const reset = new St.Button({style_class: 'island-pill-btn', reactive: true, can_focus: false});
        reset.set_child(new St.Label({text: 'Reset', style_class: 'island-pill-label'}));
        reset.connect('clicked', () => this._resetTimer());
        row.add_child(this._timerToggle);
        row.add_child(reset);
        view.add_child(row);

        this._timerState = label('', 'island-sub');
        this._timerState.x_align = Clutter.ActorAlign.CENTER;
        view.add_child(this._timerState);
        return view;
    }

    // ---------- settings view ----------

    _buildSettingsView() {
        const view = new St.BoxLayout({vertical: true, style_class: 'island-view',
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL, x_expand: true});
        // Toggles sit in two columns; the accent and animation rows below
        // them use the full width. Keeps the sheet short enough to fit.
        this._settingsCols = new St.BoxLayout({style_class: 'island-settings-cols', x_expand: true});
        this._settingsCols.add_child(new St.BoxLayout({vertical: true, style_class: 'island-settings', x_expand: true}));
        this._settingsCols.add_child(new St.BoxLayout({vertical: true, style_class: 'island-settings', x_expand: true}));
        view.add_child(this._settingsCols);
        this._settingsFoot = new St.BoxLayout({vertical: true, style_class: 'island-settings', x_expand: true});
        view.add_child(this._settingsFoot);
        return view;
    }

    _makeToggle(key) {
        const btn = new St.Button({style_class: 'island-switch', reactive: true, can_focus: false});
        const knob = new St.Widget({style_class: 'island-knob', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        btn.set_child(knob);
        btn._knob = knob;
        btn._key = key;
        btn.connect('clicked', () => {
            this._setSetting(key, !this._settings[key]);
            this._animateToggle(btn);
        });
        return btn;
    }

    _animateToggle(btn) {
        const on = !!this._settings[btn._key];
        if (on)
            btn.add_style_class_name('island-switch-on');
        else
            btn.remove_style_class_name('island-switch-on');
        btn._knob.translation_x = on ? 8 : -8;
    }

    _renderSettings() {
        for (const box of this._settingsCols.get_children()) {
            for (const c of box.get_children())
                c.destroy();
        }
        for (const c of this._settingsFoot.get_children())
            c.destroy();
        this._settingsToggles = {};
        let toggleIndex = 0;

        const addToggle = (key, title, sub) => {
            const row = new St.BoxLayout({style_class: 'island-setting'});
            const texts = new St.BoxLayout({vertical: true, x_expand: true});
            texts.add_child(label(title, 'island-setting-title'));
            if (sub)
                texts.add_child(label(sub, 'island-setting-sub'));
            const btn = this._makeToggle(key);
            row.add_child(texts);
            row.add_child(btn);
            const col = this._settingsCols.get_child_at_index(toggleIndex++ % 2);
            col.add_child(row);
            const on = !!this._settings[key];
            if (on)
                btn.add_style_class_name('island-switch-on');
            btn._knob.translation_x = on ? 8 : -8;
            this._settingsToggles[key] = btn;
            return row;
        };

        addToggle('clock24', '24-hour clock', '14:05, not 2:05 PM');
        addToggle('showWeather', 'Weather', 'Temperature in the bar');
        addToggle('showBattery', 'Battery', 'Charge in the top bar');
        addToggle('wallpaperBackground', 'Wallpaper background', 'Show a desktop or custom wallpaper');
        addToggle('batteryTab', 'Battery tab', 'Health and cycles');
        addToggle('showMusic', 'Now playing', 'Track in the capsule');
        addToggle('liveBattery', 'Battery activity', 'Charge alerts');
        addToggle('liveDevices', 'Device activity', 'Bluetooth alerts');
        addToggle('saveClips', 'Clipboard history', 'Saved on disk');

        // accent
        const accentRow = new St.BoxLayout({style_class: 'island-setting'});
        accentRow.add_child(label('Accent', 'island-setting-title'));
        accentRow.add_child(new St.Widget({x_expand: true}));
        const swatches = new St.BoxLayout({style_class: 'island-swatches'});
        for (const a of ACCENTS) {
            const b = new St.Button({style_class: `island-swatch swatch-${a}`, reactive: true, can_focus: false});
            if (this._settings.accent === a)
                b.add_style_class_name('island-swatch-active');
            b.connect('clicked', () => this._setSetting('accent', a));
            swatches.add_child(b);
        }
        accentRow.add_child(swatches);
        this._settingsFoot.add_child(accentRow);

        const chipsRow = (title, key, options) => {
            const row = new St.BoxLayout({style_class: 'island-setting'});
            row.add_child(label(title, 'island-setting-title'));
            row.add_child(new St.Widget({x_expand: true}));
            const box = new St.BoxLayout({style_class: 'island-presets'});
            for (const [value, text] of options) {
                const b = new St.Button({style_class: 'island-chip', reactive: true, can_focus: false});
                if (this._settings[key] === value)
                    b.add_style_class_name('island-chip-active');
                b.set_child(new St.Label({text, style_class: 'island-chip-label'}));
                b.connect('clicked', () => this._setSetting(key, value));
                box.add_child(b);
            }
            row.add_child(box);
            this._settingsFoot.add_child(row);
        };

        const wallpaperRow = new St.BoxLayout({style_class: 'island-setting', x_expand: true});
        const wallpaperText = new St.BoxLayout({vertical: true, x_expand: true});
        wallpaperText.add_child(label('Wallpaper image', 'island-setting-title'));
        let wallpaperName = 'Current desktop wallpaper';
        try {
            if (this._settings.wallpaperUri)
                wallpaperName = Gio.File.new_for_uri(this._settings.wallpaperUri).get_basename() || 'Custom image';
        } catch (e) {
            wallpaperName = 'Custom image';
        }
        const wallpaperNameLabel = label(wallpaperName, 'island-setting-sub');
        wallpaperNameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        wallpaperNameLabel.set_width(360);
        wallpaperText.add_child(wallpaperNameLabel);
        wallpaperRow.add_child(wallpaperText);
        const chooseWallpaper = new St.Button({style_class: 'island-chip', reactive: true, can_focus: false});
        chooseWallpaper.set_child(new St.Label({text: 'Choose…', style_class: 'island-chip-label'}));
        chooseWallpaper.connect('clicked', () => this._chooseWallpaper());
        wallpaperRow.add_child(chooseWallpaper);
        const desktopWallpaper = new St.Button({style_class: 'island-chip', reactive: true, can_focus: false});
        desktopWallpaper.set_child(new St.Label({text: 'Desktop', style_class: 'island-chip-label'}));
        desktopWallpaper.connect('clicked', () => this._setWallpaper('', true));
        wallpaperRow.add_child(desktopWallpaper);
        const wallpaperOff = new St.Button({
            style_class: `island-chip${this._settings.wallpaperBackground ? '' : ' island-chip-active'}`,
            reactive: true,
            can_focus: false,
        });
        wallpaperOff.set_child(new St.Label({text: 'Off', style_class: 'island-chip-label'}));
        wallpaperOff.connect('clicked', () => this._setWallpaper(this._settings.wallpaperUri, false));
        wallpaperRow.add_child(wallpaperOff);
        this._settingsFoot.add_child(wallpaperRow);

        chipsRow('Animation', 'speed', [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']]);
        chipsRow('Pixel art', 'pixelStyle', [
            ['spark', 'Spark'], ['anime', 'Anime'], ['car', 'Car'], ['cyberpunk', 'Cyberpunk'],
        ]);
        chipsRow('Wallpaper blur', 'wallpaperBlur', [
            [0, 'Off'], [6, 'Low'], [12, 'Medium'], [20, 'Strong'],
        ]);
        chipsRow('Auto-close', 'collapseMs', [[800, '0.8s'], [420, '0.4s'], [0, 'Off']]);
    }

    // ---------- music engine ----------

    _setupMpris() {
        this._players = new Map();
        this._dbus = Gio.DBus.session;
        this._artCache = new Map();
        this._artPending = new Map();
        this._nameSub = this._dbus.signal_subscribe(
            'org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
            '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            () => this._scanPlayers());
        this._scanPlayers();
    }

    _scanPlayers() {
        if (!this._dbus)
            return;
        this._dbus.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
            'org.freedesktop.DBus', 'ListNames', null, null,
            Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                let names = [];
                try {
                    names = conn.call_finish(res).recursiveUnpack()[0] ?? [];
                } catch (e) {
                    return;
                }
                const live = names.filter(n => n.startsWith('org.mpris.MediaPlayer2.') && n.includes('.'));
                for (const n of live) {
                    if (!this._players.has(n))
                        this._addPlayer(n);
                }
                for (const n of [...this._players.keys()]) {
                    if (!live.includes(n))
                        this._removePlayer(n);
                }
            });
    }

    _addPlayer(name) {
        const proxy = new Gio.DBusProxy({
            g_connection: this._dbus,
            g_name: name,
            g_object_path: '/org/mpris/MediaPlayer2',
            g_interface_name: 'org.mpris.MediaPlayer2.Player',
            g_interface_info: mprisInterface(),
        });
        proxy.init_async(GLib.PRIORITY_DEFAULT, null, (p, res) => {
            try {
                p.init_finish(res);
            } catch (e) {
                return;
            }
            if (!this._capsule)
                return;
            const player = {name, proxy: p};
            this._players.set(name, player);
            p.connect('g-properties-changed', () => this._onPlayerChanged());
            p.connect('g-signal', () => this._onPlayerChanged());
            this._refreshMusic();
        });
    }

    _removePlayer(name) {
        this._players?.delete(name);
        this._refreshMusic();
    }

    _onPlayerChanged() {
        this._refreshMusic();
    }

    _activePlayer() {
        if (!this._players || this._players.size === 0)
            return null;
        const all = [...this._players.values()];
        const playing = all.find(p => this._status(p) === 'Playing');
        if (playing)
            return playing;
        // A pause is still "something on screen" - but only while the player
        // actually holds a track. Browsers keep their MPRIS name and last
        // metadata after the tab is closed and report Stopped, which used to
        // leave the island stuck in music mode forever.
        const paused = all.find(p => this._status(p) === 'Paused' && this._hasTrack(p));
        return paused ?? null;
    }

    _hasTrack(player) {
        const meta = this._metadata(player);
        return !!(meta['xesam:title'] || meta['mpris:artUrl'] || meta['xesam:artist']);
    }

    _status(player) {
        try {
            return player.proxy.get_cached_property('PlaybackStatus')?.unpack() ?? 'Stopped';
        } catch (e) {
            return 'Stopped';
        }
    }

    _metadata(player) {
        try {
            const v = player.proxy.get_cached_property('Metadata');
            if (!v)
                return {};
            // a{sv}: deepUnpack() leaves every value as a GVariant, which is
            // what printed "[object variant of type "s"]". recursiveUnpack()
            // turns nested variants into plain strings/arrays/numbers.
            const raw = v.recursiveUnpack ? v.recursiveUnpack() : v.deepUnpack();
            const out = {};
            for (const [key, val] of Object.entries(raw ?? {}))
                out[key] = val instanceof GLib.Variant ? val.recursiveUnpack() : val;
            return out;
        } catch (e) {
            return {};
        }
    }

    _musicCall(method) {
        const player = this._activePlayer();
        if (!player)
            return;
        player.proxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null, (p, res) => {
            try {
                p.call_finish(res);
            } catch (e) {
                LOG(`music ${method} failed`, e.message);
            }
        });
    }

    // Click or drag the progress bar to seek: drag updates the bar locally,
    // release sends one MPRIS SetPosition for the final point.
    _seekEvent(event, commit) {
        if (!this._musicLength || !this._seek)
            return Clutter.EVENT_PROPAGATE;
        const [sx] = this._seek.get_transformed_position();
        const w = this._seek.width;
        if (w <= 0)
            return Clutter.EVENT_PROPAGATE;
        const frac = Math.max(0, Math.min(1, (event.get_coords()[0] - sx) / w));
        const player = this._activePlayer();
        if (commit) {
            this._seeking = false;
            if (!player)
                return Clutter.EVENT_PROPAGATE;
            let trackId = '/org/mpris/MediaPlayer2/TrackList/NoTrack';
            try {
                const meta = this._metadata(player);
                trackId = `${meta['mpris:trackid'] ?? trackId}`;
            } catch (e) {}
            const pos = Math.round(frac * this._musicLength * 1e6);
            this._seekPending = {until: GLib.get_monotonic_time() / 1000 + 1500,
                pos: frac * this._musicLength};
            player.proxy.call('SetPosition',
                new GLib.Variant('(ox)', [trackId, pos]),
                Gio.DBusCallFlags.NONE, -1, null, (p, res) => {
                    try {
                        p.call_finish(res);
                    } catch (e) {
                        LOG('seek failed', e.message);
                    }
                });
            this._refreshMusic(true);
            return Clutter.EVENT_STOP;
        }
        this._seeking = true;
        const w2 = Math.round(this._trackWidth() * frac);
        this._musicFill.width = w2;
        this._musicPos = frac * this._musicLength;
        this._musicElapsed.text = fmtDuration(this._musicPos);
        this._musicRemaining.text = fmtDuration(this._musicLength);
        this._updateLyrics(this._musicPos);
        return Clutter.EVENT_STOP;
    }

    _setArtwork(icon, path) {
        const uri = path ? GLib.filename_to_uri(path, null) : null;
        const paint = (actor, fallback) => {
            if (!actor)
                return;
            if (uri) {
                actor.style = `background-image: url("${uri}"); background-size: cover; background-position: center;`;
                if (fallback)
                    fallback.hide();
            } else {
                actor.style = null;
                if (fallback)
                    fallback.show();
            }
        };
        paint(this._artBin, this._art);
        paint(this._compactArt, this._compactArtIcon);
        if (this._art && !uri) {
            this._art.gicon = null;
            this._art.icon_name = 'audio-x-generic-symbolic';
        }
    }

    _loadArt(url, cb) {
        if (!url)
            return cb(null, null);
        if (this._artCache.has(url)) {
            const hit = this._artCache.get(url);
            return cb(hit.icon, hit.path);
        }
        const finish = (icon, path) => {
            if (icon)
                this._artCache.set(url, {icon, path});
            const waiting = this._artPending.get(url) ?? [cb];
            this._artPending.delete(url);
            for (const fn of waiting)
                fn(icon, path);
        };
        if (url.startsWith('file://')) {
            try {
                const file = Gio.File.new_for_uri(url);
                return finish(Gio.FileIcon.new(file), file.get_path());
            } catch (e) {
                return finish(null, null);
            }
        }
        if (!url.startsWith('http'))
            return finish(null, null);
        if (this._artPending.has(url)) {
            this._artPending.get(url).push(cb);
            return;
        }
        this._artPending.set(url, [cb]);
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1);
        const path = GLib.build_filenamev([GLib.get_tmp_dir(), `island-art-${hash}`]);
        try {
            const msg = Soup.Message.new('GET', url);
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    const file = Gio.File.new_for_path(path);
                    file.replace_contents(bytes.get_data(), null, false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                    finish(Gio.FileIcon.new(file), path);
                } catch (e) {
                    finish(null, null);
                }
            });
        } catch (e) {
            finish(null, null);
        }
    }

    _refreshMusic(force = false) {
        if (!this._musicBody || this._destroyed)
            return;
        const player = this._activePlayer();
        const has = !!player;

        this._musicBody.visible = has;
        this._musicEmpty.visible = !has;
        this._syncMusicRight();

        if (!has) {
            this._lyricsKey = null;
            this._lyricsData = null;
            this._clearLyrics();
            this._refreshCompactBits();
            if (this._mode === 'panel' && this._tab === 'music')
                this._fitPanel();
            return;
        }

        const meta = this._metadata(player) ?? {};
        const title = `${meta['xesam:title'] ?? ''}`.trim();
        const artistRaw = meta['xesam:artist'] ?? meta['xesam:albumArtist'] ?? [];
        const artist = Array.isArray(artistRaw) ? artistRaw.join(', ') : `${artistRaw}`;
        const album = `${meta['xesam:album'] ?? ''}`;
        const length = Number(meta['mpris:length'] ?? 0) / 1e6;

        this._musicTitle.text = title || 'Unknown track';
        this._musicArtist.text = artist || '';

        const playing = this._status(player) === 'Playing';
        this._btnPlay._icon.icon_name = playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        let shuffle = false;
        try {
            shuffle = !!player.proxy.get_cached_property('Shuffle')?.unpack();
        } catch (e) {}
        if (this._btnShuffle) {
            if (shuffle)
                this._btnShuffle.add_style_class_name('island-ctl-active');
            else
                this._btnShuffle.remove_style_class_name('island-ctl-active');
        }

        const artUrl = `${meta['mpris:artUrl'] ?? ''}`;
        if (artUrl && artUrl !== this._currentArtUrl) {
            this._currentArtUrl = artUrl;
            this._loadArt(artUrl, (icon, path) => this._setArtwork(icon, path));
        } else if (!artUrl) {
            this._currentArtUrl = null;
            this._setArtwork(null, null);
        }

        this._musicLength = length;
        if (this._mode === 'panel' && this._tab === 'music')
            this._ensureLyrics(title, artist, album, length);
        this._refreshProgress(player, length, force);
        this._refreshCompactBits();
        if (this._mode === 'panel' && this._tab === 'music')
            this._fitPanel();
    }

    // Return the allocated pixel width of the seek track, falling back to
    // a reasonable default when the actor is not yet laid out.
    _trackWidth() {
        try {
            const alloc = this._musicTrack?.get_allocation_box?.();
            if (alloc) {
                const w = alloc.get_width();
                if (w > 10) return w;
            }
        } catch (_) {}
        const w = this._musicTrack?.width ?? 0;
        return w > 10 ? w : 138; // 138 = NAME_W from _buildMusicView
    }

    _refreshProgress(player, length, force) {
        let position = 0;
        try {
            position = Number(player.proxy.get_cached_property('Position')?.unpack() ?? 0) / 1e6;
        } catch (e) {
            position = 0;
        }
        // Browser players often report no length and a frozen position; a
        // progress bar stuck at -0:00 looks broken, so hide the row instead.
        const known = length > 0;
        if (!known) {
            // Players that report no duration (browsers, streams) still get
            // a bar: an indeterminate sweep plus the elapsed time. The times
            // row shows elapsed on the left and "--:--" on the right, and
            // seeking stays disabled.
            this._musicProg.visible = true;
            this._musicElapsed.text = fmtDuration(position);
            this._musicRemaining.text = '--:--';
            this._musicPos = position;
            this._updateLyrics(position);
            this._startMarquee();
            return;
        }
        this._stopMarquee();
        this._musicProg.visible = true;
        // A seek we just sent has not reached the player's Position cache yet;
        // keep showing where the user dropped the bar until it catches up.
        if (this._seekPending && GLib.get_monotonic_time() / 1000 < this._seekPending.until)
            position = this._seekPending.pos;
        else
            this._seekPending = null;
        const fraction = length > 0 ? Math.max(0, Math.min(1, position / length)) : 0;
        const trackW = this._trackWidth();
        const width = Math.round(trackW * fraction);
        this._musicElapsed.text = fmtDuration(position);
        this._musicRemaining.text = fmtDuration(length);
        this._musicPos = position;
        this._updateLyrics(position);
        if (!force && this._musicFill.width === width)
            return;
        if (force) {
            this._musicFill.width = width;
            return;
        }
        this._musicFill.ease({
            width,
            duration: this._dur(180),
            mode: Clutter.AnimationMode.LINEAR,
        });
    }

    _setPixelStyle(style, repaint = true) {
        const key = PIXEL_STYLES[style] ? style : 'spark';
        this._settings.pixelStyle = key;
        if (this._pixelStyle)
            this._pixel.remove_style_class_name(`island-pixel-theme-${this._pixelStyle}`);
        this._pixelStyle = key;
        this._pixel.add_style_class_name(`island-pixel-theme-${key}`);
        this._pixelFrames = PIXEL_STYLES[key].map(frame =>
            frame.join('').split('').map(cell => cell === '#' ? 2 : cell === 'x' ? 1 : 0));
        this._pixelFrame = 0;
        if (repaint)
            this._paintPixelFrame(0);
    }

    // Pixel art is stepped, not eased: cells only switch on/off between frames.
    _paintPixelFrame(idx) {
        const frame = this._pixelFrames[idx % this._pixelFrames.length];
        for (let i = 0; i < frame.length; i++) {
            const cell = this._pixelCells[i];
            if (!cell)
                continue;
            cell.remove_style_class_name('island-pixel-on');
            cell.remove_style_class_name('island-pixel-core');
            if (frame[i] === 1)
                cell.add_style_class_name('island-pixel-on');
            else if (frame[i] === 2)
                cell.add_style_class_name('island-pixel-core');
        }
    }

    _startPixelAnim() {
        if (this._pixelTimer)
            return;
        this._pixelTimer = this._addTimer(440, () => {
            this._pixelFrame = (this._pixelFrame + 1) % this._pixelFrames.length;
            this._paintPixelFrame(this._pixelFrame);
        });
    }

    _stopPixelAnim() {
        if (this._pixelTimer)
            this._removeTimer(this._pixelTimer);
        this._pixelTimer = 0;
    }

    // Indeterminate bar for players with no reported duration: a soft ping-pong
    // sweep of the fill, ~1.1 s per sweep. Stopped as soon as a known length
    // arrives, the tab leaves music, or the island is destroyed.
    _startMarquee() {
        if (this._marqueeTimer || !this._musicFill)
            return;
        this._marqueeDir = !this._marqueeDir;
        const step = () => {
            this._marqueeDir = !this._marqueeDir;
            const trackW = this._trackWidth();
            this._musicFill.ease({
                width: this._marqueeDir ? Math.round(trackW * 0.42) : 0,
                duration: this._dur(1050),
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            });
            return GLib.SOURCE_CONTINUE;
        };
        this._marqueeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1100, step);
        step();
    }

    _stopMarquee() {
        if (this._marqueeTimer) {
            GLib.source_remove(this._marqueeTimer);
            this._marqueeTimer = 0;
        }
    }

    _pollMusic() {
        const player = this._activePlayer();
        if (!player)
            return;
        this._dbus.call(player.name, '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
            null, Gio.DBusCallFlags.NONE, 400, null, (conn, res) => {
                try {
                    const [pos] = conn.call_finish(res).recursiveUnpack();
                    const length = Number(this._metadata(player)['mpris:length'] ?? 0) / 1e6;
                    if (length > 0) {
                        let seconds = Number(pos) / 1e6;
                        if (this._seekPending && GLib.get_monotonic_time() / 1000 < this._seekPending.until)
                            seconds = this._seekPending.pos;
                        else
                            this._seekPending = null;
                        const trackW = this._trackWidth();
                        const width = Math.round(trackW * Math.max(0, Math.min(1, seconds / length)));
                        this._musicElapsed.text = fmtDuration(seconds);
                        this._musicRemaining.text = fmtDuration(length);
                        this._musicPos = seconds;
                        this._updateLyrics(seconds);
                        this._musicFill.ease({
                            width,
                            // Position is sampled once a second. A near-second
                            // ease visibly trails the player; use a short glide
                            // so the bar lands on the MPRIS-reported position.
                            duration: this._dur(120),
                            mode: Clutter.AnimationMode.LINEAR,
                        });
                    }
                } catch (e) {}
            });
    }

    // ---------- lyrics ----------

    _ensureLyrics(title, artist, album, length) {
        if (!this._lyrics)
            return;
        const key = `${title}|${artist}|${album}|${Math.round(length)}`.toLowerCase();
        if (this._lyricsKey === key)
            return;
        this._lyricsKey = key;
        this._lyricsData = null;
        this._lyricIndex = -2;
        this._lyricsToken++;
        this._clearLyrics();

        if (!title) {
            this._showLyricsMessage('No track');
            return;
        }

        const cached = this._lyricsCache.get(key);
        if (cached) {
            this._applyLyrics(cached);
            return;
        }

        this._showLyricsMessage('Finding lyrics…');
        const token = this._lyricsToken;
        const enc = encodeURIComponent;
        let url = `https://lrclib.net/api/get?track_name=${enc(title)}`;
        if (artist)
            url += `&artist_name=${enc(artist)}`;
        if (album)
            url += `&album_name=${enc(album)}`;
        if (length > 0)
            url += `&duration=${Math.round(length)}`;

        this._fetchJson(url, data => {
            if (this._destroyed || token !== this._lyricsToken)
                return;
            if (data && (data.syncedLyrics || data.plainLyrics)) {
                this._applyLyrics(data);
                return;
            }
            // The exact lookup is strict about album/duration; the search
            // endpoint still finds live versions and re-releases.
            let search = `https://lrclib.net/api/search?track_name=${enc(title)}`;
            if (artist)
                search += `&artist_name=${enc(artist)}`;
            this._fetchJson(search, items => {
                if (this._destroyed || token !== this._lyricsToken)
                    return;
                const usable = (Array.isArray(items) ? items : [])
                    .filter(x => x && (x.syncedLyrics || x.plainLyrics));
                if (!usable.length) {
                    this._showLyricsMessage('No lyrics for this track');
                    return;
                }
                const secs = Math.round(length);
                usable.sort((a, b) => {
                    const da = secs ? Math.abs((a.duration ?? 0) - secs) : 0;
                    const db = secs ? Math.abs((b.duration ?? 0) - secs) : 0;
                    return da - db;
                });
                this._applyLyrics(usable[0]);
            });
        });
    }

    _fetchJson(url, cb) {
        let msg;
        try {
            msg = Soup.Message.new('GET', url);
        } catch (e) {
            return cb(null);
        }
        msg.request_headers.append('Accept', 'application/json');
        this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
            try {
                const bytes = session.send_and_read_finish(res);
                if (msg.status_code !== 200)
                    return cb(null);
                cb(JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data())));
            } catch (e) {
                cb(null);
            }
        });
    }

    _applyLyrics(payload) {
        if (!payload || !this._lyricsKey)
            return;
        this._lyricsCache.set(this._lyricsKey, payload);

        if (payload.instrumental) {
            this._showLyricsMessage('Instrumental');
            return;
        }
        const synced = this._parseLrc(`${payload.syncedLyrics ?? ''}`);
        const plain = `${payload.plainLyrics ?? ''}`
            .split('\n').map(s => s.trim()).filter(Boolean);
        let data;
        if (synced.length) {
            data = {lines: synced, synced: true};
        } else if (plain.length) {
            // No timings: show the opening lines rather than inventing a
            // position for them.
            data = {lines: plain.slice(0, 60).map((text, i) => ({t: i, text})), synced: false};
        } else {
            this._showLyricsMessage('No lyrics for this track');
            return;
        }

        this._lyricsData = data;
        this._lyricIndex = -2;
        this._lyricsMsg.visible = false;
        for (const row of this._lyricRows)
            row.visible = true;
        if (data.synced)
            this._updateLyrics(this._musicPos ?? 0);
        else {
            this._renderLyrics(0);
            this._lyricIndex = -2;
        }
    }

    /**
     * LRC: "[mm:ss.xx] line", several stamps per line for repeats. Metadata
     * tags such as [ar:] do not match the stamp regex and are ignored.
     */
    _parseLrc(text) {
        const out = [];
        for (const raw of text.split('\n')) {
            const stamps = [...raw.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
            if (!stamps.length)
                continue;
            const lyric = raw.replace(/\[[^\]]*\]/g, '').trim();
            if (!lyric)
                continue;
            for (const m of stamps) {
                const frac = m[3] ? Number(`0.${m[3]}`) : 0;
                out.push({t: Number(m[1]) * 60 + Number(m[2]) + frac, text: lyric});
            }
        }
        out.sort((a, b) => a.t - b.t);
        return out;
    }

    _updateLyrics(position) {
        const data = this._lyricsData;
        if (!data || !data.synced || !data.lines?.length)
            return;
        let idx = -1;
        for (let i = 0; i < data.lines.length; i++) {
            if (data.lines[i].t <= position + 0.2)
                idx = i;
            else
                break;
        }
        if (idx === this._lyricIndex)
            return;
        this._lyricIndex = idx;
        this._renderLyrics(idx);
    }

    _renderLyrics(idx) {
        if (!this._lyricRows || !this._lyricsData)
            return;
        const data = this._lyricsData;
        const start = data.synced && idx >= 0 ? Math.max(0, idx - 2) : 0;
        for (let i = 0; i < this._lyricRows.length; i++) {
            const row = this._lyricRows[i];
            const line = data.lines[start + i];
            if (!line) {
                row.text = '';
                row.opacity = 0;
                continue;
            }
            const changed = row.text !== line.text;
            row.text = line.text;
            for (const cls of ['island-lyric-focus', 'island-lyric-near', 'island-lyric-far'])
                row.remove_style_class_name(cls);
            if (data.synced) {
                const d = Math.abs((start + i) - idx);
                row.add_style_class_name(d === 0 ? 'island-lyric-focus'
                    : d === 1 ? 'island-lyric-near' : 'island-lyric-far');
            } else {
                row.add_style_class_name('island-lyric-near');
            }
            if (changed) {
                row.opacity = 0;
                row.ease({
                    opacity: 255,
                    duration: this._dur(240),
                    mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                });
            } else {
                row.opacity = 255;
            }
        }
    }

    _showLyricsMessage(text) {
        if (!this._lyricsMsg)
            return;
        for (const row of this._lyricRows) {
            row.text = '';
            row.opacity = 0;
        }
        this._lyricsMsg.text = text;
        this._lyricsMsg.visible = true;
        this._lyricsMsg.opacity = 0;
        this._lyricsMsg.ease({
            opacity: 255,
            duration: this._dur(220),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _clearLyrics() {
        if (!this._lyricRows)
            return;
        for (const row of this._lyricRows) {
            row.text = '';
            row.opacity = 0;
        }
        if (this._lyricsMsg)
            this._lyricsMsg.visible = false;
    }

    _toggleShuffle() {
        const player = this._activePlayer();
        if (!player)
            return;
        let current = false;
        try {
            current = !!player.proxy.get_cached_property('Shuffle')?.unpack();
        } catch (e) {}
        const next = !current;
        this._dbus.call(player.name, '/org/mpris/MediaPlayer2',
            'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', ['org.mpris.MediaPlayer2.Player', 'Shuffle',
                new GLib.Variant('b', next)]),
            null, Gio.DBusCallFlags.NONE, 1500, null, (conn, res) => {
                try {
                    conn.call_finish(res);
                    if (!this._btnShuffle)
                        return;
                    if (next)
                        this._btnShuffle.add_style_class_name('island-ctl-active');
                    else
                        this._btnShuffle.remove_style_class_name('island-ctl-active');
                } catch (e) {
                    LOG('shuffle failed', e.message);
                }
            });
    }

    // ---------- timer engine ----------

    _setPreset(minutes) {
        this._timerMinutes = minutes;
        if (!this._timerRunning) {
            this._timerRemaining = minutes * 60000;
            this._refreshTimer();
        }
        for (const [m, btn] of Object.entries(this._presetButtons)) {
            if (Number(m) === minutes)
                btn.add_style_class_name('island-chip-active');
            else
                btn.remove_style_class_name('island-chip-active');
        }
    }

    _timerAction() {
        if (this._timerRunning) {
            this._timerRemaining = Math.max(0, this._timerEndAt - GLib.get_monotonic_time() / 1000);
            this._timerRunning = false;
            this._clearTimerTicker();
        } else {
            const remaining = this._timerRemaining ?? 0;
            this._timerRemaining = remaining > 0 ? remaining : (this._timerMinutes ?? 25) * 60000;
            this._timerTotal = this._timerRemaining;
            this._timerEndAt = GLib.get_monotonic_time() / 1000 + this._timerRemaining;
            this._timerRunning = true;
            this._startTimerTicker();
        }
        this._refreshTimer();
        this._refreshCompactBits();
    }

    _resetTimer() {
        this._timerRunning = false;
        this._clearTimerTicker();
        this._timerRemaining = (this._timerMinutes ?? 25) * 60000;
        this._timerTotal = this._timerRemaining;
        this._refreshTimer();
        this._refreshCompactBits();
    }

    _startTimerTicker() {
        this._clearTimerTicker();
        this._timerTickerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            if (!this._capsule || this._destroyed) {
                this._timerTickerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._timerRemaining = Math.max(0, this._timerEndAt - GLib.get_monotonic_time() / 1000);
            this._refreshTimer();
            if (this._timerRemaining <= 0) {
                this._timerRunning = false;
                this._timerTickerId = 0;
                this._timerFinished();
                return GLib.SOURCE_REMOVE;
            }
            this._refreshCompactBits();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _clearTimerTicker() {
        if (this._timerTickerId) {
            GLib.source_remove(this._timerTickerId);
            this._timerTickerId = 0;
        }
    }

    _timerText(ms) {
        const total = Math.max(0, Math.ceil(ms / 1000));
        return `${Math.floor(total / 60)}:${pad(total % 60)}`;
    }

    _refreshTimer() {
        if (!this._timerBig)
            return;
        const remaining = this._timerRemaining ?? ((this._timerMinutes ?? 25) * 60000);
        this._timerBig.text = this._timerText(remaining);
        this._timerToggleLabel.text = this._timerRunning ? 'Pause' : 'Start';
        this._timerToggle.add_style_class_name('island-pill-primary');
        const total = this._timerTotal ?? ((this._timerMinutes ?? 25) * 60000);
        const fraction = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
        this._timerFill.width = Math.round(576 * fraction);
        this._timerState.text = this._timerRunning ? 'Running' : (remaining > 0 ? 'Paused' : 'Finished');
    }

    _timerFinished() {
        this._timerState.text = 'Finished';
        this._timerFill.width = 0;
        this._timerRemaining = 0;
        this._liveActivity({
            title: 'Timer',
            body: 'Time is up',
            iconName: 'alarm-symbolic',
            duration: 6000,
            target: 'timer',
        });
        this._refreshCompactBits();
    }

    _buildSystemView() {
        const view = new St.BoxLayout({vertical: true, style_class: 'island-view',
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL, x_expand: true});
        this._meters = {};
        for (const [id, title] of [['cpu', 'CPU'], ['mem', 'Memory'], ['disk', 'Disk'], ['net', 'Network']]) {
            const row = new St.BoxLayout({vertical: true, style_class: 'island-meter'});
            const head = new St.BoxLayout();
            head.add_child(label(title, 'island-meter-label'));
            head.add_child(new St.Widget({x_expand: true}));
            const value = label('', 'island-meter-value');
            head.add_child(value);
            const track = new St.Widget({style_class: 'island-track', x_expand: true});
            const fill = new St.Widget({style_class: 'island-fill'});
            track.add_child(fill);
            row.add_child(head);
            row.add_child(track);
            view.add_child(row);
            this._meters[id] = {value, fill, track};
        }
        this._systemFoot = label('', 'island-sub');
        view.add_child(this._systemFoot);
        return view;
    }


    _buildBatteryView() {
        const view = new St.BoxLayout({vertical: true, style_class: 'island-view',
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL, x_expand: true});

        this._battMeters = {};
        for (const [id, title] of [['charge', 'Charge'], ['health', 'Health']]) {
            const row = new St.BoxLayout({vertical: true, style_class: 'island-meter'});
            const head = new St.BoxLayout();
            head.add_child(label(title, 'island-meter-label'));
            head.add_child(new St.Widget({x_expand: true}));
            const value = label('', 'island-meter-value');
            head.add_child(value);
            const track = new St.Widget({style_class: 'island-track', x_expand: true});
            const fill = new St.Widget({style_class: 'island-fill'});
            track.add_child(fill);
            row.add_child(head);
            row.add_child(track);
            view.add_child(row);
            this._battMeters[id] = {value, fill, track};
        }

        // Two columns of small stat tiles: cycles, power, capacity, voltage.
        this._battTiles = {};
        const grid = new St.BoxLayout({vertical: true, style_class: 'island-batt-grid', x_expand: true});
        const rows = [
            [['cycles', 'Cycles'], ['power', 'Power draw']],
            [['full', 'Full charge'], ['design', 'Design capacity']],
            [['voltage', 'Voltage'], ['wear', 'Wear']],
        ];
        for (const pair of rows) {
            const line = new St.BoxLayout({style_class: 'island-batt-row', x_expand: true});
            for (const [id, title] of pair) {
                const tile = new St.BoxLayout({vertical: true, style_class: 'island-batt-tile', x_expand: true});
                const value = label('—', 'island-batt-value');
                const cap = label(title, 'island-batt-label');
                tile.add_child(value);
                tile.add_child(cap);
                line.add_child(tile);
                this._battTiles[id] = value;
            }
            grid.add_child(line);
        }
        view.add_child(grid);

        this._battFoot = label('', 'island-sub');
        view.add_child(this._battFoot);

        this._battEmpty = label('No battery found on this device', 'island-empty');
        this._battEmpty.x_align = Clutter.ActorAlign.CENTER;
        this._battEmpty.y_align = Clutter.ActorAlign.CENTER;
        this._battEmpty.y_expand = true;
        view.add_child(this._battEmpty);
        return view;
    }

    _buildWeatherView() {
        const view = new St.BoxLayout({vertical: true, style_class: 'island-view island-weather-view',
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL, x_expand: true});

        const header = new St.BoxLayout({style_class: 'island-weather-header', x_expand: true});
        const primary = new St.BoxLayout({vertical: true, style_class: 'island-weather-primary', x_expand: true});
        const locRow = new St.BoxLayout({style_class: 'island-weather-loc-row', x_expand: true});
        this._weatherLocIcon = new St.Icon({icon_name: 'mark-location-symbolic', icon_size: 13,
            style_class: 'island-weather-loc-icon', y_align: Clutter.ActorAlign.CENTER});
        this._weatherLocLabel = label('', 'island-weather-loc');
        this._weatherLocLabel.x_expand = true;
        locRow.add_child(this._weatherLocIcon);
        locRow.add_child(this._weatherLocLabel);
        primary.add_child(locRow);

        const current = new St.BoxLayout({style_class: 'island-weather-current', x_expand: true});
        this._weatherNowIcon = new St.Icon({
            icon_name: 'weather-overcast-symbolic', icon_size: 38,
            style_class: 'island-weather-now-icon', y_align: Clutter.ActorAlign.CENTER,
        });
        this._weatherTemp = label('—°', 'island-weather-temp');
        const units = new St.BoxLayout({style_class: 'island-weather-units', y_align: Clutter.ActorAlign.CENTER});
        this._weatherUnitButtons = {};
        for (const [unit, title] of [['c', '°C'], ['f', '°F']]) {
            const button = new St.Button({style_class: 'island-weather-unit', reactive: true,
                can_focus: false, accessible_name: title});
            button.set_child(new St.Label({text: title, style_class: 'island-weather-unit-label'}));
            button.connect('clicked', () => {
                this._weatherUnit = unit;
                this._renderWeather();
            });
            this._weatherUnitButtons[unit] = button;
            units.add_child(button);
        }
        current.add_child(this._weatherNowIcon);
        current.add_child(this._weatherTemp);
        current.add_child(units);
        primary.add_child(current);
        header.add_child(primary);

        const summary = new St.BoxLayout({vertical: true, style_class: 'island-weather-summary',
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        this._weatherTitle = label('Weather', 'island-weather-title');
        this._weatherTime = label('', 'island-weather-time');
        this._weatherCondition = label('', 'island-weather-condition');
        for (const item of [this._weatherTitle, this._weatherTime, this._weatherCondition]) {
            item.x_align = Clutter.ActorAlign.END;
            summary.add_child(item);
        }
        header.add_child(summary);
        view.add_child(header);

        this._weatherDetail = new St.BoxLayout({style_class: 'island-weather-stats', x_expand: true});
        this._weatherStatRain = label('Precipitation —', 'island-weather-stat');
        this._weatherStatHumidity = label('Humidity —', 'island-weather-stat');
        this._weatherStatWind = label('Wind —', 'island-weather-stat');
        this._weatherDetail.add_child(this._weatherStatRain);
        this._weatherDetail.add_child(new St.Widget({style_class: 'island-weather-separator'}));
        this._weatherDetail.add_child(this._weatherStatHumidity);
        this._weatherDetail.add_child(new St.Widget({style_class: 'island-weather-separator'}));
        this._weatherDetail.add_child(this._weatherStatWind);
        view.add_child(this._weatherDetail);

        const metrics = new St.BoxLayout({style_class: 'island-weather-metrics', x_expand: true});
        this._weatherMetricButtons = {};
        for (const [metric, title] of [['temperature', 'Temperature'], ['precipitation', 'Precipitation'], ['wind', 'Wind']]) {
            const button = new St.Button({style_class: 'island-weather-metric', reactive: true,
                can_focus: false, accessible_name: title});
            const content = new St.BoxLayout({vertical: true, style_class: 'island-weather-metric-content'});
            content.add_child(new St.Label({text: title, style_class: 'island-weather-metric-label'}));
            content.add_child(new St.Widget({style_class: 'island-weather-metric-indicator', x_expand: true}));
            button.set_child(content);
            button.connect('clicked', () => {
                this._weatherMetric = metric;
                this._renderWeather();
            });
            this._weatherMetricButtons[metric] = button;
            metrics.add_child(button);
        }
        view.add_child(metrics);

        this._weatherChartPoints = [];
        this._weatherChartArea = new St.DrawingArea({style_class: 'island-weather-chart',
            x_expand: true, height: 98});
        this._weatherChartArea.connect('repaint', area => this._drawWeatherChart(area));
        view.add_child(this._weatherChartArea);
        this._weatherAxis = new St.BoxLayout({style_class: 'island-weather-axis', x_expand: true});
        this._weatherAxisLabels = [];
        for (let i = 0; i < 8; i++) {
            const tick = label('', 'island-weather-axis-label');
            tick.x_expand = true;
            tick.x_align = Clutter.ActorAlign.CENTER;
            this._weatherAxisLabels.push(tick);
            this._weatherAxis.add_child(tick);
        }
        view.add_child(this._weatherAxis);

        this._dailyBox = new St.BoxLayout({style_class: 'island-daily', x_expand: true});
        view.add_child(this._dailyBox);
        return view;
    }

    // ---------- mode ----------

    _showOnly(widget) {
        for (const w of [this._compact, this._panel, this._alert])
            w.visible = w === widget;
    }

    _setMode(mode) {
        if (!MODES[mode])
            return;
        if (mode === this._mode && mode !== 'panel')
            return;

        const prev = this._mode;
        this._mode = mode;
        const size = {...MODES[mode]};

        // swap content instantly, then animate the capsule: clip_to_allocation
        // makes the reveal grow/shrink without any content jumping about.
        this._showOnly(mode === 'compact' ? this._compact
            : mode === 'alert' ? this._alert
            : this._panel);

        if (mode === 'panel') {
            // Hover opens straight into the card. If something is playing,
            // open on the player: that is the expanded face of the island.
            if (prev === 'compact' && this._settings.showMusic && this._activePlayer())
                this._tab = 'music';
            size.height = this._measurePanelHeight();
            this._targetPanelHeight = size.height;
        }

        this._capsule.remove_style_class_name(MODES[prev].style);
        this._capsule.add_style_class_name(size.style);

        const duration = this._dur(DURATION);
        this._capsule.ease({
            x: Math.round((FRAME.width - size.width) / 2),
            y: mode === 'panel' ? 0 : CAP_TOP,
            width: size.width,
            height: size.height,
            duration,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });

        if (mode === 'panel') {
            this._installStageHandlers();
            this._selectTab(this._tab);
            if (this._tab === 'system')
                this._refreshSystem();
            if (this._tab === 'weather')
                this._refreshWeather();
        } else {
            this._removeStageHandlers();
        }

        if (mode === 'compact')
            this._refreshCompactBits();

        this._updateBadge();
    }

    _place() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const x = Math.round(monitor.x + (monitor.width - FRAME.width) / 2);
        this._frame.set_position(x, monitor.y);
    }

    _onHoverChanged() {
        if (this._hovered) {
            this._removeTimer(this._collapseId);
            // Direct open: the old 56 px peek was a separate animation that
            // added nothing. One hover, one smooth expansion to the card.
            if (this._mode === 'compact')
                this._setMode('panel');
            return;
        }
        this._removeTimer(this._collapseId);
        const grace = this._settings.collapseMs ?? 420;
        if (!grace)
            return;
        this._collapseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, grace, () => {
            this._collapseId = 0;
            if (this._destroyed || !this._capsule)
                return GLib.SOURCE_REMOVE;
            if (this._capsule.hover)
                return GLib.SOURCE_REMOVE;
            if (this._mode === 'panel')
                this._setMode('compact');
            return GLib.SOURCE_REMOVE;
        });
    }

    _installStageHandlers() {
        if (this._stageSignals.length)
            return;
        this._stageSignals.push(global.stage.connect('key-press-event', (actor, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._setMode('compact');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }));
        this._stageSignals.push(global.stage.connect('button-press-event', (actor, event) => {
            const [x, y] = event.get_coords();
            const [cx, cy] = this._capsule.get_transformed_position();
            const inside = x >= cx && x <= cx + this._capsule.width &&
                y >= cy && y <= cy + this._capsule.height;
            if (!inside) {
                this._setMode('compact');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }));
    }

    _removeStageHandlers() {
        for (const id of this._stageSignals)
            global.stage.disconnect(id);
        this._stageSignals = [];
    }

    _selectTab(id, animate = true) {
        if (!this._views || !this._views[id])
            return;

        const next = this._views[id];
        const prev = this._currentView;

        this._tab = id;
        for (const t of TABS) {
            const btn = this._tabButtons[t.id];
            if (!btn)
                continue;
            if (t.id === id)
                btn.add_style_class_name('island-tab-active');
            else
                btn.remove_style_class_name('island-tab-active');
        }

        // Music tab keeps the reference split (player left, lyrics right).
        // Every other tab needs the full width, so the player column folds
        // away and the sheet takes the whole slab.
        const musicFace = id === 'music';
        if (this._mediaCol)
            this._mediaCol.visible = musicFace;
        if (this._panelDivider)
            this._panelDivider.visible = musicFace;
        if (this._sideCol)
            this._sideCol.set_width(musicFace ? 305 : 608);
        this._syncMusicRight();
        if (musicFace)
            this._refreshCalendar();

        for (const [vid, view] of Object.entries(this._views)) {
            if (view !== next && vid !== 'music')
                view.hide();
        }

        this._currentView = next;
        if (animate && prev !== next) {
            next.opacity = 0;
            next.show();
            next.ease({
                opacity: 255,
                duration: this._dur(180),
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            });
        } else {
            next.opacity = 255;
            next.show();
        }

        if (id === 'notifications') {
            this._unseen = 0;
            this._updateBadge();
        } else if (id === 'system') {
            this._refreshSystem();
        } else if (id === 'battery') {
            this._refreshBatteryView(true);
        } else if (id === 'weather') {
            this._refreshWeather(true);
        } else if (id === 'music') {
            this._refreshMusic(true);
        } else if (id === 'timer') {
            this._refreshTimer();
        } else if (id === 'clips') {
            // Card heights depend on the allocation of the now-visible view,
            // and Pango reflows wrapped text a frame or two after it is shown.
            this._scheduleClipFit(320);
        } else if (id === 'settings') {
            this._renderSettings();
        }

        // After the tab has laid itself out, size the capsule to the content:
        // no half-empty panels and no clipped rows.
        this._fitPanel();
    }

    // The right half follows playback: lyrics while a track is loaded, the
    // date when the player is empty. Every non-music tab hides both.
    _syncMusicRight() {
        const face = this._tab === 'music' && this._mode === 'panel';
        const playing = face && !!this._activePlayer();
        if (this._calendar)
            this._calendar.visible = face && !playing;
        if (this._lyrics)
            this._lyrics.visible = playing;
    }

    // Preferred height of the panel chrome + current tab, clamped so a long
    // notification list scrolls instead of growing off the screen.
    _measurePanelHeight() {
        try {
            const [, nat] = this._panel.get_preferred_height(MODES.panel.width);
            return Math.max(210, Math.min(470, Math.ceil(nat)));
        } catch (e) {
            return panelHeight(this._tab, this);
        }
    }

    _fitPanel() {
        if (this._mode !== 'panel' || !this._capsule || !this._panel)
            return;
        // Force a synchronous layout pass so get_preferred_height sees the
        // current content (e.g. after deleting a notification row).
        try { this._panel.queue_relayout(); } catch (_) {}
        const target = this._measurePanelHeight();
        if (this._targetPanelHeight === target)
            return;
        this._targetPanelHeight = target;
        this._capsule.ease({
            height: target,
            duration: this._dur(220),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    // ---------- settings ----------

    _dur(ms) {
        const f = SPEED[this._settings.speed] ?? 1;
        return Math.max(40, Math.round(ms / f));
    }

    _applySettings() {
        if (!this._capsule)
            return;
        for (const a of ACCENTS)
            this._capsule.remove_style_class_name(`accent-${a}`);
        this._capsule.add_style_class_name(`accent-${this._settings.accent}`);

        this._tickClock();
        this._refreshWallpaper();
        this._refreshCompactBits();
        this._refreshSystem();
        this._applyTabVisibility();
    }

    _setSetting(key, value) {
        this._settings[key] = value;
        if (key === 'pixelStyle')
            this._setPixelStyle(value);
        saveSettings(this._settings);
        // Clipboard polling follows the switch immediately, so turning history
        // off stops reading the selection in the same click.
        if (key === 'saveClips') {
            if (value)
                this._startClipWatch();
            else
                this._stopClipWatch();
            this._renderClips();
        }
        this._applySettings();
        if (this._tab === 'settings')
            this._renderSettings();
    }

    // ---------- timers ----------

    _addTimer(interval, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            if (!this._capsule || this._destroyed)
                return GLib.SOURCE_REMOVE;
            try {
                fn();
            } catch (e) {
                LOG('timer error', e);
            }
            return GLib.SOURCE_CONTINUE;
        });
        this._timers.push(id);
        return id;
    }

    // One-shot companion to _addTimer. The id lives in the same list, so
    // destroy() cancels a pending fit like any other timer.
    _addOneShot(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            const i = this._timers.indexOf(id);
            if (i >= 0)
                this._timers.splice(i, 1);
            if (!this._capsule || this._destroyed)
                return GLib.SOURCE_REMOVE;
            try {
                fn();
            } catch (e) {
                LOG('timer error', e);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._timers.push(id);
        return id;
    }

    _removeTimer(id) {
        if (!id)
            return;
        const i = this._timers.indexOf(id);
        if (i >= 0)
            this._timers.splice(i, 1);
        GLib.source_remove(id);
    }

    // ---------- clock ----------

    _tickClock() {
        const now = new Date();
        const t = fmtTime(now, this._settings.clock24);
        this._clockCompact.text = t;
        this._dateCompact.text = fmtDateShort(now);
        this._refreshCalendar();
    }

    // Compact slot: timer wins, then charging, then weather. The battery chip
    // is useful here only while charging; battery activity alerts have their
    // own setting and stay independent of this display.
    _refreshCompactBits() {
        const batt = this._battery();

        const charging = !!batt && this._settings.showBattery && batt.charging;
        if (this._chargeChip) {
            const show = charging;
            this._chargeChip.visible = show;
            if (show) {
                this._chargeIcon.icon_name = 'battery-charging-symbolic';
                this._chargeText.text = `${batt.percent}%`;
                for (const cls of ['island-charge-charging', 'island-charge-ok', 'island-charge-warn', 'island-charge-low'])
                    this._chargeChip.remove_style_class_name(cls);
                this._chargeChip.add_style_class_name('island-charge-charging');
            }
        }
        let mini = '';
        if (this._timerRunning || (this._timerRemaining > 0 && this._timerRemaining < this._timerTotal))
            mini = `⏱ ${this._timerText(this._timerRemaining)}`;
        else if (this._settings.showWeather && this._weather?.available)
            mini = `${Math.round(this._weather.temp)}°`;
        this._tempCompact.text = charging ? '' : mini;
        this._tempCompact.visible = !!mini && !charging;

        // Compact now-playing: macOS style - artwork thumbnail and a live
        // three-bar equaliser while something is actually playing.
        const player = this._settings.showMusic ? this._activePlayer() : null;
        const hasMusic = !!player;
        const playing = hasMusic && this._status(player) === 'Playing';
        if (this._compactArt) {
            this._compactArt.visible = hasMusic;
            this._dot.visible = !hasMusic;
        }
        this._eq.visible = playing;
        if (playing)
            this._startEq();
        else
            this._stopEq();

    }

    _startEq() {
        if (this._eqTimer)
            return;
        const PATTERN = [5, 12, 7, 15, 6, 11, 8, 14];
        let step = 0;
        this._eqTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
            if (this._destroyed) {
                this._eqTimer = 0;
                return GLib.SOURCE_REMOVE;
            }
            step = (step + 1) % PATTERN.length;
            this._eqBars.forEach((bar, i) => {
                bar.ease({
                    height: PATTERN[(step + i * 3) % PATTERN.length],
                    duration: this._dur(230),
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                });
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopEq() {
        if (this._eqTimer) {
            GLib.source_remove(this._eqTimer);
            this._eqTimer = 0;
        }
        for (const bar of this._eqBars ?? [])
            bar.height = 5;
    }

    // ---------- live activities ----------

    // One shared transient capsule for battery, device and timer events.
    // A second event queues instead of clobbering the one on screen, and a
    // click opens the tab that belongs to it (like tapping the island).
    _liveActivity(activity) {
        if (!activity?.title || !this._alertTitle)
            return;
        const item = {duration: 5000, body: '', gicon: null, iconName: null, target: null, ...activity};
        if (this._mode === 'panel')
            return;
        if (this._mode === 'alert') {
            this._activities.push(item);
            if (this._activities.length > 4)
                this._activities.shift();
            return;
        }
        this._showActivity(item);
    }

    _showActivity(item) {
        this._alertTitle.text = item.title;
        this._alertBody.text = item.body ?? '';
        this._alertTarget = item.target ?? null;
        this._alertActivate = item.onActivate ?? null;
        if (item.gicon) {
            this._alertIcon.gicon = item.gicon;
            this._alertIcon.icon_name = null;
            this._alertIcon.show();
        } else if (item.iconName) {
            this._alertIcon.gicon = null;
            this._alertIcon.icon_name = item.iconName;
            this._alertIcon.show();
        } else {
            this._alertIcon.hide();
        }

        this._setMode('alert');
        this._alertUntil = GLib.get_monotonic_time() + item.duration * 1000;
        this._removeTimer(this._alertTimerId);
        this._alertTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, item.duration, () => {
            this._alertTimerId = 0;
            if (this._mode === 'alert')
                this._setMode(this._capsule?.hover ? 'panel' : 'compact');
            this._alertTarget = null;
            this._alertActivate = null;
            if (this._activities.length) {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 260, () => {
                    if (this._destroyed || this._mode === 'panel')
                        return GLib.SOURCE_REMOVE;
                    const next = this._activities.shift();
                    if (next)
                        this._showActivity(next);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // ---------- battery activity ----------

    _checkBatteryActivity() {
        const batt = this._battery();
        if (!batt)
            return;
        const raw = batt.raw;
        const charging = batt.charging;
        const prev = this._battPrev;
        this._battPrev = {percent: batt.percent, charging, raw};
        if (!prev)
            return; // first sample is the baseline, not an event

        if (!this._settings.liveBattery)
            return;

        if (charging && !prev.charging) {
            this._liveActivity({
                title: 'Charging',
                body: `${batt.percent}% · power connected`,
                iconName: 'battery-charging-symbolic',
                duration: 4200,
                target: 'system',
            });
        } else if (!charging && prev.charging && raw === 'Discharging') {
            this._liveActivity({
                title: 'On battery',
                body: `${batt.percent}% left`,
                iconName: 'battery-good-symbolic',
                duration: 3600,
                target: 'system',
            });
        } else if (raw === 'Full' && prev.raw === 'Charging') {
            this._liveActivity({
                title: 'Fully charged',
                body: '100% · you can unplug',
                iconName: 'battery-full-charged-symbolic',
                duration: 4200,
                target: 'system',
            });
        }

        // Low battery, announced once when the charge crosses each limit.
        for (const [limit, title] of [[20, 'Low battery'], [10, 'Battery critically low']]) {
            if (!charging && prev.percent > limit && batt.percent <= limit) {
                this._liveActivity({
                    title,
                    body: `${batt.percent}% remaining · plug in soon`,
                    iconName: 'battery-caution-symbolic',
                    duration: 6500,
                    target: 'system',
                });
            }
        }
    }

    // ---------- bluetooth activity ----------

    _watchBluetooth() {
        try {
            this._bluez = Gio.DBus.system;
            this._btSubs = [];
            const sub = (member, iface, cb) => {
                this._btSubs.push(this._bluez.signal_subscribe(
                    'org.bluez', iface, member, null, null, Gio.DBusSignalFlags.NONE,
                    (conn, sender, path, ifaceName, signal, params) => {
                        try {
                            cb(path, params.recursiveUnpack());
                        } catch (e) {
                            LOG('bluez event failed', e);
                        }
                    }));
            };

            sub('InterfacesAdded', 'org.freedesktop.DBus.ObjectManager', (path, [objectPath, ifaces]) => {
                const dev = ifaces?.['org.bluez.Device1'];
                if (dev) {
                    this._btDevices.set(objectPath, {
                        ...(this._btDevices.get(objectPath) ?? {}),
                        ...dev,
                        battery: ifaces['org.bluez.Battery1']?.Percentage
                            ?? this._btDevices.get(objectPath)?.battery ?? null,
                    });
                    this._btMaybeConnected(objectPath);
                } else if (ifaces?.['org.bluez.Battery1']) {
                    const known = this._btDevices.get(objectPath);
                    if (known)
                        known.battery = ifaces['org.bluez.Battery1'].Percentage;
                }
            });

            sub('PropertiesChanged', 'org.freedesktop.DBus.Properties', (path, [iface, changed]) => {
                if (iface === 'org.bluez.Device1') {
                    const dev = {...(this._btDevices.get(path) ?? {}), ...changed};
                    this._btDevices.set(path, dev);
                    this._btMaybeConnected(path);
                } else if (iface === 'org.bluez.Battery1' && changed?.Percentage !== undefined) {
                    const dev = this._btDevices.get(path);
                    if (dev)
                        dev.battery = changed.Percentage;
                }
            });

            // Devices already connected when the extension starts must not
            // fire an activity; record them as seen.
            this._bluez.call('org.bluez', '/', 'org.freedesktop.DBus.ObjectManager',
                'GetManagedObjects', null, null, Gio.DBusCallFlags.NONE, -1, null,
                (conn, res) => {
                    try {
                        const [objects] = conn.call_finish(res).recursiveUnpack();
                        for (const [path, ifaces] of Object.entries(objects ?? {})) {
                            const dev = ifaces['org.bluez.Device1'];
                            if (!dev)
                                continue;
                            this._btDevices.set(path, {
                                ...dev,
                                battery: ifaces['org.bluez.Battery1']?.Percentage ?? null,
                            });
                            if (dev.Connected)
                                this._btSeen.add(path);
                        }
                    } catch (e) {
                        // No BlueZ or no adapter: nothing to watch.
                    }
                });
        } catch (e) {
            LOG('bluez setup failed', e);
        }
    }

    _btMaybeConnected(path) {
        const dev = this._btDevices.get(path);
        if (!dev)
            return;
        if (!dev.Connected) {
            this._btSeen.delete(path);
            return;
        }
        if (this._btSeen.has(path))
            return;
        this._btSeen.add(path);
        if (!this._settings.liveDevices)
            return;

        const name = dev.Alias || dev.Name || 'Bluetooth device';
        const pct = Number(dev.battery);
        this._liveActivity({
            title: `${name} connected`,
            body: Number.isFinite(pct) && pct > 0 ? `${pct}% battery` : 'Connected',
            iconName: dev.Icon || 'bluetooth-active-symbolic',
            duration: 4200,
            target: 'system',
        });
    }

    // ---------- notifications ----------

    _onNotification(notification) {
        let title = '';
        let body = '';
        let appName = 'Notification';
        let gicon = null;

        try {
            title = notification.title ?? '';
        } catch (e) {}
        try {
            body = notification.bannerBody || notification.body || '';
        } catch (e) {}
        try {
            appName = notification.source?.title
                ?? notification.app?.get_name?.()
                ?? 'Notification';
        } catch (e) {}
        try {
            gicon = notification.gicon
                ?? notification.app?.create_icon?.(24)
                ?? null;
        } catch (e) {}

        const entry = {title: title || appName, body, appName, when: GLib.DateTime.new_now_local(),
            notification, dead: false};
        // The message tray destroys notifications when they are dismissed.
        // Keep a flag so a stale row can still open the app instead of
        // calling activate() on a dead object.
        try {
            notification.connect('destroy', () => {
                entry.dead = true;
            });
        } catch (e) {}

        this._feed.unshift({...entry, gicon});
        if (this._feed.length > 12)
            this._feed.pop();

        this._unseen++;
        this._updateBadge();
        this._renderFeed();

        // alert capsule
        this._liveActivity({
            title: entry.title,
            body: body || appName,
            gicon,
            duration: 5500,
            target: 'notifications',
            onActivate: () => this._activateNotification(entry),
        });
    }

    // A row is a shortcut to the notification itself: activate() is what a
    // click on GNOME's own banner does, so default actions (reply, open link)
    // run and the app is raised. FDO sources sometimes have no Shell.App
    // attached (the sender is not a tracked window), so fall back to matching
    // the shown app name against installed apps.
    _findApp(entry) {
        let app = entry?.notification?.source?.app ?? null;
        if (app)
            return app;
        const name = entry?.appName;
        if (!name || name === 'Notification')
            return null;
        try {
            const appSys = Shell.AppSystem.get_default();
            app = appSys.lookup_app(`${name}.desktop`)
                ?? appSys.lookup_desktop_wmclass(name);
            if (!app) {
                const lower = name.toLowerCase();
                app = appSys.get_installed()
                    .find(a => (a.get_name() ?? '').toLowerCase() === lower) ?? null;
            }
        } catch (e) {}
        return app;
    }

    // Returns true when there was an app to open, so the banner can fall back
    // to the notification list for app-less senders such as notify-send.
    _activateNotification(entry) {
        const notification = entry?.notification;
        const app = this._findApp(entry);
        if (!notification) {
            this._raiseApp(app);
            return !!app;
        }
        if (this._mode === 'panel' && app)
            this._setMode('compact');

        try {
            notification.activate();
        } catch (e) {
            LOG('notification activate failed', e.message);
        }
        // activate() opens the source app itself when the daemon attached
        // one; only raise a second window when it had none.
        if (!notification.source?.app)
            this._raiseApp(app);
        return !!app;
    }

    // Shell.App has activate(); some FDO sources expose a plain app info
    // instead, so pick whichever raise method the object actually has.
    _raiseApp(app) {
        if (!app)
            return;
        try {
            if (typeof app.activate === 'function')
                app.activate();
            else if (typeof app.open_new_window === 'function')
                app.open_new_window(-1);
            else if (typeof app.launch === 'function')
                app.launch([], null);
        } catch (e) {
            LOG('app activate failed', e.message);
        }
    }

    _updateBadge() {
        if (this._unseen > 0) {
            this._badge.text = this._unseen > 9 ? '9+' : String(this._unseen);
            this._badge.show();
        } else {
            this._badge.hide();
        }
    }

    _renderFeed() {
        const children = this._notifList.get_children();
        for (const c of children)
            c.destroy();

        this._notifEmpty.visible = this._feed.length === 0;
        this._notifBar.visible = this._feed.length > 0;
        for (const item of this._feed.slice(0, 6)) {
            const row = new St.BoxLayout({style_class: 'island-notif'});
            const icon = new St.Icon({
                icon_size: 18,
                gicon: item.gicon,
                style_class: 'island-notif-icon',
                y_align: Clutter.ActorAlign.START,
            });
            const text = new St.BoxLayout({vertical: true, style_class: 'island-notif-text'});
            text.add_child(new St.Label({
                text: item.title,
                style_class: 'island-notif-title',
                width: 470,
            }));
            if (item.body) {
                text.add_child(new St.Label({
                    text: item.body,
                    style_class: 'island-notif-body',
                    width: 470,
                }));
            }
            const time = new St.Label({
                text: fmtTime(item.when.to_unix ? new Date(item.when.to_unix() * 1000) : new Date()),
                style_class: 'island-notif-time',
                y_align: Clutter.ActorAlign.START,
            });
            row.add_child(icon);
            row.add_child(text);
            row.add_child(time);
            // Delete: removes the entry and asks the shell to dismiss the
            // underlying notification so it also leaves the tray.
            const del = new St.Button({style_class: 'island-row-btn', reactive: true,
                can_focus: false, y_align: Clutter.ActorAlign.START});
            del.set_child(new St.Icon({icon_name: 'user-trash-symbolic', icon_size: 14,
                style_class: 'island-row-btn-icon'}));
            del.connect('clicked', () => {
                this._dismissNotification(item);
                return Clutter.EVENT_STOP;
            });
            row.add_child(del);
            row.reactive = true;
            row.connect('button-release-event', (actor, event) => {
                // Presses on the delete button must not fall through to the
                // row and re-open the app.
                if (event?.get_coords) {
                    const [x, y] = event.get_coords();
                    const [bx, by] = del.get_transformed_position();
                    const [bw, bh] = del.get_size();
                    if (x >= bx && x <= bx + bw && y >= by && y <= by + bh)
                        return Clutter.EVENT_STOP;
                }
                this._activateNotification(item);
                return Clutter.EVENT_STOP;
            });
            this._notifList.add_child(row);
        }
    }

    _dismissNotification(item) {
        const notification = item?.notification;
        let dismissed = false;
        try {
            if (notification && typeof notification.dismiss === 'function') {
                notification.dismiss();
                dismissed = true;
            }
        } catch (e) {
            LOG('notification dismiss failed', e.message);
        }
        if (!dismissed) {
            try {
                notification?.source?.removeNotification?.(notification);
            } catch (e) {
                LOG('notification source remove failed', e.message);
            }
        }
        this._feed = this._feed.filter(x => x !== item);
        this._unseen = Math.max(0, this._unseen - 1);
        this._updateBadge();
        this._renderFeed();
        this._fitPanel();
    }

    _clearAllNotifications() {
        const items = this._feed.slice();
        for (const item of items)
            this._dismissNotification(item);
        this._unseen = 0;
        this._updateBadge();
        this._renderFeed();
        this._fitPanel();
    }

    _buildClipsView() {
        const view = new St.BoxLayout({vertical: true, style_class: 'island-view',
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL, x_expand: true});
        this._clipBar = new St.BoxLayout({style_class: 'island-bar', x_expand: true});
        this._clipCount = label('', 'island-bar-caption');
        this._clipBar.add_child(this._clipCount);
        this._clipBar.add_child(new St.Widget({x_expand: true}));
        const clear = new St.Button({style_class: 'island-mini-btn', reactive: true, can_focus: false});
        clear.set_child(new St.Label({text: 'Clear all', style_class: 'island-mini-label'}));
        clear.connect('clicked', () => this._clearClips());
        this._clipBar.add_child(clear);
        view.add_child(this._clipBar);

        // Composed empty state: glyph, heading line, helper caption. When
        // history is off this is the opt-in screen instead, because a blank
        // list with "nothing copied yet" would look broken rather than off.
        this._clipsEmpty = new St.BoxLayout({vertical: true,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true});
        const glyph = new St.Icon({icon_name: 'edit-paste-symbolic', icon_size: 28,
            style_class: 'island-empty-icon', x_align: Clutter.ActorAlign.CENTER});
        this._clipsEmpty.add_child(glyph);
        const et = label('Nothing copied yet', 'island-empty-title');
        et.x_align = Clutter.ActorAlign.CENTER;
        this._clipsEmpty.add_child(et);
        const es = label('Text you copy lands here and stays on disk', 'island-empty-sub');
        es.x_align = Clutter.ActorAlign.CENTER;
        this._clipsEmpty.add_child(es);
        this._clipEmptyTitle = et;
        this._clipEmptySub = es;
        const enable = new St.Button({style_class: 'island-mini-btn island-clip-enable',
            reactive: true, can_focus: false, x_align: Clutter.ActorAlign.CENTER});
        enable.set_child(new St.Label({text: 'Turn on history', style_class: 'island-mini-label'}));
        enable.connect('clicked', () => this._setSetting('saveClips', true));
        enable.visible = false;
        this._clipsEmpty.add_child(enable);
        this._clipEnableBtn = enable;
        view.add_child(this._clipsEmpty);

        this._clipList = new St.BoxLayout({vertical: true, style_class: 'island-clip-list', x_expand: true});
        // The history holds 30 entries but only a handful fit on screen. A
        // dedicated scroller keeps the panel height stable and makes every
        // stored clip reachable instead of silently hiding the tail.
        this._clipScroll = new St.ScrollView({
            style_class: 'island-clip-scroll',
            x_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            enable_mouse_scrolling: true,
        });
        this._clipScroll.set_child(this._clipList);
        view.add_child(this._clipScroll);
        return view;
    }

    _renderClips() {
        if (!this._clipList)
            return;
        for (const c of this._clipList.get_children())
            c.destroy();
        const has = this._clips.length > 0;
        const on = !!this._settings.saveClips;
        this._clipsEmpty.visible = !has;
        this._clipBar.visible = has;
        if (this._clipEmptyTitle) {
            this._clipEmptyTitle.text = on ? 'Nothing copied yet' : 'Clipboard history is off';
            this._clipEmptySub.text = on
                ? 'Text you copy lands here and stays on disk'
                : 'Copied text is never read or stored until you turn it on';
            this._clipEnableBtn.visible = !on;
        }
        if (this._clipScroll) {
            this._clipScroll.visible = has;
            if (has)
                this._clipScroll.vscrollbar_policy = St.PolicyType.AUTOMATIC;
        }
        for (const item of this._clips) {
            const row = new St.BoxLayout({style_class: `island-clip${item.flash ? ' island-clip-flash' : ''}`,
                x_expand: true});
            const textBox = new St.BoxLayout({vertical: true, style_class: 'island-clip-text', x_expand: true});
            // Trailing whitespace from a copied line would add an empty line
            // to the card; CRLF comes in from terminals and Windows apps.
            const text = item.text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\s+$/, '');
            const main = new St.Label({text, style_class: 'island-clip-main', width: CLIP_TEXT_W});
            // Wrap instead of ellipsizing: the full clip stays readable, and
            // WORD_CHAR breaks long URLs rather than overflowing the card.
            main.clutter_text.line_wrap = true;
            main.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            main.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            const when = item.flash ? 'Copied' : (item.when ? fmtTime(new Date(item.when * 1000)) : '');
            textBox.add_child(main);
            if (when)
                textBox.add_child(label(when, 'island-clip-when'));
            // Actions: copy back to the clipboard, or delete the entry.
            const copy = new St.Button({style_class: 'island-clip-btn', reactive: true,
                can_focus: false, y_align: Clutter.ActorAlign.CENTER});
            copy.set_child(new St.Icon({icon_name: 'edit-copy-symbolic', icon_size: 15,
                style_class: 'island-clip-btn-icon'}));
            copy.connect('clicked', () => this._clipCopy(item));
            const del = new St.Button({style_class: 'island-clip-btn', reactive: true,
                can_focus: false, y_align: Clutter.ActorAlign.CENTER});
            del.set_child(new St.Icon({icon_name: 'user-trash-symbolic', icon_size: 15,
                style_class: 'island-clip-btn-icon'}));
            del.connect('clicked', () => this._clipDelete(item));
            row.add_child(textBox);
            row.add_child(copy);
            row.add_child(del);
            this._clipList.add_child(row);
        }
        // A clip card is as tall as its wrapped text plus the timestamp, so
        // there is no constant row height to multiply. Keep the viewport at
        // the cap until a layout pass can report real heights, then snap it.
        if (has) {
            this._clipCount.text = `${this._clips.length} clip${this._clips.length === 1 ? '' : 's'}`;
            this._clipScroll.height = CLIP_VIEW_MAX;
            this._scheduleClipFit();
        } else if (this._tab === 'clips') {
            this._fitPanel();
        }
    }

    // Card heights are only known after Pango has laid the wrapped text out.
    // Measure on the next idle instead of trusting numbers from mid-build:
    // the old code reserved 46 px per row and cut every taller card.
    _scheduleClipFit(delay = 60) {
        this._removeTimer(this._clipFitId);
        this._clipFitId = this._addOneShot(delay, () => {
            this._clipFitId = 0;
            this._fitClipViewport();
        });
    }

    _fitClipViewport() {
        if (!this._clipScroll || !this._clipList || !this._clips.length)
            return;
        const rows = this._clipList.get_children();
        let total = 0;
        let viewH = 0;
        let visible = 0;
        for (const row of rows) {
            let h = Math.ceil(row.height);
            if (!h) {
                try {
                    h = Math.ceil(row.get_preferred_height(MODES.panel.width - 44)[1]);
                } catch (e) {
                    h = 62;
                }
            }
            const next = total + (visible ? CLIP_GAP : 0) + h;
            if (next <= CLIP_VIEW_MAX || visible === 0)
                viewH = Math.min(next, CLIP_VIEW_MAX);
            total = next;
            visible++;
        }
        this._clipScroll.height = Math.max(1, viewH);
        const more = total > viewH;
        this._clipScroll.vscrollbar_policy = more
            ? St.PolicyType.AUTOMATIC : St.PolicyType.NEVER;
        this._clipCount.text = `${this._clips.length} clip${this._clips.length === 1 ? '' : 's'}`
            + (more ? ' · scroll' : '');
        if (this._tab === 'clips')
            this._fitPanel();
    }

    // ---------- clipboard ----------

    // History lives on disk (XDG data dir), never in RAM alone: the list
    // survives a logout, a crash and a shell restart. The JSON file is the
    // single source of truth; the array in memory is only a cache.
    _loadClips() {
        // First run has no file yet; that is not an error worth a journal line.
        if (!GLib.file_test(CLIPS_FILE, GLib.FileTest.EXISTS))
            return;
        try {
            const [ok, data] = GLib.file_get_contents(CLIPS_FILE);
            if (!ok)
                return;
            const parsed = JSON.parse(new TextDecoder('utf-8').decode(data));
            if (!Array.isArray(parsed))
                return;
            this._clips = parsed
                .filter(c => c && typeof c.text === 'string' && c.text.length > 0)
                .slice(0, MAX_CLIPS)
                .map(c => ({text: c.text.slice(0, MAX_CLIP_CHARS), when: c.when ?? 0}));
        } catch (e) {
            LOG('clips load failed', e.message);
        }
    }

    _saveClips() {
        try {
            GLib.mkdir_with_parents(GLib.path_get_dirname(CLIPS_FILE), 0o755);
            GLib.file_set_contents(CLIPS_FILE, JSON.stringify(this._clips));
        } catch (e) {
            LOG('clips save failed', e.message);
        }
    }

    _startClipWatch() {
        // St exposes no clipboard-changed signal, so the watcher polls the
        // selection the way the shell's own clipboard managers do. The timer
        // rides in this._timers, which destroy() drains.
        //
        // Nothing is polled unless history is on: an extension that reads the
        // selection every two seconds with history switched off is exactly
        // what a reviewer (rightly) rejects. Opting in starts the timer.
        if (!this._settings.saveClips || this._clipWatchId)
            return;
        this._clipWatchId = this._addTimer(2000, () => {
            try {
                St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD,
                    (clipboard, text) => this._onClipText(text));
            } catch (e) {
                LOG('clipboard read failed', e.message);
            }
        });
    }

    _stopClipWatch() {
        if (!this._clipWatchId)
            return;
        this._removeTimer(this._clipWatchId);
        this._clipWatchId = 0;
        // Forget the last seen value so re-enabling records the current
        // selection instead of treating it as already handled.
        this._lastClip = '';
    }

    _onClipText(text) {
        if (typeof text !== 'string' || text.length === 0)
            return;
        if (text === this._lastClip)
            return;
        this._lastClip = text;
        if (!this._settings.saveClips)
            return;
        if (text.length > MAX_CLIP_CHARS) {
            LOG('clip too long, skipped', text.length);
            return;
        }
        this._clips = this._clips.filter(c => c.text !== text);
        this._clips.unshift({text, when: GLib.DateTime.new_now_local().to_unix()});
        if (this._clips.length > MAX_CLIPS)
            this._clips.length = MAX_CLIPS;
        this._saveClips();
        this._renderClips();
        LOG('clip saved', text.length, 'chars');
    }

    _clipCopy(item) {
        try {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, item.text);
            this._lastClip = item.text;
            item.flash = true;
            this._renderClips();
            this._addTimer(900, () => {
                item.flash = false;
                this._renderClips();
            });
        } catch (e) {
            LOG('clipboard write failed', e.message);
        }
    }

    _clipDelete(item) {
        this._clips = this._clips.filter(c => c !== item);
        this._saveClips();
        this._renderClips();
    }

    _clearClips() {
        this._clips = [];
        this._saveClips();
        this._renderClips();
    }

    // ---------- system ----------

    // GNOME's own indicator reads UPower's DisplayDevice, which smooths and
    // rounds the charge; the kernel's BAT0/capacity is a separate, coarser
    // counter and can sit a point away. Read the same UPower value so both
    // percentages always agree, and fall back to sysfs only if UPower is
    // absent (containers, live sessions without upowerd).
    _setupPower() {
        try {
            const proxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.system,
                g_name: 'org.freedesktop.UPower',
                g_object_path: '/org/freedesktop/UPower/devices/DisplayDevice',
                g_interface_name: 'org.freedesktop.UPower.Device',
            });
            proxy.init_async(GLib.PRIORITY_DEFAULT, null, (p, res) => {
                try {
                    p.init_finish(res);
                } catch (e) {
                    LOG('upower unavailable', e.message);
                    return;
                }
                if (this._destroyed)
                    return;
                this._power = p;
                this._powerChangedId = p.connect('g-properties-changed', () => {
                    if (!this._destroyed)
                        this._refreshCompactBits();
                });
                this._refreshCompactBits();
            });
        } catch (e) {
            LOG('upower setup failed', e.message);
        }
    }

    _battery() {
        const upStates = {
            0: 'Unknown', 1: 'Charging', 2: 'Discharging', 3: 'Empty',
            4: 'Full', 5: 'Pending charge', 6: 'Pending discharge',
        };
        const map = {
            Charging: 'charging', Discharging: 'on battery', Empty: 'empty',
            Full: 'full', 'Pending charge': 'plugged in',
            'Pending discharge': 'plugged in',
        };
        let raw = null;
        let percent = null;

        if (this._power) {
            try {
                const pct = this._power.get_cached_property('Percentage');
                if (pct)
                    percent = Math.round(pct.unpack());
                const st = this._power.get_cached_property('State');
                if (st)
                    raw = upStates[st.unpack()] ?? null;
            } catch (e) {}
        }

        if (percent === null || raw === null) {
            const cap = readText('/sys/class/power_supply/BAT0/capacity').trim();
            if (!cap)
                return null;
            percent = Number(cap);
            raw = readText('/sys/class/power_supply/BAT0/status').trim() || 'Unknown';
        }

        return {
            percent,
            raw,
            charging: raw === 'Charging',
            state: map[raw] ?? raw.toLowerCase(),
        };
    }

    _cpuPercent() {
        const line = readText('/proc/stat').split('\n')[0] ?? '';
        const parts = line.trim().split(/\s+/).slice(1).map(Number);
        if (parts.length < 5)
            return 0;
        const idle = (parts[3] || 0) + (parts[4] || 0);
        const total = parts.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
        let pct = 0;
        if (this._cpuPrev) {
            const dt = total - this._cpuPrev.total;
            const di = idle - this._cpuPrev.idle;
            // Opening the tab right after a tick samples a sliver of a second,
            // where one jiffy of noise reads as a huge swing. Report the last
            // full-interval figure instead of jittering.
            if (dt < 40 && this._cpuPct != null)
                return this._cpuPct;
            pct = dt > 0 ? Math.max(0, Math.min(100, (1 - di / dt) * 100)) : 0;
        }
        this._cpuPrev = {idle, total};
        this._cpuPct = pct;
        return pct;
    }

    _memory() {
        const text = readText('/proc/meminfo');
        const get = key => {
            const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
            return m ? Number(m[1]) * 1024 : 0;
        };
        const total = get('MemTotal');
        const avail = get('MemAvailable');
        return {pct: total ? ((total - avail) / total) * 100 : 0, usedGb: bytesToGb(total - avail), totalGb: bytesToGb(total)};
    }

    _disk() {
        try {
            const info = Gio.File.new_for_path('/').query_filesystem_info(
                'filesystem::size,filesystem::free,filesystem::free-space', null);
            const total = info.get_attribute_uint64('filesystem::size');
            let free = info.get_attribute_uint64('filesystem::free');
            if (!free)
                free = info.get_attribute_uint64('filesystem::free-space');
            if (!total)
                return {pct: 0, freeGb: '?', usedGb: '?', totalGb: '?'};
            return {
                pct: ((total - free) / total) * 100,
                freeGb: bytesToGb(free),
                usedGb: bytesToGb(total - free),
                totalGb: bytesToGb(total),
            };
        } catch (e) {
            LOG('disk query failed', e);
            return {pct: 0, freeGb: '?', usedGb: '?', totalGb: '?'};
        }
    }

    _network() {
        const lines = readText('/proc/net/dev').split('\n').slice(2);
        let rx = 0;
        let tx = 0;
        for (const line of lines) {
            const [name, rest] = line.split(':');
            if (!rest || /^(lo|veth|docker|br-|virbr)/.test(name.trim()))
                continue;
            const f = rest.trim().split(/\s+/).map(Number);
            rx += f[0] || 0;
            tx += f[8] || 0;
        }
        const now = GLib.get_monotonic_time();
        let rxRate = 0;
        let txRate = 0;
        if (this._netPrev) {
            const dt = (now - this._netPrev.at) / 1e6;
            if (dt < 0.4 && this._netRate)
                return this._netRate;
            if (dt > 0) {
                rxRate = Math.max(0, (rx - this._netPrev.rx) / dt);
                txRate = Math.max(0, (tx - this._netPrev.tx) / dt);
            }
        }
        this._netPrev = {rx, tx, at: now};
        this._netRate = {rxRate, txRate};
        return {rxRate, txRate};
    }

    _setMeter(id, pct, text) {
        const m = this._meters[id];
        if (!m)
            return;
        m.value.text = text;
        const clamped = Math.max(0, Math.min(100, pct));
        const trackW = m.track.width;
        // A small change (idle CPU wobbling 1-2%) should not restart the
        // animation every second, or the bar shimmers instead of settling.
        // The track width check covers the first paint, when the row has not
        // been allocated yet and width is still 0.
        if (m.pct != null && Math.abs(clamped - m.pct) < 0.5 && m.trackW === trackW)
            return;
        m.pct = clamped;
        m.trackW = trackW;
        const width = Math.max(3, Math.round(trackW * clamped / 100));
        m.fill.ease({
            width,
            duration: this._dur(480),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    // Cheap sampling with no UI work, so rates stay accurate while the tab is
    // closed and the panel opens on a live number instead of a stale average.
    _sampleSystem() {
        this._cpuPercent();
        this._network();
    }

    _refreshSystem() {
        if (!this._meters)
            return;
        const cpu = this._cpuPercent();
        this._setMeter('cpu', cpu, `${Math.round(cpu)}%`);

        const mem = this._memory();
        this._setMeter('mem', mem.pct, `${mem.usedGb} / ${mem.totalGb} GB · ${Math.round(mem.pct)}%`);

        // The bar always means "used", like the other three, so the label
        // spells out used of total instead of leaving the bar ambiguous.
        const disk = this._disk();
        this._setMeter('disk', disk.pct, `${disk.usedGb} / ${disk.totalGb} GB · ${Math.round(disk.pct)}%`);

        const net = this._network();
        const fmt = v => v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB/s`
            : v >= 1024 ? `${(v / 1024).toFixed(0)} KB/s` : `${Math.round(v)} B/s`;
        // 1 MB/s used to be a full bar; 10 MB/s is a realistic laptop-link
        // reference, so the bar tracks load instead of pinning at idle noise.
        const netPct = Math.min(100, (net.rxRate + net.txRate) / NET_FULL_RATE * 100);
        this._setMeter('net', netPct, `↓ ${fmt(net.rxRate)}   ↑ ${fmt(net.txRate)}`);

        if (this._systemFoot) {
            const up = Number((readText('/proc/uptime').trim().split(/\s+/)[0] || 0));
            const hours = Math.floor(up / 3600);
            const mins = Math.floor((up % 3600) / 60);
            this._systemFoot.text = `${disk.freeGb} GB free · up ${hours}h ${pad(mins)}m`;
        }

        this._refreshCompactBits();
    }


    // ---------- battery device ----------

    // UPower's DisplayDevice is a smoothed summary, fine for the percentage
    // but it carries no health or cycle data. The real battery device does,
    // so the tab talks to that object directly.
    _setupBatteryDevice() {
        this._battProxy = null;
        try {
            Gio.DBus.system.call('org.freedesktop.UPower', '/org/freedesktop/UPower',
                'org.freedesktop.UPower', 'EnumerateDevices', null, null,
                Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                    let paths = [];
                    try {
                        paths = conn.call_finish(res).recursiveUnpack()[0] ?? [];
                    } catch (e) {
                        return;
                    }
                    const path = paths.map(p => `${p}`).find(p => p.includes('/battery_'));
                    if (!path)
                        return;
                    const proxy = new Gio.DBusProxy({
                        g_connection: Gio.DBus.system,
                        g_name: 'org.freedesktop.UPower',
                        g_object_path: path,
                        g_interface_name: 'org.freedesktop.UPower.Device',
                    });
                    proxy.init_async(GLib.PRIORITY_DEFAULT, null, (p, r) => {
                        try {
                            p.init_finish(r);
                        } catch (e) {
                            LOG('battery device unavailable', e.message);
                            return;
                        }
                        if (this._destroyed)
                            return;
                        this._battProxy = p;
                        p.connect('g-properties-changed', () => {
                            if (!this._destroyed && this._tab === 'battery')
                                this._refreshBatteryView();
                        });
                        this._refreshBatteryView(true);
                    });
                });
        } catch (e) {
            LOG('battery device setup failed', e.message);
        }
    }

    _battGet(key) {
        try {
            const v = this._battProxy?.get_cached_property(key);
            return v ? v.unpack() : null;
        } catch (e) {
            return null;
        }
    }

    _battInfo() {
        const p = this._battProxy;
        if (!p)
            return null;
        const pct = this._battGet('Percentage');
        if (pct == null)
            return null;
        const states = {
            1: 'charging', 2: 'on battery', 3: 'empty', 4: 'full',
            5: 'charging', 6: 'on battery',
        };
        const tech = {
            1: 'Lithium-ion', 2: 'Lithium-polymer', 3: 'LiFePO4',
            4: 'Lead-acid', 5: 'NiCd', 6: 'NiMH',
        };
        const rawState = Number(this._battGet('State') ?? 0);
        return {
            percent: Number(pct),
            state: states[rawState] ?? 'unknown',
            health: Number(this._battGet('Capacity') ?? 0),
            cycles: this._battGet('ChargeCycles'),
            energy: Number(this._battGet('Energy') ?? 0),
            full: Number(this._battGet('EnergyFull') ?? 0),
            design: Number(this._battGet('EnergyFullDesign') ?? 0),
            rate: Number(this._battGet('EnergyRate') ?? 0),
            voltage: Number(this._battGet('Voltage') ?? 0),
            temp: Number(this._battGet('Temperature') ?? 0),
            toEmpty: Number(this._battGet('TimeToEmpty') ?? 0),
            toFull: Number(this._battGet('TimeToFull') ?? 0),
            vendor: `${this._battGet('Vendor') ?? ''}`.trim(),
            model: `${this._battGet('Model') ?? ''}`.trim(),
            technology: tech[Number(this._battGet('Technology') ?? 0)] ?? '',
        };
    }

    _fmtSpan(seconds) {
        const total = Math.max(0, Math.round(seconds / 60));
        const h = Math.floor(total / 60);
        const m = total % 60;
        if (h <= 0)
            return `${m} min`;
        return `${h} h ${pad(m)} min`;
    }

    _setBattMeter(id, pct, text, health) {
        const m = this._battMeters?.[id];
        if (!m)
            return;
        m.value.text = text;
        const clamped = Math.max(0, Math.min(100, pct));
        const trackW = m.track.width;
        if (m.pct != null && Math.abs(clamped - m.pct) < 0.5 && m.trackW === trackW)
            return;
        m.pct = clamped;
        m.trackW = trackW;
        m.fill.ease({
            width: Math.max(3, Math.round(trackW * clamped / 100)),
            duration: this._dur(480),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        if (health != null) {
            for (const cls of ['island-health-good', 'island-health-warn', 'island-health-bad'])
                m.fill.remove_style_class_name(cls);
            m.fill.add_style_class_name(health >= 80 ? 'island-health-good'
                : health >= 60 ? 'island-health-warn' : 'island-health-bad');
        }
    }

    _refreshBatteryView(force = false) {
        if (!this._batteryView)
            return;
        const b = this._battInfo();
        this._battEmpty.visible = !b;
        for (const c of this._batteryView.get_children()) {
            if (c !== this._battEmpty)
                c.visible = !!b;
        }
        if (!b) {
            if (this._mode === 'panel' && this._tab === 'battery')
                this._fitPanel();
            return;
        }

        let charge = `${Math.round(b.percent)}% · ${b.state}`;
        if (b.state === 'charging' && b.toFull > 0)
            charge += ` · ${this._fmtSpan(b.toFull)} to full`;
        else if (b.state === 'on battery' && b.toEmpty > 0)
            charge += ` · ${this._fmtSpan(b.toEmpty)} left`;
        this._setBattMeter('charge', b.percent, charge);

        const health = b.health > 0 ? b.health : (b.design && b.full ? (b.full / b.design) * 100 : 0);
        const word = health >= 80 ? 'good' : health >= 60 ? 'fair' : 'poor';
        this._setBattMeter('health', health, health ? `${health.toFixed(1)}% · ${word}` : 'unknown', health || 0);

        if (this._battTiles) {
            this._battTiles.cycles.text = b.cycles == null ? '—' : `${b.cycles}`;
            this._battTiles.power.text = b.rate > 0 ? `${b.rate.toFixed(1)} W` : '—';
            this._battTiles.full.text = b.full > 0 ? `${b.full.toFixed(1)} Wh` : '—';
            this._battTiles.design.text = b.design > 0 ? `${b.design.toFixed(1)} Wh` : '—';
            this._battTiles.voltage.text = b.voltage > 0 ? `${b.voltage.toFixed(1)} V` : '—';
            this._battTiles.wear.text = health > 0 ? `${(100 - health).toFixed(1)}%` : '—';
        }
        this._battFoot.text = [b.vendor, b.model, b.technology].filter(Boolean).join(' · ');

        if (this._mode === 'panel' && this._tab === 'battery')
            this._fitPanel();
    }

    // The Battery tab can be switched off in settings; the button is kept,
    // only hidden, so turning it back on needs no rebuild of the tab bar.
    _applyTabVisibility() {
        const btn = this._tabButtons?.battery;
        if (!btn)
            return;
        btn.visible = !!this._settings.batteryTab;
        if (!btn.visible && this._tab === 'battery')
            this._selectTab('notifications');
    }

    // ---------- weather ----------

    _config() {
        try {
            const path = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'dynamic-island', 'config.json']);
            const [ok, data] = GLib.file_get_contents(path);
            if (!ok)
                return {};
            return JSON.parse(new TextDecoder('utf-8').decode(data));
        } catch (e) {
            return {};
        }
    }

    _timezoneCity() {
        try {
            const info = Gio.File.new_for_path('/etc/localtime')
                .query_info('standard::symlink-target', Gio.FileQueryInfoFlags.NONE, null);
            const target = info.get_symlink_target() ?? '';
            const idx = target.indexOf('zoneinfo/');
            if (idx < 0)
                return null;
            const zone = target.slice(idx + 'zoneinfo/'.length);
            const city = zone.split('/').pop().replace(/_/g, ' ');
            return city || null;
        } catch (e) {
            return null;
        }
    }

    _httpJson(url, cb) {
        try {
            const msg = Soup.Message.new('GET', url);
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                try {
                    const bytes = session.send_and_read_finish(res);
                    const text = new TextDecoder('utf-8').decode(bytes.get_data());
                    cb(JSON.parse(text));
                } catch (e) {
                    cb(null);
                }
            });
        } catch (e) {
            cb(null);
        }
    }

    _refreshWeather(force = false) {
        const now = GLib.get_monotonic_time() / 1e6;
        if (!force && this._weather && this._weather.at && now - this._weather.at < 540)
            return;

        const cfg = this._config();
        const w = cfg.weather ?? null;
        const lat = w?.latitude ?? w?.lat;
        const lon = w?.longitude ?? w?.lon;

        if (lat != null && lon != null) {
            this._fetchWeather(lat, lon, w?.label ?? w?.name ?? null);
            return;
        }

        const city = this._timezoneCity();
        if (!city) {
            this._weather = {available: false, at: now};
            this._refreshCompactBits();
            return;
        }
        const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=en&format=json`;
        this._httpJson(url, json => {
            const hit = json?.results?.[0];
            if (!hit) {
                this._weather = {available: false, at: now};
                this._refreshCompactBits();
                return;
            }
            const location = [hit.name, hit.admin1, hit.country]
                .filter((part, index, parts) => part && parts.indexOf(part) === index)
                .join(', ');
            this._fetchWeather(hit.latitude, hit.longitude, location);
        });
    }

    _fetchWeather(lat, lon, name) {
        const params = [
            'current=temperature_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,relative_humidity_2m',
            'hourly=temperature_2m,precipitation_probability,weather_code,wind_speed_10m',
            'daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,weather_code',
            'timezone=auto', 'forecast_days=8',
            `latitude=${lat}`, `longitude=${lon}`,
        ].join('&');
        const url = `https://api.open-meteo.com/v1/forecast?${params}`;

        this._httpJson(url, json => {
            if (!json?.current) {
                this._weather = {available: false, at: GLib.get_monotonic_time() / 1e6};
                this._refreshCompactBits();
                return;
            }
            const c = json.current;
            const code = Number(c.weather_code);
            this._weather = {
                available: true,
                at: GLib.get_monotonic_time() / 1e6,
                temp: Number(c.temperature_2m),
                feels: Number(c.apparent_temperature),
                code,
                time: c.time ?? '',
                humidity: Number(c.relative_humidity_2m),
                wind: Number(c.wind_speed_10m),
                rain: Number(c.precipitation),
                name: name ?? '',
                hourly: (json.hourly?.time ?? []).map((t, i) => ({
                    time: t,
                    temp: json.hourly?.temperature_2m?.[i] ?? null,
                    rain: json.hourly?.precipitation_probability?.[i] ?? null,
                    code: json.hourly?.weather_code?.[i] ?? null,
                    wind: json.hourly?.wind_speed_10m?.[i] ?? null,
                })),
                daily: (json.daily?.time ?? []).map((t, i) => ({
                    time: t,
                    max: json.daily?.temperature_2m_max?.[i] ?? null,
                    min: json.daily?.temperature_2m_min?.[i] ?? null,
                    rain: json.daily?.precipitation_probability_max?.[i] ?? null,
                    code: json.daily?.weather_code?.[i] ?? null,
                })),
            };
            this._renderWeather();
            this._refreshCompactBits();
        });
    }

    _renderWeather() {
        const w = this._weather;
        if (!w || !w.available) {
            this._weatherNowIcon.icon_name = 'weather-severe-alert-symbolic';
            this._weatherTemp.text = '—°';
            this._weatherTitle.text = 'Weather';
            this._weatherTime.text = '';
            this._weatherCondition.text = 'Forecast unavailable';
            this._weatherStatRain.text = 'Precipitation —';
            this._weatherStatHumidity.text = 'Humidity —';
            this._weatherStatWind.text = 'Wind —';
            this._weatherChartPoints = [];
            for (const button of Object.values(this._weatherMetricButtons ?? {}))
                button.remove_style_class_name('island-weather-metric-active');
            this._weatherMetricButtons?.[this._weatherMetric]?.add_style_class_name('island-weather-metric-active');
            for (const [unit, button] of Object.entries(this._weatherUnitButtons ?? {})) {
                if (unit === this._weatherUnit)
                    button.add_style_class_name('island-weather-unit-active');
                else
                    button.remove_style_class_name('island-weather-unit-active');
            }
            this._weatherChartArea?.queue_repaint();
            this._dailyBox?.get_children().forEach(child => child.destroy());
            if (this._weatherLocLabel)
                this._weatherLocLabel.text = 'Unknown location';
            for (const tick of this._weatherAxisLabels ?? [])
                tick.text = '';
            return;
        }

        if (this._weatherLocLabel)
            this._weatherLocLabel.text = w.name || 'Your location';
        this._weatherNowIcon.icon_name = WEATHER_ICON[w.code] ?? 'weather-overcast-symbolic';
        const toDisplayTemp = value => this._weatherUnit === 'f'
            ? (Number(value) * 9 / 5) + 32
            : Number(value);
        this._weatherTemp.text = `${Math.round(toDisplayTemp(w.temp))}°`;
        for (const [unit, button] of Object.entries(this._weatherUnitButtons ?? {})) {
            if (unit === this._weatherUnit)
                button.add_style_class_name('island-weather-unit-active');
            else
                button.remove_style_class_name('island-weather-unit-active');
        }

        const currentDate = (w.time ?? '').slice(0, 10).split('-').map(Number);
        const currentClock = (w.time ?? '').slice(11, 16).split(':').map(Number);
        if (currentDate.length === 3 && currentDate.every(Number.isFinite) && currentClock.length === 2) {
            const weekday = new Date(Date.UTC(currentDate[0], currentDate[1] - 1, currentDate[2]))
                .toLocaleDateString(undefined, {weekday: 'long', timeZone: 'UTC'});
            const hour = currentClock[0] ?? 0;
            const minute = `${currentClock[1] ?? 0}`.padStart(2, '0');
            this._weatherTime.text = `${weekday}, ${hour % 12 || 12}:${minute} ${hour < 12 ? 'am' : 'pm'}`;
        } else {
            this._weatherTime.text = '';
        }
        this._weatherTitle.text = 'Weather';
        this._weatherCondition.text = WEATHER_CODES[w.code] ?? 'Current conditions';

        const currentHour = (w.hourly ?? []).find(h => h.time >= (w.time ?? '')) ?? w.hourly?.[0];
        this._weatherStatRain.text = `Precipitation ${currentHour?.rain ?? 0}%`;
        this._weatherStatHumidity.text = `Humidity ${Math.round(w.humidity)}%`;
        this._weatherStatWind.text = `Wind ${Math.round(w.wind)} km/h`;

        const chartHours = (w.hourly ?? []).filter(h => h.time >= (w.time ?? '')).slice(0, 24);
        const metricKey = this._weatherMetric === 'precipitation' ? 'rain'
            : this._weatherMetric === 'wind' ? 'wind' : 'temp';
        this._weatherChartPoints = chartHours.map(h => {
            const raw = Number(h[metricKey]);
            return {time: h.time, value: Number.isFinite(raw)
                ? (metricKey === 'temp' ? toDisplayTemp(raw) : raw)
                : null};
        }).filter(point => Number.isFinite(point.value));
        for (const [metric, button] of Object.entries(this._weatherMetricButtons ?? {})) {
            if (metric === this._weatherMetric)
                button.add_style_class_name('island-weather-metric-active');
            else
                button.remove_style_class_name('island-weather-metric-active');
        }
        const axisPoints = this._weatherChartPoints;
        this._weatherAxisLabels.forEach((tick, i) => {
            const point = axisPoints[Math.round(i * (axisPoints.length - 1) / 7)];
            if (!point) {
                tick.text = '';
                return;
            }
            const hour = Number(point.time.slice(11, 13));
            tick.text = `${hour % 12 || 12} ${hour < 12 ? 'am' : 'pm'}`;
        });
        this._weatherChartArea.queue_repaint();

        for (const c of this._dailyBox.get_children())
            c.destroy();
        for (const d of (w.daily ?? []).slice(0, 8)) {
            const card = new St.BoxLayout({vertical: true, style_class: 'island-day-card', x_expand: true});
            const dateParts = d.time.split('-').map(Number);
            const date = new Date(Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]));
            card.add_child(new St.Label({
                text: date.toLocaleDateString(undefined, {weekday: 'short', timeZone: 'UTC'}),
                style_class: 'island-day-name', x_align: Clutter.ActorAlign.CENTER,
            }));
            card.add_child(new St.Icon({
                icon_name: WEATHER_ICON[d.code] ?? 'weather-overcast-symbolic',
                icon_size: 23,
                style_class: 'island-day-icon',
                x_align: Clutter.ActorAlign.CENTER,
            }));
            const temps = new St.BoxLayout({style_class: 'island-day-temperatures', x_align: Clutter.ActorAlign.CENTER});
            temps.add_child(new St.Label({text: `${Math.round(toDisplayTemp(d.max))}°`, style_class: 'island-day-high'}));
            temps.add_child(new St.Label({text: `${Math.round(toDisplayTemp(d.min))}°`, style_class: 'island-day-low'}));
            card.add_child(temps);
            this._dailyBox.add_child(card);
        }
        if (!w.daily?.length)
            this._dailyBox.add_child(label('Daily forecast unavailable', 'island-weather-empty'));

        if (this._mode === 'panel' && this._tab === 'weather')
            this._fitPanel();
    }

    _drawWeatherChart(area) {
        let cr;
        try {
            cr = area.get_context();
            const [width, height] = area.get_surface_size();
            cr.save();
            cr.setOperator(0); // Clear the previous metric before painting the new chart.
            cr.paint();
            cr.restore();

            const points = this._weatherChartPoints ?? [];
            if (width < 20 || height < 20 || points.length < 2) {
                cr.setSourceRGBA(0.72, 0.74, 0.80, 0.60);
                cr.selectFontFace('Sans', 0, 0);
                cr.setFontSize(11);
                cr.moveTo(12, Math.max(18, height / 2));
                cr.showText('Forecast unavailable');
                return;
            }

            const values = points.map(point => point.value);
            let min = Math.min(...values);
            let max = Math.max(...values);
            if (this._weatherMetric === 'precipitation') {
                min = 0;
                max = 100;
            } else if (this._weatherMetric === 'wind') {
                min = 0;
                max = Math.max(10, Math.ceil(max / 10) * 10);
            } else {
                min = Math.floor(min - 1);
                max = Math.ceil(max + 1);
            }
            if (max <= min)
                max = min + 1;

            const left = 30;
            const right = width - 8;
            const top = 14;
            const bottom = height - 15;
            const plotWidth = right - left;
            const plotHeight = bottom - top;
            const xAt = i => left + i * plotWidth / (points.length - 1);
            const yAt = value => bottom - (value - min) * plotHeight / (max - min);

            cr.selectFontFace('Sans', 0, 0);
            cr.setFontSize(8);
            for (let i = 0; i <= 3; i++) {
                const value = max - (max - min) * i / 3;
                const y = top + plotHeight * i / 3;
                cr.setSourceRGBA(0.78, 0.80, 0.85, 0.12);
                cr.setLineWidth(1);
                cr.moveTo(left, y);
                cr.lineTo(right, y);
                cr.stroke();
                cr.setSourceRGBA(0.72, 0.74, 0.80, 0.72);
                const unit = this._weatherMetric === 'temperature' ? '°'
                    : this._weatherMetric === 'precipitation' ? '%' : '';
                cr.moveTo(0, y + 3);
                cr.showText(`${Math.round(value)}${unit}`);
            }

            cr.moveTo(xAt(0), bottom);
            points.forEach((point, i) => cr.lineTo(xAt(i), yAt(point.value)));
            cr.lineTo(xAt(points.length - 1), bottom);
            cr.closePath();
            cr.setSourceRGBA(1.0, 0.75, 0.0, 0.18);
            cr.fill();

            points.forEach((point, i) => {
                if (i === 0)
                    cr.moveTo(xAt(i), yAt(point.value));
                else
                    cr.lineTo(xAt(i), yAt(point.value));
            });
            cr.setSourceRGBA(1.0, 0.78, 0.02, 0.98);
            cr.setLineWidth(2.2);
            cr.stroke();

            cr.setFontSize(8);
            const annotate = new Set([0, Math.round((points.length - 1) / 4),
                Math.round((points.length - 1) / 2), Math.round(3 * (points.length - 1) / 4), points.length - 1]);
            for (const i of annotate) {
                const x = xAt(i);
                const y = Math.max(9, yAt(points[i].value) - 7);
                cr.setSourceRGBA(0.85, 0.86, 0.90, 0.78);
                cr.moveTo(Math.max(left, Math.min(right - 20, x - 7)), y);
                cr.showText(`${Math.round(points[i].value)}`);
            }
        } catch (e) {
            LOG('weather chart draw failed', e.message);
        } finally {
            cr?.$dispose();
        }
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._removeTimer(this._collapseId);
        this._removeTimer(this._alertTimerId);
        this._closeWallpaperRequest(this._wallpaperDialog);
        this._wallpaperDialog = null;
        this._clearTimerTicker();
        this._stopMarquee();
        this._stopPixelAnim();
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers = [];
        this._removeStageHandlers();
        if (this._monitorId)
            Main.layoutManager.disconnect(this._monitorId);
        this._monitorId = 0;
        for (const id of this._wallpaperSettingsSignals)
            this._wallpaperSettings?.disconnect(id);
        this._wallpaperSettingsSignals = [];
        this._wallpaperSettings = null;
        if (this._nameSub && this._dbus)
            this._dbus.signal_unsubscribe(this._nameSub);
        this._nameSub = null;
        this._players?.clear();
        for (const id of this._btSubs ?? [])
            this._bluez?.signal_unsubscribe(id);
        this._btSubs = [];
        this._session?.abort?.();
        if (this._powerChangedId && this._power)
            this._power.disconnect(this._powerChangedId);
        this._powerChangedId = 0;
        this._power = null;
        this._frame?.destroy();
        this._frame = null;
        this._capsule = null;
    }
}

export default class IslandImpl {
    enable() {
        // A reload that overlaps another used to leave the previous island
        // alive with its own capsule on screen: two pills, one orphaned. The
        // instance registers itself on globalThis, so a new one can always
        // tear down whatever came before it.
        try {
            globalThis.__island?.destroy?.();
        } catch (e) {
            LOG('stale island destroy failed', e.message);
        }
        globalThis.__island = null;

        this._reloadStylesheet();
        this._island = new Island();
        globalThis.__island = this._island;
        // Take the clock's place in the top bar instead of sitting next to it.
        const dateMenu = Main.panel.statusArea.dateMenu;
        this._dateMenu = dateMenu?.container ?? dateMenu ?? null;
        this._dateMenu?.hide();
        this._hookNotifications();
        LOG('enabled');
    }

    // Hot reload also has to pick up stylesheet.css: the shell caches the
    // theme, so a reloaded impl would otherwise keep the old CSS.
    _reloadStylesheet() {
        try {
            const src = import.meta.url.split('?')[0];
            const [path] = GLib.filename_from_uri(src);
            const file = Gio.File.new_for_path(
                GLib.build_filenamev([GLib.path_get_dirname(path), 'stylesheet.css']));
            const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            theme.unload_stylesheet(file);
            theme.load_stylesheet(file);
        } catch (e) {
            LOG('stylesheet reload failed', e);
        }
    }

    _hookNotifications() {
        const tray = Main.messageTray;
        if (!tray) {
            LOG('no message tray');
            return;
        }
        this._tray = tray;
        this._suppressBanner = true;

        // Every notification reaches its MessageTray.Source through
        // addNotification(); mirroring there works even when the shell has
        // banners blocked (overview, session not yet active).
        const SourceProto = MessageTray.Source.prototype;
        const origAddNotification = SourceProto.addNotification;
        this._origAddNotification = origAddNotification;
        const island = this._island;
        SourceProto.addNotification = function (notification) {
            try {
                island._onNotification(notification);
            } catch (e) {
                LOG('mirror failed', e);
            }
            return origAddNotification.call(this, notification);
        };

        // Suppress the stock banner: the island is the presentation layer now.
        this._origShowNotification = tray._showNotification;
        const origShow = this._origShowNotification;
        if (typeof origShow === 'function') {
            tray._showNotification = function (notification) {
                const result = origShow.call(this, notification);
                try {
                    if (tray._bannerBin)
                        tray._bannerBin.hide();
                } catch (e) {}
                return result;
            };
        }

        if (tray._bannerBin) {
            this._bannerBinHideId = tray._bannerBin.connect('notify::visible', () => {
                if (tray._bannerBin.visible && this._suppressBanner)
                    tray._bannerBin.hide();
            });
            tray._bannerBin.hide();
        }
    }

    disable() {
        this._dateMenu?.show();
        this._dateMenu = null;
        const tray = this._tray;
        if (tray) {
            if (this._bannerBinHideId) {
                tray._bannerBin?.disconnect(this._bannerBinHideId);
                this._bannerBinHideId = 0;
            }
            // _showNotification normally lives on the prototype: drop our
            // own-property override instead of shadowing it forever.
            if (this._origShowNotification && tray._showNotification !== this._origShowNotification)
                delete tray._showNotification;
            try {
                if (tray._bannerBin)
                    tray._bannerBin.show();
            } catch (e) {}
        }
        if (this._origAddNotification) {
            MessageTray.Source.prototype.addNotification = this._origAddNotification;
            this._origAddNotification = null;
        }
        this._suppressBanner = false;
        this._tray = null;
        this._origShowNotification = null;
        this._island?.destroy();
        this._island = null;
        if (globalThis.__island === null || globalThis.__island?._destroyed)
            delete globalThis.__island;
    }
}
