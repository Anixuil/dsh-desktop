//! DSH Desktop — Windows shell for DeepSeek Harness.
//!
//! Owns: bundled Node + dsh runtime lifecycle, health check, window navigation,
//! API-key management (→ DSH credentials), balance queries, the turn-end
//! bridge listener, the system tray, and logging.

use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Listener, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::ManagerExt;

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const DSH_WEB_PORT_DEFAULT: u16 = 3080;
const CREDENTIAL_NAME: &str = "DEEPSEEK_API_KEY";
/// Default GitHub repo (`owner/repo`) for shell update checks — this very
/// codebase. Overridable through config `update_repo` or the
/// `DSH_DESKTOP_UPDATE_REPO` env var.
const DEFAULT_UPDATE_REPO: &str = "Anixuil/dsh-desktop";
const BRIDGE_PATCH_YML: &str = include_str!("../../scripts/bridge.patch.yml");
const MIN_REFRESH_INTERVAL_SECS: u64 = 3;
/// Desktop plugin packages deployed from `runtime/plugins-src` into both the
/// dsh module tree (update restore) and the boot-time profile tree
/// (`ensure_runtime_files`). Each name doubles as its `--patch` row id.
const DESKTOP_PLUGINS: [&str; 2] = ["dsh-desktop-bridge", "dsh-desktop-session-manager"];
/// Bundled third-party plugin (github.com/tianmingwan/dsh-vision-any). Ships in
/// `runtime/plugins-src` and mounts through the web profile's `bundles` list —
/// the same contract `dsh plugin --profile web add` uses — so it loads for both
/// the desktop-hosted kernel and a CLI `dsh web` sharing the same `$DSH_HOME`.
const VISION_PLUGIN: &str = "dsh-vision-any";
/// The shipped template bundles for the `web` profile (mirrors dsh's own
/// `PROFILE_TEMPLATES.web`, used only when the desktop creates the profile).
const WEB_TEMPLATE_BUNDLES: [&str; 2] = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
/// Mirrors dsh-app-boot's `PROFILE_PATCH_TEMPLATE` / `PROFILE_PNPM_WORKSPACE` so
/// a desktop-created profile behaves exactly like a `dsh plugin`-initialized one.
const PROFILE_PATCH_TEMPLATE: &str = "# Your patch layer for this dsh profile, applied after every bundle layer:\n\
# a top-level YAML array of loader patch entries (id-targeted config\n\
# overrides, disables, and insert lists; `!!js` expressions allowed).\n\
[]\n";
const PROFILE_PNPM_WORKSPACE: &str = "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";
/// Injected on every document (including the remote dsh web UI): the desktop
/// app never shows the browser's default right-click context menu.
const INIT_SCRIPT: &str = r#"window.addEventListener('contextmenu', (e) => e.preventDefault(), true);"#;

/// Initialization script that publishes the persisted motion intensity as
/// `window.__DSH_MOTION__` ("quiet" | "rich") on every document of a window —
/// including the remote dsh web UI. Page scripts read it before first paint,
/// so the splash/settings/injected transitions never flash the wrong mode.
/// Live changes ride the `motion-updated` event.
fn motion_init_script(motion: MotionIntensity) -> String {
    let value = serde_json::to_string(&motion).unwrap_or_else(|_| "\"rich\"".to_string());
    format!("window.__DSH_MOTION__ = {value};")
}
/// Served client bundle of the settings shell (`dsh-client-ui-settings-general`),
/// relative to `runtime_dir`. Its `navIcon` hard-codes a glyph per settings
/// section id and falls back to the settings gear for unknown ids — the
/// desktop extends it with dedicated glyphs for its own sections.
const SETTINGS_SHELL_BUNDLE: [&str; 6] = [
    "dsh",
    "node_modules",
    "@deepseek-ai",
    "dsh-client-ui-settings-general",
    "lib",
    "client.js",
];
/// Marker comment injected by the settings-nav-icon patch; its presence means
/// the bundle is already patched (idempotence across boots and dsh updates).
const SETTINGS_NAV_ICONS_MARKER: &str = "dsh-desktop-settings-nav-icons";
/// The shell's fallback nav-glyph branch (gear icon) — the exact insertion
/// point for the desktop section branches. Matched verbatim against the
/// upstream bundle; a future dsh build that reshapes `navIcon` loses the match
/// and the patch skips gracefully.
const SETTINGS_NAV_ICONS_ANCHOR: &str = "\t\t\treturn (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutline16, {\n\t\t\t\tclassName: SettingsRoot_module_css_default.navIcon,\n\t\t\t\tsize: 16\n\t\t\t});";
/// Branches inserted before the anchor: a hand-drawn eye glyph for the
/// vision-model section (`vision-any`), the list-pen glyph from
/// dsh-client-ui-primitives for the session manager (`session-manager`), and
/// the user glyph for the About page (`about`). Tab-indented to match the
/// bundle's formatting (the JS parser does not care; readability does).
const SETTINGS_NAV_ICONS_INSERT: &str = r#"			/* dsh-desktop-settings-nav-icons: dedicated glyphs for the desktop-owned sections. */
			if (id === "vision-any") return (0, react_jsx_runtime.jsx)("svg", {
				width: 16,
				height: 16,
				className: SettingsRoot_module_css_default.navIcon,
				viewBox: "0 0 16 16",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
				children: (0, react_jsx_runtime.jsx)("path", {
					fillRule: "evenodd",
					clipRule: "evenodd",
					d: "M16 8C16 8 12.5 3 8 3C3.5 3 0 8 0 8C0 8 3.5 13 8 13C12.5 13 16 8 16 8ZM8 10.6C6.5641 10.6 5.4 9.4359 5.4 8C5.4 6.5641 6.5641 5.4 8 5.4C9.4359 5.4 10.6 6.5641 10.6 8C10.6 9.4359 9.4359 10.6 8 10.6Z",
					fill: "currentColor"
				})
			});
			if (id === "session-manager") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconListPenOutline16, {
				className: SettingsRoot_module_css_default.navIcon,
				size: 16
			});
			if (id === "about") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconUserOutline16, {
				className: SettingsRoot_module_css_default.navIcon,
				size: 16
			});
"#;

/// Injected on every document of the main window. On the remote dsh web UI it
/// draws the desktop shell's custom title bar (the window is undecorated, see
/// the main window builder) and pushes the page content below it. Guarded by
/// protocol so it never runs in a normal browser or on the shell's own
/// tauri://localhost pages (the splash has its own in-page title bar).
///
/// Mounting is defensive: this script executes at "document created" time,
/// when `document.documentElement` may not exist yet, and the dsh app may
/// rebuild parts of the DOM — so it retries via DOMContentLoaded, a short
/// interval, and a slow re-arm watcher. State is reported to the shell via a
/// `dsh-titlebar-state` event (logged to dsh.log).
const TITLEBAR_SCRIPT: &str = r#"
(function () {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  var BAR_ID = '__dsh_desktop_titlebar__';
  var STYLE_ID = BAR_ID + '-style';
  var H = 40;

  function report(state, detail) {
    try {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('dsh-titlebar-state', { state: state, detail: detail || '' });
      }
    } catch (e) {}
    try { console.log('[dsh-desktop titlebar]', state, detail || ''); } catch (e) {}
  }

  // Motion intensity: mirror the persisted value so quiet mode can drop the
  // entrance animation and micro-transitions on this page. `__DSH_MOTION__`
  // is injected by the shell before document scripts run; live changes arrive
  // through the `motion-updated` event.
  var MOTION_ATTR = 'data-dsh-motion';
  function motionValue() {
    try { return window.__DSH_MOTION__ === 'quiet' ? 'quiet' : 'rich'; } catch (e) { return 'rich'; }
  }
  function applyMotionAttr(m) {
    try { document.documentElement.setAttribute(MOTION_ATTR, m); } catch (e) {}
  }
  applyMotionAttr(motionValue());
  try {
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('motion-updated', function (e) {
        var m = e && e.payload && e.payload.motion;
        applyMotionAttr(m === 'quiet' ? 'quiet' : 'rich');
      });
    }
  } catch (e) {}

  // Bar colors are driven by the dsh design tokens (`--dsw-alias-*`): the dsh
  // app flips them when the user switches themes (body[data-ds-dark-theme]),
  // so the title bar follows light/dark automatically. Fallbacks match the
  // default light theme in case the dsh stylesheet has not applied yet.
  var css =
    '#' + BAR_ID + '{position:fixed;top:0;left:0;right:0;height:' + H + 'px;z-index:2147483000;' +
    'display:flex;align-items:center;justify-content:space-between;' +
    'background:var(--dsw-alias-bg-base,#fff);' +
    'border-bottom:1px solid var(--dsw-alias-border-l2,rgba(17,24,39,.08));' +
    'box-sizing:border-box;padding:0 8px 0 14px;' +
    'font-family:var(--dsw-font-family,"Segoe UI","Microsoft YaHei",system-ui,sans-serif);' +
    'color:var(--dsw-alias-label-primary,#0f1115);' +
    '-webkit-user-select:none;user-select:none;' +
    'animation:dsh-bar-in .34s cubic-bezier(.22,1,.36,1) both;}' +
    '@keyframes dsh-bar-in{from{opacity:0;transform:translateY(-8px)}}' +
    'html[data-dsh-motion="quiet"] #' + BAR_ID + '{animation:none;}' +
    '#' + BAR_ID + ' .__t{font-size:12px;line-height:1;color:var(--dsw-alias-label-secondary,#61666b);white-space:nowrap;overflow:hidden;}' +
    '#' + BAR_ID + ' .__c{display:flex;align-items:center;gap:2px;flex:none;}' +
    '#' + BAR_ID + ' button{width:34px;height:26px;display:inline-flex;align-items:center;justify-content:center;' +
    'border:none;border-radius:6px;background:transparent;padding:0;margin:0;cursor:pointer;' +
    'color:var(--dsw-alias-label-secondary,#3b3f46);outline:none;' +
    'transition:background .16s ease,color .16s ease,transform .12s cubic-bezier(.34,1.56,.64,1);}' +
    '#' + BAR_ID + ' button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(17,24,39,.07));}' +
    '#' + BAR_ID + ' button:active{background:var(--dsw-alias-interactive-bg-hover,rgba(17,24,39,.13));transform:scale(.9);}' +
    '#' + BAR_ID + ' button.__close:hover{background:#e81123;color:#fff;}' +
    '#' + BAR_ID + ' button.__close:active{background:#c50f1f;color:#fff;}' +
    'html[data-dsh-motion="quiet"] #' + BAR_ID + ' button{transition:none;}' +
    '#' + BAR_ID + ' svg{width:10px;height:10px;display:block;pointer-events:none;}' +
    'html body{padding-top:' + H + 'px !important;box-sizing:border-box !important;}';

  var svg = {
    min: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>',
    max: '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    restore: '<svg viewBox="0 0 10 10" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1" d="M2.5 2.5V.5h7v7h-2"/><rect x=".5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    close: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1"/></svg>'
  };

  function wire(bar) {
    try {
      if (!window.__TAURI__ || !window.__TAURI__.window) {
        report('mounted-no-api', 'bar visible but window controls unavailable');
        return;
      }
      var win = window.__TAURI__.window.getCurrentWindow();
      var setMaxIcon = function (maximized) {
        var btn = bar.querySelector('button[data-act="max"]');
        if (!btn) return;
        btn.innerHTML = maximized ? svg.restore : svg.max;
        btn.title = maximized ? '向下还原' : '最大化';
        btn.setAttribute('aria-label', maximized ? '向下还原' : '最大化');
      };
      bar.querySelector('button[data-act="min"]').addEventListener('click', function () { win.minimize(); });
      bar.querySelector('button[data-act="max"]').addEventListener('click', function () { win.toggleMaximize(); });
      bar.querySelector('button[data-act="close"]').addEventListener('click', function () { win.close(); });
      var sync = function () { win.isMaximized().then(setMaxIcon).catch(function () {}); };
      try { win.onResized(sync); } catch (e) {}
      sync();
      report('mounted', 'bar + window controls active');
    } catch (e) {
      report('wire-error', String(e));
    }
  }

  function mount() {
    if (document.getElementById(BAR_ID)) return true;
    if (!document.body || !document.head) return false;
    try {
      if (!document.getElementById(STYLE_ID)) {
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = css;
        document.head.appendChild(style);
      }
      var bar = document.createElement('div');
      bar.id = BAR_ID;
      bar.setAttribute('data-tauri-drag-region', 'deep');
      bar.innerHTML =
        '<span class="__t">DeepSeek Harness</span>' +
        '<span class="__c">' +
        '<button data-act="min" title="最小化" aria-label="最小化">' + svg.min + '</button>' +
        '<button data-act="max" title="最大化" aria-label="最大化">' + svg.max + '</button>' +
        '<button data-act="close" class="__close" title="关闭" aria-label="关闭">' + svg.close + '</button>' +
        '</span>';
      document.body.appendChild(bar);
      wire(bar);
      return true;
    } catch (e) {
      report('mount-error', String(e));
      return false;
    }
  }

  // primary path: document-start, retried by several independent triggers
  if (!mount()) {
    document.addEventListener('DOMContentLoaded', function () { mount(); }, { once: true });
    var tries = 0;
    var iv = setInterval(function () {
      tries += 1;
      if (mount() || tries > 120) clearInterval(iv);
    }, 250);
  }

  // slow re-arm: if the dsh app wipes/replaces the DOM, mount again
  setInterval(function () {
    if (document.body && !document.getElementById(BAR_ID)) mount();
  }, 1000);
})();
"#;

