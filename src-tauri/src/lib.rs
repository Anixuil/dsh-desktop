//! DSH Desktop — Windows shell for DeepSeek Harness.
//!
//! Owns: bundled Node + dsh runtime lifecycle, health check, window navigation,
//! API-key management (→ DSH credentials), balance queries, the turn-end
//! bridge listener, the system tray, and logging.

use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use flate2::read::GzDecoder;
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Listener, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_updater::UpdaterExt;
#[cfg(not(target_os = "windows"))]
use tauri_plugin_notification::NotificationExt;

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const DSH_WEB_PORT_DEFAULT: u16 = 3080;
/// Loopback status port of the relay-client companion process.
const RELAY_CLIENT_STATUS_PORT: u16 = 38659;
const CREDENTIAL_NAME: &str = "DEEPSEEK_API_KEY";
/// Official repository used for release links. Signed production updates use
/// the immutable updater endpoint/public key compiled into tauri.conf.json;
/// legacy update_repo configuration is intentionally not trusted for installs.
const DEFAULT_UPDATE_REPO: &str = "Anixuil/dsh-desktop";
const BRIDGE_PATCH_YML: &str = include_str!("../../scripts/bridge.patch.yml");
const WEB_SEARCH_PATCH_YML: &str = include_str!("../../scripts/web-search.patch.yml");
const MIN_REFRESH_INTERVAL_SECS: u64 = 3;
/// Desktop plugin packages deployed from `runtime/plugins-src` into both the
/// dsh module tree (update restore) and the boot-time profile tree
/// (`ensure_runtime_files`). Each name doubles as its `--patch` row id.
const DESKTOP_PLUGINS: [&str; 6] = [
    "dsh-desktop-bridge",
    "dsh-desktop-session-manager",
    "dsh-desktop-change-history",
    "dsh-desktop-file-upload",
    "dsh-desktop-conversation-navigator",
    "dsh-desktop-web-search",
];
const BUILTIN_PLUGINS: [&str; 7] = [
    "dsh-desktop-bridge",
    "dsh-desktop-session-manager",
    "dsh-desktop-change-history",
    "dsh-desktop-file-upload",
    "dsh-desktop-conversation-navigator",
    "dsh-vision-any",
    "dshmarket",
];
/// Bundled third-party plugin (github.com/tianmingwan/dsh-vision-any). Ships in
/// `runtime/plugins-src` and mounts through the web profile's `bundles` list —
/// the same contract `dsh plugin --profile web add` uses — so it loads for both
/// the desktop-hosted kernel and a CLI `dsh web` sharing the same `$DSH_HOME`.
const VISION_PLUGIN: &str = "dsh-vision-any";
/// Bundled community plugin market. Its production dependencies are copied
/// into the profile module tree too, because Node resolves them from there.
const MARKET_PLUGIN: &str = "dshmarket";
const MARKET_PLUGIN_RUNTIME_PACKAGES: [&str; 4] = ["dshmarket", "js-yaml", "argparse", "undici"];
/// Packages recorded here were first installed by DSH Desktop. A package
/// already present without this record belongs to the user and is never
/// replaced by a bundled third-party version.
const BUNDLED_THIRD_PARTY_STATE_FILE: &str = "bundled-third-party-plugins.json";
/// The shipped template bundles for the `web` profile (mirrors dsh's own
/// `PROFILE_TEMPLATES.web`, used only when the desktop creates the profile).
const WEB_TEMPLATE_BUNDLES: [&str; 2] = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];
/// Mirrors dsh-app-boot's `PROFILE_PATCH_TEMPLATE` / `PROFILE_PNPM_WORKSPACE` so
/// a desktop-created profile behaves exactly like a `dsh plugin`-initialized one.
const PROFILE_PATCH_TEMPLATE: &str =
    "# Your patch layer for this dsh profile, applied after every bundle layer:\n\
# a top-level YAML array of loader patch entries (id-targeted config\n\
# overrides, disables, and insert lists; `!!js` expressions allowed).\n\
[]\n";
const PROFILE_PNPM_WORKSPACE: &str =
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n";
/// Injected on every document (including the remote dsh web UI): the desktop
/// app never shows the browser's default right-click context menu.
const INIT_SCRIPT: &str =
    r#"window.addEventListener('contextmenu', (e) => e.preventDefault(), true);"#;

/// Initialization script that publishes the persisted motion intensity as
/// `window.__DSH_MOTION__` ("default" | "quiet" | "rich") on every document
/// of a window —
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
/// Models settings client bundle. DSH intentionally keeps credentials in its
/// write-only credential service; the desktop adds account-level provider
/// credentials here so platforms such as Volcengine can expose billing data
/// without creating a second settings owner.
const SETTINGS_MODELS_BUNDLE: [&str; 6] = [
    "dsh",
    "node_modules",
    "@deepseek-ai",
    "dsh-client-ui-settings-models",
    "lib",
    "client.js",
];
const SETTINGS_MODELS_CREDENTIALS_MARKER: &str =
    "dsh-desktop-provider-account-credentials-v1";
const SETTINGS_MODELS_COMPONENT_ANCHOR: &str = "\t\tfunction ProviderEditor(props) {";
const SETTINGS_MODELS_RENDER_ANCHOR: &str = "\t\t\t\t}), props.credentialOnly === true ? null : (0, react_jsx_runtime.jsxs)(\"details\", {";
const SETTINGS_MODELS_RENDER_REPLACEMENT: &str = "\t\t\t\t}), props.credentialOnly === true ? null : (0, react_jsx_runtime.jsx)(ProviderAccountCredentials, { provider: props.provider, baseURL: probeBaseURL, api }), props.credentialOnly === true ? null : (0, react_jsx_runtime.jsxs)(\"details\", {";
const SETTINGS_MODELS_COMPONENT_INSERT: &str = r#"		/* dsh-desktop-provider-account-credentials-v1: account-level credentials for provider control planes. */
		function ProviderAccountCredentials({ provider, baseURL, api }) {
			const identity = `${provider ?? ""} ${baseURL ?? ""}`.toLowerCase();
			const isVolcengine = /(volc|doubao|ark\.|火山|豆包)/i.test(identity);
			const zh = (() => {
				try { return document.documentElement.lang.toLowerCase().startsWith("zh") || navigator.language.toLowerCase().startsWith("zh"); }
				catch { return true; }
			})();
			const copy = zh ? {
				title: "火山引擎账户凭据",
				hint: "用于费用中心余额查询，与模型调用所需的 Ark API Key 不同。凭据仅写入本机 DSH 凭据库，不会在页面中回显。",
				access: "AccessKey ID",
				secret: "Secret Access Key",
				stored: "已配置，输入新值可替换",
				empty: "请输入 AccessKey ID 和 Secret Access Key",
				invalid: "凭据只能包含可打印 ASCII 字符，请检查输入。",
				readOnly: "该凭据由启动环境提供，当前为只读。",
				save: "保存账户凭据",
				saving: "保存中...",
				saved: "账户凭据已保存。",
				loadFailed: "无法读取账户凭据状态。"
			} : {
				title: "Volcengine account credentials",
				hint: "Used for Billing Center balance queries. These differ from the Ark API key used for model calls. Values are write-only and stored in the local DSH credential store.",
				access: "AccessKey ID",
				secret: "Secret Access Key",
				stored: "Configured, enter a new value to replace",
				empty: "Enter both the AccessKey ID and Secret Access Key",
				invalid: "Credentials may contain printable ASCII characters only.",
				readOnly: "This credential comes from the launch environment and is read-only.",
				save: "Save account credentials",
				saving: "Saving...",
				saved: "Account credentials saved.",
				loadFailed: "Could not load account credential status."
			};
			const refs = ["VOLC_ACCESS_KEY", "VOLC_SECRET_KEY"];
			const [drafts, setDrafts] = (0, react.useState)(["", ""]);
			const [states, setStates] = (0, react.useState)([void 0, void 0]);
			const [loading, setLoading] = (0, react.useState)(true);
			const [busy, setBusy] = (0, react.useState)(false);
			const [failure, setFailure] = (0, react.useState)(void 0);
			const [saved, setSaved] = (0, react.useState)(false);
			const refresh = async () => {
				const response = await api.credentials.describe({ refs });
				if (!response.result.ok) throw new Error(response.result.error.message);
				const values = response.result.value.credentials;
				setStates(refs.map((ref) => values[ref]));
			};
			(0, react.useEffect)(() => {
				let stale = false;
				if (!isVolcengine) { setLoading(false); return () => { stale = true; }; }
				setLoading(true);
				api.credentials.describe({ refs }).then((response) => {
					if (stale) return;
					if (!response.result.ok) throw new Error(response.result.error.message);
					const values = response.result.value.credentials;
					setStates(refs.map((ref) => values[ref]));
					setFailure(void 0);
				}).catch(() => { if (!stale) setFailure(copy.loadFailed); }).finally(() => { if (!stale) setLoading(false); });
				return () => { stale = true; };
			}, [api.credentials, isVolcengine]);
			const values = drafts.map((value) => value.trim());
			const invalid = drafts.some((value) => value.length > 0 && apiKeyFailure(value) !== void 0);
			const missing = states.some((state, index) => state?.configured !== true && values[index].length === 0);
			const locked = states.some((state) => state?.writable === false);
			const submit = async () => {
				setFailure(void 0);
				setSaved(false);
				if (invalid) { setFailure(copy.invalid); return; }
				if (missing) { setFailure(copy.empty); return; }
				setBusy(true);
				try {
					for (let index = 0; index < refs.length; index += 1) {
						if (values[index].length === 0) continue;
						const response = await api.credentials.set({ ref: refs[index], value: values[index] });
						if (!response.result.ok) throw new Error(response.result.error.message);
					}
					setDrafts(["", ""]);
					await refresh();
					setSaved(true);
				} catch (error) {
					setFailure(messageOf(error));
				} finally {
					setBusy(false);
				}
			};
			if (!isVolcengine) return null;
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ModelsSection_module_css_default["modelCatalog"],
				children: [
					(0, react_jsx_runtime.jsxs)("div", { className: ModelsSection_module_css_default["modelCatalogHeading"], children: [
						(0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["modelCatalogTitle"], children: copy.title }),
						(0, react_jsx_runtime.jsx)("p", { className: ModelsSection_module_css_default["modelCatalogMeta"], children: copy.hint })
					] }),
					...refs.map((ref, index) => (0, react_jsx_runtime.jsxs)("label", { className: ModelsSection_module_css_default["field"], children: [
						(0, react_jsx_runtime.jsx)("span", { className: ModelsSection_module_css_default["fieldLabel"], children: index === 0 ? copy.access : copy.secret }),
						(0, react_jsx_runtime.jsx)("input", { className: ModelsSection_module_css_default["input"], type: "password", autoComplete: "off", value: drafts[index], placeholder: states[index]?.configured === true ? copy.stored : "", disabled: loading || busy || states[index]?.writable === false, "aria-invalid": failure !== void 0, onChange: (event) => { const next = [...drafts]; next[index] = event.target.value; setDrafts(next); setSaved(false); } })
					] }, ref)),
					locked ? (0, react_jsx_runtime.jsx)("p", { className: ModelsSection_module_css_default["advancedHint"], children: copy.readOnly }) : null,
					failure !== void 0 ? (0, react_jsx_runtime.jsx)("p", { className: ModelsSection_module_css_default["error"], role: "alert", children: failure }) : null,
					saved ? (0, react_jsx_runtime.jsx)("p", { className: ModelsSection_module_css_default["savedNotice"], role: "status", children: copy.saved }) : null,
					(0, react_jsx_runtime.jsx)("div", { className: ModelsSection_module_css_default["editorActions"], children: (0, react_jsx_runtime.jsx)("button", { type: "button", className: ModelsSection_module_css_default["secondaryButton"], disabled: loading || busy || locked || values.every((value) => value.length === 0), onClick: submit, children: busy ? copy.saving : copy.save }) })
				]
			});
		}
