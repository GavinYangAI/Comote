#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::PathBuf,
    process::Child as SystemChild,
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
#[cfg(not(target_os = "windows"))]
use tauri_plugin_shell::process::CommandChild;
#[cfg(not(target_os = "windows"))]
use tauri_plugin_shell::ShellExt;

struct ComoteSidecar(Mutex<Option<ComoteChild>>);

enum ComoteChild {
    #[cfg(not(target_os = "windows"))]
    Shell(CommandChild),
    System(SystemChild),
    // A daemon this app adopted from a previous keep-alive session: we only hold
    // its PID, not a Child handle, so stop/restart still work on it.
    Pid(u32),
}

impl ComoteChild {
    fn pid(&self) -> Option<u32> {
        match self {
            #[cfg(not(target_os = "windows"))]
            ComoteChild::Shell(child) => Some(child.pid()),
            ComoteChild::System(child) => Some(child.id()),
            ComoteChild::Pid(pid) => Some(*pid),
        }
    }

    fn kill(self) {
        match self {
            #[cfg(not(target_os = "windows"))]
            ComoteChild::Shell(child) => {
                let _ = child.kill();
            }
            ComoteChild::System(mut child) => {
                let _ = child.kill();
            }
            ComoteChild::Pid(pid) => {
                #[cfg(unix)]
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGKILL);
                }
                #[cfg(target_os = "windows")]
                {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/F", "/PID", &pid.to_string()])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                }
            }
        }
    }

    // Asks the Node daemon to shut down cleanly (SIGTERM triggers its graceful
    // server.close path), then SIGKILLs as a backstop if it overstays the grace
    // window. The daemon force-exits itself after ~2s, so 2.5s is generous.
    #[cfg(unix)]
    fn graceful_stop(self) {
        let Some(pid) = self.pid() else {
            self.kill();
            return;
        };
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_millis(2500);
        while Instant::now() < deadline {
            // kill(pid, 0) probes liveness without sending a signal.
            if unsafe { libc::kill(pid as libc::pid_t, 0) } != 0 {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        self.kill();
    }

    #[cfg(not(unix))]
    fn graceful_stop(self) {
        // Node has no SIGTERM semantics on Windows; a plain kill is the norm.
        self.kill();
    }
}

const COMOTE_VERSION: &str = env!("CARGO_PKG_VERSION");
const COMOTE_PORT: u16 = 16208;
const DEFAULT_SHOW_DOCK_ICON: bool = true;
const DEFAULT_KEEP_DAEMON_ALIVE: bool = false;
const DESKTOP_SETTINGS_FILE: &str = "desktop-settings.json";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

enum ExistingService {
    None,
    Reusable(Option<u32>),
    Mismatched(Option<String>),
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_show_dock_icon,
            set_show_dock_icon,
            get_keep_daemon_alive,
            set_keep_daemon_alive,
            open_external,
            get_platform
        ])
        .setup(|app| {
            let port = COMOTE_PORT;
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            let show_dock_icon = load_show_dock_icon_from_dir(&app_data_dir);
            let existing_service = inspect_existing_service(port, COMOTE_VERSION);

            if let ExistingService::Mismatched(found_version) = &existing_service {
                app.manage(ComoteSidecar(Mutex::new(None)));
                build_main_window(
                    app,
                    WebviewUrl::External(
                        data_url(&version_mismatch_html(
                            found_version.as_deref(),
                            COMOTE_VERSION,
                            port,
                        ))
                        .parse()
                        .unwrap(),
                    ),
                    true,
                )?;
                install_tray(app, show_dock_icon)?;
                return Ok(());
            };

            // Start the bundled daemon (unless a compatible one is already up).
            // A failure here must NOT panic the app: show a recoverable error
            // page and let the user retry via the tray "重启后台服务" item.
            let startup = match existing_service {
                // Adopt the already-running daemon by PID so quitting with
                // keep-alive OFF (and tray restart) can actually stop it.
                ExistingService::Reusable(pid) => Ok(pid.map(ComoteChild::Pid)),
                _ => start_comote_sidecar_ready(app.handle(), port).map(Some),
            };

            match startup {
                Ok(child) => {
                    app.manage(ComoteSidecar(Mutex::new(child)));
                    let window = build_main_window(
                        app,
                        WebviewUrl::External(
                            format!("http://127.0.0.1:{port}").parse().unwrap(),
                        ),
                        show_dock_icon,
                    )?;
                    if show_dock_icon {
                        let _ = window.set_focus();
                    }
                }
                Err(error) => {
                    app.manage(ComoteSidecar(Mutex::new(None)));
                    build_main_window(
                        app,
                        WebviewUrl::External(
                            data_url(&sidecar_failed_html(&error.to_string(), port))
                                .parse()
                                .unwrap(),
                        ),
                        true,
                    )?;
                }
            }

            install_tray(app, show_dock_icon)?;

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
        // Window close only hides (see on_window_event), so the sidecar is
        // stopped on actual app termination. ExitRequested does not fire on
        // every quit path (e.g. an Apple-Event quit), so handle the final
        // RunEvent::Exit too; the stop/release helpers are idempotent.
        match event {
            RunEvent::ExitRequested { .. } => handle_app_exit(app_handle),
            RunEvent::Exit => handle_app_exit(app_handle),
            _ => {}
        }
    });
}