/// Injected on every document of the main window (remote dsh web UI only).
/// Animates the dsh light/dark theme switch with a DeepSeek-ocean transition:
///
/// - The dsh `ThemePresenter` (dsh-client-ui-layout) applies themes via
///   `document.body.setAttribute/removeAttribute('data-ds-dark-theme')`. We
///   hook those methods on `HTMLBodyElement.prototype` (pass-through for
///   everything else) and run the flip inside `document.startViewTransition`,
///   so the old theme "dives" down and the new one "surfaces" — GPU-composited
///   snapshot animations (transform/opacity only).
/// - On top of that a short-lived overlay plays DeepSeek branding: a deep-sea
///   gradient tint, two counter-drifting wave bands, and the whale silhouette
///   (masked from the dsh favicon) gliding across. All overlay motion is
///   transform/opacity only.
/// - Falls back to overlay-only when View Transitions or reduced-motion
///   policies are unavailable; boot-time application is never animated.
/// - Follows the persisted motion intensity: `quiet` (or reduced-motion)
///   flips instantly, `rich` plays the full ocean transition.
const THEME_TRANSITION_SCRIPT: &str = r#"
(function () {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  var ATTR = 'data-ds-dark-theme';
  var OVERLAY_ID = '__dsh_theme_wave__';
  var STYLE_ID = OVERLAY_ID + '-style';

  function prefersReduced() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  // Motion intensity: rich plays the full ocean transition (waves + whale
  // glide); quiet flips instantly like reduced-motion. The persisted value is
  // injected as `window.__DSH_MOTION__` before page scripts and updates live
  // through the `motion-updated` event.
  var MOTION_ATTR = 'data-dsh-motion';
  function applyMotionAttr(m) {
    try { document.documentElement.setAttribute(MOTION_ATTR, m); } catch (e) {}
  }
  function isQuiet() {
    return prefersReduced() || document.documentElement.getAttribute(MOTION_ATTR) === 'quiet';
  }
  function motionValue() {
    try { return window.__DSH_MOTION__ === 'quiet' ? 'quiet' : 'rich'; } catch (e) { return 'rich'; }
  }
  applyMotionAttr(motionValue());
  try {
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('motion-updated', function (e) {
        var m = e && e.payload && e.payload.motion;
        applyMotionAttr(m === 'quiet' ? 'quiet' : 'rich');
      });
    }
  } catch (e) {}

  var css =
    '::view-transition-group(root){animation-duration:.62s;animation-timing-function:cubic-bezier(.22,1,.36,1)}' +
    '::view-transition-old(root){animation-name:dsh-theme-dive;animation-duration:.38s;animation-timing-function:cubic-bezier(.45,0,.8,.45);animation-fill-mode:forwards}' +
    '::view-transition-new(root){animation-name:dsh-theme-surface;animation-duration:.62s;animation-timing-function:cubic-bezier(.22,1,.36,1);animation-fill-mode:both}' +
    '@keyframes dsh-theme-dive{to{opacity:0;transform:translateY(2.5%) scale(1.012)}}' +
    '@keyframes dsh-theme-surface{from{opacity:0;transform:translateY(2.5%) scale(.992)}}' +
    '#' + OVERLAY_ID + '{position:fixed;inset:0;pointer-events:none;z-index:2147482000;overflow:hidden;transition:opacity .25s ease}' +
    '#' + OVERLAY_ID + '.wv-out{opacity:0}' +
    '#' + OVERLAY_ID + ' .wv-tint{position:absolute;inset:0;opacity:0;animation:wv-fadein .16s ease-out forwards}' +
    '#' + OVERLAY_ID + ' .wv-wave{position:absolute;left:0;bottom:-8px;width:200%;height:132px;will-change:transform}' +
    '#' + OVERLAY_ID + ' .wv-wave svg{display:block;width:100%;height:100%}' +
    '#' + OVERLAY_ID + ' .wv-w1{animation:wv-drift 2.2s linear infinite}' +
    '#' + OVERLAY_ID + ' .wv-w2{animation:wv-drift-rev 3.1s linear infinite}' +
    '#' + OVERLAY_ID + ' .wv-whale{position:absolute;top:30%;left:0;width:88px;height:88px;opacity:.92;' +
    '-webkit-mask:url("/favicon.svg") center/contain no-repeat;mask:url("/favicon.svg") center/contain no-repeat;' +
    'filter:drop-shadow(0 10px 26px rgba(29,78,216,.5));animation:wv-glide .75s cubic-bezier(.3,.6,.3,1) .15s both}' +
    '@keyframes wv-fadein{to{opacity:1}}' +
    '@keyframes wv-drift{to{transform:translateX(-50%)}}' +
    '@keyframes wv-drift-rev{from{transform:translateX(-50%)}to{transform:translateX(0)}}' +
    '@keyframes wv-glide{from{transform:translateX(-12vw) rotate(-12deg)}55%{transform:translateX(44vw) rotate(5deg)}to{transform:translateX(112vw) rotate(-8deg)}}';

  // Two full swell periods per 1200px strip → seamless translateX(±50%) loop.
  // Each 600px half is one identical swell cycle whose start/end slopes match
  // (ctrl pairs mirror across the seam), so the loop has no visible joint.
  var WAVE_A = 'M0 84 C75 46 225 46 300 84 C375 122 525 122 600 84 C675 46 825 46 900 84 C975 122 1125 122 1200 84 V120 H0 Z';
  var WAVE_B = 'M0 100 C90 62 210 62 300 100 C390 138 510 138 600 100 C690 62 810 62 900 100 C990 138 1110 138 1200 100 V120 H0 Z';

  function ensureStyle() {
    if (!document.head || document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    document.head.appendChild(s);
  }

  function waveSvg(pathD, fill, opacity) {
    return '<svg viewBox="0 0 1200 120" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="' + pathD + '" fill="' + fill + '" fill-opacity="' + opacity + '"/></svg>';
  }

  function buildOverlay(toDark) {
    if (!document.body) return null;
    try {
      var old = document.getElementById(OVERLAY_ID);
      if (old && old.parentNode) old.parentNode.removeChild(old);
      var root = document.createElement('div');
      root.id = OVERLAY_ID;
      var tint = document.createElement('div');
      tint.className = 'wv-tint';
      tint.style.background = toDark
        ? 'linear-gradient(180deg, rgba(15,42,96,.22), rgba(23,58,150,0) 62%)'
        : 'linear-gradient(180deg, rgba(77,107,254,.10), rgba(147,197,253,0) 62%)';
      var w2 = document.createElement('div');
      w2.className = 'wv-wave wv-w2';
      w2.innerHTML = waveSvg(WAVE_B, toDark ? '#4D6BFE' : '#60A5FA', toDark ? .30 : .26);
      var w1 = document.createElement('div');
      w1.className = 'wv-wave wv-w1';
      w1.innerHTML = waveSvg(WAVE_A, toDark ? '#1D4ED8' : '#93C5FD', toDark ? .48 : .52);
      var whale = document.createElement('div');
      whale.className = 'wv-whale';
      whale.style.background = toDark ? '#8FA3FF' : '#4D6BFE';
      root.appendChild(tint);
      root.appendChild(w2);
      root.appendChild(w1);
      root.appendChild(whale);
      document.body.appendChild(root);
      return root;
    } catch (e) { return null; }
  }

  var active = false;
  function finish(overlay) {
    setTimeout(function () {
      active = false;
      if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 1180);
  }

  // Themed flip: view-transition crossfade (dive/surface) + ocean overlay.
  function flipWithTransition(body, targetHas) {
    ensureStyle();
    var overlay = null;
    var applied = false;
    var apply = function () {
      if (targetHas) body.setAttribute(ATTR, '');
      else body.removeAttribute(ATTR);
      applied = true;
    };
    if (!isQuiet() && document.readyState === 'complete') {
      try {
        if (typeof document.startViewTransition === 'function') {
          document.startViewTransition(function () {
            apply();
            overlay = buildOverlay(targetHas);
          });
        }
      } catch (e) {}
    }
    if (!applied) {
      // fallback path: flip instantly, then play the overlay alone
      apply();
      overlay = buildOverlay(targetHas);
    }
    if (overlay) {
      setTimeout(function () {
        if (overlay && overlay.parentNode) overlay.classList.add('wv-out');
      }, 900);
      finish(overlay);
    } else {
      active = false;
    }
  }

  // Hook HTMLBodyElement attribute mutations (dsh ThemePresenter path).
  function installHook() {
    var proto = window.HTMLBodyElement ? window.HTMLBodyElement.prototype : window.Element.prototype;
    ['setAttribute', 'removeAttribute'].forEach(function (name) {
      var original = proto[name];
      if (!original || original.__dshThemeHook) return;
      var hooked = function (attr, value) {
        if (this !== document.body || attr !== ATTR) return original.apply(this, arguments);
        var targetHas = name === 'setAttribute';
        if (this.hasAttribute(ATTR) === targetHas) return original.apply(this, arguments);
        if (active || isQuiet()) return original.apply(this, arguments);
        active = true;
        flipWithTransition(this, targetHas);
        return undefined;
      };
      try { hooked.__dshThemeHook = true; } catch (e) {}
      try { proto[name] = hooked; } catch (e) {}
    });
  }

  installHook();
})();
"#;

/// Injected on every document of the main window (remote dsh web UI only).
/// Re-skins the whole dsh interface with the desktop's ocean theme by
/// overriding the dsh design tokens (`--dsw-static-*` / `--dsw-alias-*`,
/// defined on `body` / `body[data-ds-dark-theme]` by dsh-client-ui-theme).
/// The app consumes these tokens everywhere, so a token override restyles the
/// entire UI without touching its DOM:
///
/// - Light theme becomes "sea glass": clearly blue-tinted surfaces, deep-sea
///   blue primary buttons (the near-black buttons become ocean blue), and
///   water edges instead of plain black-alpha borders.
/// - Dark theme becomes "deep sea": the same navy ramp as the desktop shell
///   pages (ocean-950 … foam white), with water-light borders.
/// - DeepSeek brand blues stay untouched (the whale stays the whale).
/// - A pointer-transparent ambient layer adds living ocean motion over both
///   themes: two counter-drifting wave bands at the bottom, rising bubbles,
///   and two slowly breathing glows. Transform/opacity only; gated by the
///   persisted motion intensity (`rich` animates, `quiet` freezes waves and
///   glows and hides bubbles) and by prefers-reduced-motion.
/// - Everything follows the app's live `data-ds-dark-theme` flips (the
///   THEME_TRANSITION_SCRIPT above owns the transition itself).
///
/// Selectors carry extra specificity (`html body`, `html
/// body[data-ds-dark-theme]`) so the overrides win regardless of injection
/// order relative to the app's stylesheets.
const OCEAN_THEME_SCRIPT: &str = r#"
(function () {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
  // The shell re-evals this script after navigation (3s/10s fallback); the
  // first instance owns the listeners, re-arm watchers and state machine —
  // later evals must not register duplicate dsh-wave-state listeners.
  if (window.__DSH_OCEAN_READY__) return;
  try { window.__DSH_OCEAN_READY__ = true; } catch (e) {}
  var STYLE_ID = '__dsh_ocean_theme__';
  var AMBIENT_ID = '__dsh_ocean_ambient__';

  function report(state, detail) {
    try {
      if (window.__TAURI__ && window.__TAURI__.event) {
        window.__TAURI__.event.emit('dsh-ocean-theme', { state: state, detail: detail || '' });
      }
    } catch (e) {}
    try { console.log('[dsh-desktop ocean-theme]', state, detail || ''); } catch (e) {}
  }

  // Motion intensity — defensively, the title bar script already set the attr
  var MOTION_ATTR = 'data-dsh-motion';
  function motionValue() {
    try { return window.__DSH_MOTION__ === 'quiet' ? 'quiet' : 'rich'; } catch (e) { return 'rich'; }
  }
  function applyMotionAttr(m) {
    try { document.documentElement.setAttribute(MOTION_ATTR, m); } catch (e) {}
  }
  applyMotionAttr(motionValue());
  try {
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('motion-updated', function (e) {
        var m = e && e.payload && e.payload.motion;
        applyMotionAttr(m === 'quiet' ? 'quiet' : 'rich');
        syncEngine();
      });
    }
  } catch (e) {}

  // Seamless strips: two identical 600px periods per 1200px strip with slope
  // continuity at the seams, so the translateX loop has no visible joint.
  // One profile per band: the main band's shape is fixed — states modulate
  // its speed / amplitude / color instead of swapping shapes.
  var P_SWELL  = 'M0 84 C75 46 225 46 300 84 C375 122 525 122 600 84 C675 46 825 46 900 84 C975 122 1125 122 1200 84 V120 H0 Z';
  var P_RIPPLE = 'M0 84 C90 64 210 64 300 84 C390 104 510 104 600 84 C690 64 810 64 900 84 C990 104 1110 104 1200 84 V120 H0 Z';

  var css =
    // ---- light theme: sea glass (blue-forward) ----
    'html body{' +
    '--dsw-static-neutral-bluish-00:rgb(243,247,253);' +
    '--dsw-static-neutral-bluish-50:rgb(233,240,250);' +
    '--dsw-static-neutral-bluish-60:rgb(230,238,249);' +
    '--dsw-static-neutral-bluish-75:rgb(223,233,246);' +
    '--dsw-static-neutral-bluish-100:rgb(212,225,242);' +
    '--dsw-static-neutral-bluish-150:rgb(202,218,239);' +
    '--dsw-static-neutral-bluish-200:rgb(188,206,232);' +
    '--dsw-static-neutral-bluish-300:rgb(166,188,220);' +
    '--dsw-static-neutral-bluish-400:rgb(122,142,176);' +
    '--dsw-static-neutral-bluish-500:rgb(101,121,155);' +
    '--dsw-static-neutral-bluish-600:rgb(80,97,129);' +
    '--dsw-static-neutral-bluish-700:rgb(58,73,103);' +
    '--dsw-static-neutral-bluish-750:rgb(48,62,89);' +
    '--dsw-static-neutral-bluish-800:rgb(37,49,72);' +
    '--dsw-static-neutral-bluish-850:rgb(28,38,57);' +
    '--dsw-static-neutral-bluish-875:rgb(23,31,48);' +
    '--dsw-static-neutral-bluish-900:rgb(17,25,40);' +
    '--dsw-static-neutral-bluish-950:rgb(12,19,32);' +
    '--dsw-alias-brand-primary:rgb(41,66,132);' +
    '--dsw-alias-brand-primary-new-colorprimary-new-color:rgb(41,66,132);' +
    '--dsw-alias-button-primary-hover:rgb(56,88,168);' +
    '--dsw-alias-border-l1:rgba(24,60,120,.10);' +
    '--dsw-alias-border-l2:rgba(24,60,120,.16);' +
    '--dsw-alias-border-l2-darkmode-thin:rgba(24,60,120,.16);' +
    '--dsw-alias-border-l3:rgba(24,60,120,.22);' +
    '--dsw-alias-border-l4:rgba(24,60,120,.28);' +
    '--dsw-alias-interactive-bg-hover:rgba(30,74,165,.07);' +
    '--dsw-alias-interactive-bg-hover-accent:rgba(30,74,165,.14);' +
    '--dsw-alias-interactive-bg-active:rgba(30,74,165,.12);' +
    '--dsw-alias-bg-skeleton:rgba(30,74,165,.06);' +
    '--dsw-specific-sidebar-fill:rgb(231,240,250);' +
    '--dsw-alias-scrollbar-bg-l1:rgba(96,140,220,.32);' +
    '--dsw-alias-scrollbar-bg-l2:rgba(96,140,220,.32);' +
    '--dsw-alias-scrollbar-hover-l1:rgba(122,172,250,.55);' +
    '--dsw-alias-scrollbar-hover-l2:rgba(122,172,250,.55);' +
    '}' +
    // ---- dark theme: deep sea (matches the desktop shell pages) ----
    'html body[data-ds-dark-theme]{' +
    '--dsw-static-neutral-bluish-00:rgb(246,249,253);' +
    '--dsw-static-neutral-bluish-50:rgb(240,244,251);' +
    '--dsw-static-neutral-bluish-100:rgb(232,238,248);' +
    '--dsw-static-neutral-bluish-200:rgb(211,222,244);' +
    '--dsw-static-neutral-bluish-300:rgb(183,197,226);' +
    '--dsw-static-neutral-bluish-400:rgb(143,163,200);' +
    '--dsw-static-neutral-bluish-500:rgb(122,140,176);' +
    '--dsw-static-neutral-bluish-600:rgb(95,112,147);' +
    '--dsw-static-neutral-bluish-700:rgb(52,73,122);' +
    '--dsw-static-neutral-bluish-750:rgb(38,57,99);' +
    '--dsw-static-neutral-bluish-800:rgb(27,44,80);' +
    '--dsw-static-neutral-bluish-850:rgb(20,33,63);' +
    '--dsw-static-neutral-bluish-875:rgb(16,26,49);' +
    '--dsw-static-neutral-bluish-900:rgb(13,21,40);' +
    '--dsw-static-neutral-bluish-950:rgb(10,17,34);' +
    '--dsw-alias-border-inverted:rgba(150,195,255,.06);' +
    '--dsw-alias-border-inverted2:rgba(150,195,255,.08);' +
    '--dsw-alias-border-l1:rgba(150,195,255,.08);' +
    '--dsw-alias-border-l2:rgba(150,195,255,.14);' +
    '--dsw-alias-border-l2-darkmode-thin:rgba(150,195,255,.09);' +
    '--dsw-alias-border-l3:rgba(150,195,255,.20);' +
    '--dsw-alias-border-l4:rgba(150,195,255,.26);' +
    '--dsw-alias-interactive-bg-hover:rgba(150,200,255,.10);' +
    '--dsw-alias-interactive-bg-hover-accent:rgba(150,200,255,.20);' +
    '--dsw-alias-interactive-bg-active:rgba(150,200,255,.16);' +
    '--dsw-alias-bg-skeleton:rgba(150,200,255,.08);' +
    '--dsw-alias-scrollbar-bg-l1:rgba(96,140,220,.34);' +
    '--dsw-alias-scrollbar-bg-l2:rgba(96,140,220,.34);' +
    '--dsw-alias-scrollbar-hover-l1:rgba(122,172,250,.55);' +
    '--dsw-alias-scrollbar-hover-l2:rgba(122,172,250,.55);' +
    '}' +
    // ---- ambient ocean layer: 4 blue bands + 2 red bands + waiting pulse +
    //      settle sweep, mixed per wave state via [data-wave-state] presets.
    //      Bands run at fixed speeds forever (no phase jumps); states only
    //      crossfade layer opacities — transform/opacity compositing only. ----
    '#' + AMBIENT_ID + '{position:fixed;inset:0;pointer-events:none;z-index:2147481000;overflow:hidden;color:rgba(80,130,220,.45);}' +
    'body[data-ds-dark-theme] #' + AMBIENT_ID + '{color:rgba(150,200,255,.55);}' +
    '#' + AMBIENT_ID + ' .oa-glow{position:absolute;border-radius:50%;will-change:transform;opacity:.5;transition:opacity 1.1s cubic-bezier(.22,1,.36,1);}' +
    '#' + AMBIENT_ID + ' .oa-g1{width:640px;height:640px;top:-330px;right:-200px;background:radial-gradient(circle,rgba(77,107,254,.12),transparent 65%);}' +
    '#' + AMBIENT_ID + ' .oa-g2{width:520px;height:520px;bottom:-270px;left:-160px;background:radial-gradient(circle,rgba(60,198,232,.09),transparent 65%);}' +
    '#' + AMBIENT_ID + ' .oa-g3{width:560px;height:560px;bottom:-300px;right:-160px;background:radial-gradient(circle,rgba(248,121,121,.16),transparent 65%);opacity:0;}' +
    'body[data-ds-dark-theme] #' + AMBIENT_ID + ' .oa-g1{background:radial-gradient(circle,rgba(77,107,254,.22),transparent 65%);}' +
    'body[data-ds-dark-theme] #' + AMBIENT_ID + ' .oa-g2{background:radial-gradient(circle,rgba(60,198,232,.15),transparent 65%);}' +
    'body[data-ds-dark-theme] #' + AMBIENT_ID + ' .oa-g3{background:radial-gradient(circle,rgba(248,121,121,.22),transparent 65%);}' +
    'html[data-dsh-motion="rich"] #' + AMBIENT_ID + ' .oa-g1{animation:oa-glow1 30s ease-in-out infinite alternate;}' +
    'html[data-dsh-motion="rich"] #' + AMBIENT_ID + ' .oa-g2{animation:oa-glow2 38s ease-in-out infinite alternate;}' +
    '@keyframes oa-glow1{to{transform:translate(60px,40px) scale(1.06);}}' +
    '@keyframes oa-glow2{to{transform:translate(-50px,-30px) scale(1.1);}}' +
    '#' + AMBIENT_ID + ' .oa-waves{position:absolute;left:0;right:0;bottom:0;height:110px;color:rgba(77,107,254,.16);' +
    'transition:color 1.1s cubic-bezier(.22,1,.36,1);}' +
    'body[data-ds-dark-theme] #' + AMBIENT_ID + ' .oa-waves{color:rgba(96,140,255,.20);}' +
    // two bands only: back (slower, dimmer, counter-drifting) + main.
    // Both are translated by the rAF engine (phase accumulates → speed
    // changes never jump); color/opacity ride CSS transitions per state.
    '#' + AMBIENT_ID + ' .oa-wv{position:absolute;left:0;width:200%;will-change:transform;transform-origin:bottom center;' +
    'transition:opacity 1.1s cubic-bezier(.22,1,.36,1);}' +
    '#' + AMBIENT_ID + ' .oa-wv svg{display:block;width:100%;height:100%;}' +
    '#' + AMBIENT_ID + ' .oa-wv path{fill:currentColor;}' +
    '#' + AMBIENT_ID + ' .oa-wv-main{bottom:-8px;height:96px;color:inherit;}' +
    '#' + AMBIENT_ID + ' .oa-wv-back{bottom:-14px;height:84px;color:rgba(60,140,220,.09);opacity:.85;}' +
    'body[data-ds-dark-theme] #' + AMBIENT_ID + ' .oa-wv-back{color:rgba(60,198,232,.12);}' +
    // per-state color of the main band (the state-driven wave)
    '#' + AMBIENT_ID + '[data-wave-state="calm"] .oa-waves{color:rgba(77,107,254,.16);}' +
    '#' + AMBIENT_ID + '[data-wave-state="thinking"] .oa-waves{color:rgba(96,165,250,.24);}' +
    '#' + AMBIENT_ID + '[data-wave-state="streaming"] .oa-waves{color:rgba(60,150,240,.28);}' +
    '#' + AMBIENT_ID + '[data-wave-state="tooling"] .oa-waves{color:rgba(60,198,232,.30);}' +
    '#' + AMBIENT_ID + '[data-wave-state="waiting"] .oa-waves{color:rgba(245,194,91,.24);}' +
    '#' + AMBIENT_ID + '[data-wave-state="error"] .oa-waves{color:rgba(248,121,121,.34);}' +
    '#' + AMBIENT_ID + '[data-wave-state="settle"] .oa-waves{color:rgba(190,215,255,.30);}' +
    'body[data-ds-dark-theme] #' + AMBIENT_ID + '[data-wave-state="calm"] .oa-waves{color:rgba(96,140,255,.20);}' +
    'body[data-ds-dark-theme] #' + AMBIENT_ID + '[data-wave-state="thinking"] .oa-waves{color:rgba(125,180,255,.26);}' +
    'body[data-ds-dark-theme] #' + AMBIENT_ID + '[data-wave-state="streaming"] .oa-waves{color:rgba(110,170,255,.30);}' +
    'body[data-ds-dark-theme] #' + AMBIENT_ID + '[data-wave-state="tooling"] .oa-waves{color:rgba(90,200,255,.32);}' +
    'body[data-ds-dark-theme] #' + AMBIENT_ID + '[data-wave-state="waiting"] .oa-waves{color:rgba(245,194,91,.28);}' +
    'body[data-ds-dark-theme] #' + AMBIENT_ID + '[data-wave-state="error"] .oa-waves{color:rgba(248,121,121,.38);}' +
    'body[data-ds-dark-theme] #' + AMBIENT_ID + '[data-wave-state="settle"] .oa-waves{color:rgba(190,215,255,.32);}' +
    // ---- wave-state mix presets: glows + bubble groups ----
    '#' + AMBIENT_ID + '[data-wave-state="calm"] .oa-glow{opacity:.5;}' +
    '#' + AMBIENT_ID + '[data-wave-state="calm"] .oa-bcalm{opacity:1;}' +
    '#' + AMBIENT_ID + '[data-wave-state="thinking"] .oa-glow{opacity:.75;}' +
    '#' + AMBIENT_ID + '[data-wave-state="thinking"] .oa-bcalm{opacity:.6;}' +
    '#' + AMBIENT_ID + '[data-wave-state="thinking"] .oa-bactive{opacity:.3;}' +
    '#' + AMBIENT_ID + '[data-wave-state="streaming"] .oa-glow{opacity:1;}' +
    '#' + AMBIENT_ID + '[data-wave-state="streaming"] .oa-bcalm{opacity:.3;}' +
    '#' + AMBIENT_ID + '[data-wave-state="streaming"] .oa-bactive{opacity:1;}' +
    '#' + AMBIENT_ID + '[data-wave-state="tooling"] .oa-glow{opacity:1;}' +
    '#' + AMBIENT_ID + '[data-wave-state="tooling"] .oa-bcalm{opacity:.2;}' +
    '#' + AMBIENT_ID + '[data-wave-state="tooling"] .oa-bactive{opacity:1;}' +
    '#' + AMBIENT_ID + '[data-wave-state="waiting"] .oa-glow{opacity:.5;}' +
    '#' + AMBIENT_ID + '[data-wave-state="waiting"] .oa-bcalm{opacity:.3;}' +
    '#' + AMBIENT_ID + '[data-wave-state="error"] .oa-glow{opacity:.3;}' +
    '#' + AMBIENT_ID + '[data-wave-state="error"] .oa-g3{opacity:.9;}' +
    '#' + AMBIENT_ID + '[data-wave-state="error"] .oa-bcalm{opacity:.1;}' +
    '#' + AMBIENT_ID + '[data-wave-state="error"] .oa-bactive{opacity:.4;}' +
    '#' + AMBIENT_ID + '[data-wave-state="settle"] .oa-glow{opacity:.7;}' +
    '#' + AMBIENT_ID + '[data-wave-state="settle"] .oa-bcalm{opacity:.5;}' +
    '#' + AMBIENT_ID + '[data-wave-state="settle"] .oa-bactive{opacity:.2;}' +
    // bubbles in two groups (calm / active) crossfaded by state
    '#' + AMBIENT_ID + ' .oa-bubbles{position:absolute;inset:0;transition:opacity 1.1s cubic-bezier(.22,1,.36,1);opacity:0;}' +
    '#' + AMBIENT_ID + ' .oa-bubble{position:absolute;bottom:-40px;left:var(--bx,10%);width:var(--bs,6px);height:var(--bs,6px);border-radius:50%;' +
    'background:radial-gradient(circle at 32% 30%,currentColor,transparent 70%);border:1px solid currentColor;' +
    'opacity:0;will-change:transform,opacity;}' +
    'html[data-dsh-motion="rich"] #' + AMBIENT_ID + ' .oa-bubble{animation:oa-rise var(--bd,16s) linear infinite;animation-delay:var(--bdelay,0s);}' +
    'html[data-dsh-motion="quiet"] #' + AMBIENT_ID + ' .oa-bubble{display:none;}' +
    '@keyframes oa-rise{0%{transform:translate3d(0,0,0);opacity:0;}8%{opacity:var(--bop,.5);}92%{opacity:var(--bop,.5);}100%{transform:translate3d(var(--bsx,10px),-104vh,0);opacity:0;}}' +
    // quiet: freeze band motion but keep the state crossfades (essential feedback)
    'html[data-dsh-motion="quiet"] #' + AMBIENT_ID + ' .oa-wv{transition-duration:.2s;}' +
    // ---- strong state contrast: edge bar, veils ----
    '#' + AMBIENT_ID + ' .oa-veil{position:absolute;inset:0;opacity:0;transition:opacity 1.1s cubic-bezier(.22,1,.36,1);}' +
    '#' + AMBIENT_ID + ' .oa-veil-red{background:rgba(220,60,60,.06);}' +
    '#' + AMBIENT_ID + ' .oa-veil-cyan{background:rgba(60,198,232,.05);}' +
    '#' + AMBIENT_ID + ' .oa-veil-dim{background:rgba(30,70,140,.10);}' +
    'body[data-ds-dark-theme] #' + AMBIENT_ID + ' .oa-veil-dim{background:rgba(0,0,0,.22);}' +
    // state color bar along the waterline (the most visible cue)
    '#' + AMBIENT_ID + ' .oa-bar{position:absolute;left:0;right:0;bottom:0;height:3px;opacity:0;transition:background-color 1.1s cubic-bezier(.22,1,.36,1),opacity 1.1s cubic-bezier(.22,1,.36,1);background:rgba(77,107,254,.5);}' +
    '#' + AMBIENT_ID + '[data-wave-state="calm"] .oa-bar{opacity:.35;background:rgba(77,107,254,.45);}' +
    '#' + AMBIENT_ID + '[data-wave-state="thinking"] .oa-bar{opacity:.8;background:rgba(125,216,242,.85);}' +
    '#' + AMBIENT_ID + '[data-wave-state="streaming"] .oa-bar{opacity:.9;background:rgba(96,165,250,.9);}' +
    '#' + AMBIENT_ID + '[data-wave-state="tooling"] .oa-bar{opacity:1;background:rgba(60,198,232,1);}' +
    '#' + AMBIENT_ID + '[data-wave-state="waiting"] .oa-bar{opacity:.85;background:rgba(245,194,91,.85);}' +
    '#' + AMBIENT_ID + '[data-wave-state="error"] .oa-bar{opacity:1;background:rgba(248,121,121,1);}' +
    '#' + AMBIENT_ID + '[data-wave-state="settle"] .oa-bar{opacity:.9;background:rgba(232,238,248,.9);}' +
    // full-screen color veils per state
    '#' + AMBIENT_ID + '[data-wave-state="error"] .oa-veil-red{opacity:1;}' +
    '#' + AMBIENT_ID + '[data-wave-state="tooling"] .oa-veil-cyan{opacity:1;}' +
    '#' + AMBIENT_ID + '[data-wave-state="waiting"] .oa-veil-dim{opacity:1;}' +
    // edge-bar breathing (rich only; frequency encodes the state)
    'html[data-dsh-motion="rich"] #' + AMBIENT_ID + '[data-wave-state="thinking"] .oa-bar{animation:oa-bar-pulse 1.6s ease-in-out infinite alternate;}' +
    'html[data-dsh-motion="rich"] #' + AMBIENT_ID + '[data-wave-state="streaming"] .oa-bar{animation:oa-bar-pulse 1s ease-in-out infinite alternate;}' +
    'html[data-dsh-motion="rich"] #' + AMBIENT_ID + '[data-wave-state="tooling"] .oa-bar{animation:oa-bar-pulse .7s ease-in-out infinite alternate;}' +
    'html[data-dsh-motion="rich"] #' + AMBIENT_ID + '[data-wave-state="error"] .oa-bar{animation:oa-bar-pulse .45s ease-in-out infinite alternate;}' +
    'html[data-dsh-motion="rich"] #' + AMBIENT_ID + '[data-wave-state="waiting"] .oa-bar{animation:oa-bar-pulse 2.4s ease-in-out infinite alternate;}' +
    '@keyframes oa-bar-pulse{from{opacity:.35;}to{opacity:1;}}' +
    '@media (prefers-reduced-motion:reduce){#' + AMBIENT_ID + '{display:none;}}' +
    // ---- shared accents ----
    'html ::selection{background:rgba(77,107,254,.32);}';

  function waveSvg(pathD) {
    return '<svg viewBox="0 0 1200 120" preserveAspectRatio="none" aria-hidden="true"><path d="' + pathD + '"/></svg>';
  }

  function band(cls, pathD) {
    return '<div class="oa-wv ' + cls + '">' + waveSvg(pathD) + '</div>';
  }
  function bubbleSpan(spec) {
    return '<span class="oa-bubble" style="' + spec + '"></span>';
  }
  function bubbleGroup(cls, specs) {
    var html = '';
    for (var i = 0; i < specs.length; i++) html += bubbleSpan(specs[i]);
    return '<div class="oa-bubbles ' + cls + '">' + html + '</div>';
  }

  function ambientHtml() {
    return '<div class="oa-glow oa-g1"></div>' +
      '<div class="oa-glow oa-g2"></div>' +
      '<div class="oa-glow oa-g3"></div>' +
      '<div class="oa-veil oa-veil-red"></div>' +
      '<div class="oa-veil oa-veil-cyan"></div>' +
      '<div class="oa-veil oa-veil-dim"></div>' +
      '<div class="oa-waves">' +
      band('oa-wv-back', P_RIPPLE) +
      band('oa-wv-main', P_SWELL) +
      '</div>' +
      '<div class="oa-bar"></div>' +
      bubbleGroup('oa-bcalm', [
        '--bx:6%;--bs:6px;--bd:17s;--bdelay:-2s;--bop:.4;--bsx:10px',
        '--bx:22%;--bs:4px;--bd:21s;--bdelay:-8s;--bop:.35;--bsx:-8px',
        '--bx:44%;--bs:7px;--bd:15s;--bdelay:-4s;--bop:.4;--bsx:12px',
        '--bx:68%;--bs:5px;--bd:23s;--bdelay:-14s;--bop:.3;--bsx:-10px',
        '--bx:88%;--bs:6px;--bd:18s;--bdelay:-6s;--bop:.35;--bsx:12px',
      ]) +
      bubbleGroup('oa-bactive', [
        '--bx:12%;--bs:8px;--bd:10s;--bdelay:-1s;--bop:.55;--bsx:16px',
        '--bx:30%;--bs:5px;--bd:13s;--bdelay:-5s;--bop:.5;--bsx:-12px',
        '--bx:52%;--bs:9px;--bd:9s;--bdelay:-3s;--bop:.6;--bsx:18px',
        '--bx:71%;--bs:6px;--bd:12s;--bdelay:-7s;--bop:.5;--bsx:-14px',
        '--bx:93%;--bs:7px;--bd:11s;--bdelay:-2s;--bop:.55;--bsx:16px',
      ]);
  }

  // ---- single-wave parameter engine ----------------------------------------
  // One main band + one counter-drifting back band, both driven by rAF.
  // Phase accumulates forever, so switching the target speed only eases the
  // increment — the wave never jumps. Amplitude eases the same way; color,
  // glows, veils and the edge bar ride CSS transitions per state.
  var WAVE_PARAMS = {
    calm: { speed: 0.00085, amp: 1.00 },
    thinking: { speed: 0.00155, amp: 1.15 },
    streaming: { speed: 0.00340, amp: 1.32 },
    tooling: { speed: 0.00600, amp: 1.55 },
    waiting: { speed: 0.00018, amp: 0.90 },
    error: { speed: 0.00930, amp: 1.40 },
    settle: { speed: 0.00200, amp: 1.20 },
  };
  var waveEngine = {
    running: false,
    raf: 0,
    phase: 0,
    backPhase: 0.25, // initial offset so the two bands never overlap
    speed: WAVE_PARAMS.calm.speed,
    amp: WAVE_PARAMS.calm.amp,
    target: WAVE_PARAMS.calm,
    main: null,
    back: null,
    start: function () {
      if (this.running) return;
      var root = document.getElementById(AMBIENT_ID);
      if (!root) return;
      this.main = root.querySelector('.oa-wv-main');
      this.back = root.querySelector('.oa-wv-back');
      if (!this.main) return;
      this.running = true;
      var self = this;
      var step = function () {
        if (!self.running) return;
        // slow easing: state flips glide in over ~2s instead of snapping
        self.speed += (self.target.speed - self.speed) * 0.02;
        self.amp += (self.target.amp - self.amp) * 0.018;
        // each band accumulates its OWN phase and always moves exactly one
        // full path period per wrap (-50% of the 200%-wide strip) — the loop
        // is seamless at any speed; only the per-frame increment changes
        self.phase = (self.phase + self.speed) % 1;
        self.backPhase = (self.backPhase + self.speed * 0.5) % 1;
        self.main.style.transform =
          'translateX(' + (-self.phase * 50) + '%) scaleY(' + self.amp.toFixed(4) + ')';
        if (self.back) {
          self.back.style.transform =
            'translateX(' + (-self.backPhase * 50) + '%) scaleY(' + (1 + (self.amp - 1) * 0.6).toFixed(4) + ')';
        }
        self.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    },
    stop: function () {
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    },
    setState: function (state) {
      this.target = WAVE_PARAMS[state] || WAVE_PARAMS.calm;
    },
  };
  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }
  function motionIsRich() {
    return document.documentElement.getAttribute(MOTION_ATTR) !== 'quiet';
  }
  function syncEngine() {
    if (motionIsRich() && !prefersReducedMotion()) waveEngine.start();
    else waveEngine.stop();
  }

  // ---- wave-state machine (bridge plugin → dsh-wave-state events) ----
  // Rapid mid-turn flips (streaming ↔ tooling every few seconds) are
  // debounced with a short dwell so the wave eases instead of jittering;
  // settle / error / calm always apply immediately.
  var lastApplied = 0;
  var pendingState = null;
  var pendingTimer = 0;
  function applyState(state) {
    var root = document.getElementById(AMBIENT_ID);
    if (!root) return;
    root.setAttribute('data-wave-state', state);
    waveEngine.setState(state);
    // settle eases back to calm on its own
    if (state === 'settle') {
      setTimeout(function () {
        var r = document.getElementById(AMBIENT_ID);
        if (r && r.getAttribute('data-wave-state') === 'settle') setWaveState('calm');
      }, 1900);
    }
    // error chop decays on its own when nothing else happens
    if (state === 'error') {
      setTimeout(function () {
        var r = document.getElementById(AMBIENT_ID);
        if (r && r.getAttribute('data-wave-state') === 'error') setWaveState('calm');
      }, 1800);
    }
  }
  function setWaveState(state) {
    var root = document.getElementById(AMBIENT_ID);
    if (!root) return;
    if (state === root.getAttribute('data-wave-state')) return;
    var now = Date.now();
    var dwell = (state === 'settle' || state === 'error' || state === 'calm') ? 0 : 800;
    if (dwell > 0 && now - lastApplied < dwell) {
      pendingState = state;
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(function () {
        var s = pendingState;
        pendingState = null;
        if (s) setWaveState(s);
      }, dwell - (now - lastApplied));
      return;
    }
    lastApplied = now;
    applyState(state);
  }
  // watchdog: an active state that stops receiving events (missed turn/end,
  // crashed bridge) reverts to calm
  var watchdog = 0;
  function armWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(function () {
      var r = document.getElementById(AMBIENT_ID);
      if (r) setWaveState('calm');
    }, 15000);
  }
  try {
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('dsh-wave-state', function (e) {
        var state = e && e.payload && e.payload.state;
        var valid = { calm: 1, thinking: 1, streaming: 1, tooling: 1, waiting: 1, error: 1, settle: 1 };
        if (!valid[state]) return;
        setWaveState(state);
        if (state === 'calm' || state === 'settle') clearTimeout(watchdog);
        else armWatchdog();
        report('wave', state);
      });
    }
  } catch (e) {}

  function mount() {
    if (!document.head) return false;
    var ok = true;
    try {
      if (!document.getElementById(STYLE_ID)) {
        var s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = css;
        document.head.appendChild(s);
        report('mounted', 'ocean design-token skin active');
      }
    } catch (e) {
      report('mount-error', String(e));
      ok = false;
    }
    try {
      if (document.body && !document.getElementById(AMBIENT_ID)) {
        var root = document.createElement('div');
        root.id = AMBIENT_ID;
        root.setAttribute('data-wave-state', 'calm');
        root.innerHTML = ambientHtml();
        document.body.appendChild(root);
        report('ambient', 'ocean motion layer mounted');
        syncEngine();
      }
    } catch (e) {
      report('ambient-error', String(e));
      ok = false;
    }
    return ok;
  }

  // document-start, retried by the same defensive triggers as the title bar
  if (!mount()) {
    document.addEventListener('DOMContentLoaded', function () { mount(); }, { once: true });
    var tries = 0;
    var iv = setInterval(function () {
      tries += 1;
      if (mount() || tries > 120) clearInterval(iv);
    }, 250);
  }
  // slow re-arm: if the dsh app wipes/replaces the DOM, mount again
  setInterval(function () {
    if (!document.head) return;
    if (!document.getElementById(STYLE_ID) || (document.body && !document.getElementById(AMBIENT_ID))) {
      mount();
    }
  }, 1000);
})();
"#;

