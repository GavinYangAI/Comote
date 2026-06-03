#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::Child as SystemChild,
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

struct ComoteSidecar(Mutex<Option<ComoteChild>>);

// A handle to the Comote daemon, in one of three forms:
//   - Shell:  the Tauri-managed sidecar (the normal macOS/Linux path).
//   - System: a daemon we spawned ourselves via std::process (B3c Windows
//             manual sidecar and the cross-OS fallback).
//   - Pid:    a daemon from a previous keep-alive session that we adopted by
//             pid only — no Child handle, but still stoppable.
enum ComoteChild {
    Shell(CommandChild),
    // Constructed by the B3c Windows manual sidecar / cross-OS fallback.
    #[allow(dead_code)]
    System(SystemChild),
    Pid(u32),
}

impl ComoteChild {
    fn pid(&self) -> Option<u32> {
        match self {
            ComoteChild::Shell(child) => Some(child.pid()),
            ComoteChild::System(child) => Some(child.id()),
            ComoteChild::Pid(pid) => Some(*pid),
        }
    }

    fn kill(self) {
        match self {
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
                        .output();
                }
                #[cfg(not(any(unix, target_os = "windows")))]
                let _ = pid;
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
        let outcome = graceful_stop_unix(
            pid,
            Duration::from_millis(2500),
            Duration::from_millis(100),
            |pid| unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) == 0 },
            |pid| unsafe { libc::kill(pid as libc::pid_t, 0) == 0 },
            |dur| thread::sleep(dur),
        );
        if matches!(outcome, GracefulStop::TimedOutNeedsKill) {
            self.kill();
        }
    }

    #[cfg(not(unix))]
    fn graceful_stop(self) {
        // Node has no SIGTERM semantics on Windows; a plain kill is the norm.
        self.kill();
    }
}

// Outcome of the graceful-stop state machine, factored out of the syscalls so it
// can be unit-tested without sending real signals.
#[derive(Debug, PartialEq, Eq)]
enum GracefulStop {
    // The process exited within the grace window (no SIGKILL needed).
    Exited,
    // The grace window elapsed while the process was still alive — caller must
    // SIGKILL.
    TimedOutNeedsKill,
}

// Pure-ish driver for graceful stop: send SIGTERM, then poll liveness until the
// process exits or the deadline passes. `sigterm` returns whether the signal was
// delivered; `is_alive` probes liveness; `sleep` advances the (test or real)
// clock. Time is measured with Instant so tests can use a fast poll/grace ratio.
#[cfg(unix)]
fn graceful_stop_unix(
    pid: u32,
    grace: Duration,
    poll: Duration,
    sigterm: impl Fn(u32) -> bool,
    is_alive: impl Fn(u32) -> bool,
    sleep: impl Fn(Duration),
) -> GracefulStop {
    sigterm(pid);
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if !is_alive(pid) {
            return GracefulStop::Exited;
        }
        sleep(poll);
    }
    if is_alive(pid) {
        GracefulStop::TimedOutNeedsKill
    } else {
        GracefulStop::Exited
    }
}

const COMOTE_VERSION: &str = env!("CARGO_PKG_VERSION");
const PORT: u16 = 16208;
// Default: do NOT keep the daemon alive after quit, matching the pre-keep-alive
// behavior. Persisted in desktop-settings.json under the app data dir.
const DEFAULT_KEEP_DAEMON_ALIVE: bool = false;
const DESKTOP_SETTINGS_FILE: &str = "desktop-settings.json";

