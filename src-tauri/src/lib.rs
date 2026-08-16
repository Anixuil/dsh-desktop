//! DSH Desktop — Windows shell for DeepSeek Harness.
//!
//! Owns: bundled Node + dsh runtime lifecycle, health check, window navigation,
//! API-key management (→ DSH credentials), balance queries, the turn-end
//! bridge listener, the system tray, and logging.

use std::{
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::ManagerExt;

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

const DSH_WEB_PORT_DEFAULT: u16 = 3080;
const CREDENTIAL_NAME: &str = "DEEPSEEK_API_KEY";
const BALANCE_URL: &str = "https://api.deepseek.com/user/balance";
const BRIDGE_PATCH_YML: &str = include_str!("../../scripts/bridge.patch.yml");
const MIN_REFRESH_INTERVAL_SECS: u64 = 3;
/// Injected on every document (including the remote dsh web UI): the desktop
/// app never shows the browser's default right-click context menu.
const INIT_SCRIPT: &str = r#"window.addEventListener('contextmenu', (e) => e.preventDefault(), true);"#;

fn dsh_web_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

// ---------------------------------------------------------------------------
// data types
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BalanceInfo {
    pub currency: String,
    pub total_balance: String,
    pub granted_balance: String,
    pub topped_up_balance: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Balance {
    pub is_available: bool,
    pub balance_infos: Vec<BalanceInfo>,
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
    config: Mutex<AppConfig>,
    last_refresh: Mutex<Option<Instant>>,
    last_update_check: Mutex<Option<Instant>>,
    tray_balance_item: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
}

struct Paths {
    config_file: PathBuf,
    logs_dir: PathBuf,
    log_file: PathBuf,
    patch_file: PathBuf,
    runtime_dir: PathBuf,
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

fn runtime_dir(app: &AppHandle) -> PathBuf {
    let dir = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runtime")
    } else {
        app.path().resource_dir().unwrap_or_default().join("runtime")
    };
    strip_verbatim(dir)
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
    let runtime = runtime_dir(app);
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

fn ensure_runtime_files(paths: &Paths) {
    let _ = fs::create_dir_all(&paths.logs_dir);
    if !paths.patch_file.exists() {
        let _ = fs::write(&paths.patch_file, BRIDGE_PATCH_YML);
    }
    // The loader resolves plugin entries from the profile's module tree
    // ($DSH_HOME/profiles/node_modules), not from runtime/dsh — deploy the
    // bridge package there so the `--patch` row can import it.
    let src = paths
        .runtime_dir
        .join("dsh")
        .join("node_modules")
        .join("dsh-desktop-bridge");
    let dst = paths
        .dsh_home
        .join("profiles")
        .join("node_modules")
        .join("dsh-desktop-bridge");
    if src.exists() && !dst.join("index.js").exists() {
        let _ = fs::create_dir_all(&dst);
        for file in ["package.json", "index.js"] {
            let _ = fs::copy(src.join(file), dst.join(file));
        }
    }
}

/// Extract a .tar.gz archive into `dest`. `strip_first` drops the leading
/// path component (npm tarballs root at `package/`); entries with a leading
/// `./` are normalized first.
fn extract_tarball(tgz: &Path, dest: &Path, strip_first: bool) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| format!("创建目录失败: {e}"))?;
    let file = fs::File::open(tgz).map_err(|e| format!("打开归档失败: {e}"))?;
    let gz = GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
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
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        entry
            .unpack(&target)
            .map_err(|e| format!("解包 {:?} 失败: {e}", target))?;
    }
    Ok(())
}

/// First-run bootstrap: unpack `runtime/runtime-archive.tar.gz` into the
/// runtime dir when the extracted tree is missing (fresh install).
fn extract_runtime_archive(paths: &Paths) -> Result<(), String> {
    if paths.node_exe.exists() && paths.dsh_bin.exists() {
        return Ok(());
    }
    let archive = paths.runtime_dir.join("runtime-archive.tar.gz");
    if !archive.exists() {
        return Err(format!("运行时组件缺失: {}", archive.display()));
    }
    log_line(&paths.log_file, "extracting bundled runtime archive (first run) ...");
    extract_tarball(&archive, &paths.runtime_dir, false)?;
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

    // Give the splash page a moment to register its event listeners before
    // the first health result can fire (early emits used to be lost forever).
    tokio::time::sleep(Duration::from_secs(3)).await;

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
                let _ = app.emit_to("main", "dsh-ready", url.clone());
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

async fn fetch_balance(key: &str) -> Result<Balance, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP 客户端失败: {e}"))?;
    let resp = client
        .get(BALANCE_URL)
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
    let key = {
        let config = state.config.lock().unwrap().clone();
        let paths = resolve_paths(app, &config);
        effective_key(&paths, &config)
    };
    match key {
        None => {
            let _ = state.balance.lock().unwrap().take();
            update_tray(app, state);
            Ok(None)
        }
        Some(key) => match fetch_balance(&key).await {
            Ok(bal) => {
                *state.balance.lock().unwrap() = Some(bal.clone());
                update_tray(app, state);
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
            Err(e) => Err(e),
        },
    }
}

async fn periodic_loop(app: AppHandle) {
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
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
        let state = app.state::<AppState>();
        let paths = {
            let config = state.config.lock().unwrap().clone();
            resolve_paths(&app, &config)
        };
        log_line(&paths.log_file, &format!("bridge listener on 127.0.0.1:{port}"));
        loop {
            match server.recv() {
                Ok(mut req) => {
                    let url = req.url().to_string();
                    let method = req.method().clone();
                    let mut body = String::new();
                    let _ = req.as_reader().read_to_string(&mut body);
                    let _ = req.respond(tiny_http::Response::from_string("ok").with_status_code(200));
                    if url == "/turn-end" && method == tiny_http::Method::Post {
                        let app2 = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let state2 = app2.state::<AppState>();
                            let _ = refresh_balance(&app2, &state2).await;
                        });
                    }
                }
                Err(e) => {
                    log_line(&paths.log_file, &format!("bridge listener error: {e}"));
                    break;
                }
            }
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
    }
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