fn dsh_web_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

// ---------------------------------------------------------------------------
// data types
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize, Debug)]
// NOTE: the DeepSeek balance API returns snake_case fields, and the UI/bridge
// consumers (settings.js, bridge client.js) also read snake_case — so this
// struct must serialize/deserialize snake_case, NOT camelCase.
#[serde(rename_all = "snake_case")]
pub struct BalanceInfo {
    pub currency: String,
    pub total_balance: String,
    pub granted_balance: String,
    pub topped_up_balance: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub struct Balance {
    pub is_available: bool,
    pub balance_infos: Vec<BalanceInfo>,
}

/// Billing data for OpenAI-compatible gateways (no "balance" concept — they
/// bill by usage). Sourced from the OpenAI dashboard-style endpoints
/// `GET {base}/dashboard/billing/usage` + `GET {base}/dashboard/billing/subscription`.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub total_usage_usd: Option<f64>,
    pub soft_limit_usd: Option<f64>,
    pub hard_limit_usd: Option<f64>,
    pub has_payment_method: Option<bool>,
}

/// One platform's account status. `kind` is "balance" (prepaid providers with
/// a native balance endpoint), "usage" (bill-by-usage gateways with a billing
/// endpoint), or "unsupported" (no key-accessible balance/billing API).
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub configured: bool,
    pub balance: Option<Balance>,
    pub usage: Option<ProviderUsage>,
    pub error: Option<String>,
}

/// A discovered LLM provider: the DSH built-in DeepSeek entry plus every
/// provider declared under `llm-pi-ai.providers.<id>` in `$DSH_HOME/settings.yaml`.
struct LlmProvider {
    id: String,
    display_name: String,
    base_url: String,
    /// Wire-protocol hint from the config ("" when unknown). Used together
    /// with the base URL to route to a balance adapter.
    api: String,
    key_env: String,
}

/// The balance endpoint family a provider is routed to.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Adapter {
    /// GET {base}/user/balance — DeepSeek-schema balance (api.deepseek.com
    /// and DeepSeek-compatible relays).
    DeepSeek,
    /// GET {base}/dashboard/billing/usage (+ subscription) — OpenAI-style
    /// billing gateways.
    OpenAIBilling,
    /// No known key-accessible balance/billing endpoint for this protocol.
    Unsupported,
    /// Unknown protocol — probe both endpoint families at fetch time.
    Probe,
}

/// Motion intensity of the desktop UI. `Rich` keeps the full ocean ambient
/// animation set (drifting glows, wave bands, bubbles, the whale theme-switch
/// transition); `Quiet` keeps only essential micro-interactions, entrances and
/// feedback, with shorter durations. Serializes to lowercase strings
/// ("quiet" | "rich") for config.json and the JS bridge.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MotionIntensity {
    Quiet,
    Rich,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub api_key: Option<String>,
    pub dsh_home: Option<String>,
    pub dsh_port: Option<u16>,
    pub bridge_shell_port: u16,
    pub bridge_port: u16,
    pub balance_low_threshold: Option<f64>,
    pub update_repo: Option<String>,
    /// Unix ms when the current API key was registered (drives the DSH in-app
    /// "consumption since key registration" analytics).
    pub key_registered_at: Option<i64>,
    /// UI motion intensity (see `MotionIntensity`). Serde default keeps older
    /// config.json files (without the field) loading as `Rich`.
    #[serde(default = "default_motion")]
    pub motion: MotionIntensity,
}

fn default_motion() -> MotionIntensity {
    MotionIntensity::Rich
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            api_key: None,
            dsh_home: None,
            dsh_port: None,
            bridge_shell_port: 38657,
            bridge_port: 38658,
            balance_low_threshold: Some(5.0),
            update_repo: None,
            key_registered_at: None,
            motion: MotionIntensity::Rich,
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub dsh_running: bool,
    pub ui_ready: bool,
    pub bridge_ok: bool,
    pub adopted: bool,
    pub key_configured: bool,
    pub balance: Option<Balance>,
    pub balance_low: bool,
    pub dsh_version: Option<String>,
    pub node_version: Option<String>,
    pub app_version: String,
    pub log_path: String,
    pub dsh_home: String,
    pub dsh_port: u16,
    pub motion_intensity: MotionIntensity,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetKeyResult {
    pub configured: bool,
    pub balance: Option<Balance>,
}

struct DshProcess {
    child: Option<Child>,
    restarts: u32,
}

pub struct AppState {
    dsh: Mutex<DshProcess>,
    adopted: AtomicBool,
    ui_ready: AtomicBool,
    bridge_ok: AtomicBool,
    runtime_ready: AtomicBool,
    balance: Mutex<Option<Balance>>,
    providers: Mutex<Option<Vec<ProviderStatus>>>,
    /// provider id -> resolved balance adapter ("deepseek" | "openai" |
    /// "unsupported") so probe providers don't re-probe every refresh.
    adapters: Mutex<HashMap<String, String>>,
    config: Mutex<AppConfig>,
    last_refresh: Mutex<Option<Instant>>,
    last_update_check: Mutex<Option<Instant>>,
    tray_balance_item: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
    tray_autostart_item: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
}

struct Paths {
    config_file: PathBuf,
    logs_dir: PathBuf,
    log_file: PathBuf,
    patch_file: PathBuf,
    /// Extracted/writable runtime tree (`node/` + `dsh/`): the install dir
    /// normally, the per-user local app data dir when the install dir is not
    /// writable by the running user.
    runtime_dir: PathBuf,
    /// The bundled runtime location shipped by the installer: holds the packed
    /// archive and the plugin sources. Read-only access is enough.
    bundled_runtime_dir: PathBuf,
    node_exe: PathBuf,
    dsh_bin: PathBuf,
    dsh_home: PathBuf,
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn log_line(path: &Path, text: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let line = format!("[{}] {}\n", chrono::Local::now().format("%H:%M:%S"), text);
        let _ = f.write_all(line.as_bytes());
    }
}

/// Resolve the runtime layout as `(extracted, bundled)`.
///
/// The install dir ships the packed archive + plugin sources (`bundled`);
/// first-run extraction must never depend on install-dir permissions, because
/// installs onto drive-root folders, corporate policies, or security software
/// can leave the install dir read-only for the running user even though the
/// installer could write it (fresh installs then fail with "拒绝访问 (os
/// error 5) when creating dir runtime\node").
///
/// Decision order:
/// 1. the install-dir tree is already extracted → keep using it;
/// 2. a fallback tree already exists (extracted on a previous boot) → keep
///    booting from it (no surprise location flapping);
/// 3. the install dir is writable (probed by actually creating a directory)
///    → extract there, the common case;
/// 4. otherwise → the per-user local app data dir (always writable).
fn resolve_runtime_dirs(app: &AppHandle) -> (PathBuf, PathBuf) {
    let bundled = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime")
    } else {
        app.path().resource_dir().unwrap_or_default().join("runtime")
    };
    let bundled = strip_verbatim(bundled);
    let fallback = strip_verbatim(
        app.path()
            .app_local_data_dir()
            .unwrap_or_default()
            .join("runtime"),
    );
    if runtime_tree_usable(&bundled) {
        return (bundled.clone(), bundled);
    }
    if runtime_tree_usable(&fallback) {
        return (fallback, bundled);
    }
    if dir_writable(&bundled) {
        return (bundled.clone(), bundled);
    }
    (fallback, bundled)
}

/// The extracted runtime tree is complete enough to boot from.
fn runtime_tree_usable(dir: &Path) -> bool {
    dir.join("node").join("node.exe").is_file()
        && dir.join("dsh")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js")
            .is_file()
}

/// Monotonic probe-name counter: keeps concurrent `resolve_paths` calls in
/// the same process from colliding on the probe directory name.
static PROBE_SEQ: AtomicU64 = AtomicU64::new(0);

