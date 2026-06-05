import { createServer } from "./app.js";
import { createPersistentComoteState } from "./state.js";

const port = Number(process.env.PORT ?? 16208);
const host = "127.0.0.1";

const state = await createPersistentComoteState({
  ...(process.env.COMOTE_STATE_PATH ? { filePath: process.env.COMOTE_STATE_PATH } : {}),
});
const server = createServer(state);

// Process-level backstops. Fire-and-forget work (persist(), runtime drains, the
// version poller) can reject without an awaiting caller; without these handlers
// Node's defaults terminate the daemon on the first stray rejection/throw. The
// daemon is a long-lived background service — log and keep running instead.
process.on("unhandledRejection", (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  try {
    state.eventLog?.error?.("未捕获的 Promise 拒绝", { error: message });
  } catch {
    console.error("Comote daemon: unhandled rejection:", message);
  }
});
process.on("uncaughtException", (error) => {
  try {
    state.eventLog?.error?.("未捕获的异常", { error: error?.message ?? String(error) });
  } catch {
    console.error("Comote daemon: uncaught exception:", error);
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Comote daemon: port ${port} is already in use.\n` +
        `Another Comote instance is probably already running at http://${host}:${port}.\n` +
        `Open that one, or set PORT to a free port and retry.`,
    );
    process.exit(1);
  }
  console.error(`Comote daemon failed to start: ${error.message}`);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`Comote settings app running at http://${host}:${port}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  // Release the sleep guard and stop the channel runtimes before exiting —
  // otherwise the spawned `caffeinate` is orphaned (Mac never sleeps) and the
  // IM SDK sockets are left dangling. Best-effort: never block exit on it.
  Promise.resolve(state.shutdown?.()).catch(() => {});
  server.close(() => process.exit(0));
  // Force-exit if connections keep the server alive past the grace window.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
