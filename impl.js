import Clutter from 'gi://Clutter';
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
    // 28, not 32: the shell panel is 32 px tall and a full-height pill bled
    // two pixels past it into whatever app sits underneath.
    compact: {width: 300, height: 28, radius: 14, style: 'island-compact'},
    peek: {width: 372, height: 56, radius: 18, style: 'island-peek'},
    panel: {width: 560, height: 380, radius: 22, style: 'island-panel'},
    alert: {width: 392, height: 82, radius: 20, style: 'island-alert'},
};

// The panel hugs its tab: a dashboard does not need the same vertical space
// as the music player. Height animates on tab change, like the real thing.
const PANEL_HEIGHTS = {
    notifications: 366,
    music: 366,
    system: 300,
    battery: 392,
    timer: 312,
    weather: 358,
    clips: 372,
    settings: 392,
};

// An empty tab should not sit in a half-empty capsule: the panel height
// follows what the tab actually has to show.
const panelHeight = (tab, island) => {
    if (tab === 'music' && island && !island._activePlayer?.())
        return 268;
    if (tab === 'notifications' && island && island._feed?.length === 0)
        return 300;
    if (tab === 'clips' && island && island._clips?.length === 0)
        return 300;
    return PANEL_HEIGHTS[tab] ?? MODES.panel.height;
};

const DURATION = 220;

// Fixed footprint of the overlay, sized for the largest mode (panel).
const FRAME = {width: 600, height: 400};
// Distance from the top of the monitor to the capsule. The shell panel is
// 32 px tall; a 1 px margin keeps the rounded corners visible.
const CAP_TOP = 2;
const TABS = [
    {id: 'notifications', label: 'Alerts'},
    {id: 'music', label: 'Music'},
    {id: 'system', label: 'System'},
    {id: 'battery', label: 'Battery'},
    {id: 'timer', label: 'Timer'},
    {id: 'weather', label: 'Weather'},
    {id: 'clips', label: 'Clips'},
    {id: 'settings', label: 'Settings'},
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
// Rows visible before the clip list scrolls; the rest stay one wheel away.
const CLIP_VISIBLE = 4;
const NET_FULL_RATE = 10e6;
const CLIP_ROW_H = 46;

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
    collapseMs: 420,
};