/// True when a directory can actually be created inside `dir` right now —
/// exactly the operation first-run extraction needs. The probe is created and
/// removed immediately; its name carries the pid + a monotonic counter so
/// concurrent boots (or concurrent `resolve_paths` calls) cannot collide.
fn dir_writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(format!(
        ".dsh-write-probe-{}-{}",
        std::process::id(),
        PROBE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    match fs::create_dir(&probe) {
        Ok(()) => {
            let _ = fs::remove_dir(&probe);
            true
        }
        // A leftover probe with the same name (crashed run with a reused pid)
        // proves a directory could be created here — treat as writable.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => true,
        Err(_) => false,
    }
}

/// Windows `\\?\` verbatim paths break Node's CJS loader (realpath walks to
/// the bare drive letter and fails with EISDIR) — strip the prefix.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => p,
    }
}

fn default_dsh_home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".dsh")
}

fn resolve_paths(app: &AppHandle, config: &AppConfig) -> Paths {
    // Escape hatch for sandboxed/portable runs; production uses the app data dir.
    let data_dir = strip_verbatim(
        std::env::var("DSH_DESKTOP_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| app.path().app_config_dir().unwrap_or_default()),
    );
    let (runtime, bundled_runtime) = resolve_runtime_dirs(app);
    let dsh_home = config
        .dsh_home
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| std::env::var("DSH_DESKTOP_DSH_HOME").ok().map(PathBuf::from))
        .unwrap_or_else(default_dsh_home);
    Paths {
        config_file: data_dir.join("config.json"),
        logs_dir: data_dir.join("logs"),
        log_file: data_dir.join("logs").join("dsh.log"),
        patch_file: data_dir.join("dsh-bridge.patch.yml"),
        node_exe: runtime.join("node").join("node.exe"),
        dsh_bin: runtime
            .join("dsh")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js"),
        runtime_dir: runtime,
        bundled_runtime_dir: bundled_runtime,
        dsh_home,
    }
}
fn dsh_port(config: &AppConfig) -> u16 {
    config.dsh_port.unwrap_or_else(|| {
        std::env::var("DSH_DESKTOP_DSH_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DSH_WEB_PORT_DEFAULT)
    })
}

/// WebView2 user data dir: production = app data dir; env override for portable/sandboxed runs.
fn webview_data_dir(app: &AppHandle) -> PathBuf {
    std::env::var("DSH_DESKTOP_WEBVIEW_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| app.path().app_data_dir().unwrap_or_default().join("webview-data"))
}

fn load_config(path: &Path) -> AppConfig {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_config(path: &Path, config: &AppConfig) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(config) {
        let _ = fs::write(path, s);
    }
}

/// Content for the shell's `--patch` overlay. The home-level user layer
/// (`$DSH_HOME/cordis.patch.yml`) may already mount the desktop plugins
/// (standalone `dsh web` setups); duplicating their loader entry ids crashes
/// profile boot, so the overlay only fills the gap: empty when the home layer
/// mounts every desktop plugin, the full rows otherwise.
fn desktop_patch_overlay(dsh_home: &Path) -> String {
    const EMPTY_OVERLAY: &str = "# dsh-desktop bridge rows — home layer already mounts every desktop plugin;\n\
# keep this overlay empty so loader entry ids never duplicate.\n\
- insert: []\n";
    let home_layer = dsh_home.join("cordis.patch.yml");
    let content = fs::read_to_string(&home_layer).unwrap_or_default();
    let all_mounted = DESKTOP_PLUGINS
        .iter()
        .all(|name| content.contains(&format!("id: {name}")));
    if all_mounted {
        EMPTY_OVERLAY.to_string()
    } else {
        BRIDGE_PATCH_YML.to_string()
    }
}

/// Write `content` to `path`, skipping the write when it already matches
/// (content-sync: shell updates refresh an already-deployed file).
fn write_if_different(path: &Path, content: &str) {
    let same = fs::read_to_string(path)
        .ok()
        .is_some_and(|existing| existing == content);
    if !same {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(path, content);
    }
}

fn ensure_runtime_files(paths: &Paths) {
    let _ = fs::create_dir_all(&paths.logs_dir);
    write_if_different(&paths.patch_file, &desktop_patch_overlay(&paths.dsh_home));
    // The loader resolves plugin entries from the profile's module tree
    // ($DSH_HOME/profiles/node_modules), not from runtime/dsh — deploy the
    // desktop plugin packages there so each `--patch` row can import it.
    // The canonical copies live in the bundled runtime's plugins-src (read
    // from the install dir even when the extracted tree lives elsewhere);
    // the copy is a plain overwrite (a few small files) so shell updates
    // refresh an already-deployed package, lib/ trees included.
    let plugins_src = paths.bundled_runtime_dir.join("plugins-src");
    let profile_modules = paths.dsh_home.join("profiles").join("node_modules");
    let mut vision_deployed = false;
    if plugins_src.exists() {
        for name in DESKTOP_PLUGINS
            .iter()
            .copied()
            .chain(std::iter::once(VISION_PLUGIN))
        {
            let src = plugins_src.join(name);
            if !src.exists() {
                continue;
            }
            let dst = profile_modules.join(name);
            let _ = fs::create_dir_all(&dst);
            let _ = copy_dir_contents(&src, &dst);
            if name == VISION_PLUGIN {
                vision_deployed = true;
            }
        }
    }
    // Mount the bundled vision plugin only when its package actually
    // deployed — an old runtime without it must never leave a dangling
    // bundles entry that fails profile boot.
    if vision_deployed {
        ensure_web_profile_vision_bundle(paths);
    }
    // Give the desktop-owned settings sections (视觉模型 / 会话管理) their
    // dedicated nav glyphs in the served settings-shell bundle.
    patch_settings_nav_icons(paths);
}

/// Settings-shell nav-icon patch for the desktop-owned settings sections
/// (视觉模型 `vision-any`, 会话管理 `session-manager`). The shell hard-codes
/// nav glyphs per section id and falls back to the settings gear for unknown
/// ids; this inserts dedicated branches into its served client bundle — a
/// hand-drawn eye for the vision section and the list-pen glyph (already
/// exported by dsh-client-ui-primitives) for the session manager.
///
/// Idempotent (marker-checked). When the upstream bundle no longer contains
/// the anchor — a future dsh build reworked `navIcon` — the patch logs and
/// skips, and the sections simply keep the gear fallback.
fn patch_settings_nav_icons(paths: &Paths) {
    let bundle = SETTINGS_SHELL_BUNDLE
        .iter()
        .fold(paths.runtime_dir.clone(), |p, part| p.join(part));
    let raw = match fs::read_to_string(&bundle) {
        Ok(raw) => raw,
        Err(e) => {
            // Before first-run extraction finishes the settings bundle does
            // not exist yet; the post-extraction ensure_runtime_files pass
            // patches it, so stay silent instead of logging a scary
            // "unreadable" error on every fresh install.
            if !bundle.exists() && !paths.node_exe.exists() {
                return;
            }
            log_line(
                &paths.log_file,
                &format!("settings shell bundle unreadable; nav icons unpatched: {e}"),
            );
            return;
        }
    };
    if raw.contains(SETTINGS_NAV_ICONS_MARKER) {
        return; // already patched
    }
    if !raw.contains(SETTINGS_NAV_ICONS_ANCHOR) {
        log_line(
            &paths.log_file,
            "settings shell navIcon anchor not found; nav icons unpatched (upstream bundle changed?)",
        );
        return;
    }
    let patched = raw.replacen(
        SETTINGS_NAV_ICONS_ANCHOR,
        &format!("{SETTINGS_NAV_ICONS_INSERT}{SETTINGS_NAV_ICONS_ANCHOR}"),
        1,
    );
    write_if_different(&bundle, &patched);
    log_line(
        &paths.log_file,
        "settings shell nav icons patched (vision eye + session list)",
    );
}

/// Mount the bundled vision plugin into the web profile by appending its name
/// to `dsh.profile.bundles` — the exact contract `dsh plugin --profile web add`
/// uses, minus pnpm (the package is deployed by `ensure_runtime_files`).
/// A fresh `$DSH_HOME` gets a template-equivalent web profile with the vision
/// bundle pre-listed; an existing profile keeps its own bundle order and gets
/// the entry appended only when absent. Never clobbers anything else, and
/// treats an unreadable/invalid manifest as a skip (log, not crash).
fn ensure_web_profile_vision_bundle(paths: &Paths) {
    let web_dir = paths.dsh_home.join("profiles").join("web");
    let manifest_path = web_dir.join("package.json");
    let _ = fs::create_dir_all(&web_dir);

    if !manifest_path.exists() {
        let manifest = serde_json::json!({
            "name": "dsh-profile-web",
            "private": true,
            "dependencies": {},
            "dsh": {
                "profile": {
                    "bundles": [WEB_TEMPLATE_BUNDLES[0], WEB_TEMPLATE_BUNDLES[1], VISION_PLUGIN],
                },
            },
        });
        let _ = fs::write(
            &manifest_path,
            serde_json::to_string_pretty(&manifest).unwrap_or_default() + "\n",
        );
        // Match `dsh plugin` init so a later pnpm-managed install works; only
        // create, never overwrite files the user may have made.
        for (file, content) in [
            ("pnpm-workspace.yaml", PROFILE_PNPM_WORKSPACE),
            ("cordis.patch.yml", PROFILE_PATCH_TEMPLATE),
        ] {
            let path = web_dir.join(file);
            if !path.exists() {
                let _ = fs::write(path, content);
            }
        }
        log_line(
            &paths.log_file,
            "web profile initialized with bundled dsh-vision-any",
        );
        return;
    }

    let raw = match fs::read_to_string(&manifest_path) {
        Ok(raw) => raw,
        Err(e) => {
            log_line(
                &paths.log_file,
                &format!("web profile manifest unreadable; vision bundle not mounted: {e}"),
            );
            return;
        }
    };
    let mut manifest = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(manifest) => manifest,
        Err(e) => {
            log_line(
                &paths.log_file,
                &format!("web profile manifest invalid; vision bundle not mounted: {e}"),
            );
            return;
        }
    };
    if !append_vision_bundle(&mut manifest) {
        return; // already mounted, or the manifest shape is not ours to touch
    }
    match fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).unwrap_or_default() + "\n",
    ) {
        Ok(()) => log_line(
            &paths.log_file,
            &format!("mounted bundled {VISION_PLUGIN} into the web profile"),
        ),
        Err(e) => log_line(
            &paths.log_file,
            &format!("failed to write web profile manifest: {e}"),
        ),
    }
}

/// Append `dsh-vision-any` to `dsh.profile.bundles`, creating the `dsh` /
/// `profile` / `bundles` path when absent. Returns true when the manifest was
/// mutated (and must be written back); false when already mounted or when the
/// existing shape is not a plain object (left untouched).
fn append_vision_bundle(manifest: &mut serde_json::Value) -> bool {
    let Some(root) = manifest.as_object_mut() else {
        return false;
    };
    let Some(dsh) = root
        .entry("dsh")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
    else {
        return false;
    };
    let Some(profile) = dsh
        .entry("profile")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
    else {
        return false;
    };
    let Some(bundles) = profile
        .entry("bundles")
        .or_insert_with(|| serde_json::json!([]))
        .as_array_mut()
    else {
        return false;
    };
    if bundles.iter().any(|v| v.as_str() == Some(VISION_PLUGIN)) {
        return false;
    }
    bundles.push(serde_json::json!(VISION_PLUGIN));
    true
}

/// Recursive contents copy (files and directories; no metadata promises).
fn copy_dir_contents(src: &Path, dst: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            fs::create_dir_all(&to)?;
            copy_dir_contents(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Retry-wrapped `create_dir_all`. On Windows a freshly created directory is
/// briefly handed to real-time scanners/AV on some machines, whose locks
/// surface as transient access-denied (os error 5) — retry with backoff
/// instead of failing the whole extraction. Genuine permission problems keep
/// failing; those are handled by the writable-location fallback instead.
fn create_dir_all_retry(path: &Path) -> std::io::Result<()> {
    const ATTEMPTS: u32 = 4;
    const BASE_DELAY: Duration = Duration::from_millis(250);
    let mut last = None;
    for attempt in 0..ATTEMPTS {
        match fs::create_dir_all(path) {
            Ok(()) => return Ok(()),
            Err(e)
                if attempt + 1 < ATTEMPTS
                    && matches!(
                        e.kind(),
                        std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::TimedOut
                    ) =>
            {
                last = Some(e);
                thread::sleep(BASE_DELAY * (attempt + 1));
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.expect("retry loop always records its last error"))
}

/// Extract a .tar.gz archive into `dest`. `strip_first` drops the leading
/// path component (npm tarballs root at `package/`); entries with a leading
/// `./` are normalized first. `on_entry` is invoked after every extracted
/// entry with the running entry count (used for splash progress reporting).
fn extract_tarball(
    tgz: &Path,
    dest: &Path,
    strip_first: bool,
    on_entry: &mut dyn FnMut(usize),
) -> Result<(), String> {
    create_dir_all_retry(dest).map_err(|e| format!("创建目录失败: {e}"))?;
    let file = fs::File::open(tgz).map_err(|e| format!("打开归档失败: {e}"))?;
    let gz = GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    let mut count = 0usize;
    for entry in archive.entries().map_err(|e| format!("解包失败: {e}"))? {
        let mut entry = entry.map_err(|e| format!("解包失败: {e}"))?;
        let archive_path = entry.path().map_err(|e| e.to_string())?.to_path_buf();
        let mut components: Vec<_> = archive_path.components().collect();
        // normalize a leading CurDir (".") produced by some tar writers
        if matches!(components.first(), Some(std::path::Component::CurDir)) {
            components.remove(0);
        }
        if strip_first && !components.is_empty() {
            components.remove(0);
        }
        if components.is_empty() {
            continue;
        }
        let stripped: PathBuf = components.iter().collect();
        let target = dest.join(&stripped);
        // Directory entries carry no payload: pre-create (with retry) so the
        // tar layer's create_dir sees AlreadyExists and keeps going even when
        // a scanner briefly holds the fresh parent directory.
        if entry.header().entry_type().is_dir() {
            create_dir_all_retry(&target)
                .map_err(|e| format!("创建目录 {} 失败: {e}", target.display()))?;
        }
        if let Some(parent) = target.parent() {
            create_dir_all_retry(parent)
                .map_err(|e| format!("创建目录 {} 失败: {e}", parent.display()))?;
        }
        entry
            .unpack(&target)
            .map_err(|e| format!("解包 {:?} 失败: {e}", target))?;
        count += 1;
        on_entry(count);
    }
    Ok(())
}

/// First-run bootstrap: unpack `runtime/runtime-archive.tar.gz` into the
/// runtime dir when the extracted tree is missing (fresh install).
fn extract_runtime_archive(app: &AppHandle, paths: &Paths) -> Result<(), String> {
    if paths.node_exe.exists() && paths.dsh_bin.exists() {
        return Ok(());
    }
    // The archive ships in the install dir (readable even when that dir is
    // not writable); the target is the resolved runtime_dir.
    let archive = paths.bundled_runtime_dir.join("runtime-archive.tar.gz");
    if !archive.exists() {
        return Err(format!("运行时组件缺失: {}", archive.display()));
    }
    if paths.runtime_dir != paths.bundled_runtime_dir {
        log_line(
            &paths.log_file,
            &format!(
                "install-dir runtime not usable/writable — extracting into {} instead",
                paths.runtime_dir.display()
            ),
        );
        // Seed the shipped version.json (node version etc.) into the target
        // so the dsh-version sync below only has to bump the dsh entry.
        let shipped = paths.bundled_runtime_dir.join("version.json");
        let target = paths.runtime_dir.join("version.json");
        if shipped.exists() && !target.exists() {
            let _ = fs::copy(&shipped, &target);
        }
    }
    log_line(&paths.log_file, "extracting bundled runtime archive (first run) ...");
    // The archive is streamed (no upfront total), so report a smoothed
    // entry-count progress: reaches ~95% around 24k files and caps at 99%
    // until extraction completes.
    let app2 = app.clone();
    let mut last_emit = 0usize;
    let mut on_entry = |count: usize| {
        if count - last_emit < 100 {
            return;
        }
        last_emit = count;
        let percent = (1.0 - (-(count as f64) / 8000.0).exp()) * 99.0;
        let _ = app2.emit_to(
            "main",
            "dsh-progress",
            serde_json::json!({
                "stage": "extract",
                "percent": (percent as u32).min(99),
                "detail": format!("已解压 {count} 个文件"),
            }),
        );
    };
    extract_tarball(&archive, &paths.runtime_dir, false, &mut on_entry)?;
    if !paths.node_exe.exists() || !paths.dsh_bin.exists() {
        return Err("运行时解压不完整".to_string());
    }
    // keep version.json in sync with the extracted tree
    let manifest = paths
        .runtime_dir
        .join("dsh")
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    if let Ok(s) = fs::read_to_string(&manifest) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            if let Some(ver) = v.get("version").and_then(|v| v.as_str()) {
                let version_file = paths.runtime_dir.join("version.json");
                let mut vjson: serde_json::Value = fs::read_to_string(&version_file)
                    .ok()
                    .and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or(serde_json::json!({}));
                vjson["dsh"] = serde_json::Value::String(ver.to_string());
                let _ = fs::write(
                    &version_file,
                    serde_json::to_string_pretty(&vjson).unwrap_or_default(),
                );
            }
        }
    }
    log_line(&paths.log_file, "runtime extraction complete");
    Ok(())
}

/// Merge one flat `NAME: value` entry into a YAML credentials file.
fn write_credential_entry(path: &Path, name: &str, value: Option<&str>) -> Result<(), String> {
    let content = fs::read_to_string(path).unwrap_or_default();
    let mut out = String::new();
    let mut replaced = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            out.push_str(line);
            out.push('\n');
            continue;
        }
        match trimmed.split_once(':') {
            Some((k, _)) if k.trim() == name => {
                replaced = true;
                if let Some(v) = value {
                    out.push_str(&format!("{}: {}\n", name, yaml_scalar(v)));
                }
            }
            _ => {
                out.push_str(line);
                out.push('\n');
            }
        }
    }
    if !replaced {
        if let Some(v) = value {
            out.push_str(&format!("{}: {}\n", name, yaml_scalar(v)));
        }
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, out).map_err(|e| format!("写入凭据文件失败: {e}"))
}

fn yaml_scalar(v: &str) -> String {
    let plain = v
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_.:+/=".contains(c))
        && !v.is_empty();
    if plain {
        v.to_string()
    } else {
        format!("'{}'", v.replace('\'', "''"))
    }
}

/// Read the current key: the credentials file is the freshest source of truth,
/// then Windows Credential Manager, then the legacy config fallback.
fn effective_key(paths: &Paths, config: &AppConfig) -> Option<String> {
    let cred_file = paths.dsh_home.join(".credentials.yaml");
    if let Ok(content) = fs::read_to_string(&cred_file) {
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some((k, v)) = trimmed.split_once(':') {
                if k.trim() == CREDENTIAL_NAME {
                    let v = v.trim().trim_matches('\'').trim_matches('"');
                    if !v.is_empty() {
                        return Some(v.to_string());
                    }
                }
            }
        }
    }
    keyring_get().or_else(|| config.api_key.clone())
}

/// Read one named entry from the credentials file (any name, not just the
/// DeepSeek key). The launching environment wins, mirroring dsh's own
/// credential layering (`KEY=… dsh` is read-only there).
fn read_credential(paths: &Paths, name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| {
            let cred_file = paths.dsh_home.join(".credentials.yaml");
            let content = fs::read_to_string(&cred_file).ok()?;
            for line in content.lines() {
                let trimmed = line.trim();
                if let Some((k, v)) = trimmed.split_once(':') {
                    if k.trim() == name {
                        let v = v.trim().trim_matches('\'').trim_matches('"');
                        if !v.is_empty() {
                            return Some(v.to_string());
                        }
                    }
                }
            }
            None
        })
}

/// Discover every LLM provider on this machine: the DSH built-in DeepSeek
/// entry (its base URL comes from `llm-deepseek.baseURL` / `DEEPSEEK_BASE_URL`
/// and defaults to api.deepseek.com) plus every provider declared under
/// `llm-pi-ai.providers.<id>` in `$DSH_HOME/settings.yaml` (any wire API —
/// the adapter matcher decides which balance endpoint family fits).
fn llm_providers(paths: &Paths) -> Vec<LlmProvider> {
    let settings_path = paths.dsh_home.join("settings.yaml");
    let raw = fs::read_to_string(&settings_path).unwrap_or_default();
    let env_base = std::env::var("DEEPSEEK_BASE_URL").ok().filter(|v| !v.is_empty());
    llm_providers_from_yaml(&raw, env_base.as_deref())
}

