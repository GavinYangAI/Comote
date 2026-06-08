// Loopback hosts are only reachable from the local machine, so binding there
// without an API token stays safe (the daemon's historical default). Any other
// bind address (0.0.0.0, a LAN IP, a public VPS IP, a hostname) is potentially
// reachable by other machines — there we MUST have a token or we fail closed.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(String(host ?? "").trim().toLowerCase());
}

// Throws when the requested bind is unsafe: a non-loopback host with no API
// token would let anyone who can reach the address approve Codex command
// execution unauthenticated. Returns nothing when the bind is allowed.
export function assertSafeBind({ host, hasToken }) {
  if (isLoopbackHost(host) || hasToken) {
    return;
  }
  const error = new Error(
    `Refusing to bind to non-loopback host "${host}" without an API token.\n` +
      `Anyone able to reach this address could approve arbitrary Codex command execution.\n` +
      `Fix it one of two ways:\n` +
      `  1. Set COMOTE_LOCAL_API_TOKEN to a strong secret and bind ${host} again, or\n` +
      `  2. Leave HOST at the loopback default (127.0.0.1) and use an SSH tunnel to reach it remotely.`,
  );
  error.code = "COMOTE_UNSAFE_BIND";
  throw error;
}
