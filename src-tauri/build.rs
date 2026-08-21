fn main() {
    // Tauri embeds this resource into the Windows executable. Track it
    // explicitly so an icon-only update cannot reuse a stale Cargo artifact.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
