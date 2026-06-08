#!/usr/bin/env node
// Headless CLI entrypoint: boots the standalone daemon (binds 127.0.0.1:PORT,
// runs the full IM<->Codex bridge with no Tauri). Installed as the `comote`
// command via the package.json "bin" field.
import "../src/server/index.js";
