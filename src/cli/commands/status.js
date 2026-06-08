// `comote status` — daemon + per-channel + connector summary at a glance.
//
// Maps GET /api/status (channels map, connectors, counts) merged with
// GET /api/version (version + pid). --json emits the raw merged object; the
// default renders a compact keyval + per-channel table. When the daemon is
// unreachable the dispatcher's error path takes over (DaemonUnreachable) — the
// config-only fallback is a separate task; here we surface live data cleanly.

import { createRenderer } from "../render.js";

export async function run({ parsed, client, env, write }) {
  const r = createRenderer({ flags: parsed.flags, env });

  const status = await client.get("/api/status");
  // version is best-effort: an older daemon may not expose it, but status is
  // the source of truth for health, so a version miss must not fail the command.
  let version = null;
  try {
    version = await client.get("/api/version");
  } catch {
    version = null;
  }

  const merged = { ...status, version };

  if (r.json) {
    write(`${r.jsonText(merged)}\n`);
    return 0;
  }

  const lines = [];
  const head = [
    ["Daemon", r.state(status.bridge ?? "running")],
    ["Version", version?.version ?? version?.current ?? "—"],
  ];
  if (version?.pid != null) {
    head.push(["PID", String(version.pid)]);
  }
  const counts = status.counts ?? {};
  head.push(["Identities", String(counts.identities ?? 0)]);
  head.push(["Projects", String(counts.projects ?? 0)]);
  lines.push(r.keyval(head));

  const channels = status.channels ?? {};
  const chRows = Object.entries(channels).map(([id, st]) => [
    r.bold(id),
    r.state(typeof st === "string" ? st : st?.state ?? "—"),
  ]);
  if (chRows.length > 0) {
    lines.push("");
    lines.push(r.dim("Channels"));
    lines.push(r.table(chRows));
  }

  const connectors = status.connectors ?? {};
  const connRows = Object.entries(connectors).map(([id, c]) => [
    r.bold(id),
    r.state(c?.state ?? (typeof c === "string" ? c : "—")),
  ]);
  if (connRows.length > 0) {
    lines.push("");
    lines.push(r.dim("Connectors"));
    lines.push(r.table(connRows));
  }

  write(`${lines.join("\n")}\n`);
  return 0;
}