"#;
/// Marker comment injected by the settings-nav-icon patch; its presence means
/// the bundle is already patched (idempotence across boots and dsh updates).
const SETTINGS_NAV_ICONS_MARKER: &str = "dsh-desktop-settings-nav-icons-v2";
const SETTINGS_NAV_WEB_SEARCH_MARKER: &str = "dsh-desktop-settings-nav-web-search-v1";
const SETTINGS_NAV_MODEL_BEHAVIOR_MARKER: &str = "dsh-desktop-settings-nav-model-behavior-v1";
/// The shell's fallback nav-glyph branch (gear icon) — the exact insertion
/// point for the desktop section branches. Matched verbatim against the
/// upstream bundle; a future dsh build that reshapes `navIcon` loses the match
/// and the patch skips gracefully.
const SETTINGS_NAV_ICONS_ANCHOR: &str = "\t\t\treturn (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSettingsOutline16, {\n\t\t\t\tclassName: SettingsRoot_module_css_default.navIcon,\n\t\t\t\tsize: 16\n\t\t\t});";
/// Branches inserted before the anchor: a hand-drawn wave glyph for the
/// appearance/motion section (`appearance`), a hand-drawn eye glyph for the
/// vision-model section (`vision-any`), the list-pen glyph from
/// dsh-client-ui-primitives for the session manager (`session-manager`), the
/// branch glyph for change-history, and the user glyph for the About page
/// (`about`). Tab-indented to match the bundle's formatting (the JS parser
/// does not care; readability does).
const SETTINGS_NAV_ICONS_INSERT: &str = r#"			/* dsh-desktop-settings-nav-icons-v2: dedicated glyphs for the desktop-owned sections. */
			if (id === "appearance") return (0, react_jsx_runtime.jsx)("svg", {
				width: 16,
				height: 16,
				className: SettingsRoot_module_css_default.navIcon,
				viewBox: "0 0 16 16",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
				children: [
					(0, react_jsx_runtime.jsx)("path", { d: "M1 5c1.5-1.8 3-1.8 4.5 0s3 1.8 4.5 0 3-1.8 4.5 0", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" }),
					(0, react_jsx_runtime.jsx)("path", { d: "M1 11c1.5-1.8 3-1.8 4.5 0s3 1.8 4.5 0 3-1.8 4.5 0", stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round" })
				]
			});
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
			if (id === "change-history") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconBranchOutline16, {
				className: SettingsRoot_module_css_default.navIcon,
				size: 16
			});
"#;
const SETTINGS_NAV_WEB_SEARCH_INSERT: &str = r#"			/* dsh-desktop-settings-nav-web-search-v1 */
			if (id === "web-search") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconSearchOutline16, {
				className: SettingsRoot_module_css_default.navIcon,
				size: 16
			});
"#;
const SETTINGS_NAV_MODEL_BEHAVIOR_INSERT: &str = r#"			/* dsh-desktop-settings-nav-model-behavior-v1 */
			if (id === "model-behavior") return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutline16, {
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
  function normalizeMotion(m) {
    return m === 'default' || m === 'quiet' || m === 'rich' ? m : 'rich';
  }
  function motionValue() {
    try { return normalizeMotion(window.__DSH_MOTION__); } catch (e) { return 'rich'; }
  }
  function applyMotionAttr(m) {
    try { document.documentElement.setAttribute(MOTION_ATTR, m); } catch (e) {}
  }
  applyMotionAttr(motionValue());
  try {
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('motion-updated', function (e) {
        var m = e && e.payload && e.payload.motion;
        applyMotionAttr(normalizeMotion(m));
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
  // glide); quiet flips instantly like reduced-motion; default passes through
  // to DSH's native theme behavior. The persisted value is injected as
  // `window.__DSH_MOTION__` before page scripts and updates live through the
  // `motion-updated` event.
  var MOTION_ATTR = 'data-dsh-motion';
  function applyMotionAttr(m) {
    try { document.documentElement.setAttribute(MOTION_ATTR, m); } catch (e) {}
  }
  function isQuiet() {
    return prefersReduced() || document.documentElement.getAttribute(MOTION_ATTR) !== 'rich';
  }
  function normalizeMotion(m) {
    return m === 'default' || m === 'quiet' || m === 'rich' ? m : 'rich';
  }
  function motionValue() {
    try { return normalizeMotion(window.__DSH_MOTION__); } catch (e) { return 'rich'; }
  }
  applyMotionAttr(motionValue());
  try {
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('motion-updated', function (e) {
        var m = e && e.payload && e.payload.motion;
        applyMotionAttr(normalizeMotion(m));
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
///   persisted appearance preset (`rich` animates, `quiet` hides waves and
///   bubbles and freezes glows, `default` removes the entire skin) and by
///   prefers-reduced-motion.
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
  function normalizeMotion(m) {
    return m === 'default' || m === 'quiet' || m === 'rich' ? m : 'rich';
  }
  function motionValue() {
    try { return normalizeMotion(window.__DSH_MOTION__); } catch (e) { return 'rich'; }
  }
  function applyMotionAttr(m) {
    try { document.documentElement.setAttribute(MOTION_ATTR, m); } catch (e) {}
  }
  applyMotionAttr(motionValue());
  try {
    if (window.__TAURI__ && window.__TAURI__.event) {
      window.__TAURI__.event.listen('motion-updated', function (e) {
        var m = e && e.payload && e.payload.motion;
        var next = normalizeMotion(m);
        applyMotionAttr(next);
        if (next === 'default') teardown();
        else {
          mount();
          syncEngine();
        }
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
    // quiet: remove the wave bands entirely instead of leaving a frozen wave
    'html[data-dsh-motion="quiet"] #' + AMBIENT_ID + ' .oa-waves{display:none;}' +
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
    return document.documentElement.getAttribute(MOTION_ATTR) === 'rich';
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

  function teardown() {
    try { if (waveEngine) waveEngine.stop(); } catch (e) {}
    try {
      var ambient = document.getElementById(AMBIENT_ID);
      if (ambient && ambient.parentNode) ambient.parentNode.removeChild(ambient);
    } catch (e) {}
    try {
      var style = document.getElementById(STYLE_ID);
      if (style && style.parentNode) style.parentNode.removeChild(style);
    } catch (e) {}
    report('native', 'DSH default appearance active');
  }

  function mount() {
    if (document.documentElement.getAttribute(MOTION_ATTR) === 'default') {
      teardown();
      return true;
    }
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
    if (document.documentElement.getAttribute(MOTION_ATTR) === 'default') return;
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

/// Billing or remaining-quota data for OpenAI-compatible gateways. Some
/// gateways expose the generic `GET {base}/v1/usage` contract, while older
/// OpenAI-compatible gateways only expose dashboard billing endpoints.
#[derive(Clone, Serialize, Deserialize, Debug)]
// NOTE: the bridge panel/badge read snake_case keys (total_usage_usd,
// soft_limit_usd, …) — keep snake_case on the wire.
#[serde(rename_all = "snake_case")]
pub struct ProviderUsage {
    pub remaining: Option<f64>,
    pub unit: Option<String>,
    pub is_valid: Option<bool>,
    pub total_usage_usd: Option<f64>,
    pub soft_limit_usd: Option<f64>,
    pub hard_limit_usd: Option<f64>,
    pub has_payment_method: Option<bool>,
}

/// One prepaid package or subscription exposed by a provider control plane.
/// Amounts intentionally remain numeric and carry their source unit so token,
/// request, image, and currency packages can share the same UI contract.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "snake_case")]
pub struct ProviderPlan {
    pub id: String,
    pub name: String,
    pub product: Option<String>,
    pub total: Option<f64>,
    pub used: Option<f64>,
    pub remaining: Option<f64>,
    pub unit: Option<String>,
    pub status: Option<String>,
    pub effective_at: Option<String>,
    pub expires_at: Option<String>,
    /// Usage deducted during the provider-specific reporting window.
    pub period_usage: Option<f64>,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
}

/// One platform's account status. `kind` is "balance" (prepaid providers with
/// a native balance endpoint), "usage" (bill-by-usage gateways with a billing
/// endpoint), or "unsupported" (no key-accessible balance/billing API).
#[derive(Clone, Serialize, Deserialize, Debug)]
// NOTE: the bridge panel reads snake_case keys (display_name, …) — keep
// snake_case on the wire.
#[serde(rename_all = "snake_case")]
pub struct ProviderStatus {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    pub configured: bool,
    pub balance: Option<Balance>,
    pub usage: Option<ProviderUsage>,
    #[serde(default)]
    pub plans: Vec<ProviderPlan>,
    pub plans_error: Option<String>,
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
    /// Volcengine (火山引擎/火山方舟) — the Ark API key used for LLM calls
    /// cannot read billing, so balance queries go through the signed OpenAPI
    /// `billing.QueryBalanceAcct` endpoint (needs the account AccessKey +
    /// SecretKey, not the Ark API key).
    Volcengine,
    /// No known key-accessible balance/billing endpoint for this protocol.
    Unsupported,
    /// Unknown protocol — probe both endpoint families at fetch time.
    Probe,
}

/// Appearance and motion preset of the desktop UI. `Default` leaves DSH's
/// native design tokens and interactions untouched. `Rich` keeps the full
/// ocean ambient animation set (drifting glows, wave bands, bubbles, the whale
/// theme-switch transition); `Quiet` keeps the ocean skin with only essential
/// micro-interactions and feedback. Serializes to lowercase strings
/// ("default" | "quiet" | "rich") for config.json and the JS bridge.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MotionIntensity {
    Default,
    Quiet,
    Rich,
}

/// Controls when a completed DSH task becomes a native system notification.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskNotificationMode {
    Off,
    Unfocused,
    Always,
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
    /// Native task-completion notifications. Existing config files default to
    /// the low-interruption behavior used by Codex: notify only when needed.
    #[serde(default = "default_task_notification_mode")]
    pub task_notification_mode: TaskNotificationMode,
    /// Remote access via the public relay: the relay-client companion process
    /// connects out to `remote_relay_url` as `remote_device_id` and lets a
    /// phone reach the local dsh web through it. All fields default off/empty
    /// so existing config.json files load unchanged.
    #[serde(default)]
    pub remote_enabled: bool,
    #[serde(default)]
    pub remote_relay_url: Option<String>,
    #[serde(default)]
    pub remote_secret: Option<String>,
    #[serde(default)]
    pub remote_device_id: Option<String>,
    /// Per-device secret issued by POST /register on the relay; the
    /// relay-client authenticates with it. Auto-obtained on first save.
    #[serde(default)]
    pub remote_device_secret: Option<String>,
    #[serde(default = "default_remote_max_concurrent")]
    pub remote_max_concurrent: u16,
    /// Whether the relay has a user-defined long-lived pairing code. The code
    /// itself is never persisted by the desktop client.
    #[serde(default)]
    pub remote_persistent_pairing_enabled: bool,
    /// Optional outbound proxy used by the plugin market and pnpm. When absent,
    /// the DSH child keeps the proxy inherited from the desktop process.
    #[serde(default)]
    pub plugin_network_proxy: Option<String>,
    /// Optional npm-compatible registry for plugin packages. GitHub-source
    /// plugins still use the proxy above for github.com/codeload.github.com.
    #[serde(default)]
    pub plugin_npm_registry: Option<String>,
    /// Total timeout for one market package operation, in minutes.
    #[serde(default = "default_plugin_install_timeout_minutes")]
    pub plugin_install_timeout_minutes: u16,
    /// Built-in packages that should stay installed but not be mounted into
    /// the active web profile. Missing on older configs means every built-in
    /// plugin remains enabled.
    #[serde(default)]
    pub disabled_builtin_plugins: HashSet<String>,
}

fn default_remote_max_concurrent() -> u16 {
    3
}

fn default_motion() -> MotionIntensity {
    MotionIntensity::Rich
}

fn default_task_notification_mode() -> TaskNotificationMode {
    TaskNotificationMode::Unfocused
}

fn default_plugin_install_timeout_minutes() -> u16 {
    30
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
            task_notification_mode: TaskNotificationMode::Unfocused,
            remote_enabled: false,
            remote_relay_url: None,
            remote_secret: None,
            remote_device_id: None,
            remote_device_secret: None,
            remote_max_concurrent: 3,
            remote_persistent_pairing_enabled: false,
            plugin_network_proxy: None,
            plugin_npm_registry: None,
            plugin_install_timeout_minutes: default_plugin_install_timeout_minutes(),
            disabled_builtin_plugins: HashSet::new(),
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
    /// Theme preference from DSH's `settings.yaml` (`light`, `dark`, or `system`).
    pub theme_preference: String,
    pub remote_enabled: bool,
    pub remote_running: bool,
    pub remote_online: bool,
    /// Phone entry URL when configured, e.g. https://my-pc.remote.example.com/
    pub remote_entry: Option<String>,
    /// Whether the Bailian (阿里云百炼) key is configured.
    pub bailian_configured: bool,
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

/// Companion-process bookkeeping for the relay-client (loopback status port
/// 38659; see `RELAY_CLIENT_STATUS_PORT`).
struct RelayProcess {
    child: Option<Child>,
}

/// A port checked before this shell starts any of its own listeners.  Keeping
/// the full set visible avoids treating a lone 3080 listener as a complete
/// desktop instance while its bridge services are missing.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupPortStatus {
    name: String,
    port: u16,
    occupied: bool,
    healthy: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupConflict {
    ports: Vec<StartupPortStatus>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum StartupMode {
    UseExisting,
    Independent,
}

pub struct AppState {
    dsh: Mutex<DshProcess>,
    relay: Mutex<RelayProcess>,
    /// True when the relay-client status endpoint reports an online agent
    /// connection (updated by the status probe).
    remote_online: AtomicBool,
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
    /// Defensive shell-side duplicate guard for repeated local /turn-end
    /// requests. The bridge already deduplicates by session turn.
    recent_task_notifications: Mutex<HashMap<String, Instant>>,
    last_refresh: Mutex<Option<Instant>>,
    last_update_check: Mutex<Option<Instant>>,
    /// Process-wide update gates. Backend checks are authoritative; UI button
    /// disabling is only presentation and cannot bypass these locks.
    core_update_in_progress: AtomicBool,
    shell_update_in_progress: AtomicBool,
    tray_balance_item: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
    tray_autostart_item: Mutex<Option<CheckMenuItem<tauri::Wry>>>,
    /// `Instant` of the most recent dsh child spawn (bootstrap or restart) —
    /// drives the "ready in X.Xs after spawn" boot-timing log line.
    spawned_at: Mutex<Option<Instant>>,
    /// Throttle gate for the relay-client watchdog: the earliest `Instant` at
    /// which the next automatic (re)spawn attempt may run. Stops a
    /// persistently-failing spawn (missing entry / device secret) from
    /// churning a log line every health-loop tick.
    relay_respawn_at: Mutex<Option<Instant>>,
    /// A complete prior desktop instance is allowed to be adopted only after
    /// the user has made an explicit choice on the splash screen.
    startup_conflict: Mutex<Option<StartupConflict>>,
    startup_decision: Mutex<Option<StartupMode>>,
    startup_decision_cv: Condvar,
    startup_pending: AtomicBool,
}

#[derive(Clone)]
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
        app.path()
            .resource_dir()
            .unwrap_or_default()
            .join("runtime")
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
        && dir
            .join("dsh")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js")
            .is_file()
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeReadyMarker {
    archive_size: u64,
    archive_modified_ms: u128,
    completed_at: String,
}

fn runtime_ready_marker_path(dir: &Path) -> PathBuf {
    dir.join(".runtime-ready.json")
}

/// A cheap archive identity used to invalidate an extracted tree when an
/// installer upgrade carries a different runtime. Hashing the 95 MiB archive
/// on every normal start would reintroduce avoidable startup I/O.
fn archive_identity(archive: &Path) -> Option<(u64, u128)> {
    let meta = fs::metadata(archive).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some((meta.len(), modified.as_millis()))
}

fn runtime_ready_for_archive(dir: &Path, archive: &Path) -> bool {
    if !runtime_tree_usable(dir) {
        return false;
    }
    let Some((archive_size, archive_modified_ms)) = archive_identity(archive) else {
        return false;
    };
    fs::read_to_string(runtime_ready_marker_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str::<RuntimeReadyMarker>(&s).ok())
        .is_some_and(|marker| {
            marker.archive_size == archive_size && marker.archive_modified_ms == archive_modified_ms
        })
}

fn runtime_preparation_needed(paths: &Paths) -> bool {
    if !runtime_tree_usable(&paths.runtime_dir) {
        return true;
    }
    // `npm run dev` intentionally uses the checked-out, already-extracted
    // runtime tree; release builds always verify the packaged archive marker.
    !cfg!(debug_assertions)
        && !runtime_ready_for_archive(
            &paths.runtime_dir,
            &paths.bundled_runtime_dir.join("runtime-archive.tar.gz"),
        )
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
        .or_else(|| {
            std::env::var("DSH_DESKTOP_DSH_HOME")
                .ok()
                .map(PathBuf::from)
        })
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

fn port_accepts_connections(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(450),
    )
    .is_ok()
}

/// A small dependency-free loopback HTTP probe. A response of any HTTP status
/// proves that the expected local service owns the listener; endpoint-specific
/// callers still decide which status is considered healthy.
fn http_status_on_port(port: u16, path: &str) -> Option<u16> {
    let mut stream = std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(650),
    )
    .ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(850)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(650)));
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut head = [0u8; 128];
    let read = stream.read(&mut head).ok()?;
    let status = std::str::from_utf8(&head[..read])
        .ok()?
        .lines()
        .next()?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()?;
    Some(status)
}

fn startup_port_statuses(config: &AppConfig) -> Vec<StartupPortStatus> {
    let specs = [
        ("DSH Web", dsh_port(config), "/", true),
        ("桌面桥接", config.bridge_shell_port, "/motion", true),
        ("凭据桥接", config.bridge_port, "/ping", true),
        (
            "远程访问状态",
            RELAY_CLIENT_STATUS_PORT,
            "/ping",
            config.remote_enabled,
        ),
    ];
    specs
        .into_iter()
        .map(|(name, port, path, required)| {
            let occupied = port_accepts_connections(port);
            let status = if occupied {
                http_status_on_port(port, path)
            } else {
                None
            };
            let healthy = match name {
                "DSH Web" => status.is_some_and(|s| (200..600).contains(&s)),
                _ => status.is_some_and(|s| (200..300).contains(&s)),
            };
            // An intentionally disabled remote feature is not part of a complete
            // desktop instance, but a listener there is still a conflict.
            StartupPortStatus {
                name: name.to_string(),
                port,
                occupied,
                healthy: healthy || !required && !occupied,
            }
        })
        .collect()
}

fn listening_pids_on_port(port: u16) -> Vec<u32> {
    let mut cmd = Command::new("netstat");
    cmd.args(["-ano", "-p", "tcp"]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let Ok(output) = cmd.output() else {
        return Vec::new();
    };
    let port_suffix = format!(":{port}");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() < 5
                || !fields[1].ends_with(&port_suffix)
                || !fields[3].eq_ignore_ascii_case("LISTENING")
            {
                return None;
            }
            fields[4].parse::<u32>().ok()
        })
        .collect()
}

fn stop_port_owners(ports: &[StartupPortStatus]) -> Result<(), String> {
    let mut pids: Vec<u32> = ports
        .iter()
        .filter(|p| p.occupied)
        .flat_map(|p| listening_pids_on_port(p.port))
        .collect();
    pids.sort_unstable();
    pids.dedup();
    for pid in pids {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let status = cmd
            .status()
            .map_err(|e| format!("无法结束占用端口的进程 {pid}: {e}"))?;
        if !status.success() {
            return Err(format!("结束占用端口的进程 {pid} 失败"));
        }
    }
    for _ in 0..10 {
        if ports.iter().all(|p| !port_accepts_connections(p.port)) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    let busy = ports
        .iter()
        .filter(|p| port_accepts_connections(p.port))
        .map(|p| p.port.to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!("端口仍被占用: {busy}"))
}

fn wait_for_startup_decision(state: &AppState) -> StartupMode {
    let mut decision = state.startup_decision.lock().unwrap();
    loop {
        if let Some(mode) = *decision {
            return mode;
        }
        decision = state.startup_decision_cv.wait(decision).unwrap();
    }
}

fn startup_instance_complete(ports: &[StartupPortStatus], remote_enabled: bool) -> bool {
    ports.iter().enumerate().all(|(index, port)| {
        let required = index < 3 || remote_enabled;
        if required {
            port.occupied && port.healthy
        } else {
            // A disabled feature must not leave an unrelated listener behind:
            // that would make the graph incomplete and is reclaimed below.
            !port.occupied
        }
    })
}

/// WebView2 user data dir: production = app data dir; env override for portable/sandboxed runs.
fn webview_data_dir(app: &AppHandle) -> PathBuf {
    std::env::var("DSH_DESKTOP_WEBVIEW_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            app.path()
                .app_data_dir()
                .unwrap_or_default()
                .join("webview-data")
        })
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

fn valid_plugin_proxy(value: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(value.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return None;
    }
    Some(parsed.to_string().trim_end_matches('/').to_string())
}

fn valid_npm_registry(value: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(value.trim()).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return None;
    }
    Some(format!("{}/", parsed.as_str().trim_end_matches('/')))
}

fn plugin_network_snapshot(config: &AppConfig) -> serde_json::Value {
    serde_json::json!({
        "proxy": config.plugin_network_proxy,
        "npmRegistry": config.plugin_npm_registry,
        "installTimeoutMinutes": config.plugin_install_timeout_minutes.clamp(10, 60),
    })
}

fn builtin_plugin_version(paths: &Paths, name: &str) -> Option<String> {
    let package = paths
        .bundled_runtime_dir
        .join("plugins-src")
        .join(name)
        .join("package.json");
    fs::read_to_string(package)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value.get("version")?.as_str().map(String::from))
}

fn builtin_plugins_snapshot(paths: &Paths, config: &AppConfig) -> serde_json::Value {
    let managed = read_bundled_third_party_plugins(paths);
    let profile_modules = paths.dsh_home.join("profiles").join("node_modules");
    let plugins = BUILTIN_PLUGINS
        .iter()
        .map(|name| {
            let source = if DESKTOP_PLUGINS.contains(name) {
                "desktop"
            } else if profile_modules.join(name).exists() && !managed.contains(*name) {
                "user"
            } else {
                "bundledThirdParty"
            };
            serde_json::json!({
                "id": name,
                "version": builtin_plugin_version(paths, name),
                "source": source,
                "enabled": !config.disabled_builtin_plugins.contains(*name),
                "controlPlaneRetained": *name == "dsh-desktop-bridge",
                "requiresRestart": true,
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({ "ok": true, "plugins": plugins })
}

fn restart_dsh_after_builtin_change(
    app: AppHandle,
    paths: Paths,
    next: AppConfig,
    previous: AppConfig,
) {
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(750));
        let state = app.state::<AppState>();
        state.runtime_ready.store(false, Ordering::SeqCst);
        ensure_runtime_files(&paths);
        let spawn_result = {
            let mut dsh = state.dsh.lock().unwrap();
            if let Some(mut child) = dsh.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            spawn_dsh(&paths, &next).map(|child| {
                dsh.child = Some(child);
            })
        };
        if let Err(error) = spawn_result {
            log_line(
                &paths.log_file,
                &format!("built-in plugin restart failed, rolling back: {error}"),
            );
            save_config(&paths.config_file, &previous);
            *state.config.lock().unwrap() = previous.clone();
            ensure_runtime_files(&paths);
            let mut dsh = state.dsh.lock().unwrap();
            match spawn_dsh(&paths, &previous) {
                Ok(child) => dsh.child = Some(child),
                Err(rollback_error) => log_line(
                    &paths.log_file,
                    &format!("built-in plugin rollback restart failed: {rollback_error}"),
                ),
            }
        } else {
            log_line(
                &paths.log_file,
                "built-in plugin settings applied; DSH restarted",
            );
        }
        state.runtime_ready.store(true, Ordering::SeqCst);
    });
}

async fn probe_plugin_network(config: &AppConfig) -> serde_json::Value {
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(12));
    if let Some(proxy) = config.plugin_network_proxy.as_deref() {
        match reqwest::Proxy::all(proxy) {
            Ok(value) => builder = builder.proxy(value),
            Err(error) => {
                return serde_json::json!({ "ok": false, "error": format!("代理配置无效: {error}") })
            }
        }
    }
    let client = match builder.build() {
        Ok(value) => value,
        Err(error) => {
            return serde_json::json!({ "ok": false, "error": format!("无法创建网络检测客户端: {error}") })
        }
    };
    let registry = config
        .plugin_npm_registry
        .as_deref()
        .unwrap_or("https://registry.npmjs.org/");
    let targets = [
        ("market", "https://awesome-dsh-plugin.com/plugins.json"),
        ("npm", registry),
        ("github", "https://github.com"),
        ("codeload", "https://codeload.github.com"),
    ];
    let mut checks = Vec::new();
    for (name, url) in targets {
        let started = Instant::now();
        match client
            .get(url)
            .header(reqwest::header::RANGE, "bytes=0-1023")
            .send()
            .await
        {
            Ok(response) => checks.push(serde_json::json!({
                "name": name,
                "ok": response.status().is_success() || response.status().as_u16() == 206,
                "status": response.status().as_u16(),
                "elapsedMs": started.elapsed().as_millis(),
            })),
            Err(error) => checks.push(serde_json::json!({
                "name": name,
                "ok": false,
                "elapsedMs": started.elapsed().as_millis(),
                "error": error.to_string(),
            })),
        }
    }
    serde_json::json!({ "ok": checks.iter().all(|check| check["ok"] == true), "checks": checks })
}

/// Content for the shell's `--patch` overlay. The home-level user layer
/// (`$DSH_HOME/cordis.patch.yml`) may already mount some desktop plugins
/// (standalone `dsh web` setups); duplicating their loader entry ids crashes
/// profile boot, so the overlay emits ONLY the rows the home layer does not
/// already mount — empty when every desktop plugin is already mounted.
fn desktop_patch_overlay(dsh_home: &Path, disabled: &HashSet<String>) -> String {
    let empty_overlay = format!(
        "# dsh-desktop search route + bridge rows — home layer already mounts every desktop plugin.\n{}- insert: []\n",
        WEB_SEARCH_PATCH_YML
    );
    let home_layer = dsh_home.join("cordis.patch.yml");
    let content = fs::read_to_string(&home_layer).unwrap_or_default();

    // Split the shipped patch into per-plugin rows. The shipped file is a
    // single `- insert:` list of `- id:` blocks; comment lines and the header
    // are ignored, and each `- id:` line starts one row block.
    let mut rows: Vec<String> = Vec::new();
    let mut current: Option<String> = None;
    for line in BRIDGE_PATCH_YML.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') || trimmed.starts_with("- insert:") || trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("- id:") {
            if let Some(row) = current.take() {
                rows.push(row);
            }
            current = Some(String::new());
        }
        if let Some(row) = current.as_mut() {
            row.push_str(line);
            row.push('\n');
        }
    }
    if let Some(row) = current {
        rows.push(row);
    }

    // Keep only enabled rows whose plugin id the home layer does not already
    // mount. The bridge row is the non-disableable control plane for this
    // settings page; its user-facing features are gated by the client bundle.
    let missing: Vec<&str> = rows
        .iter()
        .filter(|row| {
            !DESKTOP_PLUGINS.iter().any(|name| {
                row.contains(&format!("id: {name}"))
                    && ((*name != "dsh-desktop-bridge" && disabled.contains(*name))
                        || content.contains(&format!("id: {name}")))
            })
        })
        .map(|row| row.as_str())
        .collect();

    if missing.is_empty() {
        empty_overlay
    } else {
        format!(
            "# dsh-desktop search route + bridge rows — gap-fill overlay (managed by DSH Desktop).\n{}- insert:\n{}",
            WEB_SEARCH_PATCH_YML,
            missing.concat(),
        )
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
    let config = load_config(&paths.config_file);
    let disabled = &config.disabled_builtin_plugins;
    write_if_different(
        &paths.patch_file,
        &desktop_patch_overlay(&paths.dsh_home, disabled),
    );
    // The loader resolves plugin entries from the profile's module tree
    // ($DSH_HOME/profiles/node_modules), not from runtime/dsh — deploy the
    // desktop plugin packages there so each `--patch` row can import it.
    // The canonical copies live in the bundled runtime's plugins-src (read
    // from the install dir even when the extracted tree lives elsewhere).
    // Desktop-owned packages are refreshed on every boot. Third-party bundles
    // are only refreshed when this installation created their first copy;
    // otherwise an existing same-name package is treated as user-owned.
    let plugins_src = paths.bundled_runtime_dir.join("plugins-src");
    let profile_modules = paths.dsh_home.join("profiles").join("node_modules");
    let mut web_bundles = Vec::new();
    if plugins_src.exists() {
        for name in DESKTOP_PLUGINS {
            let src = plugins_src.join(name);
            if !src.exists() {
                continue;
            }
            let dst = profile_modules.join(name);
            let _ = fs::create_dir_all(&dst);
            let _ = copy_dir_contents(&src, &dst);
        }

        let mut managed = read_bundled_third_party_plugins(paths);
        if deploy_bundled_third_party_plugin(
            paths,
            &plugins_src,
            &profile_modules,
            VISION_PLUGIN,
            &mut managed,
        ) && !disabled.contains(VISION_PLUGIN)
        {
            web_bundles.push(VISION_PLUGIN);
        }
        if deploy_bundled_third_party_plugin(
            paths,
            &plugins_src,
            &profile_modules,
            MARKET_PLUGIN,
            &mut managed,
        ) {
            if !disabled.contains(MARKET_PLUGIN) {
                web_bundles.push(MARKET_PLUGIN);
            }
            if managed.contains(MARKET_PLUGIN) {
                // Keep market-only dependencies below the plugin package. This
                // avoids overwriting a user's top-level copies of common packages.
                let market_modules = profile_modules.join(MARKET_PLUGIN).join("node_modules");
                for name in MARKET_PLUGIN_RUNTIME_PACKAGES.iter().skip(1) {
                    let src = plugins_src.join(name);
                    if !src.exists() {
                        continue;
                    }
                    let dst = market_modules.join(name);
                    let _ = fs::create_dir_all(&dst);
                    let _ = copy_dir_contents(&src, &dst);
                }
            }
        }
        write_bundled_third_party_plugins(paths, &managed);
    }
    // Mount bundle plugins only when their packages actually deployed — an
    // old runtime without one must never leave a dangling profile entry.
    reconcile_web_profile_bundles(paths, &web_bundles, disabled);
    // Deploy the relay-client companion process (not a cordis plugin): ships
    // under the bundled runtime's relay-client/ directory, or scripts/
    // relay-client in a dev checkout. The extracted tree must hold a copy so
    // the shell can spawn it with the bundled node.exe.
    let relay_dst = paths.runtime_dir.join("relay-client");
    let relay_srcs = [
        paths.bundled_runtime_dir.join("relay-client"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("relay-client"),
    ];
    if let Some(src) = relay_srcs.iter().find(|s| s.join("index.js").exists()) {
        let _ = fs::create_dir_all(&relay_dst);
        let _ = copy_dir_contents(src, &relay_dst);
    }
    // Give the desktop-owned settings sections (外观与动效 / 视觉模型 /
    // 会话管理 / 变更历史 / 关于) their dedicated nav glyphs in the served
    // settings-shell bundle.
    patch_settings_nav_icons(paths);
    // Extend the existing Models editor with write-only account credentials
    // required by provider control planes (currently Volcengine billing).
    patch_settings_models_credentials(paths);
}

fn bundled_third_party_state_path(paths: &Paths) -> PathBuf {
    paths
        .dsh_home
        .join("desktop")
        .join(BUNDLED_THIRD_PARTY_STATE_FILE)
}

fn read_bundled_third_party_plugins(paths: &Paths) -> HashSet<String> {
    fs::read_to_string(bundled_third_party_state_path(paths))
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
        .into_iter()
        .collect()
}

fn write_bundled_third_party_plugins(paths: &Paths, plugins: &HashSet<String>) {
    let mut names: Vec<&str> = plugins.iter().map(String::as_str).collect();
    names.sort_unstable();
    let content = serde_json::to_string_pretty(&names).unwrap_or_default() + "\n";
    write_if_different(&bundled_third_party_state_path(paths), &content);
}

/// Deploy a bundled third-party package without taking ownership of a package
/// the user had already installed. Returns whether a usable package exists.
fn deploy_bundled_third_party_plugin(
    paths: &Paths,
    plugins_src: &Path,
    profile_modules: &Path,
    name: &str,
    managed: &mut HashSet<String>,
) -> bool {
    let src = plugins_src.join(name);
    if !src.exists() {
        return false;
    }
    let dst = profile_modules.join(name);
    if dst.exists() && !managed.contains(name) {
        log_line(
            &paths.log_file,
            &format!("reusing user-managed third-party plugin {name}; bundled copy not deployed"),
        );
        return true;
    }
    if fs::create_dir_all(&dst)
        .and_then(|()| copy_dir_contents(&src, &dst))
        .is_err()
    {
        log_line(
            &paths.log_file,
            &format!("failed to deploy bundled third-party plugin {name}"),
        );
        return false;
    }
    managed.insert(name.to_string());
    true
}

/// Settings-shell nav-icon patch for the desktop-owned settings sections
/// (联网搜索 `web-search`, 模型行为 `model-behavior`, 外观与动效 `appearance`, 视觉模型 `vision-any`,
/// 会话管理 `session-manager`, 变更历史 `change-history`, 关于 `about`). The shell
/// hard-codes nav glyphs per section id and falls back to the settings gear
/// for unknown ids; this inserts dedicated branches into its served client
/// bundle. Idempotent (marker-checked). When the upstream bundle no longer
/// contains the anchor — a future dsh build reworked `navIcon` — the patch
/// logs and skips, and the sections simply keep the gear fallback.
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
    let needs_existing = !raw.contains(SETTINGS_NAV_ICONS_MARKER);
    let needs_web_search = !raw.contains(SETTINGS_NAV_WEB_SEARCH_MARKER);
    let needs_model_behavior = !raw.contains(SETTINGS_NAV_MODEL_BEHAVIOR_MARKER);
    if !needs_existing && !needs_web_search && !needs_model_behavior {
        return; // already patched
    }
    if !raw.contains(SETTINGS_NAV_ICONS_ANCHOR) {
        log_line(
            &paths.log_file,
            "settings shell navIcon anchor not found; nav icons unpatched (upstream bundle changed?)",
        );
        return;
    }
    let mut patched = raw;
    if needs_existing {
        patched = patched.replacen(
            SETTINGS_NAV_ICONS_ANCHOR,
            &format!("{SETTINGS_NAV_ICONS_INSERT}{SETTINGS_NAV_ICONS_ANCHOR}"),
            1,
        );
    }
    if needs_web_search {
        patched = patched.replacen(
            SETTINGS_NAV_ICONS_ANCHOR,
            &format!("{SETTINGS_NAV_WEB_SEARCH_INSERT}{SETTINGS_NAV_ICONS_ANCHOR}"),
            1,
        );
    }
    if needs_model_behavior {
        patched = patched.replacen(
            SETTINGS_NAV_ICONS_ANCHOR,
            &format!("{SETTINGS_NAV_MODEL_BEHAVIOR_INSERT}{SETTINGS_NAV_ICONS_ANCHOR}"),
            1,
        );
    }
    write_if_different(&bundle, &patched);
    log_line(
        &paths.log_file,
        "settings shell nav icons patched (web search + model behavior + appearance + vision + session)",
    );
}

/// Add account-level credential fields to the existing Models provider card.
/// The patch is deliberately narrow and marker-guarded: when an upstream DSH
/// update changes either anchor, the unmodified Models page remains usable and
/// the desktop log records the degraded integration.
fn patch_settings_models_credentials(paths: &Paths) {
    let bundle = SETTINGS_MODELS_BUNDLE
        .iter()
        .fold(paths.runtime_dir.clone(), |path, part| path.join(part));
    let raw = match fs::read_to_string(&bundle) {
        Ok(raw) => raw,
        Err(error) => {
            if !bundle.exists() && !paths.node_exe.exists() {
                return;
            }
            log_line(
                &paths.log_file,
                &format!("models settings bundle unreadable; provider credentials unpatched: {error}"),
            );
            return;
        }
    };
    if raw.contains(SETTINGS_MODELS_CREDENTIALS_MARKER) {
        return;
    }
    if !raw.contains(SETTINGS_MODELS_COMPONENT_ANCHOR)
        || !raw.contains(SETTINGS_MODELS_RENDER_ANCHOR)
    {
        log_line(
            &paths.log_file,
            "models settings credential anchors not found; provider credentials unpatched (upstream bundle changed?)",
        );
        return;
    }
    let with_component = raw.replacen(
        SETTINGS_MODELS_COMPONENT_ANCHOR,
        &format!("{SETTINGS_MODELS_COMPONENT_INSERT}{SETTINGS_MODELS_COMPONENT_ANCHOR}"),
        1,
    );
    let patched = with_component.replacen(
        SETTINGS_MODELS_RENDER_ANCHOR,
        SETTINGS_MODELS_RENDER_REPLACEMENT,
        1,
    );
    write_if_different(&bundle, &patched);
    log_line(
        &paths.log_file,
        "models settings provider account credentials patched (Volcengine AK/SK)",
    );
}

/// Mount bundled web plugins into the web profile by appending their names
/// to `dsh.profile.bundles` — the exact contract `dsh plugin --profile web add`
/// uses, minus pnpm (the package is deployed by `ensure_runtime_files`).
/// A fresh `$DSH_HOME` gets a template-equivalent web profile with the bundled
/// plugins pre-listed; an existing profile keeps its own bundle order and gets
/// the entry appended only when absent. Never clobbers anything else, and
/// treats an unreadable/invalid manifest as a skip (log, not crash).
#[cfg(test)]
fn ensure_web_profile_bundles(paths: &Paths, bundled_plugins: &[&str]) {
    reconcile_web_profile_bundles(paths, bundled_plugins, &HashSet::new());
}

/// Reconcile the two bundle-style built-ins without touching package files or
/// unrelated profile entries. Disabled names are removed wherever they sit;
/// enabled names are appended only when absent.
fn reconcile_web_profile_bundles(
    paths: &Paths,
    bundled_plugins: &[&str],
    disabled_plugins: &HashSet<String>,
) {
    let web_dir = paths.dsh_home.join("profiles").join("web");
    let manifest_path = web_dir.join("package.json");
    let _ = fs::create_dir_all(&web_dir);

    if !manifest_path.exists() {
        let bundles = WEB_TEMPLATE_BUNDLES
            .iter()
            .chain(bundled_plugins.iter())
            .map(|name| serde_json::json!(name))
            .collect::<Vec<_>>();
        let manifest = serde_json::json!({
            "name": "dsh-profile-web",
            "private": true,
            "dependencies": {},
            "dsh": {
                "profile": {
                    "bundles": bundles,
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
            &format!(
                "web profile initialized with bundled {}",
                bundled_plugins.join(", ")
            ),
        );
        return;
    }

    let raw = match fs::read_to_string(&manifest_path) {
        Ok(raw) => raw,
        Err(e) => {
            log_line(
                &paths.log_file,
                &format!("web profile manifest unreadable; bundled plugins not mounted: {e}"),
            );
            return;
        }
    };
    let mut manifest = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(manifest) => manifest,
        Err(e) => {
            log_line(
                &paths.log_file,
                &format!("web profile manifest invalid; bundled plugins not mounted: {e}"),
            );
            return;
        }
    };
    let mut changed = false;
    if let Some(bundles) = manifest
        .get_mut("dsh")
        .and_then(|value| value.get_mut("profile"))
        .and_then(|value| value.get_mut("bundles"))
        .and_then(serde_json::Value::as_array_mut)
    {
        let before = bundles.len();
        bundles.retain(|value| {
            value
                .as_str()
                .is_none_or(|name| !disabled_plugins.contains(name))
        });
        changed = bundles.len() != before;
    }
    if append_web_profile_bundles(&mut manifest, bundled_plugins) {
        changed = true;
    }
    if !changed {
        return; // already mounted, or the manifest shape is not ours to touch
    }
    match fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).unwrap_or_default() + "\n",
    ) {
        Ok(()) => log_line(
            &paths.log_file,
            &format!(
                "mounted bundled {} into the web profile",
                bundled_plugins.join(", ")
            ),
        ),
        Err(e) => log_line(
            &paths.log_file,
            &format!("failed to write web profile manifest: {e}"),
        ),
    }
}

/// Append bundled plugins to `dsh.profile.bundles`, creating the `dsh` /
/// `profile` / `bundles` path when absent. Returns true when the manifest was
/// mutated (and must be written back); false when already mounted or when the
/// existing shape is not a plain object (left untouched).
fn append_web_profile_bundles(manifest: &mut serde_json::Value, bundled_plugins: &[&str]) -> bool {
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
    let mut changed = false;
    for name in bundled_plugins {
        if !bundles.iter().any(|v| v.as_str() == Some(name)) {
            bundles.push(serde_json::json!(name));
            changed = true;
        }
    }
    changed
}

/// Copy `src`'s contents into `dst` (files and directories; no metadata
/// promises), skipping files whose content already matches. The desktop plugin
/// packages are re-deployed into the profile module tree on every boot; a
/// plain `fs::copy` would rewrite thousands of unchanged files each time,
/// re-triggering antivirus scans and inflating the next dsh boot.
/// Content-diffing makes the per-boot deploy a near no-op after the first run.
fn copy_dir_contents(src: &Path, dst: &Path) -> std::io::Result<()> {
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            fs::create_dir_all(&to)?;
            copy_dir_contents(&from, &to)?;
        } else {
            copy_file_if_different(&from, &to)?;
        }
    }
    Ok(())
}

/// Copy `from` to `to` only when the destination is missing or its content
/// differs. Returns `Ok(true)` when a copy actually happened.
fn copy_file_if_different(from: &Path, to: &Path) -> std::io::Result<bool> {
    let src_len = fs::metadata(from)?.len();
    if let Ok(dst_meta) = fs::metadata(to) {
        if dst_meta.len() == src_len && files_equal(from, to)? {
            return Ok(false);
        }
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(from, to)?;
    Ok(true)
}

/// Byte-compare two files in chunks. The caller checks lengths first, so any
/// mismatch here is a real content difference.
fn files_equal(a: &Path, b: &Path) -> std::io::Result<bool> {
    let mut fa = fs::File::open(a)?;
    let mut fb = fs::File::open(b)?;
    let mut ba = [0u8; 64 * 1024];
    let mut bb = [0u8; 64 * 1024];
    loop {
        let na = fa.read(&mut ba)?;
        let nb = fb.read(&mut bb)?;
        if na != nb || ba[..na] != bb[..nb] {
            return Ok(false);
        }
        if na == 0 {
            return Ok(true);
        }
    }
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

/// Retry individual extracted-file writes. Antivirus scanners can briefly lock
/// a new executable such as node.exe during first-run runtime preparation.
fn write_file_retry(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    const ATTEMPTS: u32 = 6;
    const BASE_DELAY: Duration = Duration::from_millis(300);
    let mut last = None;
    for attempt in 0..ATTEMPTS {
        match fs::write(path, contents) {
            Ok(()) => return Ok(()),
            Err(e)
                if attempt + 1 < ATTEMPTS
                    && matches!(
                        e.kind(),
                        std::io::ErrorKind::PermissionDenied
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::WouldBlock
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
    // A large read buffer lets the gzip decoder pull multi-MB chunks instead
    // of many small reads — extraction of a ~100MB archive spends most of its
    // time in the decompressor, and bigger reads make it substantially faster
    // on Windows (fewer syscalls, friendlier to antivirus interposition).
    let gz = GzDecoder::new(BufReader::with_capacity(4 * 1024 * 1024, file));
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
        if entry.header().entry_type().is_file() {
            // Keep one entry in memory so a transient file lock can be retried
            // without restarting the whole archive stream.
            let mut contents = Vec::new();
            entry
                .read_to_end(&mut contents)
                .map_err(|e| format!("读取归档 {:?} 失败: {e}", target))?;
            write_file_retry(&target, &contents)
                .map_err(|e| format!("解包 {:?} 失败: {e}", target))?;
        } else {
            entry
                .unpack(&target)
                .map_err(|e| format!("解包 {:?} 失败: {e}", target))?;
        }
        count += 1;
        on_entry(count);
    }
    Ok(())
}

/// First-run bootstrap: unpack `runtime/runtime-archive.tar.gz` into the
/// runtime dir when the extracted tree is missing (fresh install).
fn extract_runtime_archive(app: &AppHandle, paths: &Paths) -> Result<(), String> {
    recover_interrupted_update(&paths.runtime_dir, &paths.log_file)?;
    let archive = paths.bundled_runtime_dir.join("runtime-archive.tar.gz");
    if !runtime_preparation_needed(paths) {
        return Ok(());
    }
    // The archive ships in the install dir (readable even when that dir is
    // not writable); the target is the resolved runtime_dir.
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
    log_line(
        &paths.log_file,
        "extracting bundled runtime archive (first run) ...",
    );
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
    // Never expose a partly expanded node_modules tree. A cancelled prepare
    // run leaves only its staging directory behind; normal startup can safely
    // retry instead of trying to boot from mixed old/new files.
    let staging = paths.runtime_dir.with_file_name(format!(
        "runtime-preparing-{}-{}",
        std::process::id(),
        PROBE_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    extract_tarball(&archive, &staging, false, &mut on_entry)?;
    if !runtime_tree_usable(&staging) {
        return Err("运行时解压不完整".to_string());
    }
    let installed_dsh_version = dsh_manifest_version(&paths.runtime_dir.join("dsh"));
    let shipped_dsh_version = dsh_manifest_version(&staging.join("dsh"));
    let preserve_newer_dsh = should_preserve_installed_dsh(
        installed_dsh_version.as_deref(),
        shipped_dsh_version.as_deref(),
    );
    if preserve_newer_dsh {
        log_line(
            &paths.log_file,
            &format!(
                "preserving newer installed dsh {} over bundled {} during shell upgrade",
                installed_dsh_version.as_deref().unwrap_or("?"),
                shipped_dsh_version.as_deref().unwrap_or("?")
            ),
        );
    }
    create_dir_all_retry(&paths.runtime_dir).map_err(|e| format!("创建运行时目录失败: {e}"))?;
    for name in ["node", "dsh"] {
        if name == "dsh" && preserve_newer_dsh {
            let _ = fs::remove_dir_all(staging.join("dsh"));
            continue;
        }
        let target = paths.runtime_dir.join(name);
        if target.exists() {
            fs::remove_dir_all(&target)
                .map_err(|e| format!("清理不完整运行时 {} 失败: {e}", target.display()))?;
        }
        fs::rename(staging.join(name), &target)
            .map_err(|e| format!("切换运行时 {} 失败: {e}", target.display()))?;
    }
    let _ = fs::remove_dir_all(&staging);
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
    let (archive_size, archive_modified_ms) =
        archive_identity(&archive).ok_or_else(|| "读取运行时归档信息失败".to_string())?;
    let marker = RuntimeReadyMarker {
        archive_size,
        archive_modified_ms,
        completed_at: chrono::Local::now().to_rfc3339(),
    };
    let marker_tmp = paths.runtime_dir.join(".runtime-ready.tmp");
    fs::write(
        &marker_tmp,
        serde_json::to_vec_pretty(&marker).unwrap_or_default(),
    )
    .map_err(|e| format!("写入运行时完成标记失败: {e}"))?;
    let marker_path = runtime_ready_marker_path(&paths.runtime_dir);
    let _ = fs::remove_file(&marker_path);
    fs::rename(marker_tmp, marker_path).map_err(|e| format!("提交运行时完成标记失败: {e}"))?;
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

// ---------------------------------------------------------------------------
// Bailian (阿里云百炼) one-click setup
// ---------------------------------------------------------------------------

/// The pi-ai catalog provider that describes Alibaba Cloud's token-plan
/// endpoint (same base URL the user would type for 百炼's compatible mode).
/// Its models ship with reasoning metadata, so the model picker offers
/// thinking levels without any hand-written `reasoningEfforts`.
const BAILIAN_PROVIDER_ID: &str = "qwen-token-plan-cn";
const BAILIAN_KEY_ENV: &str = "QWEN_TOKEN_PLAN_CN_API_KEY";
/// The catalog provider's endpoint. Written into the route profile so the
/// desktop's multi-provider panel can discover it (it reads `baseURL` from
/// settings.yaml); DSH itself would take the same URL from the catalog.
const BAILIAN_BASE_URL: &str = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
/// Token-plan hosts the built-in catalog providers describe. A hand-declared
/// route pointing at one of these endpoints duplicates the catalog provider —
/// same models, minus the reasoning metadata — so the one-click setup folds
/// such routes into the catalog route instead of leaving a twin behind.
const BAILIAN_TOKEN_PLAN_HOSTS: [&str; 2] = [
    "token-plan.cn-beijing.maas.aliyuncs.com",
    "token-plan.ap-southeast-1.maas.aliyuncs.com",
];
/// Catalog route ids that legitimately point at a token-plan host — they are
/// catalog providers themselves and must never be folded.
const BAILIAN_CATALOG_ROUTE_IDS: [&str; 2] = ["qwen-token-plan-cn", "qwen-token-plan"];

/// What `ensure_bailian_provider` did to the settings document.
struct BailianEnsureOutcome {
    /// The catalog route already existed before the write.
    existed: bool,
    /// Duplicate hand-declared routes folded into the catalog route.
    removed: Vec<String>,
    /// Model ids carried over from the folded routes.
    merged_models: Vec<String>,
}

/// Ensure `llm-pi-ai.providers.<BAILIAN_PROVIDER_ID>` exists in settings.yaml
/// with the minimal catalog-driving profile (display name + key reference).
/// Everything else — models, wire protocol, base URL, thinking levels — comes
/// from the installed pi-ai catalog. Hand-declared routes pointing at the same
/// token-plan endpoint are folded in: their model entries are merged onto the
/// catalog route (catalog-known ids keep the catalog's reasoning metadata;
/// unknown ids keep the route defaults) and the twin route is removed.
fn ensure_bailian_provider(settings_path: &Path) -> Result<BailianEnsureOutcome, String> {
    let raw = fs::read_to_string(settings_path).unwrap_or_default();
    let mut doc: serde_yaml::Value = serde_yaml::from_str(&raw).unwrap_or(serde_yaml::Value::Null);
    if !doc.is_mapping() {
        doc = serde_yaml::Value::Mapping(Default::default());
    }
    let root = doc
        .as_mapping_mut()
        .ok_or_else(|| "settings.yaml 顶层不是映射".to_string())?;

    // walk/create llm-pi-ai → providers
    let section = root
        .entry(serde_yaml::Value::String("llm-pi-ai".into()))
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    let section = section
        .as_mapping_mut()
        .ok_or_else(|| "settings.yaml 的 llm-pi-ai 不是映射".to_string())?;
    let providers = section
        .entry(serde_yaml::Value::String("providers".into()))
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    let providers = providers
        .as_mapping_mut()
        .ok_or_else(|| "settings.yaml 的 llm-pi-ai.providers 不是映射".to_string())?;

    // 1. identify duplicate hand-declared routes (token-plan host, not a
    //    catalog route id) and collect their model entries for the merge
    let mut folded: Vec<(String, Vec<serde_yaml::Value>)> = Vec::new();
    let mut all_ids: Vec<String> = Vec::new();
    let duplicate_ids: Vec<String> = providers
        .iter()
        .filter_map(|(id_value, cfg_value)| {
            let id = id_value.as_str()?;
            if BAILIAN_CATALOG_ROUTE_IDS.contains(&id) {
                return None;
            }
            let host = cfg_value
                .as_mapping()?
                .get(serde_yaml::Value::String("baseURL".into()))?
                .as_str()
                .and_then(host_of)?;
            if !BAILIAN_TOKEN_PLAN_HOSTS.contains(&host.to_ascii_lowercase().as_str()) {
                return None;
            }
            let entries = cfg_value
                .as_mapping()
                .and_then(|cfg| cfg.get(serde_yaml::Value::String("models".into())))
                .and_then(|v| v.as_sequence())
                .cloned()
                .unwrap_or_default();
            let mut ids = Vec::new();
            for entry in &entries {
                if let Some(mid) = entry
                    .as_mapping()
                    .and_then(|m| m.get(serde_yaml::Value::String("id".into())))
                    .and_then(|v| v.as_str())
                {
                    ids.push(mid.to_string());
                }
            }
            folded.push((id.to_string(), entries));
            all_ids.extend(ids);
            Some(id.to_string())
        })
        .collect();

    // 2. ensure the catalog route exists (create the minimal profile when not)
    let entry_key = serde_yaml::Value::String(BAILIAN_PROVIDER_ID.into());
    let existed = providers.contains_key(&entry_key);
    if !existed {
        let mut entry = serde_yaml::Mapping::new();
        entry.insert(
            serde_yaml::Value::String("displayName".into()),
            serde_yaml::Value::String("阿里云百炼".into()),
        );
        entry.insert(
            serde_yaml::Value::String("apiKeyEnv".into()),
            serde_yaml::Value::String(BAILIAN_KEY_ENV.into()),
        );
        entry.insert(
            serde_yaml::Value::String("baseURL".into()),
            serde_yaml::Value::String(BAILIAN_BASE_URL.into()),
        );
        providers.insert(entry_key.clone(), serde_yaml::Value::Mapping(entry));
    } else {
        // an existing catalog route may omit baseURL (pure catalog profile);
        // fill it so the desktop's provider panel can discover the platform
        if let Some(entry) = providers
            .get_mut(&entry_key)
            .and_then(|v| v.as_mapping_mut())
        {
            entry
                .entry(serde_yaml::Value::String("baseURL".into()))
                .or_insert_with(|| serde_yaml::Value::String(BAILIAN_BASE_URL.into()));
        }
    }

    // 3. merge the folded routes' models onto the catalog route (existing
    //    entries win on id collisions; order is preserved)
    let mut merged_models = Vec::new();
    if !folded.is_empty() {
        let entry = providers
            .get_mut(&entry_key)
            .and_then(|v| v.as_mapping_mut())
            .ok_or_else(|| "settings.yaml 的 qwen-token-plan-cn 条目不是映射".to_string())?;
        let models = entry
            .entry(serde_yaml::Value::String("models".into()))
            .or_insert_with(|| serde_yaml::Value::Sequence(Vec::new()));
        let models = models
            .as_sequence_mut()
            .ok_or_else(|| "settings.yaml 的 qwen-token-plan-cn.models 不是列表".to_string())?;
        let mut known: Vec<String> = models
            .iter()
            .filter_map(|m| {
                m.as_mapping()
                    .and_then(|mm| mm.get(serde_yaml::Value::String("id".into())))
                    .and_then(|v| v.as_str())
                    .map(String::from)
            })
            .collect();
        for (_, entries) in folded {
            for entry in entries {
                let mid = entry
                    .as_mapping()
                    .and_then(|mm| mm.get(serde_yaml::Value::String("id".into())))
                    .and_then(|v| v.as_str())
                    .map(String::from);
                match mid {
                    Some(id) if !known.contains(&id) => {
                        known.push(id.clone());
                        merged_models.push(id);
                        models.push(entry);
                    }
                    _ => {}
                }
            }
        }
    }

    // 4. drop the folded twin routes
    providers.retain(|id_value, _| {
        let id = id_value.as_str().unwrap_or_default();
        !duplicate_ids.iter().any(|d| d == id)
    });

    if let Some(parent) = settings_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let out = serde_yaml::to_string(&doc).map_err(|e| format!("序列化 settings.yaml 失败: {e}"))?;
    fs::write(settings_path, out).map_err(|e| format!("写入 settings.yaml 失败: {e}"))?;
    Ok(BailianEnsureOutcome {
        existed,
        removed: duplicate_ids,
        merged_models,
    })
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
    let env_base = std::env::var("DEEPSEEK_BASE_URL")
        .ok()
        .filter(|v| !v.is_empty());
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
            let Some(id) = id_value.as_str() else {
                continue;
            };
            let Some(cfg) = cfg_value.as_mapping() else {
                continue;
            };
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
            let api = cfg.get("api").and_then(|v| v.as_str()).unwrap_or_default();
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
    // Volcengine (火山方舟/豆包) speaks the openai wire protocol, but its Ark
    // API key cannot query billing — balance lives behind the signed OpenAPI
    // (open.volcengineapi.com). Route its hosts before the generic openai
    // fallback so they never hit the (absent) dashboard billing endpoints.
    if host.contains("volces") || host.contains("volcengine") {
        return Adapter::Volcengine;
    }
    // Hosts without any key-accessible balance/billing endpoint must be
    // recognized before the wire-protocol hint: Alibaba Cloud's compatible
    // mode speaks the openai protocol yet serves no billing endpoints, and
    // the same applies to other hosted platforms whose protocol name alone
    // would otherwise route them into a probe that 404s every refresh.
    const UNSUPPORTED_MARKERS: [&str; 10] = [
        "aliyuncs",
        "anthropic",
        "google",
        "gemini",
        "vertex",
        "bedrock",
        "mistral",
        "azure",
        "xai",
        "grok",
    ];
    if UNSUPPORTED_MARKERS.iter().any(|m| host.contains(m)) {
        return Adapter::Unsupported;
    }
    if api.contains("openai") || host.contains("openai") {
        return Adapter::OpenAIBilling;
    }
    if UNSUPPORTED_MARKERS.iter().any(|m| api.contains(m)) {
        return Adapter::Unsupported;
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
        return Err(format!(
            "找不到内置 Node 运行时: {}",
            paths.node_exe.display()
        ));
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
        // The desktop shell loads the web UI in its own Tauri WebView. The
        // upstream web profile defaults to opening the system browser, which
        // would otherwise launch a second window on every desktop startup.
        .arg("--no-open")
        .arg("--port")
        .arg(dsh_port(config).to_string());
    // Always pass the resolved home explicitly (default = ~/.dsh, shares CLI
    // sessions). Plugin-network settings are injected into DSH's environment:
    // dshmarket's Desktop runtime delegates to the packaged pnpm process, so
    // this is the one durable boundary that covers both its catalog fetch and
    // later package downloads.
    cmd.env("DSH_HOME", &paths.dsh_home);
    if let Some(proxy) = config.plugin_network_proxy.as_deref() {
        cmd.env("HTTP_PROXY", proxy)
            .env("HTTPS_PROXY", proxy)
            .env("http_proxy", proxy)
            .env("https_proxy", proxy);
    }
    if let Some(registry) = config.plugin_npm_registry.as_deref() {
        cmd.env("npm_config_registry", registry)
            .env("NPM_CONFIG_REGISTRY", registry);
    }
    cmd.env(
        "DSH_MARKET_INSTALL_TIMEOUT_MS",
        (u64::from(config.plugin_install_timeout_minutes.clamp(10, 60)) * 60 * 1000).to_string(),
    );
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

// ---------------------------------------------------------------------------
// relay-client companion process
// ---------------------------------------------------------------------------

/// Entry script of the bundled relay-client (deployed into the runtime tree by
/// `ensure_runtime_files`).
fn relay_client_entry(paths: &Paths) -> PathBuf {
    paths.runtime_dir.join("relay-client").join("index.js")
}

/// The public default relay operated by the author. Used out of the box so the
/// user never has to fill in a relay address; overridden only when they check
/// "自定义中继服务器" in the remote-access settings and save their own URL.
const DEFAULT_RELAY_URL: &str = "wss://remote.anixuil.com";

/// The relay URL actually in use: the user's custom URL when one is stored,
/// otherwise the public default relay.
fn effective_relay_url(config: &AppConfig) -> Option<String> {
    match config.remote_relay_url.as_deref() {
        Some(url) if !url.trim().is_empty() => Some(url.trim().to_string()),
        _ => Some(DEFAULT_RELAY_URL.to_string()),
    }
}

/// Whether the user has configured a custom relay URL (vs. using the default).
fn custom_relay_set(config: &AppConfig) -> bool {
    config
        .remote_relay_url
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
}

/// The phone entry URL when remote access is fully configured.
fn remote_entry_url(config: &AppConfig) -> Option<String> {
    let url = effective_relay_url(config)?;
    let device = config.remote_device_id.as_deref()?;
    if device.is_empty() {
        return None;
    }
    let host = url
        .strip_prefix("wss://")
        .or_else(|| url.strip_prefix("ws://"))
        .unwrap_or(url.as_str())
        .split(['/', ':', '?'])
        .next()
        .unwrap_or("");
    if host.is_empty() {
        return None;
    }
    Some(format!("https://{device}.{host}/"))
}

/// Start (or restart) the relay-client with the current remote config.
/// The relay's HTTP API base for a wss:// relay url (wss -> https).
fn relay_http_url(config: &AppConfig) -> Option<String> {
    let url = effective_relay_url(config)?;
    let https = url
        .strip_prefix("wss://")
        .or_else(|| url.strip_prefix("ws://"))
        .unwrap_or(url.as_str());
    let base = https.split(['/', '?']).next().unwrap_or("").trim();
    if base.is_empty() {
        return None;
    }
    Some(format!("https://{base}"))
}

/// Ensure this device is registered with the relay, returning the device
/// secret to authenticate with. Registers on first call and reuses the
/// persisted secret afterwards. `remote_secret` (legacy admin key) takes
/// precedence when set, keeping prototype deployments working.
async fn ensure_device_registered(
    app: &AppHandle,
    config: &AppConfig,
    paths: &Paths,
) -> Result<Option<String>, String> {
    if config
        .remote_secret
        .as_deref()
        .is_some_and(|s| !s.is_empty())
    {
        return Ok(config.remote_secret.clone());
    }
    if let Some(secret) = config.remote_device_secret.as_deref() {
        if !secret.is_empty() {
            return Ok(Some(secret.to_string()));
        }
    }
    let Some(http_url) = relay_http_url(config) else {
        return Ok(None);
    };
    let device_id = config.remote_device_id.as_deref().unwrap_or("my-pc");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{http_url}/register"))
        .json(&serde_json::json!({ "deviceId": device_id }))
        .send()
        .await
        .map_err(|e| format!("无法连接中继服务器: {e}"))?;
    if resp.status() == 409 {
        return Err(format!(
            "设备名 {device_id} 正被另一台在线客户端使用，请稍后重试或确认旧客户端已退出（设置 → 远程访问）"
        ));
    }
    if !resp.status().is_success() {
        return Err(format!("设备注册失败：中继返回 HTTP {}", resp.status()));
    }
    let payload = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("设备注册响应无法解析: {e}"))?;
    let secret = payload
        .get("deviceSecret")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "设备注册响应缺少 deviceSecret".to_string())?
        .to_string();
    {
        let mut config2 = state_config(app);
        config2.remote_device_secret = Some(secret.clone());
        save_config(&paths.config_file, &config2);
        state_set_config(app, config2);
    }
    log_line(
        &paths.log_file,
        &format!("relay device registered: {device_id}"),
    );
    Ok(Some(secret))
}

/// Synchronize the optional user-defined long-lived pairing code with the
/// relay. The relay persists only a hash; the desktop snapshot never returns
/// the plaintext code.
async fn sync_persistent_pairing_code(config: &AppConfig, code: &str) -> Result<(), String> {
    let Some(http_url) = relay_http_url(config) else {
        return Err("中继地址无效".to_string());
    };
    let device_id = config.remote_device_id.as_deref().unwrap_or("my-pc");
    let secret = config
        .remote_device_secret
        .as_deref()
        .filter(|s| !s.is_empty())
        .or(config.remote_secret.as_deref())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "设备未注册".to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{http_url}/persistent-pairing"))
        .bearer_auth(secret)
        .json(&serde_json::json!({ "deviceId": device_id, "code": code }))
        .send()
        .await
        .map_err(|e| format!("无法连接中继服务器: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let detail = resp
            .text()
            .await
            .ok()
            .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
            .and_then(|body| {
                body.get("error")
                    .and_then(|value| value.as_str())
                    .map(str::to_string)
            });
        if status == reqwest::StatusCode::NOT_FOUND {
            return Err(
                "当前中继服务器版本不支持长期配对码（HTTP 404）。请将中继升级到包含 /persistent-pairing 接口的最新版本后重试。"
                    .to_string(),
            );
        }
        let suffix = detail
            .map(|message| format!("：{message}"))
            .unwrap_or_default();
        return Err(format!(
            "保存长期配对码失败：中继返回 HTTP {status}{suffix}"
        ));
    }
    Ok(())
}

fn state_config(app: &AppHandle) -> AppConfig {
    app.state::<AppState>().config.lock().unwrap().clone()
}

fn state_set_config(app: &AppHandle, config: AppConfig) {
    *app.state::<AppState>().config.lock().unwrap() = config;
}

/// No-op with a log line when remote access is disabled or under-configured.
fn spawn_relay_client(app: &AppHandle, paths: &Paths, config: &AppConfig) {
    let state = app.state::<AppState>();
    // Stop any previous instance first (config change / boot refresh).
    if let Some(mut child) = state.relay.lock().unwrap().child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    state.remote_online.store(false, Ordering::SeqCst);
    if !config.remote_enabled {
        log_line(
            &paths.log_file,
            "remote access disabled — relay-client not started",
        );
        return;
    }
    let Some(relay_url) = effective_relay_url(config) else {
        log_line(
            &paths.log_file,
            "remote access enabled but relay url missing — relay-client not started",
        );
        return;
    };
    // Product flow authenticates with the device secret; the legacy admin key
    // is accepted as a fallback for prototype deployments.
    let secret = config
        .remote_device_secret
        .as_deref()
        .filter(|s| !s.is_empty())
        .or(config.remote_secret.as_deref())
        .filter(|s| !s.is_empty());
    let Some(secret) = secret else {
        log_line(&paths.log_file, "remote access enabled but no device secret — save the remote config first (auto-registration)");
        return;
    };
    let device_id = config.remote_device_id.as_deref().unwrap_or("my-pc");
    if device_id.is_empty() {
        log_line(
            &paths.log_file,
            "remote access enabled but device id empty — relay-client not started",
        );
        return;
    }
    let entry = relay_client_entry(paths);
    if !entry.exists() {
        log_line(
            &paths.log_file,
            &format!("relay-client entry missing: {}", entry.display()),
        );
        return;
    }
    let mut cmd = Command::new(&paths.node_exe);
    cmd.arg(&entry)
        .env("RELAY_URL", &relay_url)
        .env("RELAY_SECRET", secret)
        .env("DEVICE_ID", device_id)
        .env("LOCAL_PORT", dsh_port(config).to_string())
        .env(
            "RELAY_MAX_CONCURRENT_VIEWERS",
            config.remote_max_concurrent.max(1).min(64).to_string(),
        )
        .env("STATUS_PORT", RELAY_CLIENT_STATUS_PORT.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    match cmd.spawn() {
        Ok(mut child) => {
            let log = paths.log_file.clone();
            if let Some(stdout) = child.stdout.take() {
                let log2 = log.clone();
                thread::spawn(move || pipe_to_log(stdout, &log2));
            }
            if let Some(stderr) = child.stderr.take() {
                thread::spawn(move || pipe_to_log(stderr, &log));
            }
            log_line(
                &paths.log_file,
                &format!("relay-client spawned (device {device_id} -> {relay_url})"),
            );
            state.relay.lock().unwrap().child = Some(child);
        }
        Err(e) => log_line(&paths.log_file, &format!("relay-client spawn failed: {e}")),
    }
}

/// Probe the relay-client status endpoint; returns (running, online).
async fn probe_relay_status() -> (bool, bool) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_millis(800))
        .build()
    {
        Ok(c) => c,
        Err(_) => return (false, false),
    };
    let url = format!("http://127.0.0.1:{RELAY_CLIENT_STATUS_PORT}/ping");
    let res = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => return (false, false),
    };
    if !res.status().is_success() {
        return (true, false);
    }
    let online = res
        .json::<serde_json::Value>()
        .await
        .ok()
        .and_then(|v| v.get("online").and_then(|v| v.as_bool()))
        .unwrap_or(false);
    (true, online)
}

/// Boot-time hook: start the relay-client when remote access is enabled.
fn ensure_relay_client(app: &AppHandle, paths: &Paths, config: &AppConfig) {
    if config.remote_enabled {
        spawn_relay_client(app, paths, config);
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
        if state.startup_pending.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }
        // 1. probe health first: adoption decisions must not restart a child
        //    into a port that another instance already serves. Probing no
        //    longer waits for first-run extraction (runtime_ready): when an
        //    instance already serves the port (e.g. a CLI `dsh web` sharing
        //    the same home), the UI becomes ready while extraction continues
        //    in the background.
        let healthy = client
            .get(&url)
            .send()
            .await
            .map(|r| r.status().is_success() || r.status().is_server_error())
            .unwrap_or(false);

        if healthy {
            if !state.ui_ready.swap(true, Ordering::SeqCst) {
                // Boot-timing diagnostic: log how long after spawn the port
                // answered (None = adopted an already-running instance).
                let elapsed = state
                    .spawned_at
                    .lock()
                    .unwrap()
                    .map(|t| format!(" ({:.1}s after spawn)", t.elapsed().as_secs_f64()))
                    .unwrap_or_default();
                let paths = {
                    let config = state.config.lock().unwrap().clone();
                    resolve_paths(&app, &config)
                };
                log_line(&paths.log_file, &format!("dsh web ready{elapsed}"));
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
        } else if !state.runtime_ready.load(Ordering::SeqCst) {
            // First-run extraction is still in progress and nothing serves the
            // port yet — keep probing without burning the boot timeout on the
            // extraction phase.
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
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

        // 2. restart/recovery policy: if our child exited, either adopt the
        //    server that is already answering (port busy) or restart — never
        //    churn three restarts into an occupied port. When no child exists
        //    at all and the port is dead (spawn failed at bootstrap, or an
        //    adopted instance went away), respawn from here so the desktop
        //    always recovers its service.
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
                                Ok(c) => {
                                    state.adopted.store(false, Ordering::SeqCst);
                                    *state.spawned_at.lock().unwrap() = Some(Instant::now());
                                    dsh.child = Some(c);
                                }
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
            } else if !healthy && dsh.restarts < 3 {
                dsh.restarts += 1;
                log_line(
                    &paths.log_file,
                    &format!("respawn dsh (attempt {})", dsh.restarts),
                );
                let config = state.config.lock().unwrap().clone();
                match spawn_dsh(&paths, &config) {
                    Ok(c) => {
                        state.adopted.store(false, Ordering::SeqCst);
                        *state.spawned_at.lock().unwrap() = Some(Instant::now());
                        dsh.child = Some(c);
                    }
                    Err(e) => log_line(&paths.log_file, &format!("respawn failed: {e}")),
                }
            }
        }

        // 3. relay-client recovery: the companion is monitored like the dsh
        //    child. When it exits, clear the stale handle so get_remote_config
        //    reports an accurate "客户端未运行" (a dead process otherwise leaves
        //    `child.is_some()` true forever and the status never recovers until
        //    the user re-saves settings). When remote access is still enabled,
        //    respawn it (throttled) instead of leaving the device offline.
        {
            let config = state.config.lock().unwrap().clone();
            let paths = resolve_paths(&app, &config);
            let need_child = {
                let mut relay = state.relay.lock().unwrap();
                if let Some(child) = relay.child.as_mut() {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            log_line(&paths.log_file, &format!("relay-client exited: {status:?}"));
                            relay.child = None;
                        }
                        Ok(None) => {}
                        Err(_) => {}
                    }
                }
                relay.child.is_none()
            };
            if need_child && config.remote_enabled {
                let respawn_due = match *state.relay_respawn_at.lock().unwrap() {
                    Some(at) => at <= Instant::now(),
                    None => true,
                };
                if respawn_due {
                    *state.relay_respawn_at.lock().unwrap() =
                        Some(Instant::now() + Duration::from_secs(10));
                    spawn_relay_client(&app, &paths, &config);
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

/// Query the generic usage contract used by many OpenAI-compatible gateways:
/// `GET {base}/v1/usage` with bearer authentication. Providers commonly keep
/// `/v1` in their configured base URL, so normalize the final path to avoid
/// issuing `/v1/v1/usage`.
async fn fetch_generic_usage(base: &str, key: &str) -> Result<ProviderUsage, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP 客户端失败: {e}"))?;
    let base = base.trim_end_matches('/');
    let usage_url = if base.ends_with("/v1") {
        format!("{base}/usage")
    } else {
        format!("{base}/v1/usage")
    };
    let response = client
        .get(&usage_url)
        .header("Authorization", format!("Bearer {key}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("网络错误: {e}"))?;
    let status = response.status().as_u16();
    if status == 401 || status == 403 {
        return Err("API Key 无效（鉴权失败），请检查 Key".to_string());
    }
    if status != 200 {
        return Err(format!("通用用量接口返回状态码 {status}"));
    }
    let value = response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("解析通用用量响应失败: {e}"))?;
    parse_generic_usage(&value)
}

/// Apply the generic usage extractor contract to a decoded API response.
fn parse_generic_usage(value: &serde_json::Value) -> Result<ProviderUsage, String> {
    let number_at = |path: &str| {
        value.pointer(path).and_then(|v| match v {
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::String(s) => s.parse::<f64>().ok(),
            _ => None,
        })
    };
    let string_at = |path: &str| {
        value
            .pointer(path)
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    Ok(ProviderUsage {
        remaining: number_at("/remaining")
            .or_else(|| number_at("/quota/remaining"))
            .or_else(|| number_at("/balance")),
        unit: string_at("/unit")
            .or_else(|| string_at("/quota/unit"))
            .or_else(|| Some("USD".to_string())),
        is_valid: value
            .get("is_active")
            .and_then(|v| v.as_bool())
            .or_else(|| value.get("isValid").and_then(|v| v.as_bool()))
            .or(Some(true)),
        total_usage_usd: None,
        soft_limit_usd: None,
        hard_limit_usd: None,
        has_payment_method: None,
    })
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
        remaining: None,
        unit: None,
        is_valid: Some(true),
        total_usage_usd: usage.total_usage,
        soft_limit_usd: sub.as_ref().and_then(|s| s.soft_limit_usd),
        hard_limit_usd: sub.as_ref().and_then(|s| s.hard_limit_usd),
        has_payment_method: sub.as_ref().and_then(|s| s.has_payment_method),
    })
}

// ---------------------------------------------------------------------------
// Volcengine (火山引擎) account balance via the signed OpenAPI
// ---------------------------------------------------------------------------

/// Volcengine isn't billed through the Ark API key: the account balance comes
/// from the 费用中心 (Billing Center) OpenAPI `billing.QueryBalanceAcct`, which
/// authenticates with the account AccessKey/SecretKey + HMAC-SHA256 signing.
/// The credentials are account-level (shared by all volcengine providers), so
/// a single pair is read per refresh, not per provider.
#[derive(Clone, Default)]
struct VolcCredentials {
    access_key: Option<String>,
    secret_key: Option<String>,
}

/// Read the volcengine account AccessKey/SecretKey. Accepts both the `VOLC_*`
/// and the longer `VOLCENGINE_*` spellings (env var or `.credentials.yaml`).
fn volc_credentials(paths: &Paths) -> VolcCredentials {
    let access_key = read_credential(paths, "VOLC_ACCESS_KEY")
        .or_else(|| read_credential(paths, "VOLCENGINE_ACCESS_KEY"));
    let secret_key = read_credential(paths, "VOLC_SECRET_KEY")
        .or_else(|| read_credential(paths, "VOLCENGINE_SECRET_KEY"));
    VolcCredentials {
        access_key,
        secret_key,
    }
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

/// HMAC-SHA256 (RFC 2104), inlined instead of pulling the `hmac` crate so the
/// Volcengine signer adds no new crate downloads beyond the already-vendored
/// `sha2`/`hex`.
fn hmac_sha256(key: &[u8], msg: &[u8]) -> Vec<u8> {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        let d = Sha256::digest(key);
        k[..d.len()].copy_from_slice(&d);
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let d1 = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(d1);
    outer.finalize().to_vec()
}

const UNSUPPORTED_NOTE: &str = "该平台未提供可通过 API Key 查询的余额/账单接口";

/// Extract a possibly-string / possibly-number balance field from the OpenAPI
/// `Result` object, tolerant to the casing the SDK returns.
fn volc_field(result: &serde_json::Value, names: &[&str]) -> Option<String> {
    for name in names {
        if let Some(value) = result.get(name) {
            return match value {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Number(n) => Some(n.to_string()),
                _ => None,
            };
        }
    }
    None
}

fn volc_number(result: &serde_json::Value, names: &[&str]) -> Option<f64> {
    volc_field(result, names).and_then(|value| value.parse::<f64>().ok())
}

fn volc_result<'a>(value: &'a serde_json::Value, action: &str) -> Result<&'a serde_json::Value, String> {
    if let Some(error) = value.pointer("/ResponseMetadata/Error") {
        let code = error.get("Code").and_then(|value| value.as_str()).unwrap_or("UnknownError");
        let message = error
            .get("Message")
            .and_then(|value| value.as_str())
            .unwrap_or("火山引擎未返回错误详情");
        return Err(format!("火山引擎 {action} 失败: {code}: {message}"));
    }
    value
        .get("Result")
        .or_else(|| value.get("result"))
        .ok_or_else(|| format!("火山引擎 {action} 未返回 Result"))
}

/// Map a `billing.QueryBalanceAcct` response into the DeepSeek-schema
/// `Balance` the panel/badge already render. Missing amounts fall back to
/// "0.00"; OpenAPI errors are surfaced separately by the shared billing caller.
fn parse_volc_balance(text: &str) -> Result<Balance, String> {
    let v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("解析火山引擎余额响应失败: {e}"))?;
    let result = volc_result(&v, "QueryBalanceAcct")?;
    let available = volc_field(
        result,
        &["AvailableBalance", "availableBalance", "available_balance"],
    )
    .unwrap_or_else(|| "0.00".to_string());
    let cash = volc_field(result, &["CashBalance", "cashBalance", "cash_balance"])
        .unwrap_or_else(|| available.clone());
    Ok(Balance {
        is_available: true,
        balance_infos: vec![BalanceInfo {
            currency: "CNY".to_string(),
            total_balance: available,
            granted_balance: "0.00".to_string(),
            topped_up_balance: cash,
        }],
    })
}

/// Execute one signed Volcengine OpenAPI action. Billing and Ark use the same
/// account AK/SK signing algorithm, but have different service scopes,
/// versions, query parameters, and signed-header order.
async fn fetch_volcengine_openapi_request(
    volc: &VolcCredentials,
    action: &str,
    service: &str,
    version: &str,
    region: &str,
    include_region: bool,
    body: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let (Some(access_key), Some(secret_key)) = (&volc.access_key, &volc.secret_key) else {
        return Err(format!(
            "{UNSUPPORTED_NOTE}（请在设置 → 模型中打开火山引擎提供方，配置账户 AccessKey ID 和 Secret Access Key；它们与 Ark API Key 不同）"
        ));
    };

    let host = "open.volcengineapi.com";
    let body = body
        .map(serde_json::to_string)
        .transpose()
        .map_err(|e| format!("序列化火山引擎请求失败: {e}"))?
        .unwrap_or_default();

    let now = chrono::Utc::now();
    let date_short = now.format("%Y%m%d").to_string();
    let date_long = now.format("%Y%m%dT%H%M%SZ").to_string();
    let payload_hash = sha256_hex(body.as_bytes());

    // Canonical request (the query parameters are part of the signed scope).
    let canonical_query = if include_region {
        format!("Action={action}&Region={region}&Version={version}")
    } else {
        format!("Action={action}&Version={version}")
    };
    let (signed_headers, canonical_headers) = if service == "ark" {
        (
            "host;x-date;x-content-sha256;content-type",
            format!(
                "host:{host}\nx-date:{date_long}\nx-content-sha256:{payload_hash}\ncontent-type:application/json\n"
            ),
        )
    } else {
        (
            "content-type;host;x-content-sha256;x-date",
            format!(
                "content-type:application/json\nhost:{host}\nx-content-sha256:{payload_hash}\nx-date:{date_long}\n"
            ),
        )
    };
    let canonical_request = format!(
        "POST\n/\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );

    let scope = format!("{date_short}/{region}/{service}/request");
    let string_to_sign = format!(
        "HMAC-SHA256\n{date_long}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac_sha256(secret_key.as_bytes(), date_short.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, service.as_bytes());
    let k_signing = hmac_sha256(&k_service, b"request");
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));
    let authorization = format!(
        "HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP 客户端失败: {e}"))?;
    let resp = client
        .post(format!("https://{host}/?{canonical_query}"))
        .header("Host", host)
        .header("Content-Type", "application/json")
        .header("X-Date", &date_long)
        .header("X-Content-Sha256", &payload_hash)
        .header("Authorization", &authorization)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("网络错误: {e}"))?;

    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let value = serde_json::from_str::<serde_json::Value>(&text)
        .map_err(|e| format!("解析火山引擎 {action} 响应失败: {e}"))?;
    if status != 200 {
        if let Some(message) = value
            .pointer("/ResponseMetadata/Error/Message")
            .and_then(|value| value.as_str())
        {
            return Err(format!("火山引擎 {action} 返回状态码 {status}: {message}"));
        }
        return Err(format!("火山引擎 {action} 返回状态码 {status}"));
    }
    // Volcengine may return HTTP 200 with a structured OpenAPI error.
    let _ = volc_result(&value, action)?;
    Ok(value)
}

/// Billing Center operations use a JSON body and do not include Region in
/// the canonical query.
async fn fetch_volcengine_openapi(
    volc: &VolcCredentials,
    action: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let region = std::env::var("VOLC_REGION")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "cn-beijing".to_string());
    fetch_volcengine_openapi_request(
        volc,
        action,
        "billing",
        "2022-01-01",
        &region,
        false,
        Some(body),
    )
    .await
}

/// Ark Agent/Coding Plan usage operations use an empty body and sign Region
/// as part of the query. This is the control-plane API used by CC Switch.
async fn fetch_volcengine_ark_usage(
    volc: &VolcCredentials,
    action: &str,
    region: &str,
) -> Result<serde_json::Value, String> {
    fetch_volcengine_openapi_request(
        volc,
        action,
        "ark",
        "2024-01-01",
        region,
        true,
        None,
    )
    .await
}

fn parse_volc_plans(value: &serde_json::Value) -> Result<Vec<ProviderPlan>, String> {
    let result = volc_result(value, "ListResourcePackages")?;
    let rows = result
        .get("List")
        .or_else(|| result.get("list"))
        .and_then(|value| value.as_array())
        .ok_or_else(|| "火山引擎资源包接口未返回 List".to_string())?;
    let mut plans = rows
        .iter()
        .map(|row| {
            let id = volc_field(row, &["InstanceNo", "instanceNo", "instance_no"])
                .unwrap_or_else(|| "unknown".to_string());
            let name = volc_field(
                row,
                &["ConfigurationName", "configurationName", "InstanceName", "instanceName"],
            )
            .or_else(|| volc_field(row, &["ProductName", "productName"]))
            .unwrap_or_else(|| "资源包".to_string());
            let product = volc_field(row, &["ProductName", "productName"])
                .or_else(|| volc_field(row, &["Product", "product"]));
            let total = volc_number(row, &["TotalAmount", "totalAmount", "total_amount"]);
            let remaining = volc_number(
                row,
                &["AvailableAmount", "availableAmount", "available_amount"],
            );
            ProviderPlan {
                id,
                name,
                product,
                total,
                used: total.zip(remaining).map(|(total, remaining)| (total - remaining).max(0.0)),
                remaining,
                unit: volc_field(row, &["Unit", "unit", "SpecificationUnit", "specificationUnit"]),
                status: volc_field(row, &["Status", "status"]),
                effective_at: volc_field(row, &["EffectiveTime", "effectiveTime"]),
                expires_at: volc_field(row, &["ExpiryTime", "expiryTime"]),
                period_usage: None,
                period_start: None,
                period_end: None,
            }
        })
        .collect::<Vec<_>>();
    plans.sort_by(|left, right| left.expires_at.cmp(&right.expires_at));
    Ok(plans)
}

fn volc_next_token(value: &serde_json::Value, action: &str) -> Option<String> {
    let result = volc_result(value, action).ok()?;
    volc_field(result, &["NextToken", "nextToken", "next_token"])
        .filter(|token| !token.is_empty())
}

fn collect_volc_usage_details(
    value: &serde_json::Value,
    totals: &mut HashMap<String, f64>,
) -> Result<(), String> {
    let result = volc_result(value, "ListPackageUsageDetails")?;
    let rows = result
        .get("List")
        .or_else(|| result.get("list"))
        .and_then(|value| value.as_array())
        .ok_or_else(|| "火山引擎资源包用量接口未返回 List".to_string())?;
    for row in rows {
        let Some(id) = volc_field(row, &["InstanceNo", "instanceNo", "instance_no"]) else {
            continue;
        };
        if let Some(amount) = volc_number(
            row,
            &["DeductionAmount", "deductionAmount", "deduction_amount"],
        ) {
            *totals.entry(id).or_default() += amount;
        }
    }
    Ok(())
}

async fn fetch_volcengine_plans(volc: &VolcCredentials) -> Result<Vec<ProviderPlan>, String> {
    let mut plans = Vec::new();
    let mut next_token = String::new();
    for _ in 0..5 {
        let value = fetch_volcengine_openapi(
            volc,
            "ListResourcePackages",
            &serde_json::json!({
                "ResourceType": "Package",
                "MaxResults": "20",
                "NextToken": next_token,
            }),
        )
        .await?;
        plans.extend(parse_volc_plans(&value)?);
        let Some(next) = volc_next_token(&value, "ListResourcePackages") else {
            break;
        };
        if next == next_token {
            break;
        }
        next_token = next;
    }
    Ok(plans)
}

async fn attach_volcengine_period_usage(
    volc: &VolcCredentials,
    plans: &mut [ProviderPlan],
) -> Result<(), String> {
    if plans.is_empty() {
        return Ok(());
    }
    let period_end = chrono::Utc::now();
    let period_start = period_end - chrono::Duration::days(30);
    let period_start_text = period_start.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let period_end_text = period_end.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let mut next_token = String::new();
    let mut totals = HashMap::<String, f64>::new();
    for _ in 0..5 {
        let value = fetch_volcengine_openapi(
            volc,
            "ListPackageUsageDetails",
            &serde_json::json!({
                "ResourceType": "Package",
                "DeductBeginTime": period_start_text,
                "DeductEndTime": period_end_text,
                "MaxResults": "50",
                "NextToken": next_token,
            }),
        )
        .await?;
        collect_volc_usage_details(&value, &mut totals)?;
        let Some(next) = volc_next_token(&value, "ListPackageUsageDetails") else {
            break;
        };
        if next == next_token {
            break;
        }
        next_token = next;
    }
    for plan in plans {
        plan.period_usage = Some(totals.get(&plan.id).copied().unwrap_or(0.0));
        plan.period_start = Some(period_start_text.clone());
        plan.period_end = Some(period_end_text.clone());
    }
    Ok(())
}

fn volcengine_region(base: &str) -> String {
    base.split(['.', '/'])
        .find(|part| part.starts_with("cn-") && part.len() > 3)
        .map(str::to_string)
        .or_else(|| std::env::var("VOLC_REGION").ok().filter(|value| !value.is_empty()))
        .unwrap_or_else(|| "cn-beijing".to_string())
}

fn volc_reset_time(value: Option<&serde_json::Value>) -> Option<String> {
    let timestamp = value.and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|text| text.parse::<i64>().ok()))
    })?;
    if timestamp <= 0 {
        return None;
    }
    let seconds = if timestamp >= 1_000_000_000_000 {
        timestamp / 1000
    } else {
        timestamp
    };
    chrono::DateTime::from_timestamp(seconds, 0).map(|time| time.to_rfc3339())
}

fn volc_quota_plan(
    source: &str,
    level: &str,
    percent: f64,
    reset_at: Option<String>,
    status: Option<String>,
    product: &str,
) -> ProviderPlan {
    let name = match level {
        "session" => "5 小时额度",
        "weekly" => "7 天额度",
        "monthly" => "每月额度",
        _ => level,
    };
    let used = percent.clamp(0.0, 100.0);
    ProviderPlan {
        id: format!("volc-{source}-{level}"),
        name: name.to_string(),
        product: Some(product.to_string()),
        total: Some(100.0),
        used: Some(used),
        remaining: Some((100.0 - used).max(0.0)),
        unit: Some("%".to_string()),
        status,
        effective_at: None,
        expires_at: reset_at,
        period_usage: None,
        period_start: None,
        period_end: None,
    }
}

fn parse_volc_coding_plan(value: &serde_json::Value) -> Result<Vec<ProviderPlan>, String> {
    let result = volc_result(value, "GetCodingPlanUsage")?;
    let status = volc_field(result, &["Status", "status"]);
    let rows = result
        .get("QuotaUsage")
        .or_else(|| result.get("quotaUsage"))
        .and_then(|value| value.as_array())
        .ok_or_else(|| "火山方舟 Coding Plan 未返回 QuotaUsage".to_string())?;
    let mut plans = Vec::new();
    for row in rows {
        let level = row
            .get("Level")
            .or_else(|| row.get("level"))
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if !matches!(level, "session" | "weekly" | "monthly") {
            continue;
        }
        let Some(percent) = volc_number(row, &["Percent", "percent"]) else {
            continue;
        };
        plans.push(volc_quota_plan(
            "coding",
            level,
            percent,
            volc_reset_time(row.get("ResetTimestamp").or_else(|| row.get("resetTimestamp"))),
            status.clone(),
            "方舟 Coding Plan",
        ));
    }
    Ok(plans)
}

fn parse_volc_afp_plan(value: &serde_json::Value) -> Result<Vec<ProviderPlan>, String> {
    let result = volc_result(value, "GetAFPUsage")?;
    let plan_type = volc_field(result, &["PlanType", "planType"])
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "方舟 Agent Plan".to_string());
    let windows = [
        ("session", "AFPFiveHour"),
        ("weekly", "AFPWeekly"),
        ("monthly", "AFPMonthly"),
    ];
    let mut plans = Vec::new();
    for (level, field) in windows {
        let Some(window) = result.get(field) else {
            continue;
        };
        let quota = volc_number(window, &["Quota", "quota"]).unwrap_or(0.0);
        if quota <= 0.0 {
            continue;
        }
        let used = volc_number(window, &["Used", "used"]).unwrap_or(0.0);
        plans.push(volc_quota_plan(
            "agent",
            level,
            used / quota * 100.0,
            volc_reset_time(window.get("ResetTime").or_else(|| window.get("resetTime"))),
            Some("Running".to_string()),
            &plan_type,
        ));
    }
    Ok(plans)
}

async fn fetch_volcengine_plan_usage(
    volc: &VolcCredentials,
    base: &str,
) -> Result<Vec<ProviderPlan>, String> {
    let region = volcengine_region(base);
    let afp_result = fetch_volcengine_ark_usage(volc, "GetAFPUsage", &region).await;
    if let Ok(value) = &afp_result {
        let plans = parse_volc_afp_plan(value)?;
        if !plans.is_empty() {
            return Ok(plans);
        }
    }

    let coding_result = fetch_volcengine_ark_usage(volc, "GetCodingPlanUsage", &region).await;
    match coding_result {
        Ok(value) => {
            let plans = parse_volc_coding_plan(&value)?;
            if plans.is_empty() {
                Err("火山方舟未返回可识别的 Coding Plan 用量窗口".to_string())
            } else {
                Ok(plans)
            }
        }
        Err(coding_error) => Err(match afp_result {
            Ok(_) => coding_error,
            Err(afp_error) => format!(
                "Agent Plan 查询失败: {afp_error}；Coding Plan 查询失败: {coding_error}"
            ),
        }),
    }
}

async fn fetch_volcengine_account(
    volc: &VolcCredentials,
    base: &str,
) -> Result<(Option<Balance>, Vec<ProviderPlan>, Option<String>), String> {
    let balance_result = fetch_volcengine_openapi(volc, "QueryBalanceAcct", &serde_json::json!({}))
        .await
        .and_then(|value| parse_volc_balance(&value.to_string()));
    let coding_result = fetch_volcengine_plan_usage(volc, base).await;

    if let Ok(plans) = coding_result {
        return Ok((balance_result.ok(), plans, None));
    }
    let coding_error = coding_result.expect_err("checked above");

    let mut packages = fetch_volcengine_plans(volc).await.unwrap_or_default();
    let package_error = if packages.is_empty() {
        None
    } else {
        attach_volcengine_period_usage(volc, &mut packages).await.err()
    };
    match balance_result {
        Ok(balance) => Ok((
            Some(balance),
            packages,
            Some(package_error.unwrap_or(coding_error)),
        )),
        Err(_balance_error) if !packages.is_empty() => Ok((
            None,
            packages,
            Some(package_error.unwrap_or(coding_error)),
        )),
        Err(balance_error) => Err(format!(
            "火山账户余额查询失败: {balance_error}；套餐用量查询失败: {coding_error}"
        )),
    }
}

fn adapter_key(adapter: Adapter) -> &'static str {
    match adapter {
        Adapter::DeepSeek => "deepseek",
        Adapter::OpenAIBilling => "openai",
        Adapter::Volcengine => "volcengine",
        Adapter::Unsupported | Adapter::Probe => "unsupported",
    }
}

fn adapter_from_cache(cached: Option<&str>) -> Option<Adapter> {
    match cached {
        Some("deepseek") => Some(Adapter::DeepSeek),
        Some("openai") => Some(Adapter::OpenAIBilling),
        Some("volcengine") => Some(Adapter::Volcengine),
        Some(_) => Some(Adapter::Unsupported),
        None => None,
    }
}

async fn attempt_openai_usage(
    base: &str,
    key: &str,
) -> Result<(String, Option<Balance>, Option<ProviderUsage>, Vec<ProviderPlan>, Option<String>), String> {
    match fetch_generic_usage(base, key).await {
        Ok(u) => Ok(("openai".to_string(), None, Some(u), Vec::new(), None)),
        Err(generic_err) => fetch_openai_usage(base, key)
            .await
            .map(|u| ("openai".to_string(), None, Some(u), Vec::new(), None))
            .map_err(|billing_err| {
                format!("通用用量接口失败: {generic_err}；账单接口失败: {billing_err}")
            }),
    }
}

/// Run one adapter against a provider. OpenAI-compatible gateways first try
/// the generic `/v1/usage` contract, then the legacy dashboard endpoints.
/// `Probe` subsequently tries the DeepSeek-style balance endpoint.
async fn attempt_adapter(
    adapter: Adapter,
    base: &str,
    key: &str,
    volc: &VolcCredentials,
) -> Result<(String, Option<Balance>, Option<ProviderUsage>, Vec<ProviderPlan>, Option<String>), String> {
    match adapter {
        Adapter::DeepSeek => fetch_deepseek_balance(base, key)
            .await
            .map(|b| ("deepseek".to_string(), Some(b), None, Vec::new(), None)),
        Adapter::OpenAIBilling => attempt_openai_usage(base, key).await,
        Adapter::Volcengine => fetch_volcengine_account(volc, base)
            .await
            .map(|(balance, plans, plans_error)| {
                ("volcengine".to_string(), balance, None, plans, plans_error)
            }),
        Adapter::Unsupported => Err(UNSUPPORTED_NOTE.to_string()),
        Adapter::Probe => {
            match attempt_openai_usage(base, key).await {
                Ok(result) => Ok(result),
                Err(openai_err) => match fetch_deepseek_balance(base, key).await {
                    Ok(b) => Ok(("deepseek".to_string(), Some(b), None, Vec::new(), None)),
                    Err(deepseek_err) => Err(format!(
                        "{UNSUPPORTED_NOTE}（openai 风格失败: {openai_err}；deepseek 风格失败: {deepseek_err}）"
                    )),
                },
            }
        }
    }
}

async fn fetch_one_provider(
    provider: LlmProvider,
    key: Option<String>,
    cached: Option<String>,
    volc: VolcCredentials,
) -> (String, ProviderStatus) {
    let explicit = adapter_for(&provider.api, &provider.base_url);
    let base_kind = if matches!(explicit, Adapter::Volcengine)
        || provider.api.to_ascii_lowercase().contains("deepseek")
    {
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
        plans: Vec::new(),
        plans_error: None,
        error: None,
    };
    let Some(key) = key else {
        return (String::new(), unconfigured);
    };

    let from_cache = adapter_from_cache(cached.as_deref());
    let mut resolved = from_cache.unwrap_or(explicit);
    let mut attempt = attempt_adapter(resolved, &provider.base_url, &key, &volc).await;
    // a cached route that stopped answering: retry once with the fresh match
    if attempt.is_err() && from_cache.is_some() && explicit != resolved {
        resolved = explicit;
        attempt = attempt_adapter(resolved, &provider.base_url, &key, &volc).await;
    }

    let (key2, balance, usage, plans, plans_error, error) = match attempt {
        Ok((k, b, u, plans, plans_error)) => (k, b, u, plans, plans_error, None),
        Err(e) => (
            adapter_key(resolved).to_string(),
            None,
            None,
            Vec::new(),
            None,
            Some(e),
        ),
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
            plans,
            plans_error,
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
    // Account-level volcengine OpenAPI credentials (AK/SK), read once and
    // shared across every volcengine provider that gets routed to its adapter.
    let volc = volc_credentials(paths);
    let mut handles = Vec::with_capacity(providers.len());
    for provider in providers {
        let key = if provider.id == "deepseek-official" {
            effective_key(paths, config)
        } else {
            read_credential(paths, &provider.key_env)
        };
        let cached = adapters.lock().unwrap().get(&provider.id).cloned();
        handles.push(tauri::async_runtime::spawn(fetch_one_provider(
            provider,
            key,
            cached,
            volc.clone(),
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
                plans: Vec::new(),
                plans_error: None,
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
            match check_update_impl(&app, &state).await {
                    Ok(status) => {
                        log_line(
                            &paths.log_file,
                            &format!(
                                "update check: dsh {}{}, shell {}{}",
                                status.dsh_current.clone().unwrap_or_else(|| "?".into()),
                                if status.dsh_update_available {
                                    format!(
                                        " -> {} (available)",
                                        status.dsh_latest.clone().unwrap_or_default()
                                    )
                                } else {
                                    " (current)".into()
                                },
                                status.app_current,
                                if status.app_update_available {
                                    format!(
                                        " -> {} (available)",
                                        status.app_latest.clone().unwrap_or_default()
                                    )
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
            }
        }
    }
}

// ---------------------------------------------------------------------------
// bridge listener (shell side): dsh's bridge plugin POSTs /turn-end here
// ---------------------------------------------------------------------------

fn json_response(
    status: u16,
    body: serde_json::Value,
) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let bytes = serde_json::to_vec(&body).unwrap_or_else(|_| b"{}".to_vec());
    tiny_http::Response::from_data(bytes)
        .with_status_code(status)
        .with_header(
            tiny_http::Header::from_bytes(
                &b"Content-Type"[..],
                &b"application/json; charset=utf-8"[..],
            )
            .unwrap(),
        )
}

const TURN_END_BODY_LIMIT: usize = 8 * 1024;
const TURN_END_DEDUPE_WINDOW: Duration = Duration::from_secs(5);
#[cfg(target_os = "windows")]
const DSH_NOTIFICATION_APP_ID: &str = "com.anixuil.dshdesktop";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnEndPayload {
    session_id: String,
    title: Option<String>,
    turn_key: String,
    #[serde(default)]
    is_focused_session: bool,
}

fn read_limited_json<T: serde::de::DeserializeOwned>(
    req: &mut tiny_http::Request,
    limit: usize,
) -> Result<T, String> {
    let mut bytes = Vec::new();
    req.as_reader()
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取请求: {error}"))?;
    if bytes.len() > limit {
        return Err("请求内容过大".to_string());
    }
    serde_json::from_slice(&bytes).map_err(|_| "请求 JSON 无效".to_string())
}

fn normalize_task_title(title: Option<&str>) -> Option<String> {
    let value = title?.trim();
    if value.is_empty() {
        return None;
    }
    Some(value.chars().take(80).collect())
}

#[derive(Debug, PartialEq, Eq)]
struct TaskNotificationCopy {
    title: String,
    context: String,
    status: String,
}

fn task_notification_copy(title: Option<&str>) -> TaskNotificationCopy {
    TaskNotificationCopy {
        title: "DSH Desktop · 任务完成".to_string(),
        context: match normalize_task_title(title) {
            Some(title) => format!("会话：{title}"),
            None => "会话：未命名任务".to_string(),
        },
        status: "状态：已完成，可以回来查看结果".to_string(),
    }
}

fn test_notification_copy() -> TaskNotificationCopy {
    TaskNotificationCopy {
        title: "DSH Desktop · 通知测试".to_string(),
        context: "来源：DSH Desktop".to_string(),
        status: "内容：任务完成通知已正确启用".to_string(),
    }
}

fn should_send_task_notification(
    mode: TaskNotificationMode,
    visible: bool,
    focused: bool,
    minimized: bool,
    is_focused_session: bool,
) -> bool {
    match mode {
        TaskNotificationMode::Off => false,
        TaskNotificationMode::Always => true,
        TaskNotificationMode::Unfocused => !visible || minimized || !focused || !is_focused_session,
    }
}

fn main_window_state(app: &AppHandle) -> (bool, bool, bool) {
    let Some(window) = app.get_webview_window("main") else {
        return (false, false, false);
    };
    (
        window.is_visible().unwrap_or(false),
        window.is_focused().unwrap_or(false),
        window.is_minimized().unwrap_or(false),
    )
}

fn reserve_task_notification(
    recent: &Mutex<HashMap<String, Instant>>,
    turn_key: &str,
    now: Instant,
) -> bool {
    let mut recent = recent.lock().unwrap();
    recent.retain(|_, at| now.saturating_duration_since(*at) < TURN_END_DEDUPE_WINDOW);
    if recent.contains_key(turn_key) {
        return false;
    }
    recent.insert(turn_key.to_string(), now);
    true
}

fn parse_task_notification_mode(value: &str) -> Option<TaskNotificationMode> {
    match value {
        "off" => Some(TaskNotificationMode::Off),
        "unfocused" => Some(TaskNotificationMode::Unfocused),
        "always" => Some(TaskNotificationMode::Always),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn show_task_notification(copy: &TaskNotificationCopy) -> Result<(), String> {
    use tauri_winrt_notification::Toast;

    let show = |app_id: &str| {
        Toast::new(app_id)
            .title(&copy.title)
            .text1(&copy.context)
            .text2(&copy.status)
            .show()
    };

    // The NSIS shortcut registers this AUMID, giving installed notifications
    // the DSH Desktop name and icon in Windows. Unpacked debug/release builds
    // have no registered shortcut, so retain a reliable PowerShell fallback;
    // the toast title still identifies DSH Desktop explicitly in that case.
    match show(DSH_NOTIFICATION_APP_ID) {
        Ok(()) => Ok(()),
        Err(primary_error) => show(Toast::POWERSHELL_APP_ID).map_err(|fallback_error| {
            format!(
                "DSH Desktop 通知身份不可用: {primary_error}; PowerShell 回退失败: {fallback_error}"
            )
        }),
    }
}

#[cfg(not(target_os = "windows"))]
fn show_task_notification(app: &AppHandle, copy: &TaskNotificationCopy) -> Result<(), String> {
    app.notification()
        .builder()
        .title(&copy.title)
        .body(format!("{}\n{}", copy.context, copy.status))
        .show()
        .map_err(|error| error.to_string())
}

fn send_task_notification(app: &AppHandle, title: Option<&str>) -> Result<(), String> {
    let copy = task_notification_copy(title);
    #[cfg(target_os = "windows")]
    let _ = app;
    #[cfg(target_os = "windows")]
    return show_task_notification(&copy);
    #[cfg(not(target_os = "windows"))]
    show_task_notification(app, &copy)
}

fn send_test_notification(app: &AppHandle) -> Result<(), String> {
    let copy = test_notification_copy();
    #[cfg(target_os = "windows")]
    let _ = app;
    #[cfg(target_os = "windows")]
    return show_task_notification(&copy);
    #[cfg(not(target_os = "windows"))]
    show_task_notification(app, &copy)
}

fn persist_task_notification_mode(
    app: &AppHandle,
    mode: TaskNotificationMode,
) -> TaskNotificationMode {
    let state = app.state::<AppState>();
    let mut config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(app, &config);
    config.task_notification_mode = mode;
    save_config(&paths.config_file, &config);
    *state.config.lock().unwrap() = config;
    mode
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
        log_line(
            &paths.log_file,
            &format!("bridge listener on 127.0.0.1:{port}"),
        );
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
                        let payload = match read_limited_json::<TurnEndPayload>(
                            &mut req,
                            TURN_END_BODY_LIMIT,
                        ) {
                            Ok(payload)
                                if !payload.session_id.trim().is_empty()
                                    && payload.session_id.len() <= 256
                                    && !payload.turn_key.trim().is_empty()
                                    && payload.turn_key.len() <= 512 =>
                            {
                                payload
                            }
                            Ok(_) => {
                                let _ = req.respond(json_response(
                                    400,
                                    serde_json::json!({ "ok": false, "error": "任务完成事件字段无效" }),
                                ));
                                return;
                            }
                            Err(error) => {
                                let _ = req.respond(json_response(
                                    400,
                                    serde_json::json!({ "ok": false, "error": error }),
                                ));
                                return;
                            }
                        };
                        let state2 = app2.state::<AppState>();
                        let config = state2.config.lock().unwrap().clone();
                        let (visible, focused, minimized) = main_window_state(&app2);
                        let should_notify = should_send_task_notification(
                            config.task_notification_mode,
                            visible,
                            focused,
                            minimized,
                            payload.is_focused_session,
                        );
                        let reserved = should_notify
                            && reserve_task_notification(
                                &state2.recent_task_notifications,
                                payload.turn_key.trim(),
                                Instant::now(),
                            );
                        let mut notified = false;
                        if reserved {
                            match send_task_notification(&app2, payload.title.as_deref()) {
                                Ok(()) => notified = true,
                                Err(error) => log_line(
                                    &log_file2,
                                    &format!("task notification failed: {error}"),
                                ),
                            }
                        }
                        let _ = req.respond(json_response(
                            200,
                            serde_json::json!({ "ok": true, "notified": notified }),
                        ));
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
                        let _ = req
                            .respond(tiny_http::Response::from_string("ok").with_status_code(200));
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
                        const WAVE_STATES: [&str; 7] = [
                            "calm",
                            "thinking",
                            "streaming",
                            "tooling",
                            "waiting",
                            "error",
                            "settle",
                        ];
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
                    ("GET", "/motion") => {
                        // Current motion intensity for the in-app 外观与动效
                        // settings section (proxied through the bridge's /desktop/*).
                        let state2 = app2.state::<AppState>();
                        let config = state2.config.lock().unwrap().clone();
                        let _ = req.respond(json_response(
                            200,
                            serde_json::json!({ "ok": true, "motion": config.motion }),
                        ));
                    }
                    ("POST", "/motion-save") => {
                        // Persist the motion intensity chosen in the in-app
                        // 外观与动效 section and broadcast `motion-updated` so
                        // every window applies it live.
                        let mut body = String::new();
                        let _ = req.as_reader().read_to_string(&mut body);
                        let motion = serde_json::from_str::<serde_json::Value>(&body)
                            .ok()
                            .and_then(|v| {
                                v.get("motion").and_then(|m| m.as_str()).map(String::from)
                            })
                            .unwrap_or_default();
                        let parsed = match motion.as_str() {
                            "default" => MotionIntensity::Default,
                            "quiet" => MotionIntensity::Quiet,
                            "rich" => MotionIntensity::Rich,
                            _ => {
                                let _ = req.respond(json_response(
                                    400,
                                    serde_json::json!({ "ok": false, "error": "无效的外观与动效预设" }),
                                ));
                                return;
                            }
                        };
                        apply_motion(&app2, parsed);
                        let _ = req.respond(json_response(
                            200,
                            serde_json::json!({ "ok": true, "motion": parsed }),
                        ));
                    }
                    ("GET", "/notifications") => {
                        let state2 = app2.state::<AppState>();
                        let config = state2.config.lock().unwrap().clone();
                        let _ = req.respond(json_response(
                            200,
                            serde_json::json!({
                                "ok": true,
                                "mode": config.task_notification_mode,
                            }),
                        ));
                    }
                    ("POST", "/notifications-save") => {
                        let payload = match read_limited_json::<serde_json::Value>(&mut req, 4096) {
                            Ok(payload) => payload,
                            Err(error) => {
                                let _ = req.respond(json_response(
                                    400,
                                    serde_json::json!({ "ok": false, "error": error }),
                                ));
                                return;
                            }
                        };
                        let mode = match payload
                            .get("mode")
                            .and_then(|value| value.as_str())
                            .and_then(parse_task_notification_mode)
                        {
                            Some(mode) => mode,
                            None => {
                                let _ = req.respond(json_response(
                                    400,
                                    serde_json::json!({ "ok": false, "error": "无效的任务通知模式" }),
                                ));
                                return;
                            }
                        };
                        let saved = persist_task_notification_mode(&app2, mode);
                        let _ = req.respond(json_response(
                            200,
                            serde_json::json!({ "ok": true, "mode": saved }),
                        ));
                    }
                    ("POST", "/notifications-test") => match send_test_notification(&app2) {
                        Ok(()) => {
                            let _ =
                                req.respond(json_response(200, serde_json::json!({ "ok": true })));
                        }
                        Err(error) => {
                            log_line(&log_file2, &format!("test notification failed: {error}"));
                            let _ = req.respond(json_response(
                                500,
                                serde_json::json!({ "ok": false, "error": format!("系统通知发送失败: {error}") }),
                            ));
                        }
                    },
                    ("GET", "/plugin-network") => {
                        let state2 = app2.state::<AppState>();
                        let config = state2.config.lock().unwrap().clone();
                        let _ = req.respond(json_response(
                            200,
                            serde_json::json!({ "ok": true, "config": plugin_network_snapshot(&config) }),
                        ));
                    }
                    ("GET", "/builtin-plugins") => {
                        let state2 = app2.state::<AppState>();
                        let config = state2.config.lock().unwrap().clone();
                        let paths2 = resolve_paths(&app2, &config);
                        let _ = req.respond(json_response(
                            200,
                            builtin_plugins_snapshot(&paths2, &config),
                        ));
                    }
                    ("POST", "/builtin-plugins-apply") => {
                        let state2 = app2.state::<AppState>();
                        if state2.adopted.load(Ordering::SeqCst) {
                            let _ = req.respond(json_response(
                                409,
                                serde_json::json!({
                                    "ok": false,
                                    "error": "当前正在接入外部 DSH 实例，无法由桌面端重启并更改插件",
                                }),
                            ));
                            return;
                        }
                        let mut body = String::new();
                        let _ = req.as_reader().read_to_string(&mut body);
                        let payload: serde_json::Value =
                            serde_json::from_str(&body).unwrap_or(serde_json::json!({}));
                        let Some(enabled) =
                            payload.get("enabled").and_then(|value| value.as_array())
                        else {
                            let _ = req.respond(json_response(
                                400,
                                serde_json::json!({ "ok": false, "error": "enabled 必须是插件 ID 数组" }),
                            ));
                            return;
                        };
                        let mut enabled_ids = HashSet::new();
                        for value in enabled {
                            let Some(id) = value.as_str() else {
                                let _ = req.respond(json_response(
                                    400,
                                    serde_json::json!({ "ok": false, "error": "插件 ID 必须是字符串" }),
                                ));
                                return;
                            };
                            if !BUILTIN_PLUGINS.contains(&id) {
                                let _ = req.respond(json_response(
                                    400,
                                    serde_json::json!({ "ok": false, "error": format!("未知的内置插件: {id}") }),
                                ));
                                return;
                            }
                            enabled_ids.insert(id.to_string());
                        }
                        let previous = state2.config.lock().unwrap().clone();
                        let mut config = previous.clone();
                        config.disabled_builtin_plugins = BUILTIN_PLUGINS
                            .iter()
                            .filter(|name| !enabled_ids.contains(**name))
                            .map(|name| (*name).to_string())
                            .collect();
                        let paths2 = resolve_paths(&app2, &config);
                        save_config(&paths2.config_file, &config);
                        *state2.config.lock().unwrap() = config.clone();
                        let response = builtin_plugins_snapshot(&paths2, &config);
                        let mut response = response.as_object().cloned().unwrap_or_default();
                        response.insert("restartPending".into(), serde_json::json!(true));
                        let _ =
                            req.respond(json_response(200, serde_json::Value::Object(response)));
                        restart_dsh_after_builtin_change(app2.clone(), paths2, config, previous);
                    }
                    ("POST", "/plugin-network-save") => {
                        let mut body = String::new();
                        let _ = req.as_reader().read_to_string(&mut body);
                        let payload: serde_json::Value =
                            serde_json::from_str(&body).unwrap_or(serde_json::json!({}));
                        let state2 = app2.state::<AppState>();
                        let mut config = state2.config.lock().unwrap().clone();
                        let proxy = payload
                            .get("proxy")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim();
                        let registry = payload
                            .get("npmRegistry")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim();
                        if !proxy.is_empty() && valid_plugin_proxy(proxy).is_none() {
                            let _ = req.respond(json_response(400, serde_json::json!({ "ok": false, "error": "代理地址必须是 http:// 或 https:// URL" })));
                            return;
                        }
                        if !registry.is_empty() && valid_npm_registry(registry).is_none() {
                            let _ = req.respond(json_response(400, serde_json::json!({ "ok": false, "error": "npm 源必须是 http:// 或 https:// URL" })));
                            return;
                        }
                        config.plugin_network_proxy = if proxy.is_empty() {
                            None
                        } else {
                            valid_plugin_proxy(proxy)
                        };
                        config.plugin_npm_registry = if registry.is_empty() {
                            None
                        } else {
                            valid_npm_registry(registry)
                        };
                        config.plugin_install_timeout_minutes = payload
                            .get("installTimeoutMinutes")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(u64::from(default_plugin_install_timeout_minutes()))
                            .clamp(10, 60)
                            as u16;
                        let paths2 = resolve_paths(&app2, &config);
                        save_config(&paths2.config_file, &config);
                        {
                            let mut state_config = state2.config.lock().unwrap();
                            *state_config = config.clone();
                        }
                        // This handler is reached THROUGH the DSH web server:
                        // shell -> bridge -> browser. Killing DSH before its
                        // bridge has relayed this response drops the browser
                        // request and surfaces as a misleading “Failed to
                        // fetch”. Acknowledge first, then restart from a
                        // detached task after the response has cleared both
                        // local hops.
                        let _ = req.respond(json_response(
                            200,
                            serde_json::json!({
                                "ok": true,
                                "config": plugin_network_snapshot(&config),
                                "restartPending": true,
                            }),
                        ));
                        let restart_app = app2.clone();
                        let restart_paths = paths2.clone();
                        let restart_config = config.clone();
                        thread::spawn(move || {
                            thread::sleep(Duration::from_millis(750));
                            let state = restart_app.state::<AppState>();
                            // Hold the lifecycle lock across the hand-off so
                            // the health loop cannot observe an empty slot and
                            // launch a competing DSH process mid-restart.
                            let mut dsh = state.dsh.lock().unwrap();
                            let old = dsh.child.take();
                            if let Some(mut child) = old {
                                let _ = child.kill();
                                let _ = child.wait();
                            }
                            match spawn_dsh(&restart_paths, &restart_config) {
                                Ok(child) => {
                                    dsh.child = Some(child);
                                    log_line(
                                        &restart_paths.log_file,
                                        "plugin network saved; DSH restarted",
                                    );
                                }
                                Err(error) => log_line(
                                    &restart_paths.log_file,
                                    &format!("plugin network restart failed: {error}"),
                                ),
                            }
                        });
                    }
                    ("POST", "/plugin-network-test") => {
                        let state2 = app2.state::<AppState>();
                        let config = state2.config.lock().unwrap().clone();
                        let result = tauri::async_runtime::block_on(probe_plugin_network(&config));
                        let status = if result["ok"] == true { 200 } else { 502 };
                        let _ = req.respond(json_response(status, result));
                    }
                    ("GET", "/remote-config") => {
                        // Remote-access snapshot for the in-app settings
                        // section (proxied through the bridge's /desktop/*).
                        let state2 = app2.state::<AppState>();
                        let config = state2.config.lock().unwrap().clone();
                        let (running, online) =
                            tauri::async_runtime::block_on(probe_relay_status());
                        let _ = req.respond(json_response(
                            200,
                            serde_json::json!({
                                "ok": true,
                                "config": remote_snapshot(&config, running, online),
                            }),
                        ));
                    }
                    ("POST", "/remote-save") => {
                        // Persist remote-access settings and restart the
                        // relay-client companion with them (auto-registering
                        // the device when no legacy admin secret is set).
                        let mut body = String::new();
                        let _ = req.as_reader().read_to_string(&mut body);
                        let payload: serde_json::Value =
                            serde_json::from_str(&body).unwrap_or(serde_json::json!({}));
                        let state2 = app2.state::<AppState>();
                        let paths2 = {
                            let config = state2.config.lock().unwrap().clone();
                            resolve_paths(&app2, &config)
                        };
                        {
                            let mut config = state2.config.lock().unwrap();
                            // A custom URL is only stored when the user opted
                            // into a custom relay; otherwise the field is
                            // cleared and the public default relay is used.
                            let custom_relay = payload
                                .get("customRelay")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            let new_url = if custom_relay {
                                payload
                                    .get("relayUrl")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.trim().to_string())
                                    .filter(|s| !s.is_empty())
                            } else {
                                None
                            };
                            let new_id = payload
                                .get("deviceId")
                                .and_then(|v| v.as_str())
                                .map(|s| s.trim().to_lowercase())
                                .filter(|s| !s.is_empty());
                            // Only a changed effective relay URL/device ID
                            // invalidates a previously issued device secret;
                            // saving the same settings keeps it. The relay
                            // also reclaims offline stale registrations.
                            let old_effective = effective_relay_url(&config);
                            let old_id = config.remote_device_id.clone();
                            config.remote_enabled = payload
                                .get("enabled")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            config.remote_relay_url = new_url;
                            config.remote_secret = payload
                                .get("secret")
                                .and_then(|v| v.as_str())
                                .map(|s| s.trim().to_string())
                                .filter(|s| !s.is_empty());
                            config.remote_device_id = new_id;
                            if let Some(limit) =
                                payload.get("maxConcurrent").and_then(|v| v.as_u64())
                            {
                                config.remote_max_concurrent = limit.clamp(1, 64) as u16;
                            }
                            if old_effective != effective_relay_url(&config)
                                || old_id != config.remote_device_id
                            {
                                config.remote_device_secret = None;
                            }
                            save_config(&paths2.config_file, &config);
                        }
                        let config = state2.config.lock().unwrap().clone();
                        let register_error = if config.remote_enabled {
                            tauri::async_runtime::block_on(ensure_device_registered(
                                &app2, &config, &paths2,
                            ))
                            .err()
                        } else {
                            None
                        };
                        if let Some(e) = register_error {
                            let _ = req.respond(json_response(
                                200,
                                serde_json::json!({
                                    "ok": false,
                                    "error": e,
                                    "config": remote_snapshot(&config, false, false),
                                }),
                            ));
                            return;
                        }
                        let config = state2.config.lock().unwrap().clone();
                        spawn_relay_client(&app2, &paths2, &config);
                        std::thread::sleep(Duration::from_millis(300));
                        let (running, online) =
                            tauri::async_runtime::block_on(probe_relay_status());
                        let _ = req.respond(json_response(
                            200,
                            serde_json::json!({
                                "ok": true,
                                "config": remote_snapshot(&config, running, online),
                            }),
                        ));
                    }
                    ("GET", "/remote-pairing") => {
                        // Pairing code for the in-app settings section: the
                        // phone redeems it on the relay login page.
                        let state2 = app2.state::<AppState>();
                        let config = state2.config.lock().unwrap().clone();
                        let paths2 = resolve_paths(&app2, &config);
                        let result = tauri::async_runtime::block_on(async {
                            if !config.remote_enabled {
                                return Err("远程访问未启用".to_string());
                            }
                            let secret = ensure_device_registered(&app2, &config, &paths2)
                                .await?
                                .ok_or_else(|| "设备未注册".to_string())?;
                            // Keep the device online: minting a code for an
                            // offline relay-client would strand the phone.
                            let fresh = state2.config.lock().unwrap().clone();
                            spawn_relay_client(&app2, &paths2, &fresh);
                            let http_url =
                                relay_http_url(&fresh).ok_or_else(|| "中继地址无效".to_string())?;
                            let device_id = fresh.remote_device_id.as_deref().unwrap_or("my-pc");
                            let client = reqwest::Client::builder()
                                .timeout(Duration::from_secs(8))
                                .build()
                                .map_err(|e| e.to_string())?;
                            let resp = client
                                .post(format!("{http_url}/pairing"))
                                .bearer_auth(&secret)
                                .json(&serde_json::json!({ "deviceId": device_id }))
                                .send()
                                .await
                                .map_err(|e| format!("无法连接中继服务器: {e}"))?;
                            if !resp.status().is_success() {
                                return Err(format!(
                                    "生成配对码失败：中继返回 HTTP {}",
                                    resp.status()
                                ));
                            }
                            let mut payload = resp
                                .json::<serde_json::Value>()
                                .await
                                .map_err(|e| format!("配对码响应无法解析: {e}"))?;
                            if let Some(obj) = payload.as_object_mut() {
                                obj.insert(
                                    "entry".to_string(),
                                    serde_json::json!(remote_entry_url(&config)),
                                );
                            }
                            Ok(payload)
                        });
                        match result {
                            Ok(payload) => {
                                let _ = req.respond(json_response(
                                    200,
                                    serde_json::json!({ "ok": true, "pairing": payload }),
                                ));
                            }
                            Err(e) => {
                                let _ = req.respond(json_response(
                                    200,
                                    serde_json::json!({ "ok": false, "error": e }),
                                ));
                            }
                        }
                    }
                    ("POST", "/remote-persistent-pairing") => {
                        let mut body = String::new();
                        let _ = req.as_reader().read_to_string(&mut body);
                        let code = serde_json::from_str::<serde_json::Value>(&body)
                            .ok()
                            .and_then(|value| {
                                value
                                    .get("code")
                                    .and_then(|value| value.as_str())
                                    .map(|value| value.trim().to_string())
                            })
                            .unwrap_or_default();
                        if !code.is_empty() && (code.len() < 6 || code.len() > 64) {
                            let _ = req.respond(json_response(400, serde_json::json!({ "ok": false, "error": "长期配对码长度需为 6 至 64 位" })));
                            return;
                        }
                        let state2 = app2.state::<AppState>();
                        let config = state2.config.lock().unwrap().clone();
                        let paths2 = resolve_paths(&app2, &config);
                        let result = tauri::async_runtime::block_on(async {
                            if !config.remote_enabled {
                                return Err("远程访问未启用".to_string());
                            }
                            ensure_device_registered(&app2, &config, &paths2).await?;
                            let fresh = state2.config.lock().unwrap().clone();
                            sync_persistent_pairing_code(&fresh, &code).await
                        });
                        match result {
                            Ok(()) => {
                                let mut config = state2.config.lock().unwrap();
                                config.remote_persistent_pairing_enabled = !code.is_empty();
                                save_config(&paths2.config_file, &config);
                                let snapshot = remote_snapshot(&config, false, false);
                                let _ = req.respond(json_response(
                                    200,
                                    serde_json::json!({ "ok": true, "config": snapshot }),
                                ));
                            }
                            Err(error) => {
                                let _ = req.respond(json_response(
                                    200,
                                    serde_json::json!({ "ok": false, "error": error }),
                                ));
                            }
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
                                    let low =
                                        balance_is_low(&balance, config.balance_low_threshold);
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
                        let dsh_version =
                            fs::read_to_string(paths2.runtime_dir.join("version.json"))
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
                            let result = check_update_impl(&app3, &state2).await;
                            let _ = tx.send(result);
                        });
                        match rx.recv_timeout(Duration::from_secs(20)) {
                            Ok(Ok(status)) => {
                                let mut payload =
                                    serde_json::to_value(&status).unwrap_or(serde_json::json!({}));
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
                            .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(String::from))
                            .unwrap_or_default();
                        match open_external_impl(&url) {
                            Ok(()) => {
                                let _ = req
                                    .respond(json_response(200, serde_json::json!({ "ok": true })));
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

fn dsh_theme_preference(paths: &Paths) -> String {
    fs::read_to_string(paths.dsh_home.join("settings.yaml"))
        .ok()
        .and_then(|raw| serde_yaml::from_str::<serde_yaml::Value>(&raw).ok())
        .and_then(|doc| {
            doc.get("ui-theme")
                .and_then(|theme| theme.get("preference"))
                .and_then(|preference| preference.as_str())
                .map(str::to_string)
        })
        .filter(|preference| matches!(preference.as_str(), "light" | "dark" | "system"))
        .unwrap_or_else(|| "system".to_string())
}

#[tauri::command]
async fn get_status(app: AppHandle, state: State<'_, AppState>) -> Result<StatusSnapshot, String> {
    let config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(&app, &config);
    let key_configured = effective_key(&paths, &config).is_some();
    let balance = state.balance.lock().unwrap().clone();
    let low = balance_is_low(&balance, config.balance_low_threshold);
    let theme_preference = dsh_theme_preference(&paths);

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

    let remote_running = state.relay.lock().unwrap().child.is_some();
    let (probe_running, probe_online) = probe_relay_status().await;
    let remote_running = remote_running && probe_running;
    state.remote_online.store(probe_online, Ordering::SeqCst);

    Ok(StatusSnapshot {
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
        theme_preference,
        remote_enabled: config.remote_enabled,
        remote_running,
        remote_online: probe_online,
        remote_entry: if config.remote_enabled {
            remote_entry_url(&config)
        } else {
            None
        },
        bailian_configured: read_credential(&paths, BAILIAN_KEY_ENV).is_some(),
    })
}

#[tauri::command]
fn get_startup_conflict(state: State<'_, AppState>) -> Option<StartupConflict> {
    state.startup_conflict.lock().unwrap().clone()
}

#[tauri::command]
fn choose_startup_mode(state: State<'_, AppState>, mode: StartupMode) -> Result<(), String> {
    if state.startup_conflict.lock().unwrap().take().is_none() {
        return Err("当前没有等待处理的已有实例".to_string());
    }
    let mut decision = state.startup_decision.lock().unwrap();
    if decision.is_some() {
        return Err("启动方式已经确定".to_string());
    }
    *decision = Some(mode);
    state.startup_decision_cv.notify_all();
    Ok(())
}

/// Persist the UI motion intensity and broadcast `motion-updated` so every
/// window (splash, settings, and the injected dsh page scripts) applies it
/// live without a reload. Shared by the settings window's Tauri command and
/// the bridge listener's /motion-save route.
fn apply_motion(app: &AppHandle, motion: MotionIntensity) -> MotionIntensity {
    let state = app.state::<AppState>();
    let mut config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(app, &config);
    config.motion = motion;
    save_config(&paths.config_file, &config);
    *state.config.lock().unwrap() = config;
    let _ = app.emit("motion-updated", serde_json::json!({ "motion": motion }));
    motion
}

#[tauri::command]
fn set_motion_intensity(
    app: AppHandle,
    motion: MotionIntensity,
) -> Result<MotionIntensity, String> {
    Ok(apply_motion(&app, motion))
}

/// Remote-access configuration snapshot for the settings window.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfigSnapshot {
    pub enabled: bool,
    /// Effective relay URL in use: the user's custom URL when `custom_relay`
    /// is true, otherwise the public default relay.
    pub relay_url: String,
    /// True when the user configured their own relay URL (custom relay).
    pub custom_relay: bool,
    /// The public default relay URL, used whenever `custom_relay` is false.
    pub default_relay_url: String,
    pub secret: String,
    pub device_id: String,
    pub running: bool,
    pub online: bool,
    pub max_concurrent: u16,
    pub persistent_pairing_enabled: bool,
    pub entry: Option<String>,
}

fn remote_snapshot(config: &AppConfig, running: bool, online: bool) -> RemoteConfigSnapshot {
    RemoteConfigSnapshot {
        enabled: config.remote_enabled,
        relay_url: effective_relay_url(config).unwrap_or_default(),
        custom_relay: custom_relay_set(config),
        default_relay_url: DEFAULT_RELAY_URL.to_string(),
        secret: config.remote_secret.clone().unwrap_or_default(),
        device_id: config.remote_device_id.clone().unwrap_or_default(),
        running,
        online,
        max_concurrent: config.remote_max_concurrent.clamp(1, 64),
        persistent_pairing_enabled: config.remote_persistent_pairing_enabled,
        entry: if config.remote_enabled {
            remote_entry_url(config)
        } else {
            None
        },
    }
}

#[tauri::command]
async fn get_remote_config(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RemoteConfigSnapshot, String> {
    let _ = &app;
    let config = state.config.lock().unwrap().clone();
    let relay_running = state.relay.lock().unwrap().child.is_some();
    let (probe_running, online) = probe_relay_status().await;
    // Only trust the status probe when this session actually spawned the
    // relay-client; an orphaned process from a previous instance may still
    // serve the port but its config is stale.
    let running = relay_running && probe_running;
    Ok(remote_snapshot(&config, running, online))
}

/// Persist the remote-access settings and restart the relay-client with them.
/// Product flow: `secret` is optional — leave it empty and the device
/// auto-registers with the relay to obtain its own device secret. `custom_relay`
/// selects between the user's own relay URL and the public default relay.
#[tauri::command]
async fn save_remote_config(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
    custom_relay: bool,
    relay_url: String,
    secret: String,
    device_id: String,
    max_concurrent: Option<u16>,
) -> Result<RemoteConfigSnapshot, String> {
    let paths = {
        let config = state.config.lock().unwrap().clone();
        resolve_paths(&app, &config)
    };
    {
        let mut config = state.config.lock().unwrap();
        // A custom URL is only stored when the user opted into a custom relay;
        // otherwise the field is cleared and the public default is used.
        let new_url = if custom_relay {
            Some(relay_url.trim().to_string()).filter(|s| !s.is_empty())
        } else {
            None
        };
        let new_id = Some(device_id.trim().to_lowercase()).filter(|s| !s.is_empty());
        // Only a changed effective relay URL or device ID invalidates a
        // previously issued device secret (which forces re-registration).
        // Saving the same settings keeps the existing secret; the relay
        // reclaims a stale registration only when no agent is online.
        let old_effective = effective_relay_url(&config);
        let old_id = config.remote_device_id.clone();
        config.remote_enabled = enabled;
        config.remote_relay_url = new_url;
        config.remote_secret = Some(secret.trim().to_string()).filter(|s| !s.is_empty());
        config.remote_device_id = new_id;
        if let Some(limit) = max_concurrent {
            config.remote_max_concurrent = limit.clamp(1, 64);
        }
        if old_effective != effective_relay_url(&config) || old_id != config.remote_device_id {
            config.remote_device_secret = None;
        }
        save_config(&paths.config_file, &config);
        *state.config.lock().unwrap() = config.clone();
    }
    if enabled {
        let config = state.config.lock().unwrap().clone();
        match ensure_device_registered(&app, &config, &paths).await {
            Ok(_) => {}
            Err(e) => {
                // Keep the settings persisted but surface the registration
                // failure to the UI instead of silently ignoring it.
                return Err(e);
            }
        }
    }
    let config = state.config.lock().unwrap().clone();
    spawn_relay_client(&app, &paths, &config);
    // The companion process needs a beat to bind its status port; probe once
    // immediately and once after a short wait so the UI shows the real state.
    let (mut running, mut online) = probe_relay_status().await;
    if !running {
        tokio::time::sleep(Duration::from_millis(600)).await;
        let (r2, o2) = probe_relay_status().await;
        running = r2;
        online = o2;
    }
    Ok(remote_snapshot(&config, running, online))
}

/// Issue a pairing code for this device: the phone redeems it on the login
/// page and receives a long-lived token — no shared secrets anywhere.
#[tauri::command]
async fn get_remote_pairing(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let config = state.config.lock().unwrap().clone();
    if !config.remote_enabled {
        return Err("远程访问未启用".to_string());
    }
    let paths = resolve_paths(&app, &config);
    let secret = ensure_device_registered(&app, &config, &paths)
        .await?
        .ok_or_else(|| "设备未注册：请先在远程访问设置中保存配置".to_string())?;
    // A pairing code only matters when the device is actually online: make
    // sure the relay-client companion is running before minting a code.
    let fresh = state.config.lock().unwrap().clone();
    spawn_relay_client(&app, &paths, &fresh);
    let http_url = relay_http_url(&fresh).ok_or_else(|| "中继地址无效".to_string())?;
    let device_id = fresh.remote_device_id.as_deref().unwrap_or("my-pc");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(format!("{http_url}/pairing"))
        .bearer_auth(&secret)
        .json(&serde_json::json!({ "deviceId": device_id }))
        .send()
        .await
        .map_err(|e| format!("无法连接中继服务器: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let detail = resp
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
            .unwrap_or_else(|| format!("HTTP {status}"));
        return Err(format!("生成配对码失败: {detail}"));
    }
    let mut payload = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("配对码响应无法解析: {e}"))?;
    if let Some(obj) = payload.as_object_mut() {
        obj.insert(
            "entry".to_string(),
            serde_json::json!(remote_entry_url(&config)),
        );
    }
    Ok(payload)
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

/// One-click Bailian (阿里云百炼) setup: store the key under the pi-ai
/// catalog's credential name and ensure the `qwen-token-plan-cn` provider
/// route exists in settings.yaml. The catalog supplies models with reasoning
/// metadata, so thinking levels work in the model picker out of the box.
/// Clearing (empty key) removes only the credential, not the route.
#[derive(Serialize)]
pub struct ConfigureBailianResult {
    pub configured: bool,
    /// The catalog provider route already existed in settings.yaml (only
    /// meaningful when `configured` is true).
    pub provider_existed: bool,
    /// Hand-declared routes folded into the catalog provider (same token-plan
    /// endpoint, no reasoning metadata).
    pub removed_providers: Vec<String>,
    /// Model ids carried over from the folded routes onto the catalog route.
    pub merged_models: Vec<String>,
}

#[tauri::command]
async fn configure_bailian(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
) -> Result<ConfigureBailianResult, String> {
    let key = key.trim().to_string();
    let config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(&app, &config);

    let cred_file = paths.dsh_home.join(".credentials.yaml");
    write_credential_entry(
        &cred_file,
        BAILIAN_KEY_ENV,
        if key.is_empty() { None } else { Some(&key) },
    )?;

    if key.is_empty() {
        let statuses = fetch_provider_statuses(&paths, &config, &state.adapters).await;
        *state.providers.lock().unwrap() = Some(statuses);
        return Ok(ConfigureBailianResult {
            configured: false,
            provider_existed: false,
            removed_providers: Vec::new(),
            merged_models: Vec::new(),
        });
    }

    let outcome = ensure_bailian_provider(&paths.dsh_home.join("settings.yaml"))?;

    // refresh the multi-provider snapshot so the panel shows the new platform
    let statuses = fetch_provider_statuses(&paths, &config, &state.adapters).await;
    *state.providers.lock().unwrap() = Some(statuses);
    Ok(ConfigureBailianResult {
        configured: true,
        provider_existed: outcome.existed,
        removed_providers: outcome.removed,
        merged_models: outcome.merged_models,
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
    let config = app.state::<AppState>().config.lock().unwrap().clone();
    let motion = config.motion;
    let paths = resolve_paths(&app, &config);
    let theme_script = format!(
        "window.__DSH_THEME__ = {};",
        serde_json::to_string(&dsh_theme_preference(&paths))
            .unwrap_or_else(|_| "\"system\"".to_string())
    );
    let w = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title("DSH Desktop 设置")
        .inner_size(900.0, 700.0)
        .min_inner_size(680.0, 560.0)
        .decorations(false)
        .shadow(true)
        .data_directory(webview_data_dir(&app))
        .initialization_script(INIT_SCRIPT)
        .initialization_script(motion_init_script(motion))
        .initialization_script(theme_script)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = w.set_focus();
    Ok(())
}

// ---------------------------------------------------------------------------
// updates: dsh runtime (npm registry) + shell (GitHub Releases, optional repo)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComponentUpdateStatus {
    pub current: Option<String>,
    pub latest: Option<String>,
    pub update_available: bool,
    pub release_url: Option<String>,
    pub notes: Option<String>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReadiness {
    pub ready: bool,
    pub reason: Option<String>,
    pub core_ready: bool,
    pub shell_ready: bool,
    pub core_reason: Option<String>,
    pub shell_reason: Option<String>,
    pub task_running: bool,
    pub adopted: bool,
    pub core_update_in_progress: bool,
    pub shell_update_in_progress: bool,
    pub pending_verification: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub core: ComponentUpdateStatus,
    pub shell: ComponentUpdateStatus,
    pub readiness: UpdateReadiness,
    // Compatibility fields for the bundled 0.2.0 bridge UI. New code reads
    // core/shell/readiness, but keeping these avoids breaking an old runtime
    // during the one-time 0.2.0 -> 0.2.1 bootstrap installation.
    pub dsh_current: Option<String>,
    pub dsh_latest: Option<String>,
    pub dsh_update_available: bool,
    pub app_current: String,
    pub app_latest: Option<String>,
    pub app_update_available: bool,
    pub app_url: Option<String>,
    pub app_repo: Option<String>,
}

fn parse_version(value: &str) -> Option<Version> {
    Version::parse(value.trim().trim_start_matches('v')).ok()
}

fn version_is_newer(current: &str, latest: &str) -> bool {
    matches!((parse_version(current), parse_version(latest)), (Some(c), Some(l)) if l > c)
}

fn should_preserve_installed_dsh(installed: Option<&str>, shipped: Option<&str>) -> bool {
    matches!((installed, shipped), (Some(installed), Some(shipped)) if version_is_newer(shipped, installed))
}

/// Shared update-status query: npm registry (dsh core) + optional GitHub repo (shell).
async fn fetch_update_status(
    client: &reqwest::Client,
    paths: &Paths,
    _config: &AppConfig,
) -> Result<UpdateStatus, String> {
    let dsh_current = fs::read_to_string(paths.runtime_dir.join("version.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("dsh").and_then(|v| v.as_str()).map(String::from));

    let mut dsh_latest = None;
    match client
        .get("https://registry.npmjs.org/@deepseek-ai/dsh/latest")
        .header("Accept", "application/json")
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            if let Ok(v) = resp.json::<serde_json::Value>().await {
                dsh_latest = v.get("version").and_then(|v| v.as_str()).map(String::from);
            }
        }
        Ok(resp) => return Err(format!("npm registry 返回 {}", resp.status())),
        Err(e) => return Err(format!("查询 dsh 最新版本失败: {e}")),
    }

    // update_repo is retained in AppConfig for backwards-compatible parsing,
    // but production installs always check the official signed release line.
    let repo = Some(DEFAULT_UPDATE_REPO.to_string());
    let mut app_latest = None;
    let mut app_url = None;
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
                }
            }
            Ok(resp) => return Err(format!("GitHub API 返回 {}（仓库 {repo}）", resp.status())),
            Err(e) => return Err(format!("查询 GitHub Releases 失败: {e}")),
        }
    }

    let app_current = env!("CARGO_PKG_VERSION").to_string();
    let dsh_update_available = matches!((&dsh_latest, &dsh_current), (Some(l), Some(c)) if version_is_newer(c, l));
    let app_update_available = matches!(&app_latest, Some(l) if version_is_newer(&app_current, l));
    Ok(UpdateStatus {
        core: ComponentUpdateStatus {
            current: dsh_current.clone(),
            latest: dsh_latest.clone(),
            update_available: dsh_update_available,
            release_url: None,
            notes: None,
        },
        shell: ComponentUpdateStatus {
            current: Some(app_current.clone()),
            latest: app_latest.clone(),
            update_available: app_update_available,
            release_url: app_url.clone(),
            notes: None,
        },
        readiness: UpdateReadiness::default(),
        dsh_update_available,
        app_update_available,
        dsh_current,
        dsh_latest,
        app_current,
        app_latest,
        app_url,
        app_repo: repo,
    })
}

#[tauri::command]
async fn check_update(app: AppHandle, state: State<'_, AppState>) -> Result<UpdateStatus, String> {
    check_update_impl(&app, &state).await
}

async fn check_update_impl(app: &AppHandle, state: &AppState) -> Result<UpdateStatus, String> {
    let config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(app, &config);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端失败: {e}"))?;
    let mut status = fetch_update_status(&client, &paths, &config).await?;
    // A signed updater manifest is authoritative when available. The GitHub
    // release query above remains a bootstrap fallback for 0.2.0 installs and
    // development environments before latest.json has been published.
    if let Ok(updater) = app.updater() {
        if let Ok(update) = updater.check().await {
            match update {
                Some(update) => {
                    status.shell.latest = Some(update.version.clone());
                    status.shell.notes = update.body.clone();
                    status.shell.update_available = version_is_newer(&status.app_current, &update.version);
                    status.app_latest = Some(update.version);
                    status.app_update_available = status.shell.update_available;
                }
                None => {
                    status.shell.update_available = false;
                    status.app_update_available = false;
                }
            }
        }
    }
    status.readiness = update_readiness(state, &paths, &config).await;
    Ok(status)
}

async fn dsh_task_running(config: &AppConfig) -> bool {
    let url = format!("{}desktop/status", dsh_web_url(dsh_port(config)));
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    match client.get(url).send().await {
        Ok(response) => response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|value| value.get("running").and_then(|running| running.as_bool()))
            .unwrap_or(false),
        Err(_) => false,
    }
}

async fn update_readiness(state: &AppState, paths: &Paths, config: &AppConfig) -> UpdateReadiness {
    let task_running = dsh_task_running(config).await;
    let adopted = state.adopted.load(Ordering::SeqCst);
    let core_update_in_progress = state.core_update_in_progress.load(Ordering::SeqCst);
    let shell_update_in_progress = state.shell_update_in_progress.load(Ordering::SeqCst);
    let pending_verification = read_pending_update(&paths.runtime_dir).is_some();
    readiness_from_flags(
        task_running,
        adopted,
        core_update_in_progress,
        shell_update_in_progress,
        pending_verification,
    )
}

fn readiness_from_flags(
    task_running: bool,
    adopted: bool,
    core_update_in_progress: bool,
    shell_update_in_progress: bool,
    pending_verification: bool,
) -> UpdateReadiness {
    let reason = if core_update_in_progress {
        Some("dsh 内核更新正在进行".to_string())
    } else if shell_update_in_progress {
        Some("桌面应用更新正在进行".to_string())
    } else if pending_verification {
        Some("dsh 内核更新仍在验证，请等待验证完成".to_string())
    } else if task_running {
        Some("当前任务结束后可更新".to_string())
    } else {
        None
    };
    let common_ready = reason.is_none();
    let core_reason = if adopted {
        Some("当前正在接管外部 DSH 实例，请停止外部实例后再更新内核".to_string())
    } else {
        reason.clone()
    };
    UpdateReadiness {
        ready: common_ready,
        reason: reason.clone(),
        core_ready: common_ready && !adopted,
        shell_ready: common_ready,
        core_reason,
        shell_reason: reason,
        task_running,
        adopted,
        core_update_in_progress,
        shell_update_in_progress,
        pending_verification,
    }
}

#[tauri::command]
async fn get_update_readiness(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<UpdateReadiness, String> {
    let config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(&app, &config);
    Ok(update_readiness(&state, &paths, &config).await)
}

/// Stage, verify, swap, and roll back a dsh runtime update from an npm
/// tarball. Pure filesystem logic — unit-tested below.
/// Pending-update verification record: survives app restarts so a broken
/// update is always verified (and rolled back) on the next boot too.
#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum UpdatePhase {
    Prepared,
    OldMoved,
    Swapped,
}

impl Default for UpdatePhase {
    // 0.2.0 records were written only after the swap, so a missing phase in a
    // legacy record means the new runtime is awaiting verification.
    fn default() -> Self {
        Self::Swapped
    }
}

#[derive(Serialize, Deserialize, Clone)]
struct UpdateBackupInfo {
    backup: String,
    previous_version: String,
    #[serde(default)]
    new_version: String,
    #[serde(default)]
    phase: UpdatePhase,
    #[serde(default)]
    stage: String,
}

fn update_backup_file(runtime: &Path) -> PathBuf {
    runtime.join(".update-backup.json")
}

fn write_pending_update(runtime: &Path, info: &UpdateBackupInfo) -> Result<(), String> {
    let target = update_backup_file(runtime);
    let temp = runtime.join(".update-backup.tmp");
    let bytes = serde_json::to_vec_pretty(info).map_err(|e| format!("序列化更新事务失败: {e}"))?;
    write_file_atomically(&target, &temp, &bytes).map_err(|e| format!("提交更新事务失败: {e}"))
}

fn write_file_atomically(target: &Path, temp: &Path, bytes: &[u8]) -> std::io::Result<()> {
    fs::write(temp, bytes)?;
    atomic_replace_file(temp, target)
}

#[cfg(target_os = "windows")]
fn atomic_replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    if !target.exists() {
        return fs::rename(source, target);
    }
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let replaced = unsafe {
        ReplaceFileW(
            target_wide.as_ptr(),
            source_wide.as_ptr(),
            std::ptr::null(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if replaced == 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }
}

#[cfg(not(target_os = "windows"))]
fn atomic_replace_file(source: &Path, target: &Path) -> std::io::Result<()> {
    fs::rename(source, target)
}

fn read_pending_update(runtime: &Path) -> Option<UpdateBackupInfo> {
    fs::read_to_string(update_backup_file(runtime))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn clear_pending_update(runtime: &Path) {
    let _ = fs::remove_file(update_backup_file(runtime));
    let _ = fs::remove_file(runtime.join(".update-backup.tmp"));
}

fn dsh_manifest_version(dsh_dir: &Path) -> Option<String> {
    fs::read_to_string(
        dsh_dir
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("package.json"),
    )
    .ok()
    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    .and_then(|value| value.get("version").and_then(|value| value.as_str()).map(str::to_owned))
}

/// Repair a process crash in the small window between transaction journal
/// writes and directory renames. This runs before runtime extraction/spawn.
fn recover_interrupted_update(runtime: &Path, log: &Path) -> Result<(), String> {
    let Some(info) = read_pending_update(runtime) else {
        return Ok(());
    };
    let dsh = runtime.join("dsh");
    let backup = PathBuf::from(&info.backup);
    match info.phase {
        UpdatePhase::Prepared => {
            if !dsh.exists() && backup.exists() {
                fs::rename(&backup, &dsh).map_err(|e| format!("恢复更新前内核失败: {e}"))?;
            }
            if dsh_manifest_version(&dsh).as_deref() == Some(info.new_version.as_str())
                && backup.exists()
            {
                let mut swapped = info.clone();
                swapped.phase = UpdatePhase::Swapped;
                write_pending_update(runtime, &swapped)?;
                return Ok(());
            }
            if !info.stage.is_empty() {
                let _ = fs::remove_dir_all(&info.stage);
            }
            clear_pending_update(runtime);
            log_line(log, "recovered prepared dsh update transaction");
        }
        UpdatePhase::OldMoved => {
            if !dsh.exists() && backup.exists() {
                fs::rename(&backup, &dsh).map_err(|e| format!("恢复中断的内核更新失败: {e}"))?;
                if !info.stage.is_empty() {
                    let _ = fs::remove_dir_all(&info.stage);
                }
                clear_pending_update(runtime);
                log_line(log, "restored dsh after interrupted directory swap");
            } else if dsh_manifest_version(&dsh).as_deref() == Some(info.new_version.as_str()) {
                let mut swapped = info;
                swapped.phase = UpdatePhase::Swapped;
                write_pending_update(runtime, &swapped)?;
            }
        }
        UpdatePhase::Swapped => {
            if !dsh.exists() && backup.exists() {
                fs::rename(&backup, &dsh).map_err(|e| format!("恢复待验证内核失败: {e}"))?;
                clear_pending_update(runtime);
                log_line(log, "restored missing dsh from pending verification backup");
            } else if !backup.exists() {
                // A crash after successful backup cleanup but before journal
                // cleanup is already committed; remove the stale record.
                clear_pending_update(runtime);
            }
        }
    }
    Ok(())
}

fn apply_dsh_tarball_bytes(
    runtime: &Path,
    plugins_src_dir: &Path,
    node_exe: Option<&Path>,
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
    let package_new = stage.join("package-new");
    let mut no_progress = |_count: usize| {};
    extract_tarball(&tgz_path, &package_new, true, &mut no_progress)?;

    // An npm tarball contains the package itself at `package/`, while a
    // runnable desktop runtime needs npm's installed layout below
    // `node_modules/@deepseek-ai/dsh` plus its transitive dependencies.
    // Installing the already-downloaded tarball avoids a second download of
    // dsh and lets npm resolve any dependencies added by a new release.
    let package_manifest = package_new.join("package.json");
    let new_version = fs::read_to_string(&package_manifest)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .filter(|v| v.get("name").and_then(|name| name.as_str()) == Some("@deepseek-ai/dsh"))
        .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(String::from))
        .ok_or("更新包校验失败：不是有效的 @deepseek-ai/dsh npm 包")?;

    let dsh_new = stage.join("dsh-new");
    if let Some(node_exe) = node_exe {
        let npm_cli = node_exe
            .parent()
            .map(|dir| dir.join("node_modules/npm/bin/npm-cli.js"))
            .ok_or("找不到内置 npm")?;
        if !npm_cli.is_file() {
            return Err(format!("找不到内置 npm: {}", npm_cli.display()));
        }
        // npm is a second Windows process.  Without CREATE_NO_WINDOW it can
        // attach to the desktop console and leave a seemingly frozen terminal
        // in front of the settings window while the synchronous install runs.
        // Keep npm quiet and deterministic; its complete output is still
        // copied into the desktop log for diagnosis.
        let mut npm_cmd = Command::new(node_exe);
        npm_cmd
            .arg(&npm_cli)
            .arg("install")
            .arg("--prefix")
            .arg(&dsh_new)
            .arg("--ignore-scripts")
            .arg("--no-audit")
            .arg("--no-fund")
            .arg("--no-progress")
            .arg("--no-package-lock")
            .arg("--prefer-offline")
            .arg("--fetch-retries=1")
            .arg("--fetch-timeout=30000")
            .arg("--fetch-retry-maxtimeout=30000")
            .arg("--loglevel=error")
            .arg(&tgz_path)
            .env("npm_config_loglevel", "warn")
            .env("npm_config_progress", "false")
            .env("npm_config_update_notifier", "false")
            // Do not pipe npm output without concurrently draining it: a
            // verbose npm failure can fill the OS pipe and deadlock the child.
            // npm keeps its detailed report in its cache logs; we record the
            // exit status here and return it to the settings UI.
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            npm_cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut npm_child = npm_cmd
            .spawn()
            .map_err(|e| format!("安装 dsh 更新包失败: {e}"))?;
        // `Command::output()` has no deadline.  A stalled registry socket or
        // npm resolver could therefore leave the Tauri invoke pending forever.
        // Poll the child and kill it after five minutes so the caller receives
        // an actionable error and the old runtime remains untouched.
        let npm_deadline = Instant::now() + Duration::from_secs(300);
        let npm_status = loop {
            match npm_child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < npm_deadline => {
                    thread::sleep(Duration::from_millis(250));
                }
                Ok(None) => {
                    let _ = npm_child.kill();
                    let _ = npm_child.wait();
                    return Err(
                        "安装 dsh 更新包超时（5 分钟），已取消本次更新；请检查网络或 npm 源后重试"
                            .to_string(),
                    );
                }
                Err(e) => {
                    let _ = npm_child.kill();
                    let _ = npm_child.wait();
                    return Err(format!("读取 npm 安装状态失败: {e}"));
                }
            }
        };
        log_line(log, &format!("npm install finished: {npm_status}"));
        if !npm_status.success() {
            return Err(format!(
                "安装 dsh 更新包失败（退出码 {:?}）。请检查网络或 npm 源后重试",
                npm_status.code()
            ));
        }
    } else {
        // Unit tests exercise the archive layout without a bundled Node/npm.
        let target = dsh_new.join("node_modules/@deepseek-ai/dsh");
        fs::create_dir_all(&target).map_err(|e| format!("创建安装目录失败: {e}"))?;
        copy_dir_contents(&package_new, &target)
            .map_err(|e| format!("部署 dsh 更新包失败: {e}"))?;
    }

    // restore the desktop plugin packages (and the bundled vision plugin)
    // into the new tree — the canonical copies live in the bundled runtime
    // (the install dir) even when the extracted tree lives elsewhere.
    let plugins_src = plugins_src_dir.join("plugins-src");
    if plugins_src.exists() {
        for name in DESKTOP_PLUGINS
            .iter()
            .copied()
            .chain(std::iter::once(VISION_PLUGIN))
            .chain(MARKET_PLUGIN_RUNTIME_PACKAGES.iter().copied())
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
            fs::copy(&from, bdst.join(f)).map_err(|e| format!("恢复桥接插件失败: {e}"))?;
        }
    }

    // Verify npm produced the runtime layout the launcher uses.
    let manifest_path = dsh_new
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    let installed_version = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("version").and_then(|v| v.as_str()).map(String::from))
        .ok_or("更新包校验失败：缺少 @deepseek-ai/dsh")?;
    if installed_version != new_version {
        return Err(format!(
            "更新包校验失败：安装版本 {installed_version} 与下载版本 {new_version} 不一致"
        ));
    }

    // swap with backup; the backup is KEPT until the new runtime proves it
    // can boot — verify_update_rollback deletes it on success and restores it
    // on failure (including across app restarts).
    let dsh_dir = runtime.join("dsh");
    let previous_version = dsh_manifest_version(&dsh_dir)
        .ok_or("当前 dsh 运行时缺少有效版本，已取消更新")?;

    let backup = runtime.join(format!(
        "dsh-old-{}",
        chrono::Local::now().format("%Y%m%d%H%M%S")
    ));
    let mut transaction = UpdateBackupInfo {
        backup: backup.to_string_lossy().to_string(),
        previous_version: previous_version.clone(),
        new_version: installed_version.clone(),
        phase: UpdatePhase::Prepared,
        stage: stage.to_string_lossy().to_string(),
    };
    write_pending_update(runtime, &transaction)?;
    fs::rename(&dsh_dir, &backup).map_err(|e| {
        clear_pending_update(runtime);
        format!("备份旧版本失败: {e}")
    })?;
    transaction.phase = UpdatePhase::OldMoved;
    if let Err(error) = write_pending_update(runtime, &transaction) {
        let _ = fs::rename(&backup, &dsh_dir);
        clear_pending_update(runtime);
        return Err(error);
    }
    if let Err(e) = fs::rename(&dsh_new, &dsh_dir) {
        let _ = fs::rename(&backup, &dsh_dir);
        let _ = fs::remove_dir_all(&stage);
        clear_pending_update(runtime);
        return Err(format!("替换失败，已回滚: {e}"));
    }
    transaction.phase = UpdatePhase::Swapped;
    if let Err(error) = write_pending_update(runtime, &transaction) {
        let _ = fs::remove_dir_all(&dsh_dir);
        let _ = fs::rename(&backup, &dsh_dir);
        clear_pending_update(runtime);
        return Err(error);
    }

    // bump version.json
    let version_file = runtime.join("version.json");
    let mut vjson: serde_json::Value = fs::read_to_string(&version_file)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::json!({}));
    vjson["dsh"] = serde_json::Value::String(installed_version.clone());
    let version_bytes = serde_json::to_vec_pretty(&vjson)
        .map_err(|e| format!("序列化运行时版本失败: {e}"))?;
    if let Err(error) = write_file_atomically(
        &version_file,
        &runtime.join(".version-update.tmp"),
        &version_bytes,
    ) {
        let _ = fs::remove_dir_all(&dsh_dir);
        let _ = fs::rename(&backup, &dsh_dir);
        clear_pending_update(runtime);
        return Err(format!("写入运行时版本失败，已回滚: {error}"));
    }
    let _ = fs::remove_dir_all(&stage);
    log_line(
        log,
        &format!(
            "dsh swapped to {installed_version} (previous {previous_version} kept for verification)"
        ),
    );
    Ok(format!("dsh 已更新到 {installed_version}（正在验证…）"))
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
    let url = format!("{}desktop/status", dsh_web_url(dsh_port(&config)));
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };

    let deadline = Instant::now() + Duration::from_secs(60);
    let mut healthy_ever = false;
    let mut healthy_streak = 0u8;
    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let healthy = client
            .get(&url)
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        let expected_version = read_pending_update(&paths.runtime_dir)
            .map(|info| info.new_version)
            .unwrap_or_default();
        let version_matches = !expected_version.is_empty()
            && dsh_manifest_version(&paths.runtime_dir.join("dsh")).as_deref()
                == Some(expected_version.as_str());
        if healthy && version_matches {
            healthy_ever = true;
            healthy_streak = healthy_streak.saturating_add(1);
        } else {
            healthy_streak = 0;
        }
        let own_child = state.dsh.lock().unwrap().child.is_some();
        let adopted = state.adopted.load(Ordering::SeqCst);

        if healthy_streak >= 2 && own_child && !adopted {
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
            let version_restored = fs::read_to_string(&version_file)
                .ok()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                .and_then(|mut value| {
                    value["dsh"] = serde_json::Value::String(info.previous_version.clone());
                    serde_json::to_vec_pretty(&value).ok()
                })
                .ok_or_else(|| "无法生成回滚版本记录".to_string())
                .and_then(|bytes| {
                    write_file_atomically(
                        &version_file,
                        &paths.runtime_dir.join(".version-rollback.tmp"),
                        &bytes,
                    )
                    .map_err(|error| format!("恢复版本记录失败: {error}"))
                });
            if let Err(error) = version_restored {
                log_line(&paths.log_file, &format!("ROLLBACK VERSION WRITE FAILED: {error}"));
                let _ = app.emit(
                    "update-rollback",
                    format!("内核目录已回滚，但版本记录恢复失败：{error}"),
                );
                return;
            }
            ensure_runtime_files(&paths);
            let restart_result = spawn_dsh(&paths, &config);
            {
                let mut dsh = state.dsh.lock().unwrap();
                match restart_result {
                    Ok(c) => dsh.child = Some(c),
                    Err(e) => log_line(&paths.log_file, &format!("rollback restart failed: {e}")),
                }
            }
            let mut rollback_healthy = false;
            for _ in 0..10 {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let responding = client
                    .get(&url)
                    .send()
                    .await
                    .map(|response| response.status().is_success())
                    .unwrap_or(false);
                let version_matches = dsh_manifest_version(&paths.runtime_dir.join("dsh")).as_deref()
                    == Some(info.previous_version.as_str());
                if responding && version_matches && state.dsh.lock().unwrap().child.is_some() {
                    rollback_healthy = true;
                    break;
                }
            }
            clear_pending_update(&paths.runtime_dir);
            log_line(
                &paths.log_file,
                &format!(
                    "rollback complete — dsh restarted on {}",
                    info.previous_version
                ),
            );
            let detail = if rollback_healthy {
                format!("新版 dsh 无法启动，已自动回滚到 {}，服务已恢复。", info.previous_version)
            } else {
                format!("已回滚到 {}，但回滚后验证失败，服务仍不可访问，请查看日志。", info.previous_version)
            };
            let _ = app.emit("update-rollback", detail);
        }
        Err(e) => {
            log_line(&paths.log_file, &format!("ROLLBACK FAILED: {e}"));
            let _ = app.emit("update-rollback", "自动回滚失败！请查看日志并手动处理。");
        }
    }
}

struct AtomicFlagGuard<'a>(&'a AtomicBool);

impl Drop for AtomicFlagGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

#[derive(Clone)]
struct NpmUpdatePackage {
    version: String,
    tarball: String,
    integrity: String,
}

fn parse_npm_update_metadata(
    value: &serde_json::Value,
    current_version: &str,
) -> Result<NpmUpdatePackage, String> {
    if value.get("name").and_then(|value| value.as_str()) != Some("@deepseek-ai/dsh") {
        return Err("npm metadata 包名不匹配".to_string());
    }
    let version = value
        .get("version")
        .and_then(|value| value.as_str())
        .ok_or("npm metadata 缺少版本")?;
    if !version_is_newer(current_version, version) {
        return Err(format!("拒绝安装非升级版本: {current_version} -> {version}"));
    }
    let tarball = value
        .pointer("/dist/tarball")
        .and_then(|value| value.as_str())
        .ok_or("npm metadata 缺少 tarball")?;
    if !tarball.starts_with("https://registry.npmjs.org/@deepseek-ai/dsh/-/")
        || !tarball.ends_with(".tgz")
    {
        return Err("npm tarball 地址不受信任".to_string());
    }
    let integrity = value
        .pointer("/dist/integrity")
        .and_then(|value| value.as_str())
        .ok_or("npm metadata 缺少 dist.integrity")?;
    if !integrity.starts_with("sha512-") {
        return Err("npm 更新包必须提供 SHA-512 integrity".to_string());
    }
    Ok(NpmUpdatePackage {
        version: version.to_string(),
        tarball: tarball.to_string(),
        integrity: integrity.to_string(),
    })
}

fn verify_npm_integrity(bytes: &[u8], integrity: &str) -> Result<(), String> {
    let encoded = integrity
        .strip_prefix("sha512-")
        .ok_or("不支持的 npm integrity 算法")?;
    let expected = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "npm integrity 编码无效".to_string())?;
    let actual = Sha512::digest(bytes);
    if actual.as_slice() != expected.as_slice() {
        return Err("dsh 更新包完整性校验失败".to_string());
    }
    Ok(())
}

#[tauri::command]
async fn apply_shell_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state
        .shell_update_in_progress
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "桌面应用更新正在进行".to_string())?;
    let _gate = AtomicFlagGuard(&state.shell_update_in_progress);
    let config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(&app, &config);
    if state.core_update_in_progress.load(Ordering::SeqCst) {
        return Err("dsh 内核更新正在进行".to_string());
    }
    if read_pending_update(&paths.runtime_dir).is_some() {
        return Err("dsh 内核更新仍在验证，请等待验证完成".to_string());
    }
    if dsh_task_running(&config).await {
        return Err("当前任务结束后可更新".to_string());
    }
    let update = app
        .updater()
        .map_err(|error| format!("初始化签名更新器失败: {error}"))?
        .check()
        .await
        .map_err(|error| format!("检查签名更新失败: {error}"))?
        .ok_or("桌面应用已是最新版本")?;
    if !version_is_newer(env!("CARGO_PKG_VERSION"), &update.version) {
        return Err("拒绝安装非升级版本".to_string());
    }
    let progress_app = app.clone();
    let finish_app = app.clone();
    let mut downloaded = 0u64;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let _ = progress_app.emit(
                    "shell-update-progress",
                    serde_json::json!({
                        "stage": "download",
                        "downloaded": downloaded,
                        "total": total,
                        "detail": "正在下载并校验桌面应用更新…"
                    }),
                );
            },
            move || {
                let _ = finish_app.emit(
                    "shell-update-progress",
                    serde_json::json!({
                        "stage": "install",
                        "detail": "签名校验通过，正在安装并重启…"
                    }),
                );
            },
        )
        .await
        .map_err(|error| format!("安装桌面应用更新失败: {error}"))?;
    app.restart();
}