fn llm_providers_from_yaml(raw: &str, env_base: Option<&str>) -> Vec<LlmProvider> {
    let doc: serde_yaml::Value = serde_yaml::from_str(raw).unwrap_or(serde_yaml::Value::Null);
    let mut out = Vec::new();

    // 1. built-in DeepSeek (base URL overridable through dsh config/env)
    let ds_base = doc
        .get("llm-deepseek")
        .and_then(|v| v.get("baseURL"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .or(env_base)
        .unwrap_or("https://api.deepseek.com");
    out.push(LlmProvider {
        id: "deepseek-official".to_string(),
        display_name: "DeepSeek".to_string(),
        base_url: ds_base.trim_end_matches('/').to_string(),
        api: "deepseek".to_string(),
        key_env: CREDENTIAL_NAME.to_string(),
    });

    // 2. pi-ai providers — every wire API participates; matching happens later
    if let Some(providers) = doc
        .get("llm-pi-ai")
        .and_then(|v| v.get("providers"))
        .and_then(|v| v.as_mapping())
    {
        for (id_value, cfg_value) in providers {
            let Some(id) = id_value.as_str() else { continue };
            let Some(cfg) = cfg_value.as_mapping() else { continue };
            let Some(base_url) = cfg
                .get("baseURL")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let Some(key_env) = cfg
                .get("apiKeyEnv")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            let api = cfg
                .get("api")
                .and_then(|v| v.as_str())
                .unwrap_or_default();
            let display_name = cfg
                .get("displayName")
                .and_then(|v| v.as_str())
                .unwrap_or(id);
            out.push(LlmProvider {
                id: id.to_string(),
                display_name: display_name.to_string(),
                base_url: base_url.trim_end_matches('/').to_string(),
                api: api.to_string(),
                key_env: key_env.to_string(),
            });
        }
    }
    out
}

/// Route a provider to a balance adapter from its wire-API hint and base URL
/// host. Known protocols get a deterministic adapter; unknown combinations get
/// `Probe` (try both endpoint families at fetch time).
fn adapter_for(api: &str, base_url: &str) -> Adapter {
    let api = api.to_ascii_lowercase();
    let host = host_of(base_url).unwrap_or_default().to_ascii_lowercase();

    if api.contains("deepseek") || host.contains("deepseek") {
        return Adapter::DeepSeek;
    }
    if api.contains("openai") || host.contains("openai") {
        return Adapter::OpenAIBilling;
    }
    // protocols without any key-accessible balance/billing endpoint
    for marker in [
        "anthropic",
        "google",
        "gemini",
        "vertex",
        "bedrock",
        "mistral",
        "azure",
        "xai",
        "grok",
    ] {
        if api.contains(marker) || host.contains(marker) {
            return Adapter::Unsupported;
        }
    }
    Adapter::Probe
}

fn host_of(base_url: &str) -> Option<&str> {
    let rest = base_url
        .strip_prefix("https://")
        .or_else(|| base_url.strip_prefix("http://"))?;
    Some(rest.split('/').next().unwrap_or(rest))
}

// ---------------------------------------------------------------------------
// secure credential storage (Windows Credential Manager via keyring)
// ---------------------------------------------------------------------------

const KEYRING_SERVICE: &str = "dsh-desktop";
const KEYRING_USER: &str = "deepseek-api-key";

fn keyring_entry() -> Option<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()
}

/// Store (or clear) the key in the OS credential vault. Returns false when the
/// vault is unavailable (sandboxed runs) — callers fall back to config.json.
fn keyring_set(key: Option<&str>) -> bool {
    let Some(entry) = keyring_entry() else {
        return false;
    };
    let res = match key {
        Some(v) => entry.set_password(v),
        None => match entry.delete_credential() {
            Err(keyring::Error::NoEntry) => Ok(()),
            other => other,
        },
    };
    res.is_ok()
}

fn keyring_get() -> Option<String> {
    keyring_entry()?.get_password().ok()
}

fn balance_summary(balance: &Option<Balance>) -> String {
    match balance {
        Some(b) if b.is_available => b
            .balance_infos
            .first()
            .map(|i| {
                format!(
                    "余额 {} {}（充值 {} / 赠送 {}）",
                    i.total_balance, i.currency, i.topped_up_balance, i.granted_balance
                )
            })
            .unwrap_or_else(|| "余额未知".into()),
        Some(_) => "账户余额不可用".into(),
        None => "余额未获取".into(),
    }
}

fn balance_is_low(balance: &Option<Balance>, threshold: Option<f64>) -> bool {
    if let (Some(b), Some(t)) = (balance, threshold) {
        if let Some(info) = b.balance_infos.first() {
            if let Ok(v) = info.total_balance.parse::<f64>() {
                return v < t;
            }
        }
    }
    false
}

fn update_tray(app: &AppHandle, state: &AppState) {
    if let Ok(item) = state.tray_balance_item.lock() {
        if let Some(item) = item.as_ref() {
            let text = {
                let bal = state.balance.lock().unwrap().clone();
                let config = state.config.lock().unwrap().clone();
                let paths = resolve_paths(app, &config);
                let configured = effective_key(&paths, &config).is_some();
                if !configured {
                    "余额：未配置 Key".to_string()
                } else {
                    format!("{}（点击刷新）", balance_summary(&bal))
                }
            };
            let _ = item.set_text(text);
        }
    }
}

// ---------------------------------------------------------------------------
// dsh lifecycle
// ---------------------------------------------------------------------------

fn spawn_dsh(paths: &Paths, config: &AppConfig) -> Result<Child, String> {
    log_line(
        &paths.log_file,
        &format!(
            "spawn paths: cwd={:?} node={:?} bin={:?} patch={:?} home={:?}",
            std::env::current_dir(),
            paths.node_exe,
            paths.dsh_bin,
            paths.patch_file,
            paths.dsh_home
        ),
    );
    if !paths.node_exe.exists() {
        return Err(format!("找不到内置 Node 运行时: {}", paths.node_exe.display()));
    }
    if !paths.dsh_bin.exists() {
        return Err(format!("找不到内置 dsh: {}", paths.dsh_bin.display()));
    }
    log_line(&paths.log_file, "spawning dsh web ...");

    let mut cmd = Command::new(&paths.node_exe);
    // launcher flags first (--profile/--patch), then the web app's own flags
    cmd.arg(&paths.dsh_bin)
        .arg("--profile")
        .arg("web")
        .arg("--patch")
        .arg(&paths.patch_file)
        .arg("--port")
        .arg(dsh_port(config).to_string());
    // always pass the resolved home explicitly (default = ~/.dsh, shares CLI sessions)
    cmd.env("DSH_HOME", &paths.dsh_home);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动 dsh 失败: {e}"))?;

    let log = paths.log_file.clone();
    if let Some(stdout) = child.stdout.take() {
        let log2 = log.clone();
        thread::spawn(move || pipe_to_log(stdout, &log2));
    }
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || pipe_to_log(stderr, &log));
    }
    log_line(&paths.log_file, "dsh spawned");
    Ok(child)
}

fn pipe_to_log<R: Read + Send + 'static>(reader: R, log_path: &Path) {
    let log_path = log_path.to_path_buf();
    let reader = BufReader::new(reader);
    for line in reader.lines().map_while(Result::ok) {
        log_line(&log_path, &line);
    }
}

async fn health_check_loop(app: AppHandle) {
    let state = app.state::<AppState>();
    let mut attempts = 0u32;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .expect("http client");
    let port = dsh_port(&state.config.lock().unwrap().clone());
    let url = dsh_web_url(port);

    // Brief grace so the splash page can register its event listeners before
    // the first health result fires. Readiness no longer depends on the
    // event: the splash also polls `get_status` every 500 ms (pollStatus in
    // ui/index.html), so even a lost early `dsh-ready` costs one poll cycle
    // instead of a hard 3 s on every boot.
    tokio::time::sleep(Duration::from_millis(500)).await;

    loop {
        // first-run runtime extraction is still in progress — wait, don't
        // count attempts against the boot timeout.
        if !state.runtime_ready.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }

        // 1. probe health first: adoption decisions must not restart a child
        //    into a port that another instance already serves.
        let healthy = client
            .get(&url)
            .send()
            .await
            .map(|r| r.status().is_success() || r.status().is_server_error())
            .unwrap_or(false);

        if healthy {
            if !state.ui_ready.swap(true, Ordering::SeqCst) {
                let _ = app.emit_to(
                    "main",
                    "dsh-progress",
                    serde_json::json!({
                        "stage": "ready",
                        "percent": 100,
                        "detail": "服务已就绪",
                    }),
                );
                let _ = app.emit_to("main", "dsh-ready", url.clone());

                // Fallback title bar injection: normally the initialization
                // scripts mount everything on the dsh page; re-eval after
                // navigation covers exotic cases where document-created
                // injection failed.
                let script = format!(
                    "{}\n{}\n{}",
                    TITLEBAR_SCRIPT, THEME_TRANSITION_SCRIPT, OCEAN_THEME_SCRIPT
                );
                for delay in [3u64, 10] {
                    let app3 = app.clone();
                    let script3 = script.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(Duration::from_secs(delay)).await;
                        if let Some(w) = app3.get_webview_window("main") {
                            let _ = w.eval(&script3);
                        }
                    });
                }
            }
            let dsh_running = state.dsh.lock().unwrap().child.is_some();
            if !dsh_running && !state.adopted.load(Ordering::SeqCst) {
                state.adopted.store(true, Ordering::SeqCst);
                let paths = {
                    let config = state.config.lock().unwrap().clone();
                    resolve_paths(&app, &config)
                };
                log_line(
                    &paths.log_file,
                    "dsh port already served by another instance — adopted (balance refresh degrades to polling)",
                );
            }
        } else if !state.ui_ready.load(Ordering::SeqCst) {
            if attempts < 90 {
                attempts += 1;
                let _ = app.emit_to(
                    "main",
                    "dsh-status",
                    format!("正在启动 DeepSeek Harness 服务…（{attempts}/90）"),
                );
                let percent = ((attempts as f64 / 90.0) * 99.0) as u32;
                let _ = app.emit_to(
                    "main",
                    "dsh-progress",
                    serde_json::json!({
                        "stage": "boot",
                        "percent": percent.min(99),
                        "detail": format!("正在启动服务（{attempts}/90）"),
                    }),
                );
                if attempts == 90 {
                    // show the error, but KEEP polling: an update rollback can
                    // still bring the service back after this point.
                    let _ = app.emit_to("main", "dsh-failed", ());
                }
            }
        }

        // 2. restart policy: if our child exited, either adopt the server that
        //    is already answering (port busy) or restart — never churn three
        //    restarts into an occupied port.
        {
            let mut dsh = state.dsh.lock().unwrap();
            let paths = {
                let config = state.config.lock().unwrap().clone();
                resolve_paths(&app, &config)
            };
            if let Some(child) = dsh.child.as_mut() {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        log_line(&paths.log_file, &format!("dsh exited: {status:?}"));
                        dsh.child = None;
                        if healthy {
                            log_line(
                                &paths.log_file,
                                "another dsh instance serves the port — adopting it",
                            );
                        } else if dsh.restarts < 3 {
                            dsh.restarts += 1;
                            log_line(
                                &paths.log_file,
                                &format!("restarting dsh (attempt {})", dsh.restarts),
                            );
                            let config = state.config.lock().unwrap().clone();
                            match spawn_dsh(&paths, &config) {
                                Ok(c) => dsh.child = Some(c),
                                Err(e) => {
                                    log_line(&paths.log_file, &format!("restart failed: {e}"))
                                }
                            }
                        } else {
                            log_line(&paths.log_file, "dsh restart limit reached");
                        }
                    }
                    Ok(None) => {}
                    Err(_) => {}
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

// ---------------------------------------------------------------------------
// balance
// ---------------------------------------------------------------------------

const DEFAULT_DEEPSEEK_BASE: &str = "https://api.deepseek.com";

/// Validate/query the DeepSeek key against the official endpoint (used by the
/// settings window's key registration).
async fn fetch_balance(key: &str) -> Result<Balance, String> {
    fetch_deepseek_balance(DEFAULT_DEEPSEEK_BASE, key).await
}

/// GET {base}/user/balance with the DeepSeek response schema — works for
/// api.deepseek.com and DeepSeek-compatible relays.
async fn fetch_deepseek_balance(base: &str, key: &str) -> Result<Balance, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP 客户端失败: {e}"))?;
    let resp = client
        .get(format!("{base}/user/balance"))
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("网络错误: {e}"))?;
    match resp.status().as_u16() {
        200 => resp
            .json::<Balance>()
            .await
            .map_err(|e| format!("解析余额响应失败: {e}")),
        401 | 403 => Err("API Key 无效（鉴权失败），请检查 Key".to_string()),
        other => Err(format!("余额接口返回状态码 {other}")),
    }
}

#[derive(Deserialize)]
struct BillingUsageResp {
    total_usage: Option<f64>,
}

#[derive(Deserialize)]
struct BillingSubscriptionResp {
    has_payment_method: Option<bool>,
    soft_limit_usd: Option<f64>,
    hard_limit_usd: Option<f64>,
}

/// Query an OpenAI-compatible gateway's dashboard billing endpoints. The
/// subscription call is best-effort: a gateway may serve usage without it.
async fn fetch_openai_usage(base: &str, key: &str) -> Result<ProviderUsage, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP 客户端失败: {e}"))?;
    let usage_url = format!("{base}/dashboard/billing/usage");
    let usage_resp = client
        .get(&usage_url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("网络错误: {e}"))?;
    let usage = match usage_resp.status().as_u16() {
        200 => usage_resp
            .json::<BillingUsageResp>()
            .await
            .map_err(|e| format!("解析消费响应失败: {e}"))?,
        401 | 403 => return Err("API Key 无效（鉴权失败），请检查 Key".to_string()),
        other => return Err(format!("消费接口返回状态码 {other}")),
    };
    // subscription limits are optional — missing them is not an error
    let sub = match client
        .get(format!("{base}/dashboard/billing/subscription"))
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(r) => r.json::<BillingSubscriptionResp>().await.ok(),
        Err(_) => None,
    };
    Ok(ProviderUsage {
        total_usage_usd: usage.total_usage,
        soft_limit_usd: sub.as_ref().and_then(|s| s.soft_limit_usd),
        hard_limit_usd: sub.as_ref().and_then(|s| s.hard_limit_usd),
        has_payment_method: sub.as_ref().and_then(|s| s.has_payment_method),
    })
}

const UNSUPPORTED_NOTE: &str = "该平台未提供可通过 API Key 查询的余额/账单接口";

fn adapter_key(adapter: Adapter) -> &'static str {
    match adapter {
        Adapter::DeepSeek => "deepseek",
        Adapter::OpenAIBilling => "openai",
        Adapter::Unsupported | Adapter::Probe => "unsupported",
    }
}

fn adapter_from_cache(cached: Option<&str>) -> Option<Adapter> {
    match cached {
        Some("deepseek") => Some(Adapter::DeepSeek),
        Some("openai") => Some(Adapter::OpenAIBilling),
        Some(_) => Some(Adapter::Unsupported),
        None => None,
    }
}

/// Run one adapter against a provider. `Probe` tries the OpenAI-style billing
/// endpoints first (the common gateway case), then the DeepSeek-style balance
/// endpoint, and reports the platform as unsupported when neither answers.
async fn attempt_adapter(
    adapter: Adapter,
    base: &str,
    key: &str,
) -> Result<(String, Option<Balance>, Option<ProviderUsage>), String> {
    match adapter {
        Adapter::DeepSeek => fetch_deepseek_balance(base, key)
            .await
            .map(|b| ("deepseek".to_string(), Some(b), None)),
        Adapter::OpenAIBilling => fetch_openai_usage(base, key)
            .await
            .map(|u| ("openai".to_string(), None, Some(u))),
        Adapter::Unsupported => Err(UNSUPPORTED_NOTE.to_string()),
        Adapter::Probe => match fetch_openai_usage(base, key).await {
            Ok(u) => Ok(("openai".to_string(), None, Some(u))),
            Err(openai_err) => match fetch_deepseek_balance(base, key).await {
                Ok(b) => Ok(("deepseek".to_string(), Some(b), None)),
                Err(deepseek_err) => Err(format!(
                    "{UNSUPPORTED_NOTE}（openai 风格失败: {openai_err}；deepseek 风格失败: {deepseek_err}）"
                )),
            },
        },
    }
}

async fn fetch_one_provider(
    provider: LlmProvider,
    key: Option<String>,
    cached: Option<String>,
) -> (String, ProviderStatus) {
    let base_kind = if provider.api.to_ascii_lowercase().contains("deepseek") {
        "balance"
    } else {
        "usage"
    };
    let unconfigured = ProviderStatus {
        id: provider.id.clone(),
        display_name: provider.display_name.clone(),
        kind: base_kind.to_string(),
        configured: false,
        balance: None,
        usage: None,
        error: None,
    };
    let Some(key) = key else {
        return (String::new(), unconfigured);
    };

    let explicit = adapter_for(&provider.api, &provider.base_url);
    let from_cache = adapter_from_cache(cached.as_deref());
    let mut resolved = from_cache.unwrap_or(explicit);
    let mut attempt = attempt_adapter(resolved, &provider.base_url, &key).await;
    // a cached route that stopped answering: retry once with the fresh match
    if attempt.is_err() && from_cache.is_some() && explicit != resolved {
        resolved = explicit;
        attempt = attempt_adapter(resolved, &provider.base_url, &key).await;
    }

    let (key2, balance, usage, error) = match attempt {
        Ok((k, b, u)) => (k, b, u, None),
        Err(e) => (adapter_key(resolved).to_string(), None, None, Some(e)),
    };
    let kind = if balance.is_some() {
        "balance"
    } else if usage.is_some() {
        "usage"
    } else if key2 == "unsupported" {
        "unsupported"
    } else {
        base_kind
    };
    (
        key2,
        ProviderStatus {
            id: provider.id,
            display_name: provider.display_name,
            kind: kind.to_string(),
            configured: true,
            balance,
            usage,
            error,
        },
    )
}

/// Query every discovered LLM platform. Providers are routed to a balance
/// adapter from their wire API + base URL (with a probe fallback for unknown
/// combinations); all are queried concurrently and one failing platform only
/// fails its own status entry. Successful adapter routes are cached per
/// provider id so probing doesn't repeat every refresh cycle.
async fn fetch_provider_statuses(
    paths: &Paths,
    config: &AppConfig,
    adapters: &Mutex<HashMap<String, String>>,
) -> Vec<ProviderStatus> {
    let providers = llm_providers(paths);
    let mut handles = Vec::with_capacity(providers.len());
    for provider in providers {
        let key = if provider.id == "deepseek-official" {
            effective_key(paths, config)
        } else {
            read_credential(paths, &provider.key_env)
        };
        let cached = adapters.lock().unwrap().get(&provider.id).cloned();
        handles.push(tauri::async_runtime::spawn(fetch_one_provider(
            provider, key, cached,
        )));
    }

    let mut statuses = Vec::with_capacity(handles.len());
    for handle in handles {
        match handle.await {
            Ok((adapter_key2, status)) => {
                if !adapter_key2.is_empty() {
                    adapters
                        .lock()
                        .unwrap()
                        .insert(status.id.clone(), adapter_key2);
                }
                statuses.push(status);
            }
            Err(e) => statuses.push(ProviderStatus {
                id: "unknown".to_string(),
                display_name: "未知平台".to_string(),
                kind: "usage".to_string(),
                configured: false,
                balance: None,
                usage: None,
                error: Some(format!("后台任务失败: {e}")),
            }),
        }
    }
    statuses
}

async fn refresh_balance(
    app: &AppHandle,
    state: &State<'_, AppState>,
) -> Result<Option<Balance>, String> {
    {
        let mut last = state.last_refresh.lock().unwrap();
        if let Some(t) = *last {
            if t.elapsed() < Duration::from_secs(MIN_REFRESH_INTERVAL_SECS) {
                return Ok(state.balance.lock().unwrap().clone());
            }
        }
        *last = Some(Instant::now());
    }
    let (config, paths) = {
        let config = state.config.lock().unwrap().clone();
        let paths = resolve_paths(app, &config);
        (config, paths)
    };
    let statuses = fetch_provider_statuses(&paths, &config, &state.adapters).await;
    *state.providers.lock().unwrap() = Some(statuses.clone());

    let ds = statuses.iter().find(|s| s.id == "deepseek-official");
    let ds_configured = ds.map(|s| s.configured).unwrap_or(false);
    let ds_error = ds.and_then(|s| s.error.clone());
    let balance = ds.and_then(|s| s.balance.clone());
    *state.balance.lock().unwrap() = balance.clone();
    update_tray(app, state);

    match (ds_configured, balance, ds_error) {
        (true, Some(bal), _) => {
            let low = balance_is_low(
                &Some(bal.clone()),
                state.config.lock().unwrap().balance_low_threshold,
            );
            let _ = app.emit(
                "balance-updated",
                serde_json::json!({
                    "balance": bal,
                    "low": low,
                    "at": chrono::Local::now().format("%H:%M:%S").to_string()
                }),
            );
            Ok(Some(bal))
        }
        (true, None, Some(e)) => Err(e),
        (true, None, None) => Ok(None),
        (false, _, _) => Ok(None),
    }
}