const SPEED = {slow: 0.65, normal: 1, fast: 1.55};
const ACCENTS = ['blue', 'violet', 'green', 'amber'];

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
        this._unseen = 0;
        this._tab = 'notifications';
        this._timers = [];
        this._stageSignals = [];
        this._weather = null;
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
        this._musicPeekText = null;

        this._session = new Soup.Session({timeout: 12});
        this._session.user_agent = 'island-gnome-extension/1.0';

        this._buildUI();
        this._buildCompact();
        this._buildPeek();
        this._buildPanel();
        this._buildAlert();

        this._loadClips();
        this._renderClips();
        this._startClipWatch();

        this._capsule.add_child(this._compact);
        this._capsule.add_child(this._peek);
        this._capsule.add_child(this._panel);
        this._capsule.add_child(this._alert);

        this._showOnly(this._compact);
        this._applySettings();

        this._capsule.connect('notify::hover', () => this._onHoverChanged());
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
            y: CAP_TOP,
            opacity: 255,
        });
        this._capsule.add_style_class_name(MODES.compact.style);

        this._frame.add_child(this._capsule);
        Main.uiGroup.add_child(this._frame);
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

        const row = new St.BoxLayout({style_class: 'island-compact-row'});
        this._dot = new St.Widget({style_class: 'island-dot', y_align: Clutter.ActorAlign.CENTER});
        this._dateCompact = label('', 'island-date-compact');
        this._clockCompact = label('--:--', 'island-clock-small');
        this._tempCompact = label('', 'island-mini');
        this._chargeChip = new St.BoxLayout({
            style_class: 'island-charge-chip',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._chargeIcon = new St.Icon({
            icon_name: 'battery-charging-symbolic',
            icon_size: 14,
            style_class: 'island-charge-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._chargeText = label('', 'island-charge-text');
        this._chargeChip.add_child(this._chargeIcon);
        this._chargeChip.add_child(this._chargeText);
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

        row.add_child(this._dot);
        row.add_child(this._compactArt);
        row.add_child(this._dateCompact);
        row.add_child(this._clockCompact);
        row.add_child(new St.Widget({x_expand: true}));
        row.add_child(this._eq);
        row.add_child(this._chargeChip);
        row.add_child(this._tempCompact);
        row.add_child(this._badge);
        box.add_child(row);
        this._compact = box;
    }

    _buildPeek() {
        const box = this._shell();
        box.add_style_class_name('island-peek-body');

        const row = new St.BoxLayout({style_class: 'island-peek-row'});

        const left = new St.BoxLayout({vertical: true, style_class: 'island-peek-left'});
        this._clockPeek = label('--:--', 'island-clock-big');
        this._datePeek = label('', 'island-sub');
        left.add_child(this._clockPeek);
        left.add_child(this._datePeek);

        const right = new St.BoxLayout({vertical: true, style_class: 'island-peek-right', x_align: Clutter.ActorAlign.END});
        this._weatherPeek = label('', 'island-weather-line');
        this._weatherPeek.width = 224;
        this._weatherPeek.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._systemPeek = label('', 'island-sub');
        this._systemPeek.width = 224;
        this._systemPeek.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        right.add_child(this._weatherPeek);
        right.add_child(this._systemPeek);

        row.add_child(left);
        row.add_child(new St.Widget({x_expand: true}));
        row.add_child(right);
        box.add_child(row);
        this._peek = box;
    }

    _buildPanel() {
        const box = this._shell();
        box.add_style_class_name('island-panel-body');

        const root = new St.BoxLayout({
            vertical: true,
            style_class: 'island-panel-root',
        });

        // header
        const header = new St.BoxLayout({style_class: 'island-header'});
        const hLeft = new St.BoxLayout({vertical: true});
        this._clockPanel = label('--:--', 'island-clock-panel');
        this._datePanel = label('', 'island-sub');
        hLeft.add_child(this._clockPanel);
        hLeft.add_child(this._datePanel);
        header.add_child(hLeft);
        header.add_child(new St.Widget({x_expand: true}));
        const hRight = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.END});
        this._weatherPanel = label('', 'island-weather-line');
        this._batteryPanel = label('', 'island-sub');
        hRight.add_child(this._weatherPanel);
        hRight.add_child(this._batteryPanel);
        header.add_child(hRight);
        root.add_child(header);

        // tabs
        const tabs = new St.BoxLayout({style_class: 'island-tabs'});
        this._tabButtons = {};
        for (const t of TABS) {
            const b = new St.Button({style_class: 'island-tab', reactive: true, can_focus: false});
            b.set_child(new St.Label({text: t.label, style_class: 'island-tab-label'}));
            b.connect('clicked', () => this._selectTab(t.id));
            this._tabButtons[t.id] = b;
            tabs.add_child(b);
        }
        root.add_child(tabs);

        // body stack
        this._body = new St.BoxLayout({
            style_class: 'island-panel-body-area',
            vertical: true,
            x_expand: true,
        });
        // Scrolls when a tab is taller than the panel (Settings, long
        // notification lists) instead of being clipped at the bottom edge.
        this._scroll = new St.ScrollView({
            style_class: 'island-scroll',
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            enable_mouse_scrolling: true,
        });
        this._scroll.set_child(this._body);

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
        for (const [id, view] of Object.entries(this._views)) {
            view.visible = false;
            this._body.add_child(view);
            if (id !== 'notifications')
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
        this._notifView = this._views.notifications;
        this._systemView = this._views.system;
        this._weatherView = this._views.weather;
        this._musicView = this._views.music;
        this._timerView = this._views.timer;
        this._batteryView = this._views.battery;
        this._clipsView = this._views.clips;
        this._settingsView = this._views.settings;
        root.add_child(this._scroll);

        box.add_child(root);
        this._panel = box;
        this._panelRoot = root;
        this._selectTab('notifications');
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

        this._musicEmpty = label('No media player running', 'island-empty');
        this._musicEmpty.x_align = Clutter.ActorAlign.CENTER;
        this._musicEmpty.y_align = Clutter.ActorAlign.CENTER;
        this._musicEmpty.y_expand = true;

        // macOS 27 Dynamic Island media card, rebuilt to spec: a solid black
        // surface with a large rounded cover on the left, title + artist, a
        // speaker glyph at the far right, a full-width progress bar showing
        // elapsed on the left and *remaining* time on the right, and plain
        // white transport controls centred underneath.
        this._musicBody = new St.BoxLayout({vertical: true, style_class: 'island-music', x_expand: true});

        const head = new St.BoxLayout({style_class: 'island-music-head'});
        this._artBin = new St.Bin({style_class: 'island-art', x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER});
        this._art = new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 30, style_class: 'island-art-icon'});
        this._artBin.set_child(this._art);

        const textBox = new St.BoxLayout({vertical: true, style_class: 'island-music-text',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        // Fixed text column: an ellipsized label still reports its full
        // natural width, which would otherwise stretch the whole capsule.
        const TEXT_W = 340;
        this._musicTitle = new St.Label({text: '', style_class: 'island-music-title', width: TEXT_W});
        this._musicTitle.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._musicArtist = new St.Label({text: '', style_class: 'island-music-artist', width: TEXT_W});
        this._musicArtist.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        textBox.add_child(this._musicTitle);
        textBox.add_child(this._musicArtist);

        this._musicSpeaker = new St.Icon({
            icon_name: 'audio-volume-high-symbolic',
            icon_size: 22,
            style_class: 'island-music-speaker',
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        head.add_child(this._artBin);
        head.add_child(textBox);
        head.add_child(this._musicSpeaker);
        this._musicBody.add_child(head);

        // progress + times in one row: elapsed | bar | remaining.
        // The bar sits in a taller strip so it can be clicked and dragged to
        // seek; the visible line stays thin.
        const prog = new St.BoxLayout({style_class: 'island-music-prog', x_expand: true});
        this._musicElapsed = label('0:00', 'island-music-time');
        // St.Bin, not a bare St.Widget: a widget without a layout manager
        // never allocates its child, which collapsed the track to 3 px.
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
        this._musicRemaining = label('-0:00', 'island-music-time');
        prog.add_child(this._musicElapsed);
        prog.add_child(this._seek);
        prog.add_child(this._musicRemaining);
        this._musicProg = prog;
        this._musicBody.add_child(prog);

        const controls = new St.BoxLayout({style_class: 'island-controls', x_align: Clutter.ActorAlign.CENTER});
        this._btnPrev = this._controlButton('media-skip-backward-symbolic', () => this._musicCall('Previous'), 'island-ctl-plain', 26);
        this._btnPlay = this._controlButton('media-playback-start-symbolic', () => this._musicCall('PlayPause'), 'island-ctl-play', 30);
        this._btnNext = this._controlButton('media-skip-forward-symbolic', () => this._musicCall('Next'), 'island-ctl-plain', 26);
        controls.add_child(this._btnPrev);
        controls.add_child(this._btnPlay);
        controls.add_child(this._btnNext);
        this._musicBody.add_child(controls);

        view.add_child(this._musicEmpty);
        view.add_child(this._musicBody);
        return view;
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

        const presets = new St.BoxLayout({style_class: 'island-presets'});
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
        this._timerTrack.set_width(520);
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

        addToggle('clock24', '24-hour clock', 'Show 14:05 instead of 2:05 PM');
        addToggle('showWeather', 'Weather', 'Temperature in the bar');
        addToggle('showBattery', 'Battery', 'Battery line in the panel header');
        addToggle('batteryTab', 'Battery tab', 'Charge, health and cycle count');
        addToggle('showMusic', 'Now playing', 'Show the track in the expanded bar');
        addToggle('liveBattery', 'Battery activity', 'Charging and low battery alerts');
        addToggle('liveDevices', 'Device activity', 'Bluetooth connect alerts');
        addToggle('saveClips', 'Clipboard history', 'Keep copied text on disk');

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

        chipsRow('Animation', 'speed', [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']]);
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
        const w2 = Math.round(this._musicTrack.width * frac);
        this._musicFill.width = w2;
        this._musicElapsed.text = fmtDuration(frac * this._musicLength);
        this._musicRemaining.text = `-${fmtDuration((1 - frac) * this._musicLength)}`;
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

        if (!has) {
            this._musicPeekText = null;
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

        const artUrl = `${meta['mpris:artUrl'] ?? ''}`;
        if (artUrl && artUrl !== this._currentArtUrl) {
            this._currentArtUrl = artUrl;
            this._loadArt(artUrl, (icon, path) => this._setArtwork(icon, path));
        } else if (!artUrl) {
            this._currentArtUrl = null;
            this._setArtwork(null, null);
        }

        this._musicPeekText = title || artist
            ? `♪ ${title}${artist ? ` — ${artist}` : ''}`
            : null;
        this._musicLength = length;
        this._refreshProgress(player, length, force);
        this._refreshCompactBits();
        if (this._mode === 'panel' && this._tab === 'music')
            this._fitPanel();
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
        if (this._musicProg)
            this._musicProg.visible = known;
        if (!known) {
            this._musicFill.width = 0;
            return;
        }
        // A seek we just sent has not reached the player's Position cache yet;
        // keep showing where the user dropped the bar until it catches up.
        if (this._seekPending && GLib.get_monotonic_time() / 1000 < this._seekPending.until)
            position = this._seekPending.pos;
        else
            this._seekPending = null;
        const fraction = length > 0 ? Math.max(0, Math.min(1, position / length)) : 0;
        const width = Math.round((this._musicTrack?.width || 300) * fraction);
        this._musicElapsed.text = fmtDuration(position);
        this._musicRemaining.text = `-${fmtDuration(Math.max(0, length - position))}`;
        if (!force && this._musicFill.width === width)
            return;
        if (force) {
            this._musicFill.width = width;
            return;
        }
        this._musicFill.ease({
            width,
            duration: this._dur(900),
            mode: Clutter.AnimationMode.LINEAR,
        });
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
                        const trackW = this._musicTrack?.width || 300;
                        const width = Math.round(trackW * Math.max(0, Math.min(1, Number(pos) / 1e6 / length)));
                        this._musicElapsed.text = fmtDuration(Number(pos) / 1e6);
                        this._musicRemaining.text = `-${fmtDuration(Math.max(0, length - Number(pos) / 1e6))}`;
                        this._musicFill.ease({
                            width,
                            duration: this._dur(950),
                            mode: Clutter.AnimationMode.LINEAR,
                        });
                    }
                } catch (e) {}
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
        this._timerFill.width = Math.round(520 * fraction);
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
        const view = new St.BoxLayout({vertical: true, style_class: 'island-view',
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL, x_expand: true});
        this._weatherHead = label('', 'island-weather-head');
        this._weatherDetail = label('', 'island-sub');
        view.add_child(this._weatherHead);
        view.add_child(this._weatherDetail);
        this._hourlyBox = new St.BoxLayout({style_class: 'island-hourly', x_expand: true});
        view.add_child(this._hourlyBox);
        this._dailyBox = new St.BoxLayout({vertical: true, style_class: 'island-daily'});
        view.add_child(this._dailyBox);
        return view;
    }

    // ---------- mode ----------

    _showOnly(widget) {
        for (const w of [this._compact, this._peek, this._panel, this._alert])
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
            : mode === 'peek' ? this._peek
            : mode === 'alert' ? this._alert
            : this._panel);

        if (mode === 'panel') {
            size.height = this._measurePanelHeight();
            this._targetPanelHeight = size.height;
        }

        this._capsule.remove_style_class_name(MODES[prev].style);
        this._capsule.add_style_class_name(size.style);

        this._capsule.ease({
            x: Math.round((FRAME.width - size.width) / 2),
            y: CAP_TOP,
            width: size.width,
            height: size.height,
            duration: DURATION,
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

        if (mode === 'compact' || mode === 'peek')
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
            if (this._mode === 'compact')
                this._setMode('peek');
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
            if (this._mode === 'panel' || this._mode === 'peek')
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

        for (const view of Object.values(this._views)) {
            if (view !== next)
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
        } else if (id === 'settings') {
            this._renderSettings();
        }

        // After the tab has laid itself out, size the capsule to the content:
        // no half-empty panels and no clipped rows.
        this._fitPanel();
    }

    // Preferred height of the panel chrome + current tab, clamped so a long
    // notification list scrolls instead of growing off the screen.
    _measurePanelHeight() {
        try {
            const [, nat] = this._panel.get_preferred_height(MODES.panel.width);
            return Math.max(250, Math.min(470, Math.ceil(nat)));
        } catch (e) {
            return panelHeight(this._tab, this);
        }
    }

    _fitPanel() {
        if (this._mode !== 'panel' || !this._capsule || !this._panel)
            return;
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
        this._refreshCompactBits();
        this._refreshSystem();
        this._applyTabVisibility();
    }

    _setSetting(key, value) {
        this._settings[key] = value;
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

    _removeTimer(id) {
        if (!id)
            return;
        GLib.source_remove(id);
    }

    // ---------- clock ----------

    _tickClock() {
        const now = new Date();
        const t = fmtTime(now, this._settings.clock24);
        this._clockCompact.text = t;
        this._dateCompact.text = fmtDateShort(now);
        this._clockPeek.text = t;
        this._clockPanel.text = t;
        this._datePeek.text = fmtDate(now);
        this._datePanel.text = fmtDate(now);
    }

    _refreshCompactBits() {
        const batt = this._battery();
        this._systemPeek.text = batt ? `${batt.percent}% ${batt.state}` : '';
        this._batteryPanel.text = batt && this._settings.showBattery
            ? `${batt.percent}% ${batt.state}`
            : '';
        this._batteryPanel.visible = !!batt && this._settings.showBattery;

        // Compact slot: timer wins, then charging, then weather.
        const charging = !!batt && this._settings.liveBattery && batt.charging;
        if (this._chargeChip) {
            this._chargeChip.visible = charging;
            if (charging)
                this._chargeText.text = `${batt.percent}%`;
        }
        let mini = '';
        if (this._timerRunning || (this._timerRemaining > 0 && this._timerRemaining < this._timerTotal))
            mini = `⏱ ${this._timerText(this._timerRemaining)}`;
        else if (this._settings.showWeather && this._weather?.available)
            mini = `${Math.round(this._weather.temp)}°`;
        this._tempCompact.text = charging ? '' : mini;
        this._tempCompact.visible = !!mini && !charging;

        const weatherLine = this._weather?.available
            ? `${WEATHER_GLYPH[this._weather.code] ?? ''} ${Math.round(this._weather.temp)}°  ${WEATHER_CODES[this._weather.code] ?? ''}`
            : 'Weather unavailable';
        this._weatherPeek.text = this._settings.showWeather ? weatherLine : '';
        this._weatherPeek.visible = !!this._settings.showWeather;
        if (this._weatherPanel) {
            this._weatherPanel.text = weatherLine;
            this._weatherPanel.visible = !!this._settings.showWeather;
        }

        // Peek: now-playing echoes in the right column under the weather line.
        if (this._settings.showMusic && this._musicPeekText)
            this._systemPeek.text = this._musicPeekText;

        // Compact / peek now-playing: macOS style - artwork thumbnail and a
        // live three-bar equaliser while something is actually playing.
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
                this._setMode(this._capsule?.hover ? 'peek' : 'compact');
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
                width: 366,
            }));
            if (item.body) {
                text.add_child(new St.Label({
                    text: item.body,
                    style_class: 'island-notif-body',
                    width: 366,
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
    }

    _clearAllNotifications() {
        const items = this._feed.slice();
        for (const item of items)
            this._dismissNotification(item);
        this._unseen = 0;
        this._updateBadge();
        this._renderFeed();
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
            if (has) {
                const rows = Math.min(this._clips.length, CLIP_VISIBLE);
                this._clipScroll.height = rows * CLIP_ROW_H + (rows - 1) * 8;
                this._clipScroll.vscrollbar_policy = this._clips.length > CLIP_VISIBLE
                    ? St.PolicyType.EXTERNAL : St.PolicyType.NEVER;
            }
        }
        this._clipCount.text = `${this._clips.length} clip${this._clips.length === 1 ? '' : 's'}`
            + (this._clips.length > CLIP_VISIBLE ? ' · scroll' : '');
        for (const item of this._clips) {
            const row = new St.BoxLayout({style_class: `island-clip${item.flash ? ' island-clip-flash' : ''}`,
                x_expand: true});
            const textBox = new St.BoxLayout({vertical: true, style_class: 'island-clip-text', x_expand: true});
            const main = new St.Label({text: item.text, style_class: 'island-clip-main', width: 352});
            main.clutter_text.ellipsize = Pango.EllipsizeMode.END;
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

        const batt = this._battery();
        this._batteryPanel.text = batt ? `Battery ${batt.percent}% · ${batt.state}` : 'No battery';
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
            this._fetchWeather(lat, lon, w?.name ?? null);
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
            this._fetchWeather(hit.latitude, hit.longitude, hit.name);
        });
    }

    _fetchWeather(lat, lon, name) {
        const params = [
            'current=temperature_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,relative_humidity_2m',
            'hourly=temperature_2m,precipitation_probability,weather_code',
            'daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max',
            'timezone=auto', 'forecast_days=2',
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
                humidity: Number(c.relative_humidity_2m),
                wind: Number(c.wind_speed_10m),
                rain: Number(c.precipitation),
                name: name ?? '',
                hourly: (json.hourly?.time ?? []).map((t, i) => ({
                    time: t,
                    temp: json.hourly?.temperature_2m?.[i] ?? null,
                    rain: json.hourly?.precipitation_probability?.[i] ?? null,
                    code: json.hourly?.weather_code?.[i] ?? null,
                })),
                daily: (json.daily?.time ?? []).map((t, i) => ({
                    time: t,
                    max: json.daily?.temperature_2m_max?.[i] ?? null,
                    min: json.daily?.temperature_2m_min?.[i] ?? null,
                    rain: json.daily?.precipitation_probability_max?.[i] ?? null,
                })),
            };
            this._renderWeather();
            this._refreshCompactBits();
        });
    }

    _renderWeather() {
        const w = this._weather;
        if (!w || !w.available) {
            this._weatherHead.text = 'Weather unavailable';
            this._weatherDetail.text = 'No location configured';
            return;
        }
        this._weatherHead.text = `${WEATHER_GLYPH[w.code] ?? ''}  ${Math.round(w.temp)}°C  ·  ${WEATHER_CODES[w.code] ?? ''}`;
        this._weatherDetail.text = `${w.name ? `${w.name} · ` : ''}feels ${Math.round(w.feels)}° · humidity ${Math.round(w.humidity)}% · wind ${Math.round(w.wind)} km/h`;

        for (const c of this._hourlyBox.get_children())
            c.destroy();
        const start = new Date();
        const hour = start.getHours();
        const items = (w.hourly ?? []).filter(h => {
            const hh = Number(h.time?.slice(11, 13));
            return hh >= hour;
        }).slice(0, 6);
        for (const h of items) {
            const cell = new St.BoxLayout({vertical: true, style_class: 'island-hour'});
            cell.add_child(new St.Label({text: `${pad(Number(h.time.slice(11, 13)))}:00`, style_class: 'island-hour-time'}));
            cell.add_child(new St.Label({text: WEATHER_GLYPH[h.code] ?? '', style_class: 'island-hour-glyph'}));
            cell.add_child(new St.Label({text: h.temp == null ? '' : `${Math.round(h.temp)}°`, style_class: 'island-hour-temp'}));
            cell.add_child(new St.Label({text: h.rain == null ? '' : `${h.rain}%`, style_class: 'island-hour-rain'}));
            this._hourlyBox.add_child(cell);
        }

        for (const c of this._dailyBox.get_children())
            c.destroy();
        for (const d of (w.daily ?? []).slice(0, 2)) {
            const row = new St.BoxLayout({style_class: 'island-day'});
            const date = new Date(`${d.time}T12:00:00`);
            row.add_child(new St.Label({
                text: date.toLocaleDateString(undefined, {weekday: 'short'}),
                style_class: 'island-day-name',
            }));
            row.add_child(new St.Widget({x_expand: true}));
            row.add_child(new St.Label({text: `${Math.round(d.min)}° / ${Math.round(d.max)}°`, style_class: 'island-day-temp'}));
            row.add_child(new St.Label({text: `☂ ${d.rain ?? 0}%`, style_class: 'island-day-rain'}));
            this._dailyBox.add_child(row);
        }

        if (this._mode === 'panel' && this._tab === 'weather')
            this._fitPanel();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._removeTimer(this._collapseId);
        this._removeTimer(this._alertTimerId);
        this._clearTimerTicker();
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers = [];
        this._removeStageHandlers();
        if (this._monitorId)
            Main.layoutManager.disconnect(this._monitorId);
        this._monitorId = 0;
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