#[tauri::command]
fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let w = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title("DSH Desktop 设置")
        .inner_size(560.0, 680.0)
        .min_inner_size(480.0, 560.0)
        .data_directory(webview_data_dir(&app))
        .initialization_script(INIT_SCRIPT)
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
        .filter(|r| !r.trim().is_empty());
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

fn apply_dsh_tarball_bytes(runtime: &Path, bytes: &[u8], log: &Path) -> Result<String, String> {
    // stage
    let stage = runtime.join(".update-stage");
    let _ = fs::remove_dir_all(&stage);
    fs::create_dir_all(&stage).map_err(|e| format!("创建暂存目录失败: {e}"))?;

    let tgz_path = stage.join("pkg.tgz");
    fs::write(&tgz_path, bytes).map_err(|e| format!("写入失败: {e}"))?;

    // extract (npm tarball root is `package/`, stripped)
    let dsh_new = stage.join("dsh-new");
    extract_tarball(&tgz_path, &dsh_new, true)?;

    // restore the bridge package into the new tree
    let bridge_src = runtime.join("bridge-src");
    if bridge_src.exists() {
        let bdst = dsh_new.join("node_modules").join("dsh-desktop-bridge");
        fs::create_dir_all(&bdst).map_err(|e| e.to_string())?;
        for f in ["package.json", "index.js"] {
            fs::copy(bridge_src.join(f), bdst.join(f))
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

    let result = apply_dsh_tarball_bytes(&runtime, &bytes, &log)?;
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
    .map_err(|e| e.to_string())
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
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open)
        .item(&settings)
        .separator()
        .item(&balance_item)
        .item(&refresh)
        .separator()
        .item(&update)
        .separator()
        .item(&quit)
        .build()?;

    let state = app.state::<AppState>();
    *state.tray_balance_item.lock().unwrap() = Some(balance_item);

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
            None,
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
            config: Mutex::new(AppConfig::default()),
            last_refresh: Mutex::new(None),
            last_update_check: Mutex::new(None),
            tray_balance_item: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            set_api_key,
            refresh_balance_cmd,
            open_logs,
            open_dsh_home,
            open_settings_window,
            check_update,
            apply_dsh_update,
            get_autostart,
            set_autostart
        ])
        .setup(|app| {
            let handle = app.handle().clone();

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

            // main window: splash first, navigates to the dsh web UI when healthy
            let w = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
                .title("DeepSeek Harness")
                .inner_size(1280.0, 800.0)
                .min_inner_size(960.0, 640.0)
                .data_directory(webview_data_dir(&handle))
                .initialization_script(INIT_SCRIPT)
                .build()
                .map_err(|e| format!("创建主窗口失败: {e}"))?;
            let _ = w.set_focus();

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
                        "dsh-status",
                        "首次运行：正在解压运行时组件，请稍候…".to_string(),
                    );
                    match extract_runtime_archive(&paths) {
                        Ok(()) => {}
                        Err(e) => {
                            log_line(&paths.log_file, &format!("runtime extraction failed: {e}"));
                            state.runtime_ready.store(true, Ordering::SeqCst);
                            let _ = app2.emit_to("main", "dsh-failed", ());
                            return;
                        }
                    }
                }
                state.runtime_ready.store(true, Ordering::SeqCst);
                ensure_runtime_files(&paths);
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

            // initial balance after a moment
            let app2 = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(3)).await;
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
        let bridge = dir.join("bridge-src");
        fs::create_dir_all(&bridge).unwrap();
        fs::write(bridge.join("package.json"), r#"{"name":"bridge"}"#).unwrap();
        fs::write(bridge.join("index.js"), "// bridge marker").unwrap();
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
        let result = apply_dsh_tarball_bytes(&root, &tarball, &root.join("test.log"));
        assert!(result.is_ok(), "update failed: {result:?}");

        // new tree in place
        let manifest =
            fs::read_to_string(root.join("dsh/node_modules/@deepseek-ai/dsh/package.json"))
                .unwrap();
        assert!(manifest.contains("0.9.9"));
        // bridge restored into the new tree
        assert!(root.join("dsh/node_modules/dsh-desktop-bridge/index.js").exists());
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

        let result = apply_dsh_tarball_bytes(&root, b"not a tarball at all", &root.join("test.log"));
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
        let result = apply_dsh_tarball_bytes(&root, &tarball, &root.join("test.log"));
        assert!(result.is_err());

        assert_eq!(
            fs::read_to_string(root.join("dsh/lib/bin.js")).unwrap(),
            "// old runtime marker"
        );
        let vjson = fs::read_to_string(root.join("version.json")).unwrap();
        assert!(vjson.contains("0.1.0-rc.5"));
        let _ = fs::remove_dir_all(&root);
    }
}