fn handle_app_exit(app_handle: &AppHandle) {
    let keep_alive = app_handle
        .path()
        .app_data_dir()
        .map(|dir| load_keep_daemon_alive_from_dir(&dir))
        .unwrap_or(DEFAULT_KEEP_DAEMON_ALIVE);
    if keep_alive {
        // Leave the daemon running so the phone can still reach Codex.
        release_comote_sidecar(app_handle);
    } else {
        stop_comote_sidecar(app_handle);
    }
}

#[tauri::command]
fn get_show_dock_icon(app: AppHandle) -> Result<bool, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(load_show_dock_icon_from_dir(&app_data_dir))
}

#[tauri::command]
fn set_show_dock_icon(app: AppHandle, show: bool) -> Result<bool, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    save_show_dock_icon_to_dir(&app_data_dir, show).map_err(|error| error.to_string())?;
    apply_dock_icon_preference(&app, show, true)?;
    Ok(show)
}

#[tauri::command]
fn get_keep_daemon_alive(app: AppHandle) -> Result<bool, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(load_keep_daemon_alive_from_dir(&app_data_dir))
}

#[tauri::command]
fn set_keep_daemon_alive(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    save_keep_daemon_alive_to_dir(&app_data_dir, enabled).map_err(|error| error.to_string())?;
    Ok(enabled)
}

// Opens an external link in the system default browser. The daemon UI runs in a
// remote-origin webview where <a target="_blank"> is a no-op, so the frontend
// routes outbound links here. Only http(s) is allowed — never file:, etc.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("refused to open non-http(s) url: {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

// Lets the daemon UI hide OS-specific controls (e.g. the macOS-only Dock toggle
// has no meaning on Windows). Returns std::env::consts::OS: "macos", "windows", …
#[tauri::command]
fn get_platform() -> &'static str {
    std::env::consts::OS
}

fn build_main_window(
    app: &tauri::App,
    url: WebviewUrl,
    visible: bool,
) -> tauri::Result<tauri::WebviewWindow> {
    WebviewWindowBuilder::new(app, "main", url)
        .title("Comote")
        .inner_size(1280.0, 800.0)
        .min_inner_size(960.0, 600.0)
        .visible(visible)
        .build()
}

fn install_tray(app: &mut tauri::App, show_dock_icon: bool) -> tauri::Result<()> {
    // Show in the Dock (Regular) so users get the usual app affordance,
    // and ALSO live in the top-of-screen tray for quick access.
    #[cfg(target_os = "macos")]
    app.set_activation_policy(if show_dock_icon {
        tauri::ActivationPolicy::Regular
    } else {
        tauri::ActivationPolicy::Accessory
    });

    // A tray icon keeps Comote resident. Without it, closing the window
    // would stop the local daemon and break the phone bridge — exactly
    // when the user is away from the Mac and needs it most.
    let show = MenuItem::with_id(app, "show", "打开 Comote", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启后台服务", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Comote", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &restart, &quit])?;
    TrayIconBuilder::new()
        .icon(app.default_window_icon().expect("app icon").clone())
        .tooltip("Comote")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "restart" => match restart_comote_sidecar(app, COMOTE_PORT) {
                Ok(()) => show_main_window(app),
                Err(error) => eprintln!("failed to restart comote daemon: {error}"),
            },
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn load_show_dock_icon_from_dir(app_data_dir: &PathBuf) -> bool {
    match read_settings_body(app_data_dir) {
        Some(body) => show_dock_icon_from_settings_body(&body),
        None => DEFAULT_SHOW_DOCK_ICON,
    }
}

