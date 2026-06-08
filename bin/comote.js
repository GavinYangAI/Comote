#!/usr/bin/env node
// Dual-mode entrypoint, keyed on argv.
//
//   comote                  → boot the daemon (foreground), unchanged
//   comote daemon [--flags] → boot the daemon (foreground), unchanged
//   comote serve            → boot the daemon (foreground)
//   comote <command> ...    → run the client CLI against the local daemon
//
// The daemon path stays a bare `import "../src/server/index.js"` so there is no
// regression to startup (bind, sleep-guard, signal handlers). The client path
// is loaded lazily so requiring the CLI never drags in the server, and vice
// versa. Installed as the `comote` command via the package.json "bin" field.

import { isDaemonInvocation } from "../src/cli/index.js";

const argv = process.argv.slice(2);

if (isDaemonInvocation(argv)) {
  await import("../src/server/index.js");
} else {
  const { run } = await import("../src/cli/index.js");
  const code = await run(argv);
  process.exit(code);
}
