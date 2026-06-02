#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    io::Write,
    net::TcpStream,
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

struct ComoteSidecar(Mutex<Option<CommandChild>>);

const PORT: u16 = 16208;
// Windows first-run can be slow: Defender real-time scanning of a freshly
// extracted node.exe plus Node loading the bundled deps can take well over the
// old 12s budget. Give it generous headroom before declaring failure.
const READY_TIMEOUT: Duration = Duration::from_secs(40);

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            let log_path = app_data_dir.join("comote-launch.log");
            log_line(&log_path, "--- Comote launching ---");

            // Create the window FIRST. The previous flow waited for the local
            // service inside setup and propagated any failure out of build(),
            // which panics before any window exists — on Windows (no console,
            // sidecar output discarded) that surfaced as a blank "nothing
            // happens" launch. Now the window always appears: it loads a small
            // boot page and we navigate it to the service once ready, or show a
            // readable error (with the log path) right there if it never comes up.
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("boot.html".into()))
                    .title("Comote")
                    .inner_size(1280.0, 800.0)
                    .min_inner_size(960.0, 600.0)
                    .build()?;
            let _ = window.set_focus();

            // Start the sidecar unless a service is already listening.
            let child = if is_service_running(PORT) {
                log_line(&log_path, "Existing service detected; not starting sidecar");
                None
            } else {
                match start_comote_sidecar(app, PORT, &log_path) {
                    Ok(child) => Some(child),
                    Err(error) => {
                        log_line(&log_path, &format!("Failed to start sidecar: {error}"));
                        show_launch_error(&window, &log_path);
                        None
                    }
                }
            };
            app.manage(ComoteSidecar(Mutex::new(child)));

            // Wait for readiness off the main thread so the window stays
            // responsive, then navigate to the service or surface a clear error.
            // This never panics and never blocks window creation.
            let window_for_wait = window.clone();
            let log_for_wait = log_path.clone();
            thread::spawn(move || {
                if wait_for_service(PORT, READY_TIMEOUT) {
                    log_line(&log_for_wait, "Service ready; navigating to app");
                    navigate_to_service(&window_for_wait, PORT);
                } else {
                    log_line(&log_for_wait, "Service did not become ready before timeout");
                    show_launch_error(&window_for_wait, &log_for_wait);
                }
            });

            // Show in the Dock (Regular) so users get the usual app affordance,
            // and ALSO live in the top-of-screen tray for quick access.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);

            // A tray icon keeps Comote resident. Without it, closing the window
            // would stop the local daemon and break the phone bridge — exactly
            // when the user is away from the Mac and needs it most.
            let show = MenuItem::with_id(app, "show", "打开 Comote", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Comote", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("Comote")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Hide instead of close: the daemon must keep running so the
                // phone can still reach Codex while the window is dismissed.
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Comote");

    app.run(|app_handle, event| {
        // The sidecar is killed only on a real quit, never on window close.
        if let RunEvent::ExitRequested { .. } = event {
            stop_comote_sidecar(app_handle);
        }
    });
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn stop_comote_sidecar(app: &AppHandle) {
    if let Some(state) = app.try_state::<ComoteSidecar>() {
        if let Ok(mut child) = state.0.lock() {
            if let Some(child) = child.take() {
                let _ = child.kill();
            }
        }
    }
}

fn start_comote_sidecar(
    app: &tauri::App,
    port: u16,
    log_path: &Path,
) -> tauri::Result<CommandChild> {
    let resource_dir = app.path().resource_dir()?;
    let app_data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&app_data_dir)?;

    let server_entry = resource_dir
        .join("comote-server")
        .join("src")
        .join("server")
        .join("index.js");
    let state_path = app_data_dir.join("state.json");

    log_line(
        log_path,
        &format!(
            "Starting sidecar; server entry: {}",
            server_entry.to_string_lossy()
        ),
    );

    let (mut receiver, child) = app
        .shell()
        .sidecar("comote-node")
        .map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))?
        .args([path_to_string(server_entry)])
        .env("PORT", port.to_string())
        .env("COMOTE_STATE_PATH", path_to_string(state_path))
        .spawn()
        .map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))?;

    // Pump the sidecar's stdout/stderr (and exit status) into the launch log.
    // Previously this stream was discarded, so a Node crash — a missing module,
    // a bad path, an unhandled error — left no trace at all. Now the reason is
    // recorded where a user (or we) can read it.
    let log_for_pump = log_path.to_path_buf();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => log_bytes(&log_for_pump, "out", &bytes),
                CommandEvent::Stderr(bytes) => log_bytes(&log_for_pump, "err", &bytes),
                CommandEvent::Error(message) => {
                    log_line(&log_for_pump, &format!("sidecar error: {message}"))
                }
                CommandEvent::Terminated(payload) => log_line(
                    &log_for_pump,
                    &format!(
                        "sidecar exited: code={:?} signal={:?}",
                        payload.code, payload.signal
                    ),
                ),
                _ => {}
            }
        }
    });

    Ok(child)
}

fn navigate_to_service(window: &WebviewWindow, port: u16) {
    let _ = window.eval(&format!("window.location.replace('http://127.0.0.1:{port}')"));
}

fn show_launch_error(window: &WebviewWindow, log_path: &Path) {
    let safe = log_path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('\'', "\\'");
    // boot.html defines __comoteLaunchError; calling it flips the page from the
    // loading state to a readable failure message that points at the log file.
    let _ = window.eval(&format!(
        "window.__comoteLaunchError && window.__comoteLaunchError('{safe}')"
    ));
}

fn wait_for_service(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

fn is_service_running(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

fn log_line(log_path: &Path, message: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "{message}");
    }
}

fn log_bytes(log_path: &Path, stream: &str, bytes: &[u8]) {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim_end();
    if !trimmed.is_empty() {
        log_line(log_path, &format!("[{stream}] {trimmed}"));
    }
}