// Result of probing 127.0.0.1:PORT for an already-running Comote daemon.
enum ExistingService {
    // Nothing is listening — start our own bundled daemon.
    None,
    // A daemon whose version matches ours is up; reuse it as-is. Carries the
    // daemon's pid (when reported) so a future quit path can adopt and stop it.
    Reusable(Option<u32>),
    // A daemon is up but its version differs (or could not be read). Reusing it
    // would point the new UI at a stale service, so refuse. Carries the found
    // version (when known) for the launch log.
    Mismatched(Option<String>),
}
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

            // Inspect any already-listening daemon before starting our own. We
            // only reuse a daemon whose /api/version matches ours; a mismatched
            // (older) daemon must NOT be reused, or the new UI would talk to a
            // stale service. We also never start a second daemon on the port.
            let existing = inspect_existing_service(PORT, COMOTE_VERSION);

            let child = match existing {
                ExistingService::Mismatched(found_version) => {
                    log_line(
                        &log_path,
                        &format!(
                            "Existing daemon version {} does not match app version {}; refusing to reuse",
                            found_version.as_deref().unwrap_or("unknown"),
                            COMOTE_VERSION
                        ),
                    );
                    // Reuse our error surface: the boot page flips to its error
                    // state and points at the log, which now explains the version
                    // conflict and how to recover (quit the old Comote).
                    show_launch_error(&window, &log_path);
                    app.manage(ComoteSidecar(Mutex::new(None)));
                    return Ok(());
                }
                ExistingService::Reusable(pid) => {
                    log_line(
                        &log_path,
                        &format!(
                            "Existing service matches app version (pid {}); reusing without starting sidecar",
                            pid.map(|p| p.to_string()).unwrap_or_else(|| "unknown".into())
                        ),
                    );
                    // Adopt the daemon by pid so a quit with keep-alive OFF can
                    // still stop it. With no pid we can only leave it running.
                    pid.map(ComoteChild::Pid)
                }
                ExistingService::None => match start_comote_sidecar(app, PORT, &log_path) {
                    Ok(child) => Some(child),
                    Err(error) => {
                        log_line(&log_path, &format!("Failed to start sidecar: {error}"));
                        show_launch_error(&window, &log_path);
                        None
                    }
                },
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
        // Window close only hides (see on_window_event), so the daemon is dealt
        // with on actual termination. ExitRequested does not fire on every quit
        // path (e.g. an Apple-Event quit), so handle the final RunEvent::Exit
        // too; the stop/release helpers are idempotent (they take the handle).
        match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => handle_app_exit(app_handle),
            _ => {}
        }
    });
}