async fn periodic_loop(app: AppHandle) {
    let mut first_pass = true;
    loop {
        // the first pass runs after 10s (a quick second chance if the initial
        // boot refresh hit a transient network error), then the normal 60s cadence
        tokio::time::sleep(Duration::from_secs(if first_pass { 10 } else { 60 })).await;
        first_pass = false;
        let state = app.state::<AppState>();

        // refresh bridge reachability (cheap local ping)
        let port = state.config.lock().unwrap().bridge_port;
        let bridge_ok = match reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
        {
            Ok(client) => client
                .get(format!("http://127.0.0.1:{port}/ping"))
                .send()
                .await
                .map(|r| r.status().is_success())
                .unwrap_or(false),
            Err(_) => false,
        };
        state.bridge_ok.store(bridge_ok, Ordering::SeqCst);

        let _ = refresh_balance(&app, &state).await;

        // automatic update detection: first check soon after boot, then every 6h
        let update_due = {
            let mut last = state.last_update_check.lock().unwrap();
            let due = last
                .map(|t| t.elapsed() > Duration::from_secs(6 * 3600))
                .unwrap_or(true);
            if due {
                *last = Some(Instant::now());
            }
            due
        };
        if update_due {
            let config = state.config.lock().unwrap().clone();
            let paths = resolve_paths(&app, &config);
            match reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
            {
                Ok(client) => match fetch_update_status(&client, &paths, &config).await {
                    Ok(status) => {
                        log_line(
                            &paths.log_file,
                            &format!(
                                "update check: dsh {}{}, shell {}{}",
                                status.dsh_current.clone().unwrap_or_else(|| "?".into()),
                                if status.dsh_update_available {
                                    format!(" -> {} (available)", status.dsh_latest.clone().unwrap_or_default())
                                } else {
                                    " (current)".into()
                                },
                                status.app_current,
                                if status.app_update_available {
                                    format!(" -> {} (available)", status.app_latest.clone().unwrap_or_default())
                                } else {
                                    " (current)".into()
                                },
                            ),
                        );
                        if status.dsh_update_available || status.app_update_available {
                            let _ = app.emit("update-status", &status);
                        }
                    }
                    Err(e) => log_line(&paths.log_file, &format!("update check failed: {e}")),
                },
                Err(e) => log_line(&paths.log_file, &format!("update check client failed: {e}")),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// bridge listener (shell side): dsh's bridge plugin POSTs /turn-end here
// ---------------------------------------------------------------------------

fn json_response(status: u16, body: serde_json::Value) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let bytes = serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec());
    tiny_http::Response::from_data(bytes)
        .with_status_code(status)
        .with_header(
            tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap(),
        )
}

fn start_bridge_listener(app: AppHandle, port: u16) {
    thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", port)) {
            Ok(s) => s,
            Err(e) => {
                let state = app.state::<AppState>();
                let paths = {
                    let config = state.config.lock().unwrap().clone();
                    resolve_paths(&app, &config)
                };
                log_line(&paths.log_file, &format!("bridge listener failed: {e}"));
                return;
            }
        };
        let paths = {
            let config = app.state::<AppState>().config.lock().unwrap().clone();
            resolve_paths(&app, &config)
        };
        log_line(&paths.log_file, &format!("bridge listener on 127.0.0.1:{port}"));
        // handle each request on its own thread: /refresh can block up to the
        // balance-fetch timeout and must never queue /balance or /turn-end
        // behind it (the in-app widget's /desktop proxy has a 3s deadline).
        let log_file = paths.log_file.clone();
        loop {
            let mut req = match server.recv() {
                Ok(req) => req,
                Err(e) => {
                    log_line(&paths.log_file, &format!("bridge listener error: {e}"));
                    break;
                }
            };
            let app2 = app.clone();
            let log_file2 = log_file.clone();
            thread::spawn(move || {
                let url = req.url().to_string();
                let method = req.method().clone();
                let path = url.split('?').next().unwrap_or("").to_string();
                match (method.as_str(), path.as_str()) {
                    ("POST", "/turn-end") => {
                        let _ = req.respond(tiny_http::Response::from_string("ok").with_status_code(200));
                        let app3 = app2.clone();
                        tauri::async_runtime::spawn(async move {
                            let state2 = app3.state::<AppState>();
                            let _ = refresh_balance(&app3, &state2).await;
                        });
                    }
                    ("POST", "/turn-state") => {
                        // wave-state feed from the bridge plugin: read the JSON
                        // body, acknowledge, then broadcast to the main window
                        // (the injected ambient layer listens and crossfades)
                        let mut body = String::new();
                        let _ = req.as_reader().read_to_string(&mut body);
                        let _ = req.respond(tiny_http::Response::from_string("ok").with_status_code(200));
                        let payload: serde_json::Value =
                            serde_json::from_str(&body).unwrap_or(serde_json::json!({}));
                        let state = payload
                            .get("state")
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();
                        let detail = payload
                            .get("detail")
                            .and_then(|s| s.as_str())
                            .unwrap_or("")
                            .to_string();
                        const WAVE_STATES: [&str; 7] =
                            ["calm", "thinking", "streaming", "tooling", "waiting", "error", "settle"];
                        if WAVE_STATES.contains(&state.as_str()) {
                            let _ = app2.emit(
                                "dsh-wave-state",
                                serde_json::json!({ "state": state, "detail": detail }),
                            );
                            log_line(
                                &log_file2,
                                &format!("wave state: {state} <- {detail}").trim_end(),
                            );
                        }
                    }
                    ("GET", "/balance") => {
                        let state2 = app2.state::<AppState>();
                        let config = state2.config.lock().unwrap().clone();
                        let paths2 = resolve_paths(&app2, &config);
                        let configured = effective_key(&paths2, &config).is_some()
                            || state2
                                .providers
                                .lock()
                                .unwrap()
                                .as_ref()
                                .is_some_and(|p| p.iter().any(|s| s.configured));
                        let balance = state2.balance.lock().unwrap().clone();
                        let providers = state2.providers.lock().unwrap().clone();
                        let low = balance_is_low(&balance, config.balance_low_threshold);
                        let _ = req.respond(json_response(
                            200,
                            serde_json::json!({
                                "ok": true,
                                "configured": configured,
                                "registeredAt": config.key_registered_at,
                                "balance": balance,
                                "providers": providers,
                                "low": low,
                            }),
                        ));
                    }
                    ("GET", "/refresh") => {
                        let app3 = app2.clone();
                        let (tx, rx) = std::sync::mpsc::channel();
                        tauri::async_runtime::spawn(async move {
                            let state2 = app3.state::<AppState>();
                            let result = refresh_balance(&app3, &state2).await;
                            let _ = tx.send(result);
                        });
                        let state2 = app2.state::<AppState>();
                        match rx.recv_timeout(Duration::from_secs(12)) {
                            Ok(result) => match result {
                                Ok(balance) => {
                                    let config = state2.config.lock().unwrap().clone();
                                    let paths2 = resolve_paths(&app2, &config);
                                    let configured = effective_key(&paths2, &config).is_some();
                                    let low = balance_is_low(&balance, config.balance_low_threshold);
                                    let _ = req.respond(json_response(
                                        200,
                                        serde_json::json!({
                                            "ok": true,
                                            "configured": configured,
                                            "registeredAt": config.key_registered_at,
                                            "balance": balance,
                                            "low": low,
                                        }),
                                    ));
                                }
                                Err(e) => {
                                    let _ = req.respond(json_response(
                                        502,
                                        serde_json::json!({ "ok": false, "error": e }),
                                    ));
                                }
                            },
                            Err(_) => {
                                let _ = req.respond(json_response(
                                    504,
                                    serde_json::json!({ "ok": false, "error": "余额刷新超时" }),
                                ));
                            }
                        }
                    }
                    ("GET", "/about") => {
                        let state2 = app2.state::<AppState>();
                        let config = state2.config.lock().unwrap().clone();
                        let paths2 = resolve_paths(&app2, &config);
                        let dsh_version = fs::read_to_string(paths2.runtime_dir.join("version.json"))
                            .ok()
                            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                            .and_then(|v| {
                                v.get("dsh").and_then(|v| v.as_str()).map(String::from)
                            });
                        let _ = req.respond(json_response(
                            200,
                            serde_json::json!({
                                "ok": true,
                                "appName": "DSH Desktop",
                                "appVersion": env!("CARGO_PKG_VERSION"),
                                "dshVersion": dsh_version,
                                "author": "Anixuil",
                                "blog": "https://www.anixuil.top",
                                "repo": "https://github.com/Anixuil/dsh-desktop",
                            }),
                        ));
                    }
                    ("GET", "/update-status") => {
                        let app3 = app2.clone();
                        let (tx, rx) = std::sync::mpsc::channel();
                        tauri::async_runtime::spawn(async move {
                            let state2 = app3.state::<AppState>();
                            let config = state2.config.lock().unwrap().clone();
                            let paths2 = resolve_paths(&app3, &config);
                            let result = match reqwest::Client::builder()
                                .timeout(Duration::from_secs(15))
                                .build()
                            {
                                Ok(client) => {
                                    fetch_update_status(&client, &paths2, &config).await
                                }
                                Err(e) => Err(format!("HTTP 客户端失败: {e}")),
                            };
                            let _ = tx.send(result);
                        });
                        match rx.recv_timeout(Duration::from_secs(20)) {
                            Ok(Ok(status)) => {
                                let mut payload = serde_json::to_value(&status)
                                    .unwrap_or(serde_json::json!({}));
                                payload["ok"] = serde_json::json!(true);
                                let _ = req.respond(json_response(200, payload));
                            }
                            Ok(Err(e)) => {
                                let _ = req.respond(json_response(
                                    502,
                                    serde_json::json!({ "ok": false, "error": e }),
                                ));
                            }
                            Err(_) => {
                                let _ = req.respond(json_response(
                                    504,
                                    serde_json::json!({ "ok": false, "error": "检查更新超时" }),
                                ));
                            }
                        }
                    }
                    ("POST", "/open-external") => {
                        let mut body = Vec::new();
                        let _ = req.as_reader().read_to_end(&mut body);
                        let url = serde_json::from_slice::<serde_json::Value>(&body)
                            .ok()
                            .and_then(|v| {
                                v.get("url").and_then(|u| u.as_str()).map(String::from)
                            })
                            .unwrap_or_default();
                        match open_external_impl(&url) {
                            Ok(()) => {
                                let _ = req.respond(json_response(
                                    200,
                                    serde_json::json!({ "ok": true }),
                                ));
                            }
                            Err(e) => {
                                let _ = req.respond(json_response(
                                    400,
                                    serde_json::json!({ "ok": false, "error": e }),
                                ));
                            }
                        }
                    }
                    _ => {
                        let _ = req.respond(json_response(
                            404,
                            serde_json::json!({ "ok": false, "error": "not found" }),
                        ));
                    }
                }
            });
        }
    });
}

// ---------------------------------------------------------------------------
// tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_status(app: AppHandle, state: State<'_, AppState>) -> StatusSnapshot {
    let config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(&app, &config);
    let key_configured = effective_key(&paths, &config).is_some();
    let balance = state.balance.lock().unwrap().clone();
    let low = balance_is_low(&balance, config.balance_low_threshold);

    let dsh_version = fs::read_to_string(
        paths
            .runtime_dir
            .join("dsh")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("package.json"),
    )
    .ok()
    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(String::from));

    let node_version = fs::read_to_string(paths.runtime_dir.join("version.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("node").and_then(|v| v.as_str()).map(String::from));

    StatusSnapshot {
        dsh_running: state.dsh.lock().unwrap().child.is_some()
            || state.adopted.load(Ordering::SeqCst),
        ui_ready: state.ui_ready.load(Ordering::SeqCst),
        bridge_ok: state.bridge_ok.load(Ordering::SeqCst),
        adopted: state.adopted.load(Ordering::SeqCst),
        key_configured,
        balance,
        balance_low: low,
        dsh_version,
        node_version,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        log_path: paths.log_file.display().to_string(),
        dsh_home: paths.dsh_home.display().to_string(),
        dsh_port: dsh_port(&config),
        motion_intensity: config.motion,
    }
}

/// Persist the UI motion intensity and broadcast `motion-updated` so every
/// window (splash, settings, and the injected dsh page scripts) applies it
/// live without a reload.
#[tauri::command]
fn set_motion_intensity(
    app: AppHandle,
    state: State<'_, AppState>,
    motion: MotionIntensity,
) -> Result<MotionIntensity, String> {
    let mut config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(&app, &config);
    config.motion = motion;
    save_config(&paths.config_file, &config);
    *state.config.lock().unwrap() = config;
    let _ = app.emit(
        "motion-updated",
        serde_json::json!({ "motion": motion }),
    );
    Ok(motion)
}

#[tauri::command]
async fn set_api_key(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<SetKeyResult, String> {
    let key = key.trim().to_string();
    let mut config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(&app, &config);

    if key.is_empty() {
        config.api_key = None;
        config.key_registered_at = None;
        let _ = keyring_set(None);
        save_config(&paths.config_file, &config);
        *state.config.lock().unwrap() = config.clone();
        let _ = write_credential_entry(
            &paths.dsh_home.join(".credentials.yaml"),
            CREDENTIAL_NAME,
            None,
        );
        let _ = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{}/unset-key", config.bridge_port))
            .send()
            .await;
        *state.balance.lock().unwrap() = None;
        update_tray(&app, &state);
        return Ok(SetKeyResult {
            configured: false,
            balance: None,
        });
    }

    // validate first — a bad key must never reach DSH
    let balance = fetch_balance(&key).await?;

    // primary storage: Windows Credential Manager; config.json only as fallback
    let vault_ok = keyring_set(Some(&key));
    config.api_key = if vault_ok { None } else { Some(key.clone()) };
    // each successful registration restarts the in-app consumption window
    config.key_registered_at = Some(chrono::Utc::now().timestamp_millis());
    save_config(&paths.config_file, &config);
    *state.config.lock().unwrap() = config.clone();
    // deliver to DSH: credentials file (works always) + bridge service (live event)
    write_credential_entry(
        &paths.dsh_home.join(".credentials.yaml"),
        CREDENTIAL_NAME,
        Some(&key),
    )?;
    let _ = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{}/set-key", config.bridge_port))
        .json(&serde_json::json!({ "key": key }))
        .send()
        .await;

    *state.balance.lock().unwrap() = Some(balance.clone());
    // refresh the full multi-provider snapshot too (the registered key is new)
    let statuses = fetch_provider_statuses(&paths, &config, &state.adapters).await;
    *state.providers.lock().unwrap() = Some(statuses);
    update_tray(&app, &state);
    let low = balance_is_low(&Some(balance.clone()), config.balance_low_threshold);
    let _ = app.emit(
        "balance-updated",
        serde_json::json!({
            "balance": balance,
            "low": low,
            "at": chrono::Local::now().format("%H:%M:%S").to_string()
        }),
    );
    Ok(SetKeyResult {
        configured: true,
        balance: Some(balance),
    })
}

#[tauri::command]
async fn refresh_balance_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Balance>, String> {
    refresh_balance(&app, &state).await
}

#[tauri::command]
fn open_logs(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(&app, &config);
    let _ = Command::new("explorer").arg(&paths.logs_dir).spawn();
    Ok(())
}

#[tauri::command]
fn open_dsh_home(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(&app, &config);
    let _ = Command::new("explorer").arg(&paths.dsh_home).spawn();
    Ok(())
}

/// Open an http(s) URL in the system default browser. The scheme whitelist
/// is the whole safety boundary: nothing else ever reaches explorer.exe.
fn open_external_impl(url: &str) -> Result<(), String> {
    let url = url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持打开 http/https 链接".to_string());
    }
    // explorer.exe doubles as a ShellExecute delegate: http(s) URLs are
    // handed to the default browser, and the argument passes through
    // CreateProcess directly (no `cmd /C start` metacharacter parsing).
    let _ = Command::new("explorer")
        .arg(url)
        .spawn()
        .map_err(|e| format!("打开链接失败: {e}"))?;
    Ok(())
}

/// Tauri command (settings window) — the in-app About section reaches the
/// same helper through the bridge listener's POST /open-external route.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    open_external_impl(&url)
}

#[tauri::command]
fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let motion = app.state::<AppState>().config.lock().unwrap().motion;
    let w = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title("DSH Desktop 设置")
        .inner_size(560.0, 780.0)
        .min_inner_size(480.0, 560.0)
        .data_directory(webview_data_dir(&app))
        .initialization_script(INIT_SCRIPT)
        .initialization_script(motion_init_script(motion))
        .build()
        .map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    Ok(())
}

// ---------------------------------------------------------------------------
// updates: dsh runtime (npm registry) + shell (GitHub Releases, optional repo)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub dsh_current: Option<String>,
    pub dsh_latest: Option<String>,
    pub dsh_tarball: Option<String>,
    pub dsh_update_available: bool,
    pub app_current: String,
    pub app_latest: Option<String>,
    pub app_update_available: bool,
    pub app_url: Option<String>,
    pub app_asset: Option<String>,
    pub app_repo: Option<String>,
}

/// Shared update-status query: npm registry (dsh core) + optional GitHub repo (shell).
async fn fetch_update_status(
    client: &reqwest::Client,
    paths: &Paths,
    config: &AppConfig,
) -> Result<UpdateStatus, String> {
    let dsh_current = fs::read_to_string(paths.runtime_dir.join("version.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("dsh").and_then(|v| v.as_str()).map(String::from));

    let mut dsh_latest = None;
    let mut dsh_tarball = None;
    match client
        .get("https://registry.npmjs.org/@deepseek-ai/dsh/latest")
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(v) = resp.json::<serde_json::Value>().await {
                dsh_latest = v.get("version").and_then(|v| v.as_str()).map(String::from);
                dsh_tarball = v
                    .pointer("/dist/tarball")
                    .and_then(|v| v.as_str())
                    .map(String::from);
            }
        }
        Ok(resp) => return Err(format!("npm registry 返回 {}", resp.status())),
        Err(e) => return Err(format!("查询 dsh 最新版本失败: {e}")),
    }

    let repo = config
        .update_repo
        .clone()
        .or_else(|| std::env::var("DSH_DESKTOP_UPDATE_REPO").ok())
        .filter(|r| !r.trim().is_empty())
        .or_else(|| Some(DEFAULT_UPDATE_REPO.to_string()));
    let mut app_latest = None;
    let mut app_url = None;
    let mut app_asset = None;
    if let Some(repo) = &repo {
        let url = format!("https://api.github.com/repos/{repo}/releases/latest");
        match client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "dsh-desktop")
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(v) = resp.json::<serde_json::Value>().await {
                    app_latest = v
                        .get("tag_name")
                        .and_then(|t| t.as_str())
                        .map(|t| t.trim_start_matches('v').to_string());
                    app_url = v.get("html_url").and_then(|u| u.as_str()).map(String::from);
                    if let Some(assets) = v.get("assets").and_then(|a| a.as_array()) {
                        app_asset = assets
                            .iter()
                            .filter_map(|a| {
                                a.get("browser_download_url")
                                    .and_then(|u| u.as_str())
                            })
                            .find(|u| u.ends_with(".exe") || u.ends_with(".msi"))
                            .map(String::from);
                    }
                }
            }
            Ok(resp) => return Err(format!("GitHub API 返回 {}（仓库 {repo}）", resp.status())),
            Err(e) => return Err(format!("查询 GitHub Releases 失败: {e}")),
        }
    }

    let app_current = env!("CARGO_PKG_VERSION").to_string();
    Ok(UpdateStatus {
        dsh_update_available: matches!((&dsh_latest, &dsh_current), (Some(l), Some(c)) if l != c),
        app_update_available: matches!(&app_latest, Some(l) if l != &app_current),
        dsh_current,
        dsh_latest,
        dsh_tarball,
        app_current,
        app_latest,
        app_url,
        app_asset,
        app_repo: repo,
    })
}

#[tauri::command]
async fn check_update(app: AppHandle, state: State<'_, AppState>) -> Result<UpdateStatus, String> {
    let config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(&app, &config);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端失败: {e}"))?;
    fetch_update_status(&client, &paths, &config).await
}

/// Stage, verify, swap, and roll back a dsh runtime update from an npm
/// tarball. Pure filesystem logic — unit-tested below.
/// Pending-update verification record: survives app restarts so a broken
/// update is always verified (and rolled back) on the next boot too.
#[derive(Serialize, Deserialize)]
struct UpdateBackupInfo {
    backup: String,
    previous_version: String,
}

fn update_backup_file(runtime: &Path) -> PathBuf {
    runtime.join(".update-backup.json")
}

fn write_pending_update(runtime: &Path, info: &UpdateBackupInfo) {
    if let Ok(s) = serde_json::to_string(info) {
        let _ = fs::write(update_backup_file(runtime), s);
    }
}

