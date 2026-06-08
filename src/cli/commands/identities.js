// `comote identities [list|pending]`, `comote confirm`, `comote revoke`.
//
// identities list    → GET /api/identities          (authorized senders)
// identities pending → GET /api/identities/candidates (detected, unconfirmed)
//   (bare `comote identities` defaults to list; `--pending` is an alias.)
// confirm <channel>:<id> [--name <display>] → POST /api/identities/confirm 201
// revoke  <channel>:<id>                    → DELETE /api/identities/:ch/:id 204
//
// The TASK's `<channel>:<id>` form and the SPEC's two-positional
// `<channel> <stableId>` form are both accepted. --json passes through.

import { createRenderer } from "../render.js";
import { UsageError } from "../index.js";

// Resolve {channel, stableId} from either `channel:stableId` (one positional)
// or `channel stableId` (two positionals). The stableId itself may contain ':'
// so we split on the FIRST colon only.
export function parseTarget(positionals) {
  const first = positionals[0];
  if (!first) {
    return null;
  }
  if (positionals.length >= 2 && !first.includes(":")) {
    return { channel: first, stableId: positionals[1] };
  }
  const idx = first.indexOf(":");
  if (idx === -1) {
    return null;
  }
  return { channel: first.slice(0, idx), stableId: first.slice(idx + 1) };
}

// Gather operand tokens for a flat verb (confirm/revoke). The parser greedily
// extends the command path up to two segments, so for `confirm feishu:ou_1` the
// first operand lands in path[1], not positionals; merge both so either lands.
function operands(parsed) {
  const extra = parsed.path.length > 1 ? [parsed.path[1]] : [];
  return [...extra, ...parsed.positionals];
}

export async function run({ command, parsed, client, env, write }) {
  const r = createRenderer({ flags: parsed.flags, env });

  if (command === "confirm") {
    const target = parseTarget(operands(parsed));
    if (!target || !target.channel || !target.stableId) {
      throw new UsageError("Usage: comote confirm <channel>:<stableId> [--name <display>]");
    }
    const body = { channel: target.channel, stableId: target.stableId };
    if (parsed.flags.name) {
      body.displayName = parsed.flags.name;
    }
    const identity = await client.post("/api/identities/confirm", body);
    if (r.json) {
      write(`${r.jsonText(identity)}\n`);
      return 0;
    }
    write(`${r.green("Confirmed")} ${identity.displayName ?? identity.stableId} ${r.dim(`(${identity.channel})`)}\n`);
    return 0;
  }

  if (command === "revoke") {
    const target = parseTarget(operands(parsed));
    if (!target || !target.channel || !target.stableId) {
      throw new UsageError("Usage: comote revoke <channel>:<stableId>");
    }
    await client.del(
      `/api/identities/${encodeURIComponent(target.channel)}/${encodeURIComponent(target.stableId)}`,
    );
    if (r.json) {
      write(`${r.jsonText({ ok: true, channel: target.channel, stableId: target.stableId })}\n`);
      return 0;
    }
    write(`${r.yellow("Revoked")} ${target.stableId} ${r.dim(`(${target.channel})`)}\n`);
    return 0;
  }

  // identities [list|pending]
  const sub = parsed.path[1] ?? parsed.positionals[0];
  const pending = sub === "pending" || parsed.flags.pending === true;
  const route = pending ? "/api/identities/candidates" : "/api/identities";
  const items = (await client.get(route)) ?? [];

  if (r.json) {
    write(`${r.jsonText(items)}\n`);
    return 0;
  }
  if (items.length === 0) {
    write(`${r.dim(pending ? "No pending candidates." : "No authorized identities.")}\n`);
    return 0;
  }
  const head = ["CHANNEL", "STABLE ID", "DISPLAY NAME"];
  const rows = items.map((it) => [
    r.bold(it.channel ?? "—"),
    it.stableId ?? "—",
    it.displayName ?? r.dim("—"),
  ]);
  write(`${r.table(rows, { head })}\n`);
  return 0;
}
