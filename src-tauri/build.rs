fn main() {
    // The main window loads the daemon UI from http://127.0.0.1:16208, which
    // Tauri treats as a remote origin. Remote windows do not auto-allow custom
    // commands, so register them here to generate `allow-<command>` permissions
    // that the capability can grant.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "get_show_dock_icon",
        "set_show_dock_icon",
        "get_keep_daemon_alive",
        "set_keep_daemon_alive",
        "open_external",
        "get_platform",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to run tauri-build");
}