fn read_pending_update(runtime: &Path) -> Option<UpdateBackupInfo> {
    fs::read_to_string(update_backup_file(runtime))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn clear_pending_update(runtime: &Path) {
    let _ = fs::remove_file(update_backup_file(runtime));
}

fn apply_dsh_tarball_bytes(
    runtime: &Path,
    plugins_src_dir: &Path,
    bytes: &[u8],
    log: &Path,
) -> Result<String, String> {
    // stage
    let stage = runtime.join(".update-stage");
    let _ = fs::remove_dir_all(&stage);
    fs::create_dir_all(&stage).map_err(|e| format!("创建暂存目录失败: {e}"))?;

    let tgz_path = stage.join("pkg.tgz");
    fs::write(&tgz_path, bytes).map_err(|e| format!("写入失败: {e}"))?;

    // extract (npm tarball root is `package/`, stripped)
    let dsh_new = stage.join("dsh-new");
    let mut no_progress = |_count: usize| {};
    extract_tarball(&tgz_path, &dsh_new, true, &mut no_progress)?;

    // restore the desktop plugin packages (and the bundled vision plugin)
    // into the new tree — the canonical copies live in the bundled runtime
    // (the install dir) even when the extracted tree lives elsewhere.
    let plugins_src = plugins_src_dir.join("plugins-src");
    if plugins_src.exists() {
        for name in DESKTOP_PLUGINS
            .iter()
            .copied()
            .chain(std::iter::once(VISION_PLUGIN))
        {
            let src = plugins_src.join(name);
            if !src.exists() {
                continue;
            }
            let dst = dsh_new.join("node_modules").join(name);
            fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
            copy_dir_contents(&src, &dst).map_err(|e| format!("恢复桌面插件 {name} 失败: {e}"))?;
        }
    } else if plugins_src_dir.join("bridge-src").exists() {
        // pre-plugins-src installs keep the legacy canonical dir: restore the
        // bridge from it so a dsh update never strips the shell bridge.
        let bdst = dsh_new.join("node_modules").join("dsh-desktop-bridge");
        fs::create_dir_all(&bdst).map_err(|e| e.to_string())?;
        for f in ["package.json", "index.js", "client.js"] {
            let from = plugins_src_dir.join("bridge-src").join(f);
            if !from.exists() {
                continue;
            }
            fs::copy(&from, bdst.join(f))
                .map_err(|e| format!("恢复桥接插件失败: {e}"))?;
        }
    }

    // verify the new tree carries a readable dsh version
    let manifest_path = dsh_new
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    let new_version = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(String::from))
        .ok_or("更新包校验失败：缺少 @deepseek-ai/dsh")?;

    // swap with backup; the backup is KEPT until the new runtime proves it
    // can boot — verify_update_rollback deletes it on success and restores it
    // on failure (including across app restarts).
    let dsh_dir = runtime.join("dsh");
    let previous_version = fs::read_to_string(
        dsh_dir
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("package.json"),
    )
    .ok()
    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(String::from))
    .unwrap_or_else(|| "unknown".to_string());

    let backup = runtime.join(format!(
        "dsh-old-{}",
        chrono::Local::now().format("%Y%m%d%H%M%S")
    ));
    if dsh_dir.exists() {
        fs::rename(&dsh_dir, &backup).map_err(|e| format!("备份旧版本失败: {e}"))?;
    }
    if let Err(e) = fs::rename(&dsh_new, &dsh_dir) {
        let _ = fs::rename(&backup, &dsh_dir);
        let _ = fs::remove_dir_all(&stage);
        return Err(format!("替换失败，已回滚: {e}"));
    }

    // bump version.json
    let version_file = runtime.join("version.json");
    let mut vjson: serde_json::Value = fs::read_to_string(&version_file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}));
    vjson["dsh"] = serde_json::Value::String(new_version.clone());
    let _ = fs::write(&version_file, serde_json::to_string_pretty(&vjson).unwrap_or_default());

    // record the pending-verification backup
    write_pending_update(
        runtime,
        &UpdateBackupInfo {
            backup: backup.to_string_lossy().to_string(),
            previous_version: previous_version.clone(),
        },
    );
    let _ = fs::remove_dir_all(&stage);
    log_line(
        log,
        &format!(
            "dsh swapped to {new_version} (previous {previous_version} kept for verification)"
        ),
    );
    Ok(format!("dsh 已更新到 {new_version}（正在验证…）"))
}

/// Verifies a freshly applied dsh update: polls health for up to 60s.
///   - our child answers  → update is good: delete the backup, clear state
///   - nothing answers and we are not adopting someone else's instance
///                        → broken update: restore the backup, restart dsh
///   - another instance serves the port (adopted mode) → inconclusive: keep
///     the backup and verify again on a future self-hosted boot
async fn verify_update_rollback(app: AppHandle) {
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(&app, &config);
    if read_pending_update(&paths.runtime_dir).is_none() {
        return;
    }
    let url = dsh_web_url(dsh_port(&config));
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };

    let deadline = Instant::now() + Duration::from_secs(60);
    let mut healthy_ever = false;
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let healthy = client
            .get(&url)
            .send()
            .await
            .map(|r| r.status().is_success() || r.status().is_server_error())
            .unwrap_or(false);
        if healthy {
            healthy_ever = true;
        }
        let own_child = state.dsh.lock().unwrap().child.is_some();
        let adopted = state.adopted.load(Ordering::SeqCst);

        if healthy && own_child && !adopted {
            // success: our child runs the new runtime
            let info = read_pending_update(&paths.runtime_dir);
            if let Some(info) = info {
                let _ = fs::remove_dir_all(PathBuf::from(&info.backup));
                log_line(
                    &paths.log_file,
                    &format!("dsh update verified healthy — backup removed"),
                );
            }
            clear_pending_update(&paths.runtime_dir);
            let _ = app.emit("update-rollback", "dsh 更新验证通过，备份已清理。");
            return;
        }

        if Instant::now() >= deadline {
            break;
        }
    }

    // deadline reached
    let adopted = state.adopted.load(Ordering::SeqCst);
    let own_child = state.dsh.lock().unwrap().child.is_some();
    if adopted && !own_child {
        // someone else serves the port; our child never got to boot — keep
        // the backup and re-verify on a future self-hosted start.
        log_line(
            &paths.log_file,
            "dsh update verification inconclusive (adopted external instance) — keeping backup",
        );
        let _ = app.emit(
            "update-rollback",
            "本次验证无法确认（检测到外部 DSH 实例占用端口），备份已保留，下次自托管启动时继续验证。",
        );
        return;
    }

    // rollback: the new runtime never came up
    let info = match read_pending_update(&paths.runtime_dir) {
        Some(i) => i,
        None => return,
    };
    log_line(
        &paths.log_file,
        &format!(
            "dsh update verification failed ({}s, healthy_ever={healthy_ever}) — rolling back to {}",
            60,
            info.previous_version
        ),
    );
    {
        let mut dsh = state.dsh.lock().unwrap();
        if let Some(child) = dsh.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        dsh.child = None;
        dsh.restarts = 0;
    }
    let broken = paths.runtime_dir.join(format!(
        "dsh-broken-{}",
        chrono::Local::now().format("%Y%m%d%H%M%S")
    ));
    let _ = fs::rename(paths.runtime_dir.join("dsh"), &broken);
    match fs::rename(PathBuf::from(&info.backup), paths.runtime_dir.join("dsh")) {
        Ok(_) => {
            let _ = fs::remove_dir_all(&broken);
            // restore the recorded version
            let version_file = paths.runtime_dir.join("version.json");
            if let Ok(s) = fs::read_to_string(&version_file) {
                if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&s) {
                    v["dsh"] = serde_json::Value::String(info.previous_version.clone());
                    let _ = fs::write(&version_file, serde_json::to_string_pretty(&v).unwrap_or_default());
                }
            }
            clear_pending_update(&paths.runtime_dir);
            ensure_runtime_files(&paths);
            let mut dsh = state.dsh.lock().unwrap();
            match spawn_dsh(&paths, &config) {
                Ok(c) => dsh.child = Some(c),
                Err(e) => log_line(&paths.log_file, &format!("rollback restart failed: {e}")),
            }
            log_line(
                &paths.log_file,
                &format!("rollback complete — dsh restarted on {}", info.previous_version),
            );
            let _ = app.emit(
                "update-rollback",
                format!(
                    "新版 dsh 无法启动，已自动回滚到 {} 并重启服务。",
                    info.previous_version
                ),
            );
        }
        Err(e) => {
            log_line(&paths.log_file, &format!("ROLLBACK FAILED: {e}"));
            let _ = app.emit("update-rollback", "自动回滚失败！请查看日志并手动处理。");
        }
    }
}

#[tauri::command]
async fn apply_dsh_update(
    app: AppHandle,
    state: State<'_, AppState>,
    tarball: Option<String>,
) -> Result<String, String> {
    let config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(&app, &config);
    let runtime = paths.runtime_dir.clone();
    let log = paths.log_file.clone();

    let tarball = match tarball {
        Some(t) => t,
        None => {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|e| e.to_string())?;
            let body = client
                .get("https://registry.npmjs.org/@deepseek-ai/dsh/latest")
                .header("Accept", "application/json")
                .send()
                .await
                .map_err(|e| format!("网络错误: {e}"))?
                .text()
                .await
                .map_err(|e| e.to_string())?;
            let v = serde_json::from_str::<serde_json::Value>(&body).map_err(|e| e.to_string())?;
            v.pointer("/dist/tarball")
                .and_then(|v| v.as_str())
                .ok_or("无法确定 dsh 下载地址")?
                .to_string()
        }
    };

    log_line(&log, &format!("applying dsh update: {tarball}"));

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let bytes = client
        .get(&tarball)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    let result = apply_dsh_tarball_bytes(&runtime, &paths.bundled_runtime_dir, &bytes, &log)?;
    // redeploy bridge/patch into DSH_HOME so the next boot picks everything up
    ensure_runtime_files(&paths);

    // restart the child on the new runtime so the update takes effect now
    {
        let state2 = app.state::<AppState>();
        let old_child = {
            let mut dsh = state2.dsh.lock().unwrap();
            dsh.restarts = 0;
            dsh.child.take()
        };
        if let Some(mut child) = old_child {
            let _ = child.kill();
            let _ = child.wait();
        }
        let mut dsh = state2.dsh.lock().unwrap();
        match spawn_dsh(&paths, &config) {
            Ok(c) => dsh.child = Some(c),
            Err(e) => log_line(&log, &format!("restart after update failed: {e}")),
        }
    }
    log_line(&log, "dsh child restarted on the updated runtime");

    // verify the new runtime can actually serve; roll back automatically if not
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        verify_update_rollback(app2).await;
    });

    Ok(format!("{result} 已重启内置服务；新内核将在 60 秒内完成健康验证，失败会自动回滚。"))
}

