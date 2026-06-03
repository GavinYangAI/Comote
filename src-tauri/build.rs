fn main() {
    // The main window loads the daemon UI from http://127.0.0.1:16208, which
    // Tauri treats as a remote origin. Remote windows do not auto-allow custom
    // commands, so register them here to generate `allow-<command>` permissions
    // that capabilities/default.json can grant to that origin.
    let manifest = tauri_build::AppManifest::new().commands(&["open_external"]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run tauri-build");
}
