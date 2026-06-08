// `comote doctor` — preflight health / diagnostics.
//
// Designed to be useful even when the daemon is DOWN: every check is
// independent and degrades gracefully. Each check prints one PASS / WARN / FAIL
// line; the overall exit code is 0 unless at least one check FAILs (a WARN — a
// stopped daemon, an offline connector — is not a hard failure).
//
// Checks:
//   1. State file   — resolve the path (--state-path / $COMOTE_STATE_PATH /
//                     default .comote/state.json), report existence and (on
//                     POSIX) that mode is 0600. Reuses JsonFileStore.load() so
//                     a missing/corrupt file never throws here.
//   2. Bind safety  — evaluate the CURRENT intended bind ($HOST default
//                     127.0.0.1, token = Boolean($COMOTE_LOCAL_API_TOKEN)) via
//                     assertSafeBind; loopback/with-token → PASS, the guard's
//                     throw → FAIL with its own message.
//   3. Daemon       — GET /api/version; reachable → PASS (version/pid);
//                     DaemonUnreachable → WARN (start with `comote`), not a
//                     hard fail so doctor still works offline.
//   4. Connector    — only when the daemon is reachable: GET /api/status and
//                     report connectors.desktop.state. (Whether `codex` is on
//                     PATH is out of scope — we never shell out.)

import { stat } from "node:fs/promises";

import { JsonFileStore } from "../../core/persistence.js";
import { assertSafeBind } from "../../server/bind-safety.js";
import { createRenderer } from "../render.js";
import { DaemonUnreachable } from "../client.js";

const DEFAULT_STATE_PATH = ".comote/state.json";

// Resolve the state.json path the same way the daemon does: an explicit
// --state-path wins, then $COMOTE_STATE_PATH, then the default.
function resolveStatePath({ flags = {}, env = {} } = {}) {
  return flags["state-path"] || env.COMOTE_STATE_PATH || DEFAULT_STATE_PATH;
}

// One diagnostic line. `level` is "pass" | "warn" | "fail".
function makeCheck(level, name, detail) {
  return { level, name, detail };
}

// --- check 1: state file -------------------------------------------------
async function checkStateFile({ statePath, FileStore = JsonFileStore }) {
  let info;
  try {
    info = await stat(statePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      // Absent is not a failure: the daemon writes it on first run. Confirm we
      // can load() it without crashing (JsonFileStore.load() returns {}).
      const store = new FileStore({ filePath: statePath, logger: silentLogger() });
      await store.load();
      return makeCheck("warn", "State file", `not found at ${statePath} (created on first daemon run)`);
    }
    return makeCheck("fail", "State file", `cannot stat ${statePath}: ${error.message}`);
  }

  // Load it (never throws — corrupt files are quarantined + recovered).
  const store = new FileStore({ filePath: statePath, logger: silentLogger() });
  await store.load();

  // POSIX-only mode check. NTFS doesn't carry 0600 bits, so don't assert there.
  if (process.platform === "win32") {
    return makeCheck("pass", "State file", `present at ${statePath}`);
  }
  const mode = info.mode & 0o777;
  if (mode === 0o600) {
    return makeCheck("pass", "State file", `present at ${statePath} (mode 0600)`);
  }
  return makeCheck(
    "warn",
    "State file",
    `present at ${statePath} but mode is ${mode.toString(8).padStart(4, "0")} (expected 0600)`,
  );
}

// --- check 2: bind safety ------------------------------------------------
function checkBindSafety({ env = {} }) {
  const host = env.HOST || "127.0.0.1";
  const hasToken = Boolean(env.COMOTE_LOCAL_API_TOKEN);
  try {
    assertSafeBind({ host, hasToken });
  } catch (error) {
    // The guard's message is multi-line and operator-actionable; surface its
    // first line as the detail so the summary stays scannable.
    const first = String(error.message).split("\n")[0];
    return makeCheck("fail", "Bind safety", first);
  }
  const note = hasToken
    ? `${host} with API token`
    : `${host} (loopback, no token required)`;
  return makeCheck("pass", "Bind safety", note);
}

// --- check 3: daemon reachability ----------------------------------------
async function checkDaemon({ client }) {
  try {
    const version = await client.get("/api/version");
    const v = version?.version ?? "unknown";
    const pid = version?.pid;
    const detail = pid ? `reachable (version ${v}, pid ${pid})` : `reachable (version ${v})`;
    return { check: makeCheck("pass", "Daemon", detail), reachable: true };
  } catch (error) {
    if (error instanceof DaemonUnreachable) {
      return {
        check: makeCheck("warn", "Daemon", "not running; start with `comote`"),
        reachable: false,
      };
    }
    // An HTTP/other error means the daemon answered but rejected — that's a fail.
    return { check: makeCheck("fail", "Daemon", error.message), reachable: false };
  }
}

// --- check 4: codex connector (only when daemon reachable) ---------------
async function checkConnector({ client }) {
  try {
    const status = await client.get("/api/status");
    const state = status?.connectors?.desktop?.state ?? "unknown";
    const level = state === "connected" ? "pass" : "warn";
    return makeCheck(level, "Codex connector", `desktop ${state}`);
  } catch (error) {
    return makeCheck("fail", "Codex connector", error.message);
  }
}

function silentLogger() {
  return { warn() {}, error() {}, info() {} };
}

function paintLevel(r, level) {
  if (level === "pass") {
    return r.green("PASS");
  }
  if (level === "warn") {
    return r.yellow("WARN");
  }
  return r.red("FAIL");
}

export async function run({ parsed, client, env, write }) {
  const r = createRenderer({ flags: parsed.flags, env });
  const statePath = resolveStatePath({ flags: parsed.flags, env });

  const checks = [];
  checks.push(await checkStateFile({ statePath }));
  checks.push(checkBindSafety({ env }));

  const daemon = await checkDaemon({ client });
  checks.push(daemon.check);
  if (daemon.reachable) {
    checks.push(await checkConnector({ client }));
  }

  if (r.json) {
    write(`${r.jsonText(checks)}\n`);
    const failed = checks.some((c) => c.level === "fail");
    return failed ? 1 : 0;
  }

  for (const c of checks) {
    write(`${paintLevel(r, c.level)}  ${c.name}: ${c.detail}\n`);
  }

  const failed = checks.filter((c) => c.level === "fail").length;
  const warned = checks.filter((c) => c.level === "warn").length;
  write("\n");
  if (failed > 0) {
    write(`${r.red(`${failed} check(s) failed`)}${warned ? ` · ${warned} warning(s)` : ""}.\n`);
    return 1;
  }
  if (warned > 0) {
    write(`${r.yellow(`All checks passed with ${warned} warning(s)`)}.\n`);
    return 0;
  }
  write(`${r.green("All checks passed.")}\n`);
  return 0;
}

export const __test__ = { resolveStatePath, checkBindSafety, checkStateFile, DEFAULT_STATE_PATH };
