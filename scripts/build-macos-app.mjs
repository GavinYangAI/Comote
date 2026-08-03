import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { generateDesktopIcons } from "./desktop-icon-assets.mjs";

const execFileAsync = promisify(execFile);
const pkg = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
const version = pkg.version;

const appRoot = join(process.cwd(), "dist", "Comote.app");
const contents = join(appRoot, "Contents");
const macos = join(contents, "MacOS");
const resources = join(contents, "Resources");
const buildDir = join(process.cwd(), "dist", "build");
const iconsDir = join(process.cwd(), "src-tauri", "icons");
const executablePath = join(macos, "Comote");
const swiftPath = join(buildDir, "ComoteApp.swift");

await rm(appRoot, { recursive: true, force: true });
await mkdir(macos, { recursive: true });
await mkdir(resources, { recursive: true });

await generateDesktopIcons(iconsDir);
await writeFile(join(resources, "AppIcon.icns"), await readFile(join(iconsDir, "icon.icns")));
await writeFile(join(resources, "AppIcon.png"), await readFile(join(iconsDir, "icon.png")));

await writeFile(
  join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Comote</string>
  <key>CFBundleIdentifier</key>
  <string>dev.comote.app</string>
  <key>CFBundleName</key>
  <string>Comote</string>
  <key>CFBundleDisplayName</key>
  <string>Comote</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>2</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`,
);

await writeFile(
  swiftPath,
  `import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var serverProcess: Process?
    private let port = ProcessInfo.processInfo.environment["PORT"] ?? "16208"

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildWindow()
        startServerIfNeeded()
        loadWhenReady(attempt: 0)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    private func buildWindow() {
        let config = WKWebViewConfiguration()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.center()
        window.title = "Comote"
        window.minSize = NSSize(width: 860, height: 620)
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
    }

    private func projectRoot() -> String {
        let bundlePath = Bundle.main.bundleURL.path
        return URL(fileURLWithPath: bundlePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .standardizedFileURL
            .path
    }

    private func startServerIfNeeded() {
        if serverReady() {
            return
        }

        let root = projectRoot()
        let logDir = URL(fileURLWithPath: root).appendingPathComponent(".comote/logs").path
        try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)

        let process = Process()
        process.currentDirectoryURL = URL(fileURLWithPath: root)
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["npm", "run", "dev"]
        process.environment = ProcessInfo.processInfo.environment.merging(["PORT": port]) { _, new in new }

        let logURL = URL(fileURLWithPath: logDir).appendingPathComponent("comote-app.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        if let handle = try? FileHandle(forWritingTo: logURL) {
            handle.seekToEndOfFile()
            process.standardOutput = handle
            process.standardError = handle
        }

        do {
            try process.run()
            serverProcess = process
        } catch {
            showStartupError("Could not start Comote service: \\(error.localizedDescription)")
        }
    }

    private func loadWhenReady(attempt: Int) {
        if serverReady() {
            webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\\(port)")!))
            return
        }

        if attempt > 80 {
            showStartupError("Comote service did not start. Check .comote/logs/comote-app.log in the project folder.")
            return
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            self.loadWhenReady(attempt: attempt + 1)
        }
    }

    private func serverReady() -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\\(port)/api/status"),
              let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
            return false
        }
        return !data.isEmpty
    }

    private func showStartupError(_ message: String) {
        let html = """
        <!doctype html><meta charset="utf-8">
        <style>
        body{margin:0;height:100vh;display:grid;place-items:center;background:#f6f4ef;color:#20241f;font:15px -apple-system,BlinkMacSystemFont,sans-serif}
        section{max-width:560px;padding:32px;border:1px solid #d8d4c8;border-radius:14px;background:white}
        h1{margin:0 0 12px;font-size:24px} p{line-height:1.5;color:#5f665f}
        </style>
        <section><h1>Comote could not open</h1><p>\\(message)</p></section>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
`,
);

await execFileAsync("swiftc", [
  swiftPath,
  "-framework",
  "Cocoa",
  "-framework",
  "WebKit",
  "-o",
  executablePath,
]);
await chmod(executablePath, 0o755);

console.log(`Built ${appRoot}`);