fn save_show_dock_icon_to_dir(app_data_dir: &PathBuf, show: bool) -> std::io::Result<()> {
    let keep_alive = load_keep_daemon_alive_from_dir(app_data_dir);
    write_settings(app_data_dir, show, keep_alive)
}

fn load_keep_daemon_alive_from_dir(app_data_dir: &PathBuf) -> bool {
    match read_settings_body(app_data_dir) {
        Some(body) => keep_daemon_alive_from_settings_body(&body),
        None => DEFAULT_KEEP_DAEMON_ALIVE,
    }
}

fn save_keep_daemon_alive_to_dir(app_data_dir: &PathBuf, enabled: bool) -> std::io::Result<()> {
    let show_dock = load_show_dock_icon_from_dir(app_data_dir);
    write_settings(app_data_dir, show_dock, enabled)
}

fn read_settings_body(app_data_dir: &PathBuf) -> Option<String> {
    fs::read_to_string(desktop_settings_path(app_data_dir)).ok()
}

// Both desktop preferences live in one JSON file, so always write the full set
// to avoid clobbering the field that wasn't being changed.
fn write_settings(app_data_dir: &PathBuf, show_dock_icon: bool, keep_daemon_alive: bool) -> std::io::Result<()> {
    let settings_path = desktop_settings_path(app_data_dir);
    fs::write(
        settings_path,
        format!("{{\"showDockIcon\":{show_dock_icon},\"keepDaemonAlive\":{keep_daemon_alive}}}\n"),
    )
}

fn desktop_settings_path(app_data_dir: &PathBuf) -> PathBuf {
    app_data_dir.join(DESKTOP_SETTINGS_FILE)
}

fn show_dock_icon_from_settings_body(body: &str) -> bool {
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    !compact.contains("\"showDockIcon\":false")
}

fn keep_daemon_alive_from_settings_body(body: &str) -> bool {
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    compact.contains("\"keepDaemonAlive\":true")
}

fn apply_dock_icon_preference(
    app: &AppHandle,
    show: bool,
    hide_window_when_hidden: bool,
) -> Result<(), String> {
    // On macOS the Dock icon only drops at runtime if the window is hidden
    // *before* switching to Accessory; switching the policy alone is a no-op
    // on an app that launched as Regular. See tauri discussion #10774.
    let window = app.get_webview_window("main");
    if show {
        #[cfg(target_os = "macos")]
        app.set_activation_policy(tauri::ActivationPolicy::Regular)
            .map_err(|error| error.to_string())?;
        if let Some(window) = &window {
            window.show().map_err(|error| error.to_string())?;
            let _ = window.set_focus();
        }
    } else {
        if hide_window_when_hidden {
            if let Some(window) = &window {
                window.hide().map_err(|error| error.to_string())?;
            }
        }
        #[cfg(target_os = "macos")]
        app.set_activation_policy(tauri::ActivationPolicy::Accessory)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
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
                child.graceful_stop();
            }
        }
    }
}

