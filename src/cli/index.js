// `comote` client-mode dispatcher.
//
// bin/comote.js routes here when argv carries a subcommand; otherwise it boots
// the daemon unchanged. This module parses global flags, resolves the command
// from a dispatch table, invokes its handler, and maps thrown errors to exit
// codes: 0 ok, 1 runtime/daemon error, 2 usage error.
//
// Command handlers (status, channels, channel, identities, …) live under
// src/cli/commands/ and are loaded lazily so a single missing module never
// breaks `comote help` or `comote --version`. The handlers themselves are
// built in follow-up tasks; this core wiring owns the parser, the client, the
// table, help/usage, and error→exit-code mapping.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./args.js";
import { createClient, DaemonUnreachable, ApiError } from "./client.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// Usage error: argv didn't name a known command or required positionals are
// missing. Exits 2.
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.code = "USAGE";
  }
}

// The dispatch table. Each key is a top-level verb; `module` is the file under
// commands/ that exports `run({ client, parsed, render })`. `summary` feeds the
// generated help catalog. Keeping the table here (not scattered across the
// command files) makes `comote help` a single source of truth.
// Only commands with a built handler module under commands/ are listed, so the
// generated `comote help` never advertises a stub. (onboard/pairing/logs/doctor
// from the design are planned follow-ups and intentionally omitted until built.)
export const COMMANDS = {
  status: { module: "status.js", summary: "Daemon + per-channel health at a glance" },
  channels: { module: "channels.js", summary: "list / status [<id>] [--probe] across all channels" },
  config: { module: "config.js", summary: "<channel> [field=value ...] — read/write channel config" },
  start: { module: "runtime.js", summary: "<channel> — start a channel runtime" },
  stop: { module: "runtime.js", summary: "<channel> — stop a channel runtime" },
  login: { module: "login.js", summary: "<channel> — QR/credential pairing in the terminal" },
  identities: { module: "identities.js", summary: "list / pending senders" },
  confirm: { module: "identities.js", summary: "<channel>:<id> [--name <n>] — authorize a sender" },
  revoke: { module: "identities.js", summary: "<channel>:<id> — revoke an authorized sender" },
  approvals: { module: "approvals.js", summary: "List pending Codex approvals" },
  approve: { module: "approvals.js", summary: "Approve a pending Codex command by code" },
  deny: { module: "approvals.js", summary: "Decline a pending Codex command by code" },
};

function readPackageVersion() {
  try {
    const pkgPath = join(HERE, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function usageText() {
  const lines = [];
  lines.push("comote — local remote companion for Codex Desktop");
  lines.push("");
  lines.push("Usage:");
  lines.push("  comote                 Boot the daemon (foreground)");
  lines.push("  comote <command> ...   Run a client command against the local daemon");
  lines.push("");
  lines.push("Commands:");
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [name, meta] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(width)}  ${meta.summary}`);
  }
  lines.push("");
  lines.push("Global flags:");
  lines.push("  --json                 Machine-readable JSON output");
  lines.push("  --plain / --no-color   Disable color / decoration");
  lines.push("  --token <t>            API token (or --token-file <path>)");
  lines.push("  --base-url <url>       Override daemon discovery (default $HOST:$PORT)");
  lines.push("  --state-path <path>    state.json location for offline fallback");
  lines.push("  --version              Print version");
  lines.push("  --help                 Show this help");
  lines.push("");
  lines.push("Daemon discovery: http://${HOST:-127.0.0.1}:${PORT:-16208}");
  lines.push("Auth: COMOTE_LOCAL_API_TOKEN (or --token / --token-file).");
  return lines.join("\n");
}

// Determine whether argv should boot the daemon instead of running a client
// command. Exported so bin/comote.js and tests share one rule.
//   - no subcommand (argv empty) → daemon
//   - first token is `daemon` or `serve` → daemon
// Everything else → client dispatcher.
export function isDaemonInvocation(argv) {
  const tokens = Array.isArray(argv) ? argv : [];
  if (tokens.length === 0) {
    return true;
  }
  const first = tokens[0];
  // `comote daemon stop` is a CLIENT command (stop the running daemon), so only
  // a bare `daemon` / `daemon --background` boots; `daemon stop` does not.
  if (first === "serve") {
    return true;
  }
  if (first === "daemon") {
    const rest = tokens.slice(1).filter((t) => !t.startsWith("-"));
    return rest.length === 0; // `daemon` or `daemon --flag` → boot
  }
  return false;
}

// Render an error to stderr and return the matching exit code. Kept separate
// from run() so tests can assert mapping without process.exit.
export function errorToExit(error, { write = (s) => process.stderr.write(s) } = {}) {
  if (error instanceof UsageError) {
    write(`${error.message}\n`);
    write("Run `comote help` for usage.\n");
    return 2;
  }
  if (error instanceof DaemonUnreachable) {
    write(`${error.message}\n`);
    return 1;
  }
  if (error instanceof ApiError) {
    write(`Daemon error (${error.status}): ${error.message}\n`);
    return 1;
  }
  write(`${error?.message || String(error)}\n`);
  return 1;
}

// Lazy command loader, overridable in tests so routing can be asserted without
// the (not-yet-built) handler modules on disk.
async function defaultLoadCommand(moduleFile) {
  return import(`./commands/${moduleFile}`);
}

export async function run(argv, deps = {}) {
  const write = deps.write || ((s) => process.stdout.write(s));
  const loadCommand = deps.loadCommand || defaultLoadCommand;

  const parsed = parseArgs(argv);
  const command = parsed.path[0];

  // --version / --help short-circuit before any command resolution.
  if (parsed.flags.version || command === "version") {
    write(`${readPackageVersion()}\n`);
    return 0;
  }
  if (parsed.flags.help || command === "help" || command === undefined) {
    write(`${usageText()}\n`);
    return 0;
  }

  const entry = COMMANDS[command];
  if (!entry) {
    return errorToExit(new UsageError(`Unknown command: ${command}`), { write: deps.writeErr || write });
  }

  // Build the client (injectable transport for tests). Construction is cheap
  // and does no I/O until a request is made.
  const client =
    deps.client ||
    createClient({
      fetch: deps.fetch,
      env: deps.env || process.env,
      baseUrl: parsed.flags["base-url"],
      token: parsed.flags.token,
      tokenFile: parsed.flags["token-file"],
    });

  try {
    let mod;
    try {
      mod = await loadCommand(entry.module);
    } catch (loadError) {
      // The handler modules are built in follow-up tasks. Until then, surface a
      // clean message instead of a raw ESM module-resolution stack.
      if (loadError?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(`Command \`${command}\` is not implemented yet.`);
      }
      throw loadError;
    }
    if (!mod || typeof mod.run !== "function") {
      throw new Error(`Command \`${command}\` is not implemented yet.`);
    }
    const result = await mod.run({
      command,
      parsed,
      client,
      env: deps.env || process.env,
      write,
    });
    return typeof result === "number" ? result : 0;
  } catch (error) {
    return errorToExit(error, { write: deps.writeErr || ((s) => process.stderr.write(s)) });
  }
}
