// `comote channels list` / `comote channels status [<id>] [--probe]`.
//
// list  → GET /api/channels, one row per channel (id, name, binding, inbound,
//         status, runtime, bound?).
// status → same source filtered to one id, rendered as a detail keyval; with
//         --probe it also fires GET /api/channels/:id/runtime to confirm
//         liveness. Bare `comote channels` defaults to list.
//
// --json passes the raw array (list) or the matched object (status) through.

import { createRenderer } from "../render.js";

function boundOf(channel) {
  // boundWhen.field on a redacted public config is a boolean ("configured").
  const field = channel?.boundWhen?.field;
  if (field && channel.config && field in channel.config) {
    return Boolean(channel.config[field]);
  }
  return Boolean(channel?.config && Object.keys(channel.config).length > 0);
}

export async function run({ parsed, client, env, write }) {
  const r = createRenderer({ flags: parsed.flags, env });
  // `channels` is path[0]; the sub-verb (list|status) lands in path[1] (the
  // parser greedily fills two path segments). A filter id follows in
  // positionals: `channels status feishu` → path=[channels,status],
  // positionals=[feishu].
  const sub = parsed.path[1] ?? parsed.positionals[0] ?? "list";
  // When the sub-verb consumed path[1], the id is positionals[0]; when the
  // sub-verb itself came from positionals[0], the id would be positionals[1].
  const filterId = parsed.path[1] ? parsed.positionals[0] : parsed.positionals[1];

  const list = await client.get("/api/channels");

  if (sub === "status") {
    const id = filterId;
    const match = id ? list.find((c) => c.id === id) : null;
    if (id && !match) {
      write(`${r.red(`No such channel: ${id}`)}\n`);
      return 1;
    }
    const targets = id ? [match] : list;

    if (r.json && id) {
      let probe;
      if (parsed.flags.probe) {
        probe = await client.get(`/api/channels/${encodeURIComponent(id)}/runtime`);
      }
      write(`${r.jsonText(probe ? { ...match, probe } : match)}\n`);
      return 0;
    }
    if (r.json) {
      write(`${r.jsonText(targets)}\n`);
      return 0;
    }

    const blocks = [];
    for (const ch of targets) {
      const rows = [
        ["id", r.bold(ch.id)],
        ["name", ch.displayName ?? "—"],
        ["binding", ch.binding ?? "—"],
        ["inbound", ch.inboundMode ?? "—"],
        ["status", r.state(ch.status?.state ?? "—")],
        ["runtime", r.state(ch.runtime?.state ?? "—")],
        ["bound", boundOf(ch) ? r.green("yes") : r.yellow("no")],
      ];
      if (parsed.flags.probe) {
        const live = await client.get(`/api/channels/${encodeURIComponent(ch.id)}/runtime`);
        rows.push(["probe", r.state(live?.state ?? "—")]);
      }
      blocks.push(r.keyval(rows));
    }
    write(`${blocks.join("\n\n")}\n`);
    return 0;
  }

  // list (default)
  if (r.json) {
    write(`${r.jsonText(list)}\n`);
    return 0;
  }

  const head = ["ID", "NAME", "BINDING", "INBOUND", "STATUS", "RUNTIME", "BOUND"];
  const rows = list.map((ch) => [
    r.bold(ch.id),
    ch.displayName ?? "—",
    ch.binding ?? "—",
    ch.inboundMode ?? "—",
    r.state(ch.status?.state ?? "—"),
    r.state(ch.runtime?.state ?? "—"),
    boundOf(ch) ? r.green("yes") : r.yellow("no"),
  ]);
  write(`${r.table(rows, { head })}\n`);
  return 0;
}