// Stops any running daemon, starts a fresh one, waits for it to listen, and
// stores the new handle. On success the main window is pointed back at the live
// daemon. Returns Err (never panics) so the tray handler can surface failure.
fn restart_comote_sidecar(app: &AppHandle, port: u16) -> Result<(), String> {
    stop_comote_sidecar(app);
    let child = start_comote_sidecar_ready(app, port).map_err(|error| error.to_string())?;
    if let Some(state) = app.try_state::<ComoteSidecar>() {
        if let Ok(mut slot) = state.0.lock() {
            *slot = Some(child);
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        // The window may be showing the error page or a dead URL; navigate it
        // back to the now-live daemon.
        let url = format!("http://127.0.0.1:{port}");
        let _ = window.eval(format!("window.location.replace('{url}')"));
    }
    Ok(())
}

// Detaches the daemon without killing it: take the handle so its Drop does not
// terminate the child, leaving it running after the app quits.
fn release_comote_sidecar(app: &AppHandle) {
    if let Some(state) = app.try_state::<ComoteSidecar>() {
        if let Ok(mut child) = state.0.lock() {
            let _ = child.take();
        }
    }
}

fn start_comote_sidecar_ready(app: &AppHandle, port: u16) -> tauri::Result<ComoteChild> {
    let child = start_comote_sidecar(app, port)?;
    match wait_for_service(port) {
        Ok(()) => Ok(child),
        Err(error) => {
            child.kill();
            let fallback = start_manual_comote_node_from_app(app, port).map_err(|fallback_error| {
                tauri::Error::Anyhow(anyhow::anyhow!(
                    "bundled comote-node started but did not listen on 127.0.0.1:{port}: {error}; manual comote-node.exe fallback failed: {fallback_error}"
                ))
            })?;
            wait_for_service(port)?;
            Ok(ComoteChild::System(fallback))
        }
    }
}

fn start_comote_sidecar(app: &AppHandle, port: u16) -> tauri::Result<ComoteChild> {
    let resource_dir = app.path().resource_dir()?;
    let app_data_dir = app.path().app_data_dir()?;
    fs::create_dir_all(&app_data_dir)?;

    let server_entry = resource_dir
        .join("comote-server")
        .join("src")
        .join("server")
        .join("index.js");
    let state_path = app_data_dir.join("state.json");

    #[cfg(target_os = "windows")]
    {
        return start_manual_comote_node(&resource_dir, server_entry, port, state_path)
            .map(ComoteChild::System)
            .map_err(|error| {
                tauri::Error::Anyhow(anyhow::anyhow!(
                    "failed to start comote-node.exe: {error}"
                ))
            });
    }

    #[cfg(not(target_os = "windows"))]
    {
    let sidecar_result = app
        .shell()
        .sidecar("comote-node")
        .map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))?
        .args([server_entry_to_string(server_entry.clone())])
        .env("PORT", port.to_string())
        .env("COMOTE_STATE_PATH", path_to_string(state_path.clone()))
        .spawn();

    match sidecar_result {
        Ok((_receiver, child)) => Ok(ComoteChild::Shell(child)),
        Err(error) => start_manual_comote_node(&resource_dir, server_entry, port, state_path)
            .map(ComoteChild::System)
            .map_err(|fallback_error| {
                tauri::Error::Anyhow(anyhow::anyhow!(
                    "failed to start bundled comote-node sidecar: {error}; manual comote-node.exe fallback failed: {fallback_error}"
                ))
            }),
    }
    }
}

fn start_manual_comote_node_from_app(app: &AppHandle, port: u16) -> std::io::Result<SystemChild> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error.to_string()))?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error.to_string()))?;
    let server_entry = resource_dir
        .join("comote-server")
        .join("src")
        .join("server")
        .join("index.js");
    let state_path = app_data_dir.join("state.json");

    start_manual_comote_node(&resource_dir, server_entry, port, state_path)
}

fn start_manual_comote_node(
    resource_dir: &PathBuf,
    server_entry: PathBuf,
    port: u16,
    state_path: PathBuf,
) -> std::io::Result<SystemChild> {
    #[cfg(target_os = "windows")]
    {
        let log_dir = state_path
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| resource_dir.clone());
        let _ = fs::create_dir_all(&log_dir);
        let stdout = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("comote-node.stdout.log"))?;
        let stderr = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("comote-node.stderr.log"))?;
        let executable = windows_manual_sidecar_candidates(resource_dir)
            .into_iter()
            .find(|candidate| candidate.exists())
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "comote-node.exe was not found",
                )
            })?;
        return std::process::Command::new(normalize_windows_path(executable))
            .arg(normalize_windows_path(server_entry))
            .current_dir(normalize_windows_path(resource_dir.clone()))
            .env("PORT", port.to_string())
            .env("COMOTE_STATE_PATH", normalize_windows_path(state_path))
            .stdout(stdout)
            .stderr(stderr)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (resource_dir, server_entry, port, state_path);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "manual comote-node fallback is only available on Windows",
        ))
    }
}

#[cfg(any(target_os = "windows", test))]
fn windows_manual_sidecar_candidates(resource_dir: &PathBuf) -> Vec<PathBuf> {
    vec![
        resource_dir.join("comote-node.exe"),
        resource_dir.join("comote-node-x86_64-pc-windows-msvc.exe"),
        resource_dir.join("comote-node-aarch64-pc-windows-msvc.exe"),
        resource_dir.join("binaries").join("comote-node.exe"),
        resource_dir
            .join("binaries")
            .join("comote-node-x86_64-pc-windows-msvc.exe"),
        resource_dir
            .join("binaries")
            .join("comote-node-aarch64-pc-windows-msvc.exe"),
    ]
}

