// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;

struct FileLogger;

impl log::Log for FileLogger {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        if let Ok(path) = std::env::var("DSH_DESKTOP_DEBUG_LOG") {
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                let _ = writeln!(
                    f,
                    "[{}] {}: {}",
                    record.level(),
                    record.target(),
                    record.args()
                );
            }
        }
    }
    fn flush(&self) {}
}

static LOGGER: FileLogger = FileLogger;

fn main() {
    // TEMP-DEBUG: capture swallowed window/webview creation errors.
    if std::env::var("DSH_DESKTOP_DEBUG_LOG").is_ok() {
        let _ = log::set_logger(&LOGGER);
        log::set_max_level(log::LevelFilter::Trace);
    }
    dsh_desktop_lib::run()
}