#[tauri::command]
async fn apply_dsh_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    state
        .core_update_in_progress
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map_err(|_| "dsh 内核更新正在进行".to_string())?;
    let _gate = AtomicFlagGuard(&state.core_update_in_progress);
    let config = state.config.lock().unwrap().clone();
    let paths = resolve_paths(&app, &config);
    let runtime = paths.runtime_dir.clone();
    let log = paths.log_file.clone();
    if state.shell_update_in_progress.load(Ordering::SeqCst) {
        return Err("桌面应用更新正在进行".to_string());
    }
    if state.adopted.load(Ordering::SeqCst) {
        return Err("当前正在接管外部 DSH 实例，请先停止外部实例再更新内核".to_string());
    }
    if read_pending_update(&runtime).is_some() {
        return Err("上一次 dsh 更新仍在验证，请等待完成".to_string());
    }
    if dsh_task_running(&config).await {
        return Err("当前任务结束后可更新".to_string());
    }
    let current_version = fs::read_to_string(runtime.join("version.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| value.get("dsh").and_then(|value| value.as_str()).map(str::to_owned))
        .ok_or("无法读取当前 dsh 版本")?;
    let metadata_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let metadata = metadata_client
        .get("https://registry.npmjs.org/@deepseek-ai/dsh/latest")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("查询 dsh 更新失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("查询 dsh 更新失败: {e}"))?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("解析 dsh 更新信息失败: {e}"))?;
    let package = parse_npm_update_metadata(&metadata, &current_version)?;

    log_line(&log, &format!("applying verified dsh update: {}", package.version));
    let _ = app.emit(
        "update-progress",
        serde_json::json!({ "stage": "download", "detail": "正在下载 dsh 更新包…" }),
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(&package.tarball)
        .send()
        .await
        .map_err(|e| format!("下载失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("下载失败: {e}"))?;
    let total = response.content_length();
    let mut bytes = Vec::with_capacity(total.unwrap_or(0).min(usize::MAX as u64) as usize);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("下载失败: {e}"))?
    {
        bytes.extend_from_slice(&chunk);
        let _ = app.emit(
            "update-progress",
            serde_json::json!({
                "stage": "download",
                "downloaded": bytes.len(),
                "total": total,
                "detail": "正在下载并校验 dsh 更新包…"
            }),
        );
    }
    verify_npm_integrity(&bytes, &package.integrity)?;
    log_line(
        &log,
        &format!("downloaded dsh update archive ({} bytes)", bytes.len()),
    );
    let _ = app.emit(
        "update-progress",
        serde_json::json!({ "stage": "install", "detail": "正在安装更新依赖，网络异常时会在约 30 秒内失败…" }),
    );

    let result = apply_dsh_tarball_bytes(
        &runtime,
        &paths.bundled_runtime_dir,
        Some(&paths.node_exe),
        &bytes,
        &log,
    )?;
    // redeploy bridge/patch into DSH_HOME so the next boot picks everything up
    ensure_runtime_files(&paths);

    // Return the invoke response before killing DSH, otherwise the bridge hop
    // carrying this response is severed and the UI reports Failed to fetch.
    let app2 = app.clone();
    let paths2 = paths.clone();
    let config2 = config.clone();
    let log2 = log.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(750)).await;
        {
            let state2 = app2.state::<AppState>();
            let mut dsh = state2.dsh.lock().unwrap();
            dsh.restarts = 0;
            if let Some(mut child) = dsh.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            match spawn_dsh(&paths2, &config2) {
                Ok(child) => dsh.child = Some(child),
                Err(error) => log_line(&log2, &format!("restart after update failed: {error}")),
            }
        }
        log_line(&log2, "dsh child restarted on the updated runtime");
        let _ = app2.emit(
            "update-progress",
            serde_json::json!({ "stage": "verify", "detail": "更新已安装，正在验证服务…" }),
        );
        verify_update_rollback(app2.clone()).await;
    });

    Ok(format!(
        "{result} 即将重启内置服务；新内核将在 60 秒内完成健康验证，失败会自动回滚。"
    ))
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
    let settings = MenuItemBuilder::with_id("settings", "设置").build(app)?;
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState {
            dsh: Mutex::new(DshProcess {
                child: None,
                restarts: 0,
            }),
            relay: Mutex::new(RelayProcess { child: None }),
            remote_online: AtomicBool::new(false),
            adopted: AtomicBool::new(false),
            ui_ready: AtomicBool::new(false),
            bridge_ok: AtomicBool::new(false),
            runtime_ready: AtomicBool::new(false),
            balance: Mutex::new(None),
            providers: Mutex::new(None),
            adapters: Mutex::new(HashMap::new()),
            config: Mutex::new(AppConfig::default()),
            recent_task_notifications: Mutex::new(HashMap::new()),
            last_refresh: Mutex::new(None),
            last_update_check: Mutex::new(None),
            core_update_in_progress: AtomicBool::new(false),
            shell_update_in_progress: AtomicBool::new(false),
            tray_balance_item: Mutex::new(None),
            tray_autostart_item: Mutex::new(None),
            spawned_at: Mutex::new(None),
            relay_respawn_at: Mutex::new(None),
            startup_conflict: Mutex::new(None),
            startup_decision: Mutex::new(None),
            startup_decision_cv: Condvar::new(),
            startup_pending: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_startup_conflict,
            choose_startup_mode,
            set_api_key,
            configure_bailian,
            refresh_balance_cmd,
            open_logs,
            open_dsh_home,
            open_external,
            open_settings_window,
            check_update,
            get_update_readiness,
            apply_dsh_update,
            apply_shell_update,
            get_autostart,
            set_autostart,
            set_motion_intensity,
            get_remote_config,
            save_remote_config,
            get_remote_pairing
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

            // Inspect every desktop-owned listener before binding anything.
            // A fully working earlier desktop instance needs an explicit user
            // choice; a partial/orphaned set is reclaimed automatically so it
            // cannot block this shell's complete service graph.
            let startup_ports = startup_port_statuses(&config);
            let occupied: Vec<_> = startup_ports.iter().filter(|p| p.occupied).cloned().collect();
            if !occupied.is_empty() {
                if startup_instance_complete(&startup_ports, config.remote_enabled) {
                    log_line(&paths.log_file, "complete desktop service instance detected; waiting for startup mode selection");
                    *app.state::<AppState>().startup_conflict.lock().unwrap() = Some(StartupConflict { ports: startup_ports.clone() });
                    app.state::<AppState>().startup_pending.store(true, Ordering::SeqCst);
                } else {
                    log_line(&paths.log_file, "incomplete desktop port occupancy detected; stopping owners before full startup");
                    stop_port_owners(&occupied)?;
                }
            }

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
                if state.startup_pending.load(Ordering::SeqCst) {
                    let _ = app2.emit_to("main", "dsh-startup-conflict", ());
                    let app_wait = app2.clone();
                    let mode = tauri::async_runtime::spawn_blocking(move || {
                        wait_for_startup_decision(&app_wait.state::<AppState>())
                    })
                        .await
                        .unwrap_or(StartupMode::Independent);
                    let config2 = state.config.lock().unwrap().clone();
                    let ports = startup_port_statuses(&config2);
                    let occupied: Vec<_> = ports.into_iter().filter(|p| p.occupied).collect();
                    match mode {
                        StartupMode::UseExisting => {
                            state.adopted.store(true, Ordering::SeqCst);
                            state.runtime_ready.store(true, Ordering::SeqCst);
                            state.startup_pending.store(false, Ordering::SeqCst);
                            let paths = resolve_paths(&app2, &config2);
                            log_line(&paths.log_file, "startup mode selected: use existing complete desktop instance");
                            return;
                        }
                        StartupMode::Independent => {
                            let paths = resolve_paths(&app2, &config2);
                            log_line(&paths.log_file, "startup mode selected: independent; stopping complete existing desktop instance");
                            if let Err(e) = tauri::async_runtime::spawn_blocking(move || stop_port_owners(&occupied)).await
                                .unwrap_or_else(|e| Err(format!("结束已有实例任务失败: {e}"))) {
                                log_line(&paths.log_file, &format!("startup port cleanup failed: {e}"));
                                let _ = app2.emit_to("main", "dsh-failed", serde_json::json!({ "kind": "startup-conflict", "message": e }));
                                state.startup_pending.store(false, Ordering::SeqCst);
                                return;
                            }
                        }
                    }
                    state.startup_pending.store(false, Ordering::SeqCst);
                }
                let paths = resolve_paths(&app2, &boot_cfg);
                let url = dsh_web_url(dsh_port(&boot_cfg));

                // Pre-probe the port before doing anything expensive. When an
                // instance already serves it (a CLI `dsh web` sharing the same
                // home, a double launch), adopt it instead of booting a doomed
                // child that loads the whole plugin tree and then dies on
                // EADDRINUSE — a 3–60 s waste that also competes with the
                // loading UI for I/O. Readiness is owned by the health loop,
                // which probes from its very first tick, so a healthy port
                // also stops delaying the UI on first-run extraction.
                let probe_client = reqwest::Client::builder()
                    .timeout(Duration::from_secs(2))
                    .build()
                    .ok();
                let probe = || async {
                    match &probe_client {
                        Some(client) => client
                            .get(&url)
                            .send()
                            .await
                            .map(|r| r.status().is_success() || r.status().is_server_error())
                            .unwrap_or(false),
                        None => false,
                    }
                };
                if probe().await {
                    state.adopted.store(true, Ordering::SeqCst);
                    log_line(
                        &paths.log_file,
                        "dsh port already served by another instance — skipping child spawn (adopted)",
                    );
                    // An external/previous DSH is already healthy, so do not
                    // make the visible launch compete with it for tens of
                    // thousands of file writes. Keep runtime preparation as a
                    // background recovery task instead.
                    if runtime_preparation_needed(&paths) {
                        let app3 = app2.clone();
                        let paths3 = paths.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(e) = extract_runtime_archive(&app3, &paths3) {
                                log_line(&paths3.log_file, &format!(
                                    "background runtime preparation failed: {e}"
                                ));
                            }
                        });
                    }
                    state.runtime_ready.store(true, Ordering::SeqCst);
                    return;
                }

                if runtime_preparation_needed(&paths) {
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
                    let extraction_start = Instant::now();
                    // Gzip extraction is CPU-bound: run it on the blocking pool
                    // so it cannot stall the tokio workers serving the UI.
                    let app3 = app2.clone();
                    let paths3 = paths.clone();
                    let result = tauri::async_runtime::spawn_blocking(move || {
                        extract_runtime_archive(&app3, &paths3)
                    })
                    .await
                    .unwrap_or_else(|e| Err(format!("解压任务失败: {e}")));
                    match result {
                        Ok(()) => log_line(
                            &paths.log_file,
                            &format!(
                                "runtime extraction complete in {:.1}s",
                                extraction_start.elapsed().as_secs_f64()
                            ),
                        ),
                        Err(e) => {
                            log_line(&paths.log_file, &format!("runtime extraction failed: {e}"));
                            // Keep runtime_ready false: the health loop must
                            // not respawn dsh when runtime extraction failed,
                            // because node/dsh are incomplete and those
                            // retries only obscure the real failure.
                            let _ = app2.emit_to(
                                "main",
                                "dsh-failed",
                                serde_json::json!({ "kind": "runtime-extraction", "message": e }),
                            );
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
                ensure_runtime_files(&paths);

                // The bridge belongs to the service graph and must be bound
                // only after an occupied/partial prior graph has been
                // reclaimed. Relay waits until the runtime is usable too.
                start_bridge_listener(app2.clone(), boot_cfg.bridge_shell_port);

                // Re-probe right before the spawn decision: an instance may
                // have come up while extraction ran (the health loop adopts it
                // and readies the UI meanwhile), and spawning now would only
                // waste a full plugin-tree boot on a doomed EADDRINUSE child.
                if probe().await {
                    state.adopted.store(true, Ordering::SeqCst);
                    log_line(
                        &paths.log_file,
                        "dsh port served by another instance — skipping child spawn (adopted during boot)",
                    );
                    state.runtime_ready.store(true, Ordering::SeqCst);
                    let app3 = app2.clone();
                    tauri::async_runtime::spawn(async move {
                        verify_update_rollback(app3).await;
                    });
                    return;
                }

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
                    Ok(child) => {
                        *state.spawned_at.lock().unwrap() = Some(Instant::now());
                        dsh.child = Some(child);
                    }
                    Err(e) => {
                        log_line(&paths.log_file, &format!("spawn failed: {e}"));
                        let _ = app2.emit_to("main", "dsh-status", format!("启动失败：{e}"));
                        // the health loop's respawn path retries (restart budget)
                    }
                }
                ensure_relay_client(&app2, &paths, &boot_cfg);
                // Signal the health loop only after extraction (if any) and the
                // initial spawn attempt are both done: its respawn path must
                // never double-spawn against this bootstrap task.
                state.runtime_ready.store(true, Ordering::SeqCst);
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
            // Kill the relay-client companion too — otherwise it survives
            // as an orphan on port 38659 and blocks the next instance.
            let mut relay = state.relay.lock().unwrap();
            if let Some(mut child) = relay.child.take() {
                let _ = child.kill();
                let _ = child.wait();
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
        for name in DESKTOP_PLUGINS {
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
    fn semver_update_comparison_is_strict() {
        assert!(version_is_newer("0.2.0", "0.2.1"));
        assert!(version_is_newer("0.2.1-rc.1", "0.2.1"));
        assert!(version_is_newer("0.2.1-beta.2", "0.2.1-beta.10"));
        assert!(!version_is_newer("0.2.1", "0.2.1"));
        assert!(!version_is_newer("0.2.1", "0.2.0"));
        assert!(!version_is_newer("not-a-version", "0.2.2"));
        assert!(!version_is_newer("0.2.1", "latest"));
    }

    #[test]
    fn npm_update_metadata_requires_official_matching_upgrade() {
        let valid = serde_json::json!({
            "name": "@deepseek-ai/dsh",
            "version": "0.2.2",
            "dist": {
                "tarball": "https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.2.tgz",
                "integrity": "sha512-AA=="
            }
        });
        let parsed = parse_npm_update_metadata(&valid, "0.2.1").unwrap();
        assert_eq!(parsed.version, "0.2.2");

        let mut wrong_name = valid.clone();
        wrong_name["name"] = serde_json::json!("dsh");
        assert!(parse_npm_update_metadata(&wrong_name, "0.2.1").is_err());
        let mut http = valid.clone();
        http["dist"]["tarball"] = serde_json::json!("http://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.2.tgz");
        assert!(parse_npm_update_metadata(&http, "0.2.1").is_err());
        let mut same = valid.clone();
        same["version"] = serde_json::json!("0.2.1");
        assert!(parse_npm_update_metadata(&same, "0.2.1").is_err());
        let mut downgrade = valid;
        downgrade["version"] = serde_json::json!("0.2.0");
        assert!(parse_npm_update_metadata(&downgrade, "0.2.1").is_err());
    }

    #[test]
    fn npm_integrity_rejects_tampering() {
        let bytes = b"verified dsh archive";
        let integrity = format!("sha512-{}", BASE64_STANDARD.encode(Sha512::digest(bytes)));
        assert!(verify_npm_integrity(bytes, &integrity).is_ok());
        assert!(verify_npm_integrity(b"tampered", &integrity).is_err());
        assert!(verify_npm_integrity(bytes, "sha256-invalid").is_err());
    }

    #[test]
    fn readiness_blocks_each_unsafe_state() {
        let busy = readiness_from_flags(true, false, false, false, false);
        assert!(!busy.core_ready && !busy.shell_ready);
        assert_eq!(busy.reason.as_deref(), Some("当前任务结束后可更新"));

        let adopted = readiness_from_flags(false, true, false, false, false);
        assert!(!adopted.core_ready && adopted.shell_ready);
        assert!(adopted.core_reason.unwrap().contains("外部 DSH"));

        let core = readiness_from_flags(false, false, true, false, false);
        assert!(!core.core_ready && !core.shell_ready);
        let shell = readiness_from_flags(false, false, false, true, false);
        assert!(!shell.core_ready && !shell.shell_ready);
        let pending = readiness_from_flags(false, false, false, false, true);
        assert!(!pending.core_ready && !pending.shell_ready);
    }

    #[test]
    fn shell_runtime_upgrade_preserves_only_newer_installed_dsh() {
        assert!(should_preserve_installed_dsh(Some("0.3.0"), Some("0.2.9")));
        assert!(!should_preserve_installed_dsh(Some("0.2.9"), Some("0.3.0")));
        assert!(!should_preserve_installed_dsh(Some("0.3.0"), Some("0.3.0")));
        assert!(!should_preserve_installed_dsh(None, Some("0.3.0")));
    }

    #[test]
    fn interrupted_update_recovers_owned_paths_by_phase() {
        for (index, phase) in [UpdatePhase::Prepared, UpdatePhase::OldMoved, UpdatePhase::Swapped]
            .into_iter()
            .enumerate()
        {
            let root = std::env::temp_dir().join(format!("dsh-recover-{}-{index}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            make_runtime(&root, "0.2.0");
            let backup = root.join(format!("owned-backup-{index}"));
            let stage = root.join(format!("owned-stage-{index}"));
            let unrelated = root.join(format!("unrelated-{index}"));
            fs::create_dir_all(&stage).unwrap();
            fs::create_dir_all(&unrelated).unwrap();
            fs::rename(root.join("dsh"), &backup).unwrap();
            write_pending_update(
                &root,
                &UpdateBackupInfo {
                    backup: backup.to_string_lossy().into_owned(),
                    previous_version: "0.2.0".into(),
                    new_version: "0.2.1".into(),
                    phase,
                    stage: stage.to_string_lossy().into_owned(),
                },
            )
            .unwrap();

            recover_interrupted_update(&root, &root.join("test.log")).unwrap();
            assert_eq!(dsh_manifest_version(&root.join("dsh")).as_deref(), Some("0.2.0"));
            assert!(unrelated.exists());
            let _ = fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn update_succeeds_and_restores_bridge() {
        let root = std::env::temp_dir().join(format!("dsh-upd-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        make_runtime(&root, "0.1.0-rc.5");

        let tarball = make_tarball(&[
            (
                "package/package.json",
                r#"{"name":"@deepseek-ai/dsh","version":"0.9.9"}"#,
            ),
            ("package/lib/bin.js", "// new runtime"),
        ]);
        let result = apply_dsh_tarball_bytes(&root, &root, None, &tarball, &root.join("test.log"));
        assert!(result.is_ok(), "update failed: {result:?}");

        // new tree in place
        let manifest =
            fs::read_to_string(root.join("dsh/node_modules/@deepseek-ai/dsh/package.json"))
                .unwrap();
        assert!(manifest.contains("0.9.9"));
        // every desktop plugin restored into the new tree, lib/ files included
        assert!(root
            .join("dsh/node_modules/dsh-desktop-bridge/index.js")
            .exists());
        assert!(root
            .join("dsh/node_modules/dsh-desktop-session-manager/index.js")
            .exists());
        assert!(root
            .join("dsh/node_modules/dsh-desktop-session-manager/lib/mod.js")
            .exists());
        assert!(root
            .join("dsh/node_modules/dsh-desktop-change-history/index.js")
            .exists());
        assert!(root
            .join("dsh/node_modules/dsh-desktop-change-history/lib/mod.js")
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
        assert_eq!(
            backups.len(),
            1,
            "backup must be kept for verification: {backups:?}"
        );
        // pending-verification record written
        let info = read_pending_update(&root).expect("pending update record");
        assert_eq!(info.previous_version, "0.1.0-rc.5");
        assert!(PathBuf::from(&info.backup).exists());
        // backup contains the OLD runtime
        assert!(PathBuf::from(&info.backup).join("lib/bin.js").exists());
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
        fs::write(
            bridge.join("package.json"),
            r#"{"name":"dsh-desktop-bridge"}"#,
        )
        .unwrap();
        fs::write(bridge.join("index.js"), "// bridge marker").unwrap();
        fs::write(bridge.join("client.js"), "// bridge client marker").unwrap();

        let tarball = make_tarball(&[(
            "package/package.json",
            r#"{"name":"@deepseek-ai/dsh","version":"0.9.9"}"#,
        )]);
        let result = apply_dsh_tarball_bytes(&root, &root, None, &tarball, &root.join("test.log"));
        assert!(result.is_ok(), "update failed: {result:?}");
        assert!(root
            .join("dsh/node_modules/dsh-desktop-bridge/index.js")
            .exists());
        assert!(root
            .join("dsh/node_modules/dsh-desktop-bridge/client.js")
            .exists());
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
        assert_eq!(
            fs::read_to_string(dest.join("node/node.exe")).unwrap(),
            "x\n"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_file_if_different_skips_identical_content() {
        let root = std::env::temp_dir().join(format!("dsh-copy-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let src = root.join("src.txt");
        let dst = root.join("dst.txt");

        // missing destination -> copied
        fs::write(&src, "same").unwrap();
        assert!(copy_file_if_different(&src, &dst).unwrap());
        assert_eq!(fs::read_to_string(&dst).unwrap(), "same");

        // identical content -> skipped, destination untouched
        let before = fs::metadata(&dst).unwrap().modified().unwrap();
        assert!(!copy_file_if_different(&src, &dst).unwrap());
        assert_eq!(fs::metadata(&dst).unwrap().modified().unwrap(), before);

        // changed content -> copied again
        fs::write(&src, "changed").unwrap();
        assert!(copy_file_if_different(&src, &dst).unwrap());
        assert_eq!(fs::read_to_string(&dst).unwrap(), "changed");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn patch_overlay_fills_home_layer_gap() {
        let root = std::env::temp_dir().join(format!("dsh-patch-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        // no home layer -> full rows
        let full = desktop_patch_overlay(&root, &HashSet::new());
        assert!(full.contains("searchProvider: desktop-priority"));
        for name in DESKTOP_PLUGINS {
            assert!(
                full.contains(&format!("id: {name}")),
                "full overlay missing {name}"
            );
        }

        // home layer mounts every desktop plugin -> empty insert (no duplicate loader ids)
        let all_ids = DESKTOP_PLUGINS
            .iter()
            .map(|name| format!("    - id: {name}"))
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(
            root.join("cordis.patch.yml"),
            format!("- insert:\n{all_ids}\n"),
        )
        .unwrap();
        let empty = desktop_patch_overlay(&root, &HashSet::new());
        assert!(empty.contains("searchProvider: desktop-priority"));
        assert!(
            empty.contains("- insert: []"),
            "expected empty insert, got: {empty}"
        );
        assert!(!empty.contains(&format!("id: {}", DESKTOP_PLUGINS[0])));

        // home layer mounts only the bridge -> overlay fills ONLY the missing gap
        fs::write(
            root.join("cordis.patch.yml"),
            format!("- insert:\n    - id: {}\n", DESKTOP_PLUGINS[0]),
        )
        .unwrap();
        let gap = desktop_patch_overlay(&root, &HashSet::new());
        assert!(
            !gap.contains(&format!("id: {}", DESKTOP_PLUGINS[0])),
            "gap overlay must not duplicate the mounted bridge, got: {gap}"
        );
        for name in &DESKTOP_PLUGINS[1..] {
            assert!(
                gap.contains(&format!("id: {name}")),
                "gap overlay missing {name}"
            );
        }

        let disabled = HashSet::from([
            "dsh-desktop-session-manager".to_string(),
            "dsh-desktop-file-upload".to_string(),
            "dsh-desktop-bridge".to_string(),
        ]);
        fs::remove_file(root.join("cordis.patch.yml")).unwrap();
        let selective = desktop_patch_overlay(&root, &disabled);
        assert!(selective.contains("id: dsh-desktop-bridge"));
        assert!(!selective.contains("id: dsh-desktop-session-manager"));
        assert!(!selective.contains("id: dsh-desktop-file-upload"));
        assert!(selective.contains("id: dsh-desktop-change-history"));

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
        assert_eq!(
            fs::metadata(&target).unwrap().modified().unwrap(),
            first_modified
        );

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
            dsh_bin: root.join("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
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

    fn settings_models_bundle(root: &Path) -> PathBuf {
        root.join("runtime")
            .join("dsh")
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh-client-ui-settings-models")
            .join("lib")
            .join("client.js")
    }

    fn settings_models_fixture() -> String {
        format!(
            "const react = {{ useState() {{}}, useEffect() {{}}, useMemo() {{}} }};\nconst react_jsx_runtime = {{ jsx() {{}}, jsxs() {{}}, Fragment: \"fragment\" }};\nconst ModelsSection_module_css_default = {{}};\nfunction apiKeyFailure() {{}}\nfunction messageOf(error) {{ return String(error); }}\n{SETTINGS_MODELS_COMPONENT_ANCHOR}\n\t\t\tconst probeBaseURL = \"\";\n\t\t\tconst api = props.api;\n\t\t\treturn (0, react_jsx_runtime.jsxs)(\"div\", {{ children: [(0, react_jsx_runtime.jsxs)(\"div\", {{ children: []\n{SETTINGS_MODELS_RENDER_ANCHOR}\n\t\t\t\tchildren: []\n\t\t\t}})] }});\n\t\t}}\n"
        )
    }

    fn write_plugin_package(root: &Path, name: &str, marker: &str) {
        let package = root.join(name);
        fs::create_dir_all(&package).unwrap();
        fs::write(
            package.join("package.json"),
            format!(r#"{{"name":"{name}","marker":"{marker}"}}"#),
        )
        .unwrap();
        fs::write(package.join("index.js"), marker).unwrap();
    }

    #[test]
    fn bundled_third_party_plugins_preserve_existing_user_packages() {
        let root = std::env::temp_dir().join(format!(
            "dsh-third-party-plugin-test-{}-user",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let paths = test_paths(&root);
        let bundled = paths.bundled_runtime_dir.join("plugins-src");
        write_plugin_package(&bundled, VISION_PLUGIN, "bundled-vision");
        write_plugin_package(&bundled, MARKET_PLUGIN, "bundled-market");
        write_plugin_package(&bundled, "undici", "bundled-undici");

        let user_modules = paths.dsh_home.join("profiles/node_modules");
        write_plugin_package(&user_modules, VISION_PLUGIN, "user-vision");
        write_plugin_package(&user_modules, MARKET_PLUGIN, "user-market");
        write_plugin_package(&user_modules, "undici", "user-undici");

        ensure_runtime_files(&paths);

        assert_eq!(
            fs::read_to_string(user_modules.join(VISION_PLUGIN).join("index.js")).unwrap(),
            "user-vision"
        );
        assert_eq!(
            fs::read_to_string(user_modules.join(MARKET_PLUGIN).join("index.js")).unwrap(),
            "user-market"
        );
        assert_eq!(
            fs::read_to_string(user_modules.join("undici/index.js")).unwrap(),
            "user-undici"
        );
        assert!(!user_modules
            .join(MARKET_PLUGIN)
            .join("node_modules/undici")
            .exists());
        assert!(read_bundled_third_party_plugins(&paths).is_empty());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bundled_third_party_plugins_refresh_only_desktop_owned_packages() {
        let root = std::env::temp_dir().join(format!(
            "dsh-third-party-plugin-test-{}-owned",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let paths = test_paths(&root);
        let bundled = paths.bundled_runtime_dir.join("plugins-src");
        write_plugin_package(&bundled, VISION_PLUGIN, "bundled-v1");

        ensure_runtime_files(&paths);
        let deployed = paths
            .dsh_home
            .join("profiles/node_modules")
            .join(VISION_PLUGIN)
            .join("index.js");
        assert_eq!(fs::read_to_string(&deployed).unwrap(), "bundled-v1");
        assert!(read_bundled_third_party_plugins(&paths).contains(VISION_PLUGIN));

        fs::write(bundled.join(VISION_PLUGIN).join("index.js"), "bundled-v2").unwrap();
        ensure_runtime_files(&paths);
        assert_eq!(fs::read_to_string(&deployed).unwrap(), "bundled-v2");

        let _ = fs::remove_dir_all(&root);
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
        assert!(patched.contains(r#"id === "appearance""#));
        assert!(patched.contains(r#"id === "vision-any""#));
        assert!(patched.contains(r#"id === "web-search""#));
        assert!(patched.contains(r#"id === "model-behavior""#));
        assert!(patched.contains(r#"id === "session-manager""#));
        assert!(patched.contains(r#"id === "about""#));
        assert!(patched.contains(r#"id === "change-history""#));
        assert!(patched.contains("IconListPenOutline16"));
        assert!(patched.contains("IconUserOutline16"));
        assert!(patched.contains("IconBranchOutline16"));
        assert!(patched.contains("IconPersonalizationOutline16"));
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
    fn settings_models_credentials_patch_applies_once_and_degrades() {
        let root = std::env::temp_dir().join(format!(
            "dsh-model-credentials-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let paths = test_paths(&root);
        let bundle = settings_models_bundle(&root);
        fs::create_dir_all(bundle.parent().unwrap()).unwrap();
        fs::write(&bundle, settings_models_fixture()).unwrap();

        patch_settings_models_credentials(&paths);
        let patched = fs::read_to_string(&bundle).unwrap();
        assert!(patched.contains(SETTINGS_MODELS_CREDENTIALS_MARKER));
        assert!(patched.contains("function ProviderAccountCredentials"));
        assert!(patched.contains("VOLC_ACCESS_KEY"));
        assert!(patched.contains("VOLC_SECRET_KEY"));
        assert!(patched.contains("ProviderAccountCredentials, { provider: props.provider"));
        if let Ok(output) = std::process::Command::new("node")
            .arg("--check")
            .arg(&bundle)
            .output()
        {
            assert!(
                output.status.success(),
                "patched Models fixture is invalid JavaScript: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let once = fs::read(&bundle).unwrap();
        patch_settings_models_credentials(&paths);
        assert_eq!(fs::read(&bundle).unwrap(), once);

        fs::write(&bundle, "function ProviderEditorChanged() {}\n").unwrap();
        patch_settings_models_credentials(&paths);
        assert_eq!(
            fs::read_to_string(&bundle).unwrap(),
            "function ProviderEditorChanged() {}\n"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn vision_bundle_initializes_fresh_web_profile() {
        let root =
            std::env::temp_dir().join(format!("dsh-vision-test-{}-fresh", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let paths = test_paths(&root);

        ensure_web_profile_bundles(&paths, &[VISION_PLUGIN, MARKET_PLUGIN]);

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
                VISION_PLUGIN,
                MARKET_PLUGIN
            ]
        );
        // `dsh plugin` compatible profile scaffolding
        assert!(paths
            .dsh_home
            .join("profiles/web/pnpm-workspace.yaml")
            .exists());
        assert!(paths
            .dsh_home
            .join("profiles/web/cordis.patch.yml")
            .exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn vision_bundle_appends_to_existing_profile_once() {
        let root =
            std::env::temp_dir().join(format!("dsh-vision-test-{}-append", std::process::id()));
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

        ensure_web_profile_bundles(&paths, &[VISION_PLUGIN, MARKET_PLUGIN]);
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
                VISION_PLUGIN,
                MARKET_PLUGIN
            ]
        );
        // user's other manifest fields untouched
        assert_eq!(manifest["dependencies"]["some-plugin"], "^1.0.0");

        // second run is a no-op: bytes identical, no duplicate entry
        let after_first = fs::read_to_string(&manifest_path).unwrap();
        ensure_web_profile_bundles(&paths, &[VISION_PLUGIN, MARKET_PLUGIN]);
        assert_eq!(fs::read_to_string(&manifest_path).unwrap(), after_first);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn bundled_plugin_switches_remove_only_disabled_bundle_rows() {
        let root =
            std::env::temp_dir().join(format!("dsh-builtin-switch-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let paths = test_paths(&root);
        let web = paths.dsh_home.join("profiles/web");
        fs::create_dir_all(&web).unwrap();
        let manifest_path = web.join("package.json");
        fs::write(
            &manifest_path,
            format!(
                r#"{{"name":"dsh-profile-web","private":true,"dependencies":{{"some-plugin":"1.0.0"}},"dsh":{{"profile":{{"bundles":["@deepseek-ai/dsh-base","some-plugin","{VISION_PLUGIN}","{MARKET_PLUGIN}"]}}}}}}"#
            ),
        )
        .unwrap();

        let disabled = HashSet::from([VISION_PLUGIN.to_string()]);
        reconcile_web_profile_bundles(&paths, &[MARKET_PLUGIN], &disabled);
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let names = manifest["dsh"]["profile"]["bundles"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            vec!["@deepseek-ai/dsh-base", "some-plugin", MARKET_PLUGIN]
        );
        assert_eq!(manifest["dependencies"]["some-plugin"], "1.0.0");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn vision_bundle_creates_missing_dsh_path() {
        let root =
            std::env::temp_dir().join(format!("dsh-vision-test-{}-nodsh", std::process::id()));
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

        ensure_web_profile_bundles(&paths, &[VISION_PLUGIN, MARKET_PLUGIN]);
        let manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap()).unwrap();
        let names: Vec<&str> = manifest["dsh"]["profile"]["bundles"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(names, vec![VISION_PLUGIN, MARKET_PLUGIN]);
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

        ensure_web_profile_bundles(&paths, &[VISION_PLUGIN, MARKET_PLUGIN]); // must not panic
        assert_eq!(fs::read_to_string(&manifest_path).unwrap(), "not json {{{");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn update_state_survives_and_clears() {
        let root = std::env::temp_dir().join(format!("dsh-upd-test-{}-d", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        make_runtime(&root, "0.1.0-rc.5");

        assert!(read_pending_update(&root).is_none());
        write_pending_update(
            &root,
            &UpdateBackupInfo {
                backup: root.join("dsh-old-20260101").to_string_lossy().to_string(),
                previous_version: "0.1.0-rc.5".to_string(),
                new_version: "0.1.0".to_string(),
                phase: UpdatePhase::Swapped,
                stage: String::new(),
            },
        )
        .unwrap();
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

        let result = apply_dsh_tarball_bytes(
            &root,
            &root,
            None,
            b"not a tarball at all",
            &root.join("test.log"),
        );
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

        // valid tar, but no package manifest → verification fails before swap
        let tarball = make_tarball(&[("package/lib/bin.js", "// no manifest")]);
        let result = apply_dsh_tarball_bytes(&root, &root, None, &tarball, &root.join("test.log"));
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
        let ds = providers
            .iter()
            .find(|p| p.id == "deepseek-official")
            .expect("built-in");
        assert_eq!(ds.base_url, "https://api.deepseek.com");
        assert_eq!(ds.key_env, "DEEPSEEK_API_KEY");
        assert_eq!(ds.api, "deepseek");
        let pi = providers
            .iter()
            .find(|p| p.id == "anixuilgpt")
            .expect("pi provider");
        assert_eq!(pi.display_name, "CODEX");
        assert_eq!(pi.base_url, "https://apinebula.ai/v1");
        assert_eq!(pi.api, "openai-responses");
        let relay = providers
            .iter()
            .find(|p| p.id == "anthropic-relay")
            .expect("relay");
        assert_eq!(relay.api, "anthropic-messages");

        // env override + malformed documents
        let with_env = llm_providers_from_yaml(raw, Some("https://ds.example.com/v1"));
        assert_eq!(
            with_env
                .iter()
                .find(|p| p.id == "deepseek-official")
                .unwrap()
                .base_url,
            "https://ds.example.com/v1"
        );
        assert_eq!(llm_providers_from_yaml("not: [valid", None).len(), 1);
    }

    #[test]
    fn adapter_matching_routes_by_api_and_host() {
        assert_eq!(
            adapter_for("deepseek", "https://api.deepseek.com"),
            Adapter::DeepSeek
        );
        assert_eq!(
            adapter_for("", "https://gateway.deepseek.io/v1"),
            Adapter::DeepSeek
        );
        assert_eq!(
            adapter_for("openai-responses", "https://apinebula.ai/v1"),
            Adapter::OpenAIBilling
        );
        assert_eq!(
            adapter_for("openai-chat", "https://x.example/v1"),
            Adapter::OpenAIBilling
        );
        assert_eq!(
            adapter_for("", "https://api.openai-proxy.example/v1"),
            Adapter::OpenAIBilling
        );
        assert_eq!(
            adapter_for("anthropic-messages", "https://relay.example/v1"),
            Adapter::Unsupported
        );
        assert_eq!(
            adapter_for("google-genai", "https://x.example/v1"),
            Adapter::Unsupported
        );
        // unknown combos probe at fetch time
        assert_eq!(
            adapter_for("", "https://mystery.example/v1"),
            Adapter::Probe
        );
    }

    #[test]
    fn generic_usage_extractor_accepts_common_response_shapes() {
        let top_level = serde_json::json!({
            "is_active": false,
            "remaining": "12.50",
            "unit": "CNY"
        });
        let usage = parse_generic_usage(&top_level).unwrap();
        assert_eq!(usage.remaining, Some(12.5));
        assert_eq!(usage.unit.as_deref(), Some("CNY"));
        assert_eq!(usage.is_valid, Some(false));

        let quota = serde_json::json!({
            "isValid": true,
            "quota": { "remaining": 8, "unit": "TOKENS" }
        });
        let usage = parse_generic_usage(&quota).unwrap();
        assert_eq!(usage.remaining, Some(8.0));
        assert_eq!(usage.unit.as_deref(), Some("TOKENS"));
        assert_eq!(usage.is_valid, Some(true));

        let balance = serde_json::json!({ "balance": 3.25 });
        let usage = parse_generic_usage(&balance).unwrap();
        assert_eq!(usage.remaining, Some(3.25));
        assert_eq!(usage.unit.as_deref(), Some("USD"));
        assert_eq!(usage.is_valid, Some(true));
    }

    #[test]
    fn volcengine_hosts_route_to_volcengine_adapter() {
        // Ark (火山方舟) hosts speak the openai wire protocol but their Ark API
        // key can't read billing — they must route to the signed OpenAPI
        // adapter, not the (absent) dashboard billing endpoints.
        for base in [
            "https://ark.cn-beijing.volces.com/api/v3",
            "https://ark.volcengine.com/api/v3",
            "https://open.volcengineapi.com",
        ] {
            assert_eq!(adapter_for("openai", base), Adapter::Volcengine);
            assert_eq!(adapter_for("", base), Adapter::Volcengine);
        }
    }

    #[test]
    fn hmac_sha256_matches_rfc4231_vector() {
        // RFC 4231 test case 1: key = 0x0b × 20, data = "Hi There".
        let key = [0x0bu8; 20];
        let digest = hmac_sha256(&key, b"Hi There");
        assert_eq!(
            hex::encode(&digest),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    #[test]
    fn volc_balance_parses_query_balance_acct_response() {
        // Shape returned by the 费用中心 OpenAPI billing.QueryBalanceAcct
        // (PascalCase `Result` fields, amounts as strings).
        let raw = r#"{
            "ResponseMetadata": {
                "RequestId": "0213XXXXX",
                "Action": "QueryBalanceAcct",
                "Version": "2022-01-01",
                "Service": "billing",
                "Region": "cn-north-1"
            },
            "Result": {
                "AccountID": "2100XXXX",
                "ArrearsBalance": "0",
                "AvailableBalance": "123.45",
                "CashBalance": "123.45",
                "CreditLimit": "0",
                "FreezeAmount": "0"
            }
        }"#;
        let bal = parse_volc_balance(raw).expect("volc balance response must parse");
        assert!(bal.is_available);
        let info = bal.balance_infos.first().expect("one balance info");
        assert_eq!(info.currency, "CNY");
        assert_eq!(info.total_balance, "123.45");
        assert_eq!(info.topped_up_balance, "123.45");
        assert_eq!(info.granted_balance, "0.00");

        // numeric amounts are coerced too (the SDK sometimes emits numbers)
        let numeric = r#"{"Result":{"AvailableBalance":250,"CashBalance":250}}"#;
        let bal2 = parse_volc_balance(numeric).expect("numeric balance must parse");
        assert_eq!(bal2.balance_infos[0].total_balance, "250");
    }

    #[test]
    fn volc_resource_packages_parse_amounts_and_usage_details() {
        let packages = serde_json::json!({
            "ResponseMetadata": { "Action": "ListResourcePackages" },
            "Result": {
                "List": [{
                    "InstanceNo": "Package-1",
                    "ConfigurationName": "方舟 Coding Plan",
                    "ProductName": "火山方舟",
                    "TotalAmount": "100",
                    "AvailableAmount": "72.5",
                    "Unit": "M Tokens",
                    "Status": "Effective",
                    "EffectiveTime": "2026-08-01T00:00:00Z",
                    "ExpiryTime": "2026-09-01T00:00:00Z"
                }]
            }
        });
        let plans = parse_volc_plans(&packages).expect("resource packages must parse");
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].name, "方舟 Coding Plan");
        assert_eq!(plans[0].product.as_deref(), Some("火山方舟"));
        assert_eq!(plans[0].total, Some(100.0));
        assert_eq!(plans[0].remaining, Some(72.5));
        assert_eq!(plans[0].used, Some(27.5));
        assert_eq!(plans[0].unit.as_deref(), Some("M Tokens"));

        let details = serde_json::json!({
            "Result": {
                "List": [
                    { "InstanceNo": "Package-1", "DeductionAmount": "2.5" },
                    { "InstanceNo": "Package-1", "DeductionAmount": 1.25 },
                    { "InstanceNo": "Package-2", "DeductionAmount": "4" }
                ]
            }
        });
        let mut totals = HashMap::new();
        collect_volc_usage_details(&details, &mut totals).expect("usage details must parse");
        assert_eq!(totals.get("Package-1"), Some(&3.75));
        assert_eq!(totals.get("Package-2"), Some(&4.0));
    }

    #[test]
    fn volc_coding_plan_parses_three_usage_windows() {
        let response = serde_json::json!({
            "Result": {
                "Status": "Running",
                "UpdateTimestamp": 1782053286_i64,
                "QuotaUsage": [
                    { "Level": "session", "Percent": 0.0, "ResetTimestamp": -1_i64 },
                    { "Level": "weekly", "Percent": 1.672568, "ResetTimestamp": 1782057600_i64 },
                    { "Level": "monthly", "Percent": 0.836284, "ResetTimestamp": 1784303999_i64 }
                ]
            }
        });
        let plans = parse_volc_coding_plan(&response).expect("coding plan response must parse");
        assert_eq!(plans.len(), 3);
        assert_eq!(plans[0].name, "5 小时额度");
        assert_eq!(plans[0].used, Some(0.0));
        assert_eq!(plans[0].expires_at, None);
        assert_eq!(plans[1].name, "7 天额度");
        assert_eq!(plans[1].used, Some(1.672568));
        assert!(plans[1].expires_at.is_some());
        assert_eq!(plans[2].name, "每月额度");
        assert_eq!(plans[2].remaining, Some(99.163716));
    }

    #[test]
    fn volc_agent_plan_ignores_unsubscribed_windows() {
        let response = serde_json::json!({
            "Result": {
                "PlanType": "Agent Plan Pro",
                "AFPFiveHour": { "Quota": 40.0, "Used": 10.0, "ResetTime": 1778806800000_i64 },
                "AFPWeekly": { "Quota": 0.0, "Used": 0.0 }
            }
        });
        let plans = parse_volc_afp_plan(&response).expect("agent plan response must parse");
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].product.as_deref(), Some("Agent Plan Pro"));
        assert_eq!(plans[0].used, Some(25.0));
        assert_eq!(plans[0].remaining, Some(75.0));
    }

    #[test]
    fn volc_region_comes_from_ark_base_url() {
        assert_eq!(
            volcengine_region("https://ark.cn-shanghai.volces.com/api/coding/v3"),
            "cn-shanghai"
        );
    }

    #[test]
    fn volc_openapi_errors_are_not_treated_as_empty_packages() {
        let denied = serde_json::json!({
            "ResponseMetadata": {
                "Error": { "Code": "AccessDenied", "Message": "permission denied" }
            }
        });
        let error = parse_volc_plans(&denied).expect_err("access errors must be surfaced");
        assert!(error.contains("AccessDenied"));
        assert!(error.contains("permission denied"));
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

    #[test]
    fn bailian_hosts_route_to_unsupported_adapter() {
        // Alibaba Cloud hosts expose no key-accessible balance/billing API —
        // the panel should show the friendly "unsupported" note, not a 404.
        for base in [
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
        ] {
            assert_eq!(adapter_for("openai", base), Adapter::Unsupported);
            assert_eq!(adapter_for("openai-responses", base), Adapter::Unsupported);
        }
    }

    #[test]
    fn ensure_bailian_provider_writes_once_and_is_idempotent() {
        let root = std::env::temp_dir().join(format!("dsh-bailian-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let settings = root.join("settings.yaml");
        fs::write(&settings, "ui-theme:\n  preference: light\n").unwrap();

        // first call creates the route
        let outcome = ensure_bailian_provider(&settings).unwrap();
        assert!(!outcome.existed);
        assert!(outcome.removed.is_empty());
        assert!(outcome.merged_models.is_empty());
        let raw = fs::read_to_string(&settings).unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&raw).unwrap();
        let entry = &doc["llm-pi-ai"]["providers"]["qwen-token-plan-cn"];
        assert_eq!(
            entry["apiKeyEnv"],
            serde_yaml::Value::String("QWEN_TOKEN_PLAN_CN_API_KEY".into())
        );
        assert_eq!(
            entry["displayName"],
            serde_yaml::Value::String("阿里云百炼".into())
        );
        // the desktop's provider panel discovers routes through baseURL
        assert_eq!(
            entry["baseURL"],
            serde_yaml::Value::String(
                "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1".into()
            )
        );
        // unrelated sections survive the round-trip
        assert_eq!(
            doc["ui-theme"]["preference"],
            serde_yaml::Value::String("light".into())
        );

        // second call reports existing and does not duplicate the entry
        let outcome = ensure_bailian_provider(&settings).unwrap();
        assert!(outcome.existed);
        assert!(outcome.removed.is_empty());
        let raw = fs::read_to_string(&settings).unwrap();
        assert_eq!(raw.matches("qwen-token-plan-cn").count(), 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_bailian_provider_folds_token_plan_duplicates() {
        let root = std::env::temp_dir().join(format!("dsh-bailian-fold-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let settings = root.join("settings.yaml");
        // a hand-declared duplicate of the token-plan endpoint plus an
        // unrelated provider that must survive untouched
        fs::write(
            &settings,
            "llm-pi-ai:\n  providers:\n    aliyunbailian:\n      displayName: 阿里云百炼\n      apiKeyEnv: ALIYUNBAILIAN_API_KEY\n      api: openai-responses\n      baseURL: https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1\n      models:\n        - id: qwen3.7-max\n        - id: wan2.7-image\n    othergateway:\n      displayName: Other\n      apiKeyEnv: OTHER_API_KEY\n      api: openai\n      baseURL: https://other.example.com/v1\n      models:\n        - id: gpt-1\n",
        )
        .unwrap();

        let outcome = ensure_bailian_provider(&settings).unwrap();
        assert!(!outcome.existed);
        assert_eq!(outcome.removed, vec!["aliyunbailian".to_string()]);
        // models from the folded route land on the catalog route
        assert_eq!(
            outcome.merged_models,
            vec!["qwen3.7-max".to_string(), "wan2.7-image".to_string()]
        );

        let raw = fs::read_to_string(&settings).unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&raw).unwrap();
        let providers = &doc["llm-pi-ai"]["providers"];
        assert!(providers.get("qwen-token-plan-cn").is_some());
        assert!(providers.get("aliyunbailian").is_none());
        assert!(providers.get("othergateway").is_some());
        let models = providers["qwen-token-plan-cn"]["models"]
            .as_sequence()
            .unwrap();
        let ids: Vec<&str> = models
            .iter()
            .filter_map(|m| m.as_mapping()?.get("id")?.as_str())
            .collect();
        assert_eq!(ids, vec!["qwen3.7-max", "wan2.7-image"]);

        // a second run must be a no-op (idempotent merge)
        let outcome = ensure_bailian_provider(&settings).unwrap();
        assert!(outcome.existed);
        assert!(outcome.removed.is_empty());
        assert!(outcome.merged_models.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_bailian_provider_never_folds_catalog_routes() {
        let root = std::env::temp_dir().join(format!("dsh-bailian-cat-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let settings = root.join("settings.yaml");
        // the international catalog route shares the token-plan host family —
        // it is a catalog provider and must survive the fold untouched
        fs::write(
            &settings,
            "llm-pi-ai:\n  providers:\n    qwen-token-plan:\n      displayName: Qwen Token Plan\n      apiKeyEnv: QWEN_TOKEN_PLAN_API_KEY\n",
        )
        .unwrap();

        let outcome = ensure_bailian_provider(&settings).unwrap();
        assert!(outcome.removed.is_empty());
        assert!(outcome.merged_models.is_empty());

        let raw = fs::read_to_string(&settings).unwrap();
        let doc: serde_yaml::Value = serde_yaml::from_str(&raw).unwrap();
        let providers = &doc["llm-pi-ai"]["providers"];
        assert!(providers.get("qwen-token-plan-cn").is_some());
        assert!(providers.get("qwen-token-plan").is_some());
        // the international route keeps its own profile untouched
        assert_eq!(
            providers["qwen-token-plan"]["apiKeyEnv"],
            serde_yaml::Value::String("QWEN_TOKEN_PLAN_API_KEY".into())
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ipc_wire_names_match_the_js_consumers() {
        // The bridge panel and the settings window read specific key spellings;
        // serde rename attributes must keep producing them.
        let status = serde_json::to_value(&ProviderStatus {
            id: "qwen-token-plan-cn".to_string(),
            display_name: "阿里云百炼".to_string(),
            kind: "unsupported".to_string(),
            configured: true,
            balance: None,
            usage: None,
            plans: Vec::new(),
            plans_error: None,
            error: None,
        })
        .unwrap();
        // the panel reads display_name / kind / configured
        assert_eq!(status["display_name"], "阿里云百炼");
        assert_eq!(status["kind"], "unsupported");
        assert_eq!(status["configured"], true);

        let usage = serde_json::to_value(&ProviderUsage {
            remaining: None,
            unit: None,
            is_valid: Some(true),
            total_usage_usd: Some(1.0),
            soft_limit_usd: Some(2.0),
            hard_limit_usd: None,
            has_payment_method: Some(true),
        })
        .unwrap();
        // the panel reads total_usage_usd / soft_limit_usd / has_payment_method
        assert_eq!(usage["total_usage_usd"], 1.0);
        assert_eq!(usage["soft_limit_usd"], 2.0);
        assert_eq!(usage["has_payment_method"], true);

        let plan = serde_json::to_value(&ProviderPlan {
            id: "package-1".to_string(),
            name: "方舟资源包".to_string(),
            product: Some("火山方舟".to_string()),
            total: Some(100.0),
            used: Some(25.0),
            remaining: Some(75.0),
            unit: Some("M Tokens".to_string()),
            status: Some("Effective".to_string()),
            effective_at: None,
            expires_at: Some("2026-09-01T00:00:00Z".to_string()),
            period_usage: Some(8.0),
            period_start: None,
            period_end: None,
        })
        .unwrap();
        assert_eq!(plan["remaining"], 75.0);
        assert_eq!(plan["period_usage"], 8.0);
        assert_eq!(plan["expires_at"], "2026-09-01T00:00:00Z");
    }

    #[test]
    fn motion_defaults_to_rich_for_new_and_legacy_configs() {
        assert_eq!(default_motion(), MotionIntensity::Rich);
        assert_eq!(AppConfig::default().motion, MotionIntensity::Rich);

        // Older config files omit `motion`; serde's field default must keep
        // the first-run experience on the full, rich motion preset.
        let legacy = serde_json::json!({
            "apiKey": null,
            "dshHome": null,
            "dshPort": null,
            "bridgeShellPort": 38657,
            "bridgePort": 38658,
            "balanceLowThreshold": 5.0,
            "updateRepo": null,
            "keyRegisteredAt": null
        });
        let parsed: AppConfig = serde_json::from_value(legacy).unwrap();
        assert_eq!(parsed.motion, MotionIntensity::Rich);
        assert_eq!(
            parsed.task_notification_mode,
            TaskNotificationMode::Unfocused
        );
        assert!(parsed.disabled_builtin_plugins.is_empty());
        assert!(AppConfig::default().disabled_builtin_plugins.is_empty());
    }

    #[test]
    fn task_notification_modes_serialize_and_default_to_unfocused() {
        assert_eq!(
            default_task_notification_mode(),
            TaskNotificationMode::Unfocused
        );
        assert_eq!(
            AppConfig::default().task_notification_mode,
            TaskNotificationMode::Unfocused
        );
        assert_eq!(
            serde_json::to_string(&TaskNotificationMode::Off).unwrap(),
            r#""off""#
        );
        assert_eq!(
            serde_json::to_string(&TaskNotificationMode::Unfocused).unwrap(),
            r#""unfocused""#
        );
        assert_eq!(
            serde_json::to_string(&TaskNotificationMode::Always).unwrap(),
            r#""always""#
        );
        assert_eq!(
            parse_task_notification_mode("unfocused"),
            Some(TaskNotificationMode::Unfocused)
        );
        assert_eq!(parse_task_notification_mode("sometimes"), None);
    }

    #[test]
    fn task_notification_focus_policy_matches_the_settings_contract() {
        assert!(!should_send_task_notification(
            TaskNotificationMode::Off,
            false,
            false,
            true,
            false
        ));
        assert!(should_send_task_notification(
            TaskNotificationMode::Always,
            true,
            true,
            false,
            true
        ));
        assert!(!should_send_task_notification(
            TaskNotificationMode::Unfocused,
            true,
            true,
            false,
            true
        ));
        assert!(should_send_task_notification(
            TaskNotificationMode::Unfocused,
            true,
            true,
            false,
            false
        ));
        assert!(should_send_task_notification(
            TaskNotificationMode::Unfocused,
            false,
            false,
            false,
            true
        ));
        assert!(should_send_task_notification(
            TaskNotificationMode::Unfocused,
            true,
            false,
            false,
            true
        ));
        assert!(should_send_task_notification(
            TaskNotificationMode::Unfocused,
            true,
            true,
            true,
            true
        ));
    }

    #[test]
    fn task_notification_titles_and_duplicate_guard_are_bounded() {
        let title = "鲸".repeat(100);
        let copy = task_notification_copy(Some(&title));
        assert_eq!(copy.title, "DSH Desktop · 任务完成");
        assert_eq!(copy.context.chars().count(), 83);
        assert!(copy.context.starts_with("会话："));
        assert_eq!(copy.status, "状态：已完成，可以回来查看结果");
        assert_eq!(task_notification_copy(None).context, "会话：未命名任务");
        assert_eq!(
            test_notification_copy(),
            TaskNotificationCopy {
                title: "DSH Desktop · 通知测试".to_string(),
                context: "来源：DSH Desktop".to_string(),
                status: "内容：任务完成通知已正确启用".to_string(),
            }
        );

        let slot = Mutex::new(HashMap::new());
        let now = Instant::now();
        assert!(reserve_task_notification(&slot, "s1:1", now));
        assert!(!reserve_task_notification(
            &slot,
            "s1:1",
            now + Duration::from_secs(1)
        ));
        assert!(reserve_task_notification(
            &slot,
            "s1:2",
            now + Duration::from_secs(1)
        ));
        assert!(reserve_task_notification(
            &slot,
            "s1:1",
            now + Duration::from_secs(7)
        ));
    }

    #[test]
    fn dsh_default_appearance_uses_the_wire_value_and_disables_the_ocean_skin() {
        assert_eq!(
            serde_json::to_string(&MotionIntensity::Default).unwrap(),
            r#""default""#
        );
        assert!(motion_init_script(MotionIntensity::Default)
            .contains(r#"window.__DSH_MOTION__ = "default";"#));
        assert!(THEME_TRANSITION_SCRIPT.contains("getAttribute(MOTION_ATTR) !== 'rich'"));
        assert!(OCEAN_THEME_SCRIPT.contains("if (next === 'default') teardown()"));
        assert!(OCEAN_THEME_SCRIPT.contains("DSH default appearance active"));
    }

    #[test]
    fn relay_url_falls_back_to_the_public_default() {
        // Fresh config: no custom relay stored -> the public default is used.
        let mut cfg = AppConfig::default();
        assert_eq!(
            effective_relay_url(&cfg).as_deref(),
            Some(DEFAULT_RELAY_URL)
        );
        assert!(!custom_relay_set(&cfg));

        // A stored custom URL wins and is flagged as custom.
        cfg.remote_relay_url = Some("wss://relay.example.com".to_string());
        assert_eq!(
            effective_relay_url(&cfg).as_deref(),
            Some("wss://relay.example.com")
        );
        assert!(custom_relay_set(&cfg));

        // Entry / HTTP base derive from the effective (custom) URL.
        cfg.remote_device_id = Some("my-pc".to_string());
        assert_eq!(
            remote_entry_url(&cfg).as_deref(),
            Some("https://my-pc.relay.example.com/")
        );
        assert_eq!(
            relay_http_url(&cfg).as_deref(),
            Some("https://relay.example.com")
        );

        // Clearing the custom URL reverts everything to the public default.
        cfg.remote_relay_url = None;
        assert!(!custom_relay_set(&cfg));
        assert_eq!(
            effective_relay_url(&cfg).as_deref(),
            Some(DEFAULT_RELAY_URL)
        );
        assert_eq!(
            remote_entry_url(&cfg).as_deref(),
            Some("https://my-pc.remote.anixuil.com/")
        );
        assert_eq!(
            relay_http_url(&cfg).as_deref(),
            Some("https://remote.anixuil.com")
        );
    }

    #[test]
    fn remote_snapshot_exposes_custom_and_default_relay() {
        let cfg = AppConfig {
            remote_enabled: true,
            remote_relay_url: Some("wss://relay.example.com".to_string()),
            remote_device_id: Some("my-pc".to_string()),
            ..AppConfig::default()
        };
        let snap = remote_snapshot(&cfg, true, true);
        let value = serde_json::to_value(&snap).unwrap();
        // the UI reads camelCase spellings
        assert_eq!(value["relayUrl"], "wss://relay.example.com");
        assert_eq!(value["customRelay"], true);
        assert_eq!(value["defaultRelayUrl"], DEFAULT_RELAY_URL);
        assert_eq!(
            snap.entry.as_deref(),
            Some("https://my-pc.relay.example.com/")
        );

        // Without a custom URL the snapshot reports the default and entry
        // based on the public relay.
        let default_cfg = AppConfig {
            remote_enabled: true,
            remote_relay_url: None,
            remote_device_id: Some("my-pc".to_string()),
            ..AppConfig::default()
        };
        let snap2 = remote_snapshot(&default_cfg, false, false);
        let value2 = serde_json::to_value(&snap2).unwrap();
        assert_eq!(value2["relayUrl"], DEFAULT_RELAY_URL);
        assert_eq!(value2["customRelay"], false);
        assert_eq!(
            snap2.entry.as_deref(),
            Some("https://my-pc.remote.anixuil.com/")
        );
    }
}
