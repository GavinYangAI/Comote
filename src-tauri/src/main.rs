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

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::CommandChild;
#[cfg(not(target_os = "windows"))]
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

struct ComoteSidecar(Mutex<Option<ComoteChild>>);

// A handle to the Comote daemon, in one of three forms:
//   - Shell:  the Tauri-managed sidecar (the normal macOS/Linux path).
//   - System: a daemon we spawned ourselves via std::process (B3c Windows
//             manual sidecar and the cross-OS fallback).
//   - Pid:    a daemon from a previous keep-alive session that we adopted by
//             pid only — no Child handle, but still stoppable.
enum ComoteChild {
    Shell(CommandChild),
    // The Windows manual sidecar, or the cross-OS fallback when the shell
    // sidecar fails to spawn.
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
// Windows: spawn comote-node.exe without flashing a console window.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

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
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            open_external,
            get_keep_daemon_alive,
            set_keep_daemon_alive
        ])
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

// Reads the persisted "keep daemon alive after quit" preference for the UI
// toggle (B3e) and the quit path (B3b).
#[tauri::command]
fn get_keep_daemon_alive(app: AppHandle) -> Result<bool, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(load_keep_daemon_alive_from_dir(&app_data_dir))
}

// Persists the keep-alive preference; the quit path reads it back to decide
// whether to release or stop the daemon.
#[tauri::command]
fn set_keep_daemon_alive(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    save_keep_daemon_alive_to_dir(&app_data_dir, enabled).map_err(|e| e.to_string())?;
    Ok(enabled)
}

// Opens an external link in the system default browser. The daemon UI runs in a
// remote-origin webview where <a target="_blank"> is a no-op, so the frontend
// routes outbound links here. Only http(s) is allowed — never file:, etc.
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    // Lowercase only for the scheme gate so `HTTPS://` is accepted; still
    // http(s)-only (fail safe). The original-case url is what we actually open.
    let scheme = url.to_ascii_lowercase();
    if !(scheme.starts_with("http://") || scheme.starts_with("https://")) {
        return Err(format!("refused to open non-http(s) url: {url}"));
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
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

    // Windows: the Tauri shell sidecar has been unreliable (no console, output
    // discarded, occasional spawn failures), so start comote-node.exe directly.
    #[cfg(target_os = "windows")]
    {
        return start_manual_comote_node(&resource_dir, server_entry, port, state_path, log_path)
            .map(ComoteChild::System)
            .map_err(|error| {
                tauri::Error::Anyhow(anyhow::anyhow!("failed to start comote-node.exe: {error}"))
            });
    }

    // Non-Windows: use the bundled shell sidecar; if even spawning it fails,
    // fall back to launching comote-node directly (no-op on macOS/Linux today,
    // but the fallback path is shared so the behavior is uniform).
    #[cfg(not(target_os = "windows"))]
    {
        let sidecar_result = app
            .shell()
            .sidecar("comote-node")
            .map_err(|error| tauri::Error::Anyhow(anyhow::anyhow!(error)))?
            .args([path_to_string(server_entry.clone())])
            .env("PORT", port.to_string())
            .env("COMOTE_STATE_PATH", path_to_string(state_path.clone()))
            .spawn();

        let (mut receiver, child) = match sidecar_result {
            Ok(pair) => pair,
            Err(error) => {
                log_line(
                    log_path,
                    &format!("shell sidecar spawn failed ({error}); trying manual comote-node"),
                );
                let fallback =
                    start_manual_comote_node(&resource_dir, server_entry, port, state_path, log_path)
                        .map_err(|fallback_error| {
                            tauri::Error::Anyhow(anyhow::anyhow!(
                                "failed to start bundled comote-node sidecar: {error}; manual comote-node fallback failed: {fallback_error}"
                            ))
                        })?;
                return Ok(ComoteChild::System(fallback));
            }
        };

        // Pump the sidecar's stdout/stderr (and exit status) into the launch
        // log. Previously this stream was discarded, so a Node crash — a missing
        // module, a bad path, an unhandled error — left no trace at all. Now the
        // reason is recorded where a user (or we) can read it.
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
}

// Launches comote-node directly (no Tauri shell). On Windows this is the primary
// path: it searches known candidate locations for comote-node.exe, redirects
// stdout/stderr to log files, and uses CREATE_NO_WINDOW so no console flashes.
// On non-Windows it is only the fallback when the shell sidecar can't spawn.
#[allow(unused_variables)]
fn start_manual_comote_node(
    resource_dir: &Path,
    server_entry: PathBuf,
    port: u16,
    state_path: PathBuf,
    log_path: &Path,
) -> std::io::Result<SystemChild> {
    #[cfg(target_os = "windows")]
    {
        let log_dir = state_path
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| resource_dir.to_path_buf());
        let _ = fs::create_dir_all(&log_dir);
        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("comote-node.stdout.log"))?;
        let stderr = OpenOptions::new()
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
        log_line(
            log_path,
            &format!(
                "Starting manual comote-node: {}",
                executable.to_string_lossy()
            ),
        );
        return std::process::Command::new(normalize_windows_path(executable))
            .arg(normalize_windows_path(server_entry))
            .current_dir(normalize_windows_path(resource_dir.to_path_buf()))
            .env("PORT", port.to_string())
            .env("COMOTE_STATE_PATH", normalize_windows_path(state_path))
            .stdout(stdout)
            .stderr(stderr)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "manual comote-node fallback is only used on Windows",
        ))
    }
}