// ---------------------------------------------------------------------------
// autostart (Windows: HKCU Run entry)
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|e| e.to_string())?;
    // keep the tray checkbox in sync with the settings page
    let state = app.state::<AppState>();
    if let Some(item) = state.tray_autostart_item.lock().unwrap().as_ref() {
        let _ = item.set_checked(enabled);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("open", "打开主窗口").build(app)?;
    let settings = MenuItemBuilder::with_id("settings", "设置 / API Key").build(app)?;
    let refresh = MenuItemBuilder::with_id("refresh-balance", "刷新余额").build(app)?;
    let balance_item = MenuItemBuilder::with_id("balance", "余额：未获取")
        .enabled(false)
        .build(app)?;
    let update = MenuItemBuilder::with_id("check-update", "检查更新").build(app)?;
    let autostart = CheckMenuItemBuilder::with_id("autostart", "开机自启")
        .checked(app.autolaunch().is_enabled().unwrap_or(false))
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open)
        .item(&settings)
        .separator()
        .item(&balance_item)
        .item(&refresh)
        .separator()
        .item(&update)
        .item(&autostart)
        .separator()
        .item(&quit)
        .build()?;

    let state = app.state::<AppState>();
    *state.tray_balance_item.lock().unwrap() = Some(balance_item);
    *state.tray_autostart_item.lock().unwrap() = Some(autostart);

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip("DSH Desktop — DeepSeek Harness")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            "settings" => {
                let _ = open_settings_window(app.clone());
            }
            "refresh-balance" => {
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app2.state::<AppState>();
                    let _ = refresh_balance(&app2, &state).await;
                });
            }
            "check-update" => {
                let _ = open_settings_window(app.clone());
            }
            "autostart" => {
                // toggle: read the checkbox state, flip it, persist, re-check.
                // set_autostart refreshes the item state on success.
                let next = {
                    let state = app.state::<AppState>();
                    let guard = state.tray_autostart_item.lock().unwrap();
                    let checked = guard
                        .as_ref()
                        .and_then(|item| item.is_checked().ok())
                        .unwrap_or(false);
                    !checked
                };
                if let Err(e) = set_autostart(app.clone(), next) {
                    let state = app.state::<AppState>();
                    let config = state.config.lock().unwrap().clone();
                    let paths = resolve_paths(app, &config);
                    log_line(&paths.log_file, &format!("autostart toggle failed: {e}"));
                }
            }
            "quit" => {
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app2.state::<AppState>();
                    let mut dsh = state.dsh.lock().unwrap();
                    if let Some(child) = dsh.child.as_mut() {
                        let _ = child.kill();
                        dsh.child = None;
                    }
                    app2.exit(0);
                });
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .manage(AppState {
            dsh: Mutex::new(DshProcess {
                child: None,
                restarts: 0,
            }),
            adopted: AtomicBool::new(false),
            ui_ready: AtomicBool::new(false),
            bridge_ok: AtomicBool::new(false),
            runtime_ready: AtomicBool::new(false),
            balance: Mutex::new(None),
            providers: Mutex::new(None),
            adapters: Mutex::new(HashMap::new()),
            config: Mutex::new(AppConfig::default()),
            last_refresh: Mutex::new(None),
            last_update_check: Mutex::new(None),
            tray_balance_item: Mutex::new(None),
            tray_autostart_item: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            set_api_key,
            refresh_balance_cmd,
            open_logs,
            open_dsh_home,
            open_external,
            open_settings_window,
            check_update,
            apply_dsh_update,
            get_autostart,
            set_autostart,
            set_motion_intensity
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // Autostart launches carry `--hidden`: boot the service in the
            // background and wait in the tray instead of popping a window at
            // login. A later launch (double-click) hits the single-instance
            // plugin and shows the already-warmed window instantly.
            let start_hidden = std::env::args().any(|a| a == "--hidden");

            let config = {
                let state = app.state::<AppState>();
                let paths = {
                    let c = state.config.lock().unwrap().clone();
                    resolve_paths(&handle, &c)
                };
                let c = load_config(&paths.config_file);
                *state.config.lock().unwrap() = c.clone();
                ensure_runtime_files(&paths);
                c
            };

            let paths = resolve_paths(&handle, &config);
            log_line(&paths.log_file, "DSH Desktop starting");

            // Refresh the autostart entry so installs that enabled it before
            // this version pick up the `--hidden` argument (the plugin only
            // writes args when enable() is called).
            if app.autolaunch().is_enabled().unwrap_or(false) {
                let _ = app.autolaunch().enable();
            }

            // main window: splash first, navigates to the dsh web UI when healthy.
            // Frameless (custom title bar) + shadow for the Win11 rounded corners.
            let w = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
                .title("DeepSeek Harness")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 640.0)
                .decorations(false)
                .shadow(true)
                .visible(!start_hidden)
                .data_directory(webview_data_dir(&handle))
                .initialization_script(INIT_SCRIPT)
                .initialization_script(motion_init_script(config.motion))
                .initialization_script(TITLEBAR_SCRIPT)
                .initialization_script(THEME_TRANSITION_SCRIPT)
                .initialization_script(OCEAN_THEME_SCRIPT)
                .build()
                .map_err(|e| format!("创建主窗口失败: {e}"))?;
            if !start_hidden {
                let _ = w.set_focus();
            }

            // tauri-runtime-wry swallows webview creation errors (e.g. WebView2
            // ERROR_BUSY right after a previous instance exited), which would
            // leave the app running as a windowless tray zombie. Detect it and
            // refuse to start instead.
            if w.hwnd().is_err() {
                log_line(
                    &paths.log_file,
                    "main window webview creation failed (WebView2 busy?) — exiting",
                );
                handle.exit(1);
                return Ok(());
            }

            // Diagnostics: the injected title bar reports its own state so
            // silent failures inside the remote dsh page stay visible.
            {
                let log_file = paths.log_file.clone();
                let _ = handle.listen("dsh-titlebar-state", move |event| {
                    let (state, detail) = serde_json::from_str::<serde_json::Value>(event.payload())
                        .ok()
                        .and_then(|p| {
                            Some((
                                p.get("state")?.as_str()?.to_string(),
                                p.get("detail")?.as_str()?.to_string(),
                            ))
                        })
                        .unwrap_or_default();
                    log_line(
                        &log_file,
                        &format!("titlebar state: {state} {detail}").trim_end(),
                    );
                });
            }

            // Diagnostics: the injected ocean skin reports its own state too —
            // "ocean theme: mounted" in dsh.log proves the token override
            // stylesheet landed on the dsh page.
            {
                let log_file = paths.log_file.clone();
                let _ = handle.listen("dsh-ocean-theme", move |event| {
                    let (state, detail) = serde_json::from_str::<serde_json::Value>(event.payload())
                        .ok()
                        .and_then(|p| {
                            Some((
                                p.get("state")?.as_str()?.to_string(),
                                p.get("detail")?.as_str()?.to_string(),
                            ))
                        })
                        .unwrap_or_default();
                    log_line(
                        &log_file,
                        &format!("ocean theme: {state} {detail}").trim_end(),
                    );
                });
            }

            // bootstrap runtime + spawn dsh in the background so the splash
            // can show first-run extraction progress instead of blocking setup.
            let boot_cfg = config.clone();
            let app2 = handle.clone();
            tauri::async_runtime::spawn(async move {
                let state = app2.state::<AppState>();
                let paths = resolve_paths(&app2, &boot_cfg);
                if !paths.node_exe.exists() || !paths.dsh_bin.exists() {
                    let _ = app2.emit_to(
                        "main",
                        "dsh-progress",
                        serde_json::json!({
                            "stage": "extract",
                            "percent": 0,
                            "detail": "准备解压运行时组件",
                        }),
                    );
                    let _ = app2.emit_to(
                        "main",
                        "dsh-status",
                        "首次运行：正在解压运行时组件，请稍候…".to_string(),
                    );
                    match extract_runtime_archive(&app2, &paths) {
                        Ok(()) => {}
                        Err(e) => {
                            log_line(&paths.log_file, &format!("runtime extraction failed: {e}"));
                            state.runtime_ready.store(true, Ordering::SeqCst);
                            let _ = app2.emit_to("main", "dsh-failed", ());
                            return;
                        }
                    }
                    let _ = app2.emit_to(
                        "main",
                        "dsh-progress",
                        serde_json::json!({
                            "stage": "extract",
                            "percent": 100,
                            "detail": "运行时组件解压完成",
                        }),
                    );
                }
                state.runtime_ready.store(true, Ordering::SeqCst);
                ensure_runtime_files(&paths);
                let _ = app2.emit_to(
                    "main",
                    "dsh-progress",
                    serde_json::json!({
                        "stage": "boot",
                        "percent": 0,
                        "detail": "正在启动 DeepSeek Harness 服务",
                    }),
                );
                let mut dsh = state.dsh.lock().unwrap();
                match spawn_dsh(&paths, &boot_cfg) {
                    Ok(child) => dsh.child = Some(child),
                    Err(e) => {
                        log_line(&paths.log_file, &format!("spawn failed: {e}"));
                        let _ = app2.emit_to("main", "dsh-status", format!("启动失败：{e}"));
                    }
                }
                // a previous update may still be pending verification — resume
                // it (no-op when there is no pending backup)
                let app3 = app2.clone();
                tauri::async_runtime::spawn(async move {
                    verify_update_rollback(app3).await;
                });
            });

            // background loops
            tauri::async_runtime::spawn(health_check_loop(handle.clone()));
            tauri::async_runtime::spawn(periodic_loop(handle.clone()));
            start_bridge_listener(handle.clone(), config.bridge_shell_port);

            setup_tray(&handle)?;

            // initial balance right after boot (the health of the dsh child is
            // irrelevant — balance comes from the platforms' own APIs)
            let app2 = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                let state = app2.state::<AppState>();
                let _ = refresh_balance(&app2, &state).await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    // close = minimize to tray; quit via tray menu
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building DSH Desktop");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            let state = app.state::<AppState>();
            let mut dsh = state.dsh.lock().unwrap();
            if let Some(child) = dsh.child.as_mut() {
                let _ = child.kill();
                dsh.child = None;
            }
        }
    });
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;

    fn make_tarball(files: &[(&str, &str)]) -> Vec<u8> {
        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        {
            let mut builder = tar::Builder::new(&mut gz);
            for (path, content) in files {
                let mut header = tar::Header::new_gnu();
                header.set_size(content.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder
                    .append_data(&mut header, path, content.as_bytes())
                    .unwrap();
            }
            builder.finish().unwrap();
        }
        gz.finish().unwrap()
    }

    fn make_runtime(dir: &Path, old_version: &str) {
        let dsh = dir.join("dsh");
        fs::create_dir_all(dsh.join("node_modules/@deepseek-ai/dsh")).unwrap();
        fs::create_dir_all(dsh.join("lib")).unwrap();
        fs::write(
            dsh.join("node_modules/@deepseek-ai/dsh/package.json"),
            format!(r#"{{"version":"{old_version}"}}"#),
        )
        .unwrap();
        fs::write(dsh.join("lib/bin.js"), "// old runtime marker").unwrap();
        let plugins = dir.join("plugins-src");
        for name in ["dsh-desktop-bridge", "dsh-desktop-session-manager"] {
            let pkg = plugins.join(name);
            fs::create_dir_all(pkg.join("lib")).unwrap();
            fs::write(pkg.join("package.json"), format!(r#"{{"name":"{name}"}}"#)).unwrap();
            fs::write(pkg.join("index.js"), format!("// {name} marker")).unwrap();
            fs::write(pkg.join("client.js"), format!("// {name} client marker")).unwrap();
            fs::write(pkg.join("lib/mod.js"), format!("// {name} lib marker")).unwrap();
        }
        fs::write(
            dir.join("version.json"),
            format!(r#"{{"node":"v24.15.0","dsh":"{old_version}"}}"#),
        )
        .unwrap();
    }

    #[test]
    fn update_succeeds_and_restores_bridge() {
        let root = std::env::temp_dir().join(format!("dsh-upd-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        make_runtime(&root, "0.1.0-rc.5");

        let tarball = make_tarball(&[
            (
                "package/node_modules/@deepseek-ai/dsh/package.json",
                r#"{"version":"0.9.9"}"#,
            ),
            ("package/lib/bin.js", "// new runtime"),
        ]);
        let result = apply_dsh_tarball_bytes(&root, &root, &tarball, &root.join("test.log"));
        assert!(result.is_ok(), "update failed: {result:?}");

        // new tree in place
        let manifest =
            fs::read_to_string(root.join("dsh/node_modules/@deepseek-ai/dsh/package.json"))
                .unwrap();
        assert!(manifest.contains("0.9.9"));
        // every desktop plugin restored into the new tree, lib/ files included
        assert!(root.join("dsh/node_modules/dsh-desktop-bridge/index.js").exists());
        assert!(root
            .join("dsh/node_modules/dsh-desktop-session-manager/index.js")
            .exists());
        assert!(root
            .join("dsh/node_modules/dsh-desktop-session-manager/lib/mod.js")
            .exists());
        // version.json bumped
        let vjson = fs::read_to_string(root.join("version.json")).unwrap();
        assert!(vjson.contains("0.9.9"));
        // stage cleaned, backup KEPT for post-boot verification
        assert!(!root.join(".update-stage").exists());
        let backups: Vec<_> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with("dsh-old"))
            .collect();
        assert_eq!(backups.len(), 1, "backup must be kept for verification: {backups:?}");
        // pending-verification record written
        let info = read_pending_update(&root).expect("pending update record");
        assert_eq!(info.previous_version, "0.1.0-rc.5");
        assert!(PathBuf::from(&info.backup).exists());
        // backup contains the OLD runtime
        assert!(PathBuf::from(&info.backup)
            .join("lib/bin.js")
            .exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn update_restores_legacy_bridge_src() {
        // Installs created before the plugins-src generalization keep the
        // legacy runtime/bridge-src canonical dir; a dsh update must still
        // restore the bridge package from it.
        let root = std::env::temp_dir().join(format!("dsh-upd-test-{}-legacy", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        make_runtime(&root, "0.1.0-rc.5");
        // simulate the pre-plugins-src layout
        fs::remove_dir_all(root.join("plugins-src")).unwrap();
        let bridge = root.join("bridge-src");
        fs::create_dir_all(&bridge).unwrap();
        fs::write(bridge.join("package.json"), r#"{"name":"dsh-desktop-bridge"}"#).unwrap();
        fs::write(bridge.join("index.js"), "// bridge marker").unwrap();
        fs::write(bridge.join("client.js"), "// bridge client marker").unwrap();

        let tarball = make_tarball(&[(
            "package/node_modules/@deepseek-ai/dsh/package.json",
            r#"{"version":"0.9.9"}"#,
        )]);
        let result = apply_dsh_tarball_bytes(&root, &root, &tarball, &root.join("test.log"));
        assert!(result.is_ok(), "update failed: {result:?}");
        assert!(root.join("dsh/node_modules/dsh-desktop-bridge/index.js").exists());
        assert!(root.join("dsh/node_modules/dsh-desktop-bridge/client.js").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dir_writable_probes_real_create_permission() {
        let root = std::env::temp_dir().join(format!("dsh-writeprobe-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        // a fresh, owned directory is writable
        assert!(dir_writable(&root));
        // a nested not-yet-existing path under it is also reported writable
        // (create_dir_all covers the whole chain)
        assert!(dir_writable(&root.join("a/b")));
        // a path whose parent chain ends in a FILE is not writable
        let blocker = root.join("blocker");
        fs::write(&blocker, "file").unwrap();
        assert!(!dir_writable(&blocker.join("runtime")));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn runtime_tree_usable_requires_node_and_dsh() {
        let root = std::env::temp_dir().join(format!("dsh-usable-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        // full dsh bin path laid out, node.exe still missing -> not bootable
        fs::create_dir_all(root.join("dsh/node_modules/@deepseek-ai/dsh/lib")).unwrap();
        fs::write(
            root.join("dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
            "x",
        )
        .unwrap();
        assert!(!runtime_tree_usable(&root));

        fs::create_dir_all(root.join("node")).unwrap();
        fs::write(root.join("node/node.exe"), "x").unwrap();
        assert!(runtime_tree_usable(&root));

        // a dsh tree elsewhere (e.g. dsh/lib/bin.js) does not count
        fs::remove_dir_all(root.join("dsh")).unwrap();
        fs::create_dir_all(root.join("dsh/lib")).unwrap();
        fs::write(root.join("dsh/lib/bin.js"), "x").unwrap();
        assert!(!runtime_tree_usable(&root));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_tarball_handles_directory_entries() {
        let root = std::env::temp_dir().join(format!("dsh-extract-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let archive = root.join("a.tar.gz");
        let gz = GzEncoder::new(Vec::new(), Compression::default());
        let mut builder = tar::Builder::new(gz);
        builder.append_dir("node", ".").unwrap();
        let mut file_header = tar::Header::new_gnu();
        file_header.set_size(2);
        file_header.set_mode(0o644);
        file_header.set_cksum();
        builder
            .append_data(&mut file_header, "node/node.exe", "x\n".as_bytes())
            .unwrap();
        let gz = builder.into_inner().unwrap();
        fs::write(&archive, gz.finish().unwrap()).unwrap();

        let dest = root.join("out");
        let mut on_entry = |_count: usize| {};
        extract_tarball(&archive, &dest, false, &mut on_entry).unwrap();
        assert!(dest.join("node").is_dir());
        assert_eq!(fs::read_to_string(dest.join("node/node.exe")).unwrap(), "x\n");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn patch_overlay_fills_home_layer_gap() {
        let root = std::env::temp_dir().join(format!("dsh-patch-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        // no home layer -> full rows
        let full = desktop_patch_overlay(&root);
        for name in DESKTOP_PLUGINS {
            assert!(full.contains(&format!("id: {name}")), "full overlay missing {name}");
        }

        // home layer mounts both -> empty insert (no duplicate loader ids)
        fs::write(
            root.join("cordis.patch.yml"),
            format!("- insert:\n    - id: {}\n    - id: {}\n", DESKTOP_PLUGINS[0], DESKTOP_PLUGINS[1]),
        )
        .unwrap();
        let empty = desktop_patch_overlay(&root);
        assert!(empty.contains("- insert: []"), "expected empty insert, got: {empty}");
        assert!(!empty.contains(&format!("id: {}", DESKTOP_PLUGINS[0])));

        // home layer mounts only the bridge -> overlay fills the gap with full rows
        fs::write(
            root.join("cordis.patch.yml"),
            format!("- insert:\n    - id: {}\n", DESKTOP_PLUGINS[0]),
        )
        .unwrap();
        let gap = desktop_patch_overlay(&root);
        for name in DESKTOP_PLUGINS {
            assert!(gap.contains(&format!("id: {name}")), "gap overlay missing {name}");
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn patch_file_content_syncs() {
        let root = std::env::temp_dir().join(format!("dsh-patch-test-{}-sync", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let target = root.join("dsh-bridge.patch.yml");

        // missing -> written
        write_if_different(&target, "first\n");
        assert_eq!(fs::read_to_string(&target).unwrap(), "first\n");
        let first_modified = fs::metadata(&target).unwrap().modified().unwrap();

        // identical -> skipped (mtime untouched)
        write_if_different(&target, "first\n");
        assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), first_modified);

        // different -> overwritten
        write_if_different(&target, "second\n");
        assert_eq!(fs::read_to_string(&target).unwrap(), "second\n");

        let _ = fs::remove_dir_all(&root);
    }

    fn test_paths(root: &Path) -> Paths {
        Paths {
            config_file: root.join("config.json"),
            logs_dir: root.join("logs"),
            log_file: root.join("logs").join("dsh.log"),
            patch_file: root.join("dsh-bridge.patch.yml"),
            runtime_dir: root.join("runtime"),
            bundled_runtime_dir: root.join("runtime"),
            node_exe: root.join("runtime/node/node.exe"),
            dsh_bin: root
                .join("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
            dsh_home: root.join(".dsh"),
        }
    }

    /// Minimal fixture mirroring the upstream shell's `navIcon` fallback, so
    /// the patch runs against the exact anchor bytes without the full bundle.
    fn settings_shell_fixture() -> String {
        format!(
            "function navIcon(id) {{\n\t\t\tif (id === \"models\") return null;\n{SETTINGS_NAV_ICONS_ANCHOR}\n\t\t}}\n"
        )
    }

    fn settings_shell_bundle(root: &Path) -> PathBuf {
        root.join("runtime")
            .join("dsh")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh-client-ui-settings-general")
            .join("lib")
            .join("client.js")
    }

    #[test]
    fn settings_nav_icons_patch_applies_once_and_degrades() {
        let root = std::env::temp_dir().join(format!("dsh-navicons-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let paths = test_paths(&root);
        let bundle = settings_shell_bundle(&root);
        fs::create_dir_all(bundle.parent().unwrap()).unwrap();
        fs::write(&bundle, settings_shell_fixture()).unwrap();

        // applies: dedicated branches land before the fallback, marker present
        patch_settings_nav_icons(&paths);
        let patched = fs::read_to_string(&bundle).unwrap();
        assert!(patched.contains(SETTINGS_NAV_ICONS_MARKER));
        assert!(patched.contains(r#"id === "vision-any""#));
        assert!(patched.contains(r#"id === "session-manager""#));
        assert!(patched.contains(r#"id === "about""#));
        assert!(patched.contains("IconListPenOutline16"));
        assert!(patched.contains("IconUserOutline16"));
        assert!(patched.contains(r#"viewBox: "0 0 16 16""#));

        // idempotent: second run leaves the file byte-identical
        let once = fs::read(&bundle).unwrap();
        patch_settings_nav_icons(&paths);
        assert_eq!(fs::read(&bundle).unwrap(), once);

        // missing bundle -> skip without panicking
        fs::remove_file(&bundle).unwrap();
        patch_settings_nav_icons(&paths);

        // changed upstream (no anchor) -> skip, file untouched
        fs::write(&bundle, "function navIcon(id) { return null; }\n").unwrap();
        let before = fs::read(&bundle).unwrap();
        patch_settings_nav_icons(&paths);
        assert_eq!(fs::read(&bundle).unwrap(), before);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn vision_bundle_initializes_fresh_web_profile() {
        let root = std::env::temp_dir().join(format!("dsh-vision-test-{}-fresh", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let paths = test_paths(&root);

        ensure_web_profile_vision_bundle(&paths);

        let manifest: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(paths.dsh_home.join("profiles/web/package.json")).unwrap(),
        )
        .unwrap();
        let names: Vec<&str> = manifest["dsh"]["profile"]["bundles"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                VISION_PLUGIN
            ]
        );
        // `dsh plugin` compatible profile scaffolding
        assert!(paths.dsh_home.join("profiles/web/pnpm-workspace.yaml").exists());
        assert!(paths.dsh_home.join("profiles/web/cordis.patch.yml").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn vision_bundle_appends_to_existing_profile_once() {
        let root = std::env::temp_dir().join(format!("dsh-vision-test-{}-append", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let paths = test_paths(&root);
        let web = paths.dsh_home.join("profiles/web");
        fs::create_dir_all(&web).unwrap();
        let manifest_path = web.join("package.json");
        fs::write(
            &manifest_path,
            r#"{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": { "some-plugin": "^1.0.0" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "some-plugin"] } }
}"#,
        )
        .unwrap();

        ensure_web_profile_vision_bundle(&paths);
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let names: Vec<&str> = manifest["dsh"]["profile"]["bundles"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(
            names,
            vec![
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                "some-plugin",
                VISION_PLUGIN
            ]
        );
        // user's other manifest fields untouched
        assert_eq!(manifest["dependencies"]["some-plugin"], "^1.0.0");

        // second run is a no-op: bytes identical, no duplicate entry
        let after_first = fs::read_to_string(&manifest_path).unwrap();
        ensure_web_profile_vision_bundle(&paths);
        assert_eq!(fs::read_to_string(&manifest_path).unwrap(), after_first);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn vision_bundle_creates_missing_dsh_path() {
        let root = std::env::temp_dir().join(format!("dsh-vision-test-{}-nodsh", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let paths = test_paths(&root);
        let web = paths.dsh_home.join("profiles/web");
        fs::create_dir_all(&web).unwrap();
        let manifest_path = web.join("package.json");
        fs::write(
            &manifest_path,
            r#"{"name":"dsh-profile-web","private":true,"dependencies":{}}"#,
        )
        .unwrap();

        ensure_web_profile_vision_bundle(&paths);
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let names: Vec<&str> = manifest["dsh"]["profile"]["bundles"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(names, vec![VISION_PLUGIN]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn vision_bundle_skips_invalid_manifest() {
        let root = std::env::temp_dir().join(format!("dsh-vision-test-{}-bad", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let paths = test_paths(&root);
        let web = paths.dsh_home.join("profiles/web");
        fs::create_dir_all(&web).unwrap();
        let manifest_path = web.join("package.json");
        fs::write(&manifest_path, "not json {{{").unwrap();

        ensure_web_profile_vision_bundle(&paths); // must not panic
        assert_eq!(fs::read_to_string(&manifest_path).unwrap(), "not json {{{");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn update_state_survives_and_clears() {        let root = std::env::temp_dir().join(format!("dsh-upd-test-{}-d", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        make_runtime(&root, "0.1.0-rc.5");

        assert!(read_pending_update(&root).is_none());
        write_pending_update(
            &root,
            &UpdateBackupInfo {
                backup: root.join("dsh-old-20260101").to_string_lossy().to_string(),
                previous_version: "0.1.0-rc.5".to_string(),
            },
        );
        let info = read_pending_update(&root).expect("record persists");
        assert_eq!(info.previous_version, "0.1.0-rc.5");
        clear_pending_update(&root);
        assert!(read_pending_update(&root).is_none());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn garbage_tarball_rolls_back() {
        let root = std::env::temp_dir().join(format!("dsh-upd-test-{}-b", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        make_runtime(&root, "0.1.0-rc.5");

        let result = apply_dsh_tarball_bytes(&root, &root, b"not a tarball at all", &root.join("test.log"));
        assert!(result.is_err());

        // old tree untouched
        assert_eq!(
            fs::read_to_string(root.join("dsh/lib/bin.js")).unwrap(),
            "// old runtime marker"
        );
        let vjson = fs::read_to_string(root.join("version.json")).unwrap();
        assert!(vjson.contains("0.1.0-rc.5"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_manifest_rejected_without_swap() {
        let root = std::env::temp_dir().join(format!("dsh-upd-test-{}-c", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        make_runtime(&root, "0.1.0-rc.5");

        // valid tar, but no @deepseek-ai/dsh/package.json → verification fails pre-swap
        let tarball = make_tarball(&[("package/lib/bin.js", "// no manifest")]);
        let result = apply_dsh_tarball_bytes(&root, &root, &tarball, &root.join("test.log"));
        assert!(result.is_err());

        assert_eq!(
            fs::read_to_string(root.join("dsh/lib/bin.js")).unwrap(),
            "// old runtime marker"
        );
        let vjson = fs::read_to_string(root.join("version.json")).unwrap();
        assert!(vjson.contains("0.1.0-rc.5"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn llm_providers_parses_settings_yaml() {
        let raw = r#"
llm-pi-ai:
  providers:
    anixuilgpt:
      displayName: CODEX
      apiKeyEnv: ANIXUILGPT_API_KEY
      api: openai-responses
      baseURL: https://apinebula.ai/v1
      models:
        - id: gpt-5.4
    anthropic-relay:
      displayName: Claude Relay
      apiKeyEnv: CLAUDE_KEY
      api: anthropic-messages
      baseURL: https://relay.example/v1
agent-default-model:
  provider: deepseek-official
"#;
        let providers = llm_providers_from_yaml(raw, None);
        // built-in DeepSeek + every pi-ai provider (any wire API)
        assert_eq!(providers.len(), 3);
        let ds = providers.iter().find(|p| p.id == "deepseek-official").expect("built-in");
        assert_eq!(ds.base_url, "https://api.deepseek.com");
        assert_eq!(ds.key_env, "DEEPSEEK_API_KEY");
        assert_eq!(ds.api, "deepseek");
        let pi = providers.iter().find(|p| p.id == "anixuilgpt").expect("pi provider");
        assert_eq!(pi.display_name, "CODEX");
        assert_eq!(pi.base_url, "https://apinebula.ai/v1");
        assert_eq!(pi.api, "openai-responses");
        let relay = providers.iter().find(|p| p.id == "anthropic-relay").expect("relay");
        assert_eq!(relay.api, "anthropic-messages");

        // env override + malformed documents
        let with_env = llm_providers_from_yaml(raw, Some("https://ds.example.com/v1"));
        assert_eq!(
            with_env.iter().find(|p| p.id == "deepseek-official").unwrap().base_url,
            "https://ds.example.com/v1"
        );
        assert_eq!(llm_providers_from_yaml("not: [valid", None).len(), 1);
    }

    #[test]
    fn adapter_matching_routes_by_api_and_host() {
        assert_eq!(adapter_for("deepseek", "https://api.deepseek.com"), Adapter::DeepSeek);
        assert_eq!(adapter_for("", "https://gateway.deepseek.io/v1"), Adapter::DeepSeek);
        assert_eq!(adapter_for("openai-responses", "https://apinebula.ai/v1"), Adapter::OpenAIBilling);
        assert_eq!(adapter_for("openai-chat", "https://x.example/v1"), Adapter::OpenAIBilling);
        assert_eq!(adapter_for("", "https://api.openai-proxy.example/v1"), Adapter::OpenAIBilling);
        assert_eq!(adapter_for("anthropic-messages", "https://relay.example/v1"), Adapter::Unsupported);
        assert_eq!(adapter_for("google-genai", "https://x.example/v1"), Adapter::Unsupported);
        // unknown combos probe at fetch time
        assert_eq!(adapter_for("", "https://mystery.example/v1"), Adapter::Probe);
    }

    #[test]
    fn balance_parses_deepseek_api_response() {
        // Exact shape returned by GET https://api.deepseek.com/user/balance
        // (snake_case fields). A camelCase rename here would make every
        // balance refresh fail with "error decoding response body".
        let raw = r#"{
            "is_available": true,
            "balance_infos": [{
                "currency": "CNY",
                "total_balance": "168.88",
                "granted_balance": "0.00",
                "topped_up_balance": "168.88"
            }]
        }"#;
        let bal: Balance = serde_json::from_str(raw).expect("balance response must deserialize");
        assert!(bal.is_available);
        let info = bal.balance_infos.first().expect("one balance info");
        assert_eq!(info.currency, "CNY");
        assert_eq!(info.total_balance, "168.88");
        assert_eq!(info.granted_balance, "0.00");
        assert_eq!(info.topped_up_balance, "168.88");

        // serialized form must stay snake_case for the UI/bridge consumers
        let out = serde_json::to_value(&bal).expect("balance must serialize");
        assert_eq!(out["is_available"], serde_json::json!(true));
        assert_eq!(
            out["balance_infos"][0]["total_balance"],
            serde_json::json!("168.88")
        );
        assert_eq!(
            out["balance_infos"][0]["granted_balance"],
            serde_json::json!("0.00")
        );
    }
}