// On quit, honor the keep-alive preference: leave the daemon running (release
// our handle so its Drop won't kill it) when keep-alive is ON, otherwise stop it
// gracefully (SIGTERM → poll → SIGKILL).
fn handle_app_exit(app_handle: &AppHandle) {
    let keep_alive = app_handle
        .path()
        .app_data_dir()
        .map(|dir| load_keep_daemon_alive_from_dir(&dir))
        .unwrap_or(DEFAULT_KEEP_DAEMON_ALIVE);
    if keep_alive {
        release_comote_sidecar(app_handle);
    } else {
        stop_comote_sidecar(app_handle);
    }
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

// Detaches the daemon without stopping it: take the handle so its Drop does not
// terminate the child, leaving it alive after the app quits (keep-alive ON).
fn release_comote_sidecar(app: &AppHandle) {
    if let Some(state) = app.try_state::<ComoteSidecar>() {
        if let Ok(mut child) = state.0.lock() {
            let _ = child.take();
        }
    }
}

fn start_comote_sidecar(
    app: &tauri::App,
    port: u16,
    log_path: &Path,
) -> tauri::Result<ComoteChild> {
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

    Ok(ComoteChild::Shell(child))
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

// Probes the port for an existing daemon and classifies it for reuse. A daemon
// is reusable only when its reported version equals ours.
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

// Speaks just enough HTTP/1.1 to GET /api/version and read the JSON body. Kept
// dependency-free (raw TCP) because the only consumer is this one probe and we
// don't want an HTTP client crate in the desktop shell.
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

fn can_reuse_existing_service(found_version: Option<&str>, expected_version: &str) -> bool {
    found_version == Some(expected_version)
}

// Extracts the "version" string from the /api/version JSON body.
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

// Extracts the daemon's process id ("pid":12345) from the /api/version JSON so a
// reused daemon can later be adopted as a killable handle.
fn service_pid_from_body(body: &str) -> Option<u32> {
    let after_key = body.split("\"pid\"").nth(1)?;
    let after_colon = after_key.split_once(':')?.1.trim_start();
    let digits: String = after_colon
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    digits.parse().ok()
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

// --- keep-alive preference persistence (read on quit, written by B3e commands) ---

fn desktop_settings_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DESKTOP_SETTINGS_FILE)
}

fn load_keep_daemon_alive_from_dir(app_data_dir: &Path) -> bool {
    match fs::read_to_string(desktop_settings_path(app_data_dir)) {
        Ok(body) => keep_daemon_alive_from_settings_body(&body),
        Err(_) => DEFAULT_KEEP_DAEMON_ALIVE,
    }
}

#[allow(dead_code)] // wired to the set_keep_daemon_alive command in B3e
fn save_keep_daemon_alive_to_dir(app_data_dir: &Path, enabled: bool) -> std::io::Result<()> {
    fs::write(
        desktop_settings_path(app_data_dir),
        format!("{{\"keepDaemonAlive\":{enabled}}}\n"),
    )
}

// Tolerant of formatting/whitespace and missing keys; only an explicit
// "keepDaemonAlive":true enables it.
fn keep_daemon_alive_from_settings_body(body: &str) -> bool {
    let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    compact.contains("\"keepDaemonAlive\":true")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_daemon_version_from_api_version_body() {
        assert_eq!(
            service_version_from_status_body(r#"{"version":"0.2.1","pid":42,"latest":"0.2.1"}"#),
            Some("0.2.1".to_string())
        );
    }

    #[test]
    fn missing_daemon_version_is_not_parsed() {
        assert_eq!(
            service_version_from_status_body(r#"{"latest":"0.2.1","pid":42}"#),
            None
        );
        // An explicit empty version string is treated as unknown, not reusable.
        assert_eq!(
            service_version_from_status_body(r#"{"version":"","pid":42}"#),
            None
        );
    }

    #[test]
    fn extracts_daemon_pid_from_api_version_body() {
        assert_eq!(
            service_pid_from_body(r#"{"version":"0.2.1","pid":91632,"latest":null}"#),
            Some(91632)
        );
        assert_eq!(service_pid_from_body(r#"{"version":"0.2.1"}"#), None);
    }

    #[test]
    fn rejects_reusing_mismatched_daemon_versions() {
        assert!(can_reuse_existing_service(Some("0.2.1"), "0.2.1"));
        assert!(!can_reuse_existing_service(Some("0.2.0"), "0.2.1"));
        assert!(!can_reuse_existing_service(None, "0.2.1"));
    }

    #[test]
    fn keep_daemon_alive_defaults_to_false_and_reads_true() {
        assert_eq!(keep_daemon_alive_from_settings_body(""), false);
        assert_eq!(keep_daemon_alive_from_settings_body("{}"), false);
        assert_eq!(
            keep_daemon_alive_from_settings_body(r#"{"keepDaemonAlive":false}"#),
            false
        );
        assert_eq!(
            keep_daemon_alive_from_settings_body(r#"{ "keepDaemonAlive" : true }"#),
            true
        );
    }

    #[cfg(unix)]
    #[test]
    fn graceful_stop_returns_exited_when_process_dies_in_grace() {
        use std::cell::Cell;
        let alive = Cell::new(true);
        let sent = Cell::new(false);
        let outcome = graceful_stop_unix(
            123,
            Duration::from_millis(2500),
            Duration::from_millis(1),
            |_| {
                sent.set(true);
                true
            },
            // Alive for the first probe, then the SIGTERM "takes effect".
            |_| {
                let was = alive.get();
                alive.set(false);
                was
            },
            |_| {},
        );
        assert!(sent.get(), "SIGTERM must be sent first");
        assert_eq!(outcome, GracefulStop::Exited);
    }

    #[cfg(unix)]
    #[test]
    fn graceful_stop_requests_kill_when_process_outlives_grace() {
        // Process never dies → after the (tiny) grace window the caller is told
        // to SIGKILL it.
        let outcome = graceful_stop_unix(
            123,
            Duration::from_millis(2),
            Duration::from_millis(1),
            |_| true,
            |_| true,
            |dur| std::thread::sleep(dur),
        );
        assert_eq!(outcome, GracefulStop::TimedOutNeedsKill);
    }
}