// Candidate locations for the manual Windows sidecar. Plain comote-node.exe
// first (NSIS layout), then the target-triple names Tauri may produce, under the
// resource root and a binaries/ subdir. Available to tests on every OS.
#[cfg(any(target_os = "windows", test))]
fn windows_manual_sidecar_candidates(resource_dir: &Path) -> Vec<PathBuf> {
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

// Strips the Windows verbatim/extended-length prefix (\\?\) that Tauri's
// resolved paths sometimes carry, which std::process::Command and the daemon
// handle poorly. Identity on paths without the prefix. Available to tests
// everywhere (operates purely on the string form).
#[cfg(any(target_os = "windows", test))]
fn normalize_windows_path(path: PathBuf) -> PathBuf {
    let body = path.to_string_lossy();
    if let Some(stripped) = body.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else {
        path
    }
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

// Outcome of probing the daemon port. Distinguishing "nothing is listening"
// from "something answered but we couldn't read it" is load-bearing: only the
// former is safe to start our own daemon onto. See classify_service_probe.
enum ServiceProbe {
    // TCP connect failed — the port is free, nothing is listening.
    Unreachable,
    // TCP connect succeeded but the /api/version body couldn't be read or
    // parsed (read timeout, partial/non-UTF-8, missing version). Something
    // already owns the port, so we must NOT start a second daemon onto it.
    Unreadable,
    // A version (and optionally pid) was successfully read from the daemon.
    Read(String, Option<u32>),
}

// Probes the port for an existing daemon and classifies it for reuse. A daemon
// is reusable only when its reported version equals ours.
fn inspect_existing_service(port: u16, expected_version: &str) -> ExistingService {
    classify_service_probe(fetch_service_version(port), expected_version)
}

// Pure classification of a probe outcome into a reuse decision. Kept separate
// from the TCP I/O so it can be unit-tested without a live socket.
//   Unreachable    -> None        (port free; start our own daemon)
//   Unreadable     -> Mismatched  (port occupied; refuse, do NOT double-spawn)
//   Read(version)  -> Reusable iff version matches, else Mismatched
fn classify_service_probe(probe: ServiceProbe, expected_version: &str) -> ExistingService {
    match probe {
        ServiceProbe::Unreachable => ExistingService::None,
        ServiceProbe::Unreadable => ExistingService::Mismatched(None),
        ServiceProbe::Read(version, pid) => {
            if can_reuse_existing_service(Some(&version), expected_version) {
                ExistingService::Reusable(pid)
            } else {
                ExistingService::Mismatched(Some(version))
            }
        }
    }
}

// Speaks just enough HTTP/1.1 to GET /api/version and read the JSON body. Kept
// dependency-free (raw TCP) because the only consumer is this one probe and we
// don't want an HTTP client crate in the desktop shell. A successful connect
// whose body can't be read or parsed yields Unreadable (NOT Unreachable) so the
// caller refuses the port instead of spawning a second daemon onto it.
fn fetch_service_version(port: u16) -> ServiceProbe {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return ServiceProbe::Unreachable;
    };
    let timeout = Some(Duration::from_millis(600));
    let _ = stream.set_read_timeout(timeout);
    let _ = stream.set_write_timeout(timeout);
    let request = "GET /api/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(request.as_bytes()).is_err() {
        return ServiceProbe::Unreadable;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return ServiceProbe::Unreadable;
    }
    let body = response
        .split("\r\n\r\n")
        .nth(1)
        .unwrap_or(response.as_str());
    match service_version_from_status_body(body) {
        Some(version) => ServiceProbe::Read(version, service_pid_from_body(body)),
        None => ServiceProbe::Unreadable,
    }
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

#[cfg(not(target_os = "windows"))]
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
    fn connected_but_unreadable_is_mismatched_not_none() {
        // A successful connect whose body couldn't be read/parsed must NOT be
        // classified as None — None means "port free", which would spawn a
        // second daemon onto the already-occupied port.
        assert!(matches!(
            classify_service_probe(ServiceProbe::Unreadable, "0.2.1"),
            ExistingService::Mismatched(None)
        ));
    }

    #[test]
    fn unreachable_port_is_none_so_we_start_our_own_daemon() {
        assert!(matches!(
            classify_service_probe(ServiceProbe::Unreachable, "0.2.1"),
            ExistingService::None
        ));
    }

    #[test]
    fn read_version_classifies_reuse_vs_mismatch() {
        assert!(matches!(
            classify_service_probe(ServiceProbe::Read("0.2.1".to_string(), Some(42)), "0.2.1"),
            ExistingService::Reusable(Some(42))
        ));
        assert!(matches!(
            classify_service_probe(ServiceProbe::Read("0.2.0".to_string(), None), "0.2.1"),
            ExistingService::Mismatched(Some(_))
        ));
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

    #[test]
    fn windows_manual_sidecar_candidates_prefer_plain_exe() {
        let resource_dir = PathBuf::from(r"C:\Program Files\Comote");
        let candidates = windows_manual_sidecar_candidates(&resource_dir);
        assert_eq!(candidates[0], resource_dir.join("comote-node.exe"));
        assert!(candidates.contains(&resource_dir.join("comote-node-x86_64-pc-windows-msvc.exe")));
        assert!(candidates.contains(&resource_dir.join("comote-node-aarch64-pc-windows-msvc.exe")));
        assert!(candidates.contains(&resource_dir.join("binaries").join("comote-node.exe")));
    }

    #[test]
    fn normalize_windows_path_strips_verbatim_prefix() {
        assert_eq!(
            normalize_windows_path(PathBuf::from(r"\\?\C:\Program Files\Comote\comote-node.exe")),
            PathBuf::from(r"C:\Program Files\Comote\comote-node.exe")
        );
        // No prefix → identity.
        assert_eq!(
            normalize_windows_path(PathBuf::from(r"C:\Comote\node.exe")),
            PathBuf::from(r"C:\Comote\node.exe")
        );
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