fn wait_for_service(port: u16) -> tauri::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(150));
    }
    Err(tauri::Error::Anyhow(anyhow::anyhow!(
        "Comote service did not start on 127.0.0.1:{port}"
    )))
}

fn inspect_existing_service(port: u16, expected_version: &str) -> ExistingService {
    let Some((version, pid)) = fetch_service_version(port) else {
        return ExistingService::None;
    };
    match version {
        None => ExistingService::Mismatched(None),
        Some(version) if can_reuse_existing_service(Some(&version), expected_version) => {
            ExistingService::Reusable(pid)
        }
        Some(version) => ExistingService::Mismatched(Some(version)),
    }
}

fn fetch_service_version(port: u16) -> Option<(Option<String>, Option<u32>)> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    let timeout = Some(Duration::from_millis(600));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    let request = "GET /api/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    stream.write_all(request.as_bytes()).ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let body = response
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or(response.as_str());
    Some((
        service_version_from_status_body(body),
        service_pid_from_body(body),
    ))
}

// Pulls the daemon's process id out of the /api/version JSON ("pid":12345) so a
// reused daemon can be adopted as a killable handle.
fn service_pid_from_body(body: &str) -> Option<u32> {
    let after_key = body.split("\"pid\"").nth(1)?;
    let after_colon = after_key.split_once(':')?.1.trim_start();
    let digits: String = after_colon
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn can_reuse_existing_service(found_version: Option<&str>, expected_version: &str) -> bool {
    found_version == Some(expected_version)
}

fn service_version_from_status_body(body: &str) -> Option<String> {
    let marker = "\"version\"";
    let after_key = body.split(marker).nth(1)?;
    let after_colon = after_key.split_once(':')?.1.trim_start();
    let after_quote = after_colon.strip_prefix('"')?;
    let version = after_quote.split('"').next()?;
    if version.is_empty() {
        None
    } else {
        Some(version.to_string())
    }
}

fn version_mismatch_html(found_version: Option<&str>, expected_version: &str, port: u16) -> String {
    let found = found_version.unwrap_or("未知");
    format!(
        r#"<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<style>
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbfaf9;color:#1f2430;font:15px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}}
main{{width:min(560px,calc(100vw - 48px));padding:30px;border:1px solid #e5e3de;border-radius:16px;background:white;box-shadow:0 10px 30px rgba(0,0,0,.06)}}
h1{{margin:0 0 10px;font-size:24px;line-height:1.25}}
p{{margin:8px 0;color:#525a68;line-height:1.6}}
dl{{display:grid;grid-template-columns:120px 1fr;margin:18px 0;border:1px solid #eeede9;border-radius:10px;overflow:hidden}}
dt,dd{{margin:0;padding:10px 12px;background:#faf9f8;border-bottom:1px solid #eeede9}}
dt{{color:#6b7280}} dd{{font-weight:700}}
dt:last-of-type,dd:last-of-type{{border-bottom:0}}
code{{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}}
</style>
<main>
  <h1>Comote 仍在运行旧版本</h1>
  <p>检测到 <code>127.0.0.1:{port}</code> 已被另一个 Comote daemon 占用。为避免新版界面连接到旧版服务，本次不会复用它，也不会启动第二个 daemon。</p>
  <dl><dt>正在运行</dt><dd>{found}</dd><dt>当前应用</dt><dd>{expected_version}</dd></dl>
  <p>请从菜单栏或 Dock 退出旧版 Comote，然后重新打开当前版本。</p>
</main></html>"#
    )
}

fn sidecar_failed_html(error: &str, port: u16) -> String {
    let safe_error = html_escape(error);
    format!(
        r#"<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<style>
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#fbfaf9;color:#1f2430;font:15px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}}
main{{width:min(560px,calc(100vw - 48px));padding:30px;border:1px solid #e5e3de;border-radius:16px;background:white;box-shadow:0 10px 30px rgba(0,0,0,.06)}}
h1{{margin:0 0 10px;font-size:24px;line-height:1.25}}
p{{margin:8px 0;color:#525a68;line-height:1.6}}
pre{{margin:14px 0;padding:12px;background:#faf9f8;border:1px solid #eeede9;border-radius:10px;white-space:pre-wrap;word-break:break-word;color:#9a3b3b;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}}
</style>
<main>
  <h1>后台服务启动失败</h1>
  <p>Comote 的本地后台服务（<code>127.0.0.1:{port}</code>）未能启动，所以设置页暂时无法打开。</p>
  <p>请点击菜单栏 / 托盘里的 <strong>「重启后台服务」</strong> 重试。如果反复失败，请检查端口是否被占用或查看日志。</p>
  <pre>{safe_error}</pre>
</main></html>"#
    )
}

fn html_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn data_url(html: &str) -> String {
    let mut encoded = String::with_capacity(html.len());
    for byte in html.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    format!("data:text/html;charset=utf-8,{encoded}")
}

#[cfg(not(target_os = "windows"))]
fn server_entry_to_string(path: PathBuf) -> String {
    path_to_string(path)
}

#[cfg(not(target_os = "windows"))]
fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(target_os = "windows")]
fn normalize_windows_path(path: PathBuf) -> PathBuf {
    let body = path.to_string_lossy();
    if let Some(stripped) = body.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_daemon_version_from_api_status_body() {
        assert_eq!(
            service_version_from_status_body(r#"{"version":"0.2.1","latest":"0.2.1"}"#),
            Some("0.2.1".to_string())
        );
    }

    #[test]
    fn extracts_daemon_pid_from_api_version_body() {
        assert_eq!(
            service_pid_from_body(r#"{"version":"0.2.4","pid":91632,"latest":null}"#),
            Some(91632)
        );
        assert_eq!(service_pid_from_body(r#"{"version":"0.2.4"}"#), None);
    }

    #[test]
    fn rejects_reusing_mismatched_daemon_versions() {
        assert!(!can_reuse_existing_service(Some("0.2.0"), "0.2.1"));
        assert!(can_reuse_existing_service(Some("0.2.1"), "0.2.1"));
    }

    #[test]
    fn missing_daemon_version_is_not_reusable() {
        match service_version_from_status_body(r#"{"latest":"0.2.1"}"#) {
            None => {}
            Some(version) => panic!("unexpected version parsed: {version}"),
        }
    }

    #[test]
    fn windows_manual_sidecar_candidates_include_plain_exe_first() {
        let resource_dir = PathBuf::from(r"C:\Program Files\Comote");
        let candidates = windows_manual_sidecar_candidates(&resource_dir);

        assert_eq!(candidates[0], resource_dir.join("comote-node.exe"));
        assert!(candidates.contains(&resource_dir.join("comote-node-x86_64-pc-windows-msvc.exe")));
        assert!(candidates.contains(&resource_dir.join("comote-node-aarch64-pc-windows-msvc.exe")));
    }

    #[test]
    fn dock_icon_preference_defaults_to_visible() {
        assert_eq!(show_dock_icon_from_settings_body(""), true);
        assert_eq!(show_dock_icon_from_settings_body("{}"), true);
    }

    #[test]
    fn dock_icon_preference_reads_saved_false() {
        assert_eq!(
            show_dock_icon_from_settings_body(r#"{"showDockIcon":false}"#),
            false
        );
    }

    #[test]
    fn keep_daemon_alive_defaults_to_false() {
        assert_eq!(keep_daemon_alive_from_settings_body(""), false);
        assert_eq!(keep_daemon_alive_from_settings_body("{}"), false);
        assert_eq!(
            keep_daemon_alive_from_settings_body(r#"{"showDockIcon":false}"#),
            false
        );
    }

    #[test]
    fn keep_daemon_alive_reads_saved_true() {
        assert_eq!(
            keep_daemon_alive_from_settings_body(r#"{"showDockIcon":true,"keepDaemonAlive":true}"#),
            true
        );
    }

    #[test]
    fn both_preferences_coexist_in_one_body() {
        let body = r#"{"showDockIcon":false,"keepDaemonAlive":true}"#;
        assert_eq!(show_dock_icon_from_settings_body(body), false);
        assert_eq!(keep_daemon_alive_from_settings_body(body), true);
    }

    #[test]
    fn sidecar_failed_html_shows_port_and_restart_hint() {
        let html = sidecar_failed_html("spawn EPERM", 16208);
        assert!(html.contains("127.0.0.1:16208"));
        assert!(html.contains("重启后台服务"));
        assert!(html.contains("spawn EPERM"));
    }

    #[test]
    fn html_escape_neutralizes_markup() {
        assert_eq!(html_escape("a<b>&c"), "a&lt;b&gt;&amp;c");
    }
}
