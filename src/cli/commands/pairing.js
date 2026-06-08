// `comote pairing list` / `comote pairing show <channel>`.
//
// Surfaces inbound-sender pairing codes in the terminal (OpenClaw's `pairing`
// analog), so a headless operator can pair a token-binding channel (today:
// Telegram) without opening the desktop UI.
//
// list  → GET /api/channels, keep channels whose binding is "token", then GET
//         each one's /config to read its pairingCode + linked state. One row
//         per token channel (id, name, status, paired?, code).
// show  → GET /api/channels/:id/config, print the pairing code prominently with
//         a one-line hint on how to send it to the bot. Non-token / unknown /
//         already-paired channels get a clear note instead.
//
// --json passes the assembled rows (list) or the channel's config (show)
// through unchanged.

import { createRenderer } from "../render.js";

// A channel binds via a pairing code when its binding is "token". The
// /api/channels response spreads plugin.meta at the top level, so `binding`
// lives there; we also accept a nested meta.binding for hand-built fixtures.
function bindingOf(channel) {
  return channel?.binding ?? channel?.meta?.binding ?? null;
}

function isTokenChannel(channel) {
  return bindingOf(channel) === "token";
}

export async function run({ parsed, client, env, write }) {
  const r = createRenderer({ flags: parsed.flags, env });
  // `pairing` is path[0]; the sub-verb (list|show) lands in path[1]. For
  // `pairing show <id>` the id is positionals[0]; bare `pairing` defaults to
  // list.
  const sub = parsed.path[1] ?? parsed.positionals[0] ?? "list";

  if (sub === "show") {
    const id = parsed.path[1] ? parsed.positionals[0] : parsed.positionals[1];
    return showPairing({ id, parsed, client, r, write });
  }

  return listPairing({ parsed, client, r, write });
}

async function listPairing({ client, r, write }) {
  const list = await client.get("/api/channels");
  const tokenChannels = (Array.isArray(list) ? list : []).filter(isTokenChannel);

  // Pull each token channel's config so we can read its pairingCode + linked
  // state (the channel list itself carries only redacted public config).
  const rows = [];
  for (const ch of tokenChannels) {
    const config = await client.get(`/api/channels/${encodeURIComponent(ch.id)}/config`);
    rows.push({
      id: ch.id,
      displayName: ch.displayName ?? null,
      binding: bindingOf(ch),
      status: ch.status?.state ?? null,
      paired: Boolean(config?.linkedChatId),
      linkedUserName: config?.linkedUserName ?? null,
      pairingCode: config?.pairingCode ?? null,
    });
  }

  if (r.json) {
    write(`${r.jsonText(rows)}\n`);
    return 0;
  }

  if (rows.length === 0) {
    write(`${r.dim("No token-binding channels. (Pairing applies to channels like Telegram.)")}\n`);
    return 0;
  }

  const head = ["ID", "NAME", "STATUS", "PAIRED", "CODE"];
  const body = rows.map((row) => [
    r.bold(row.id),
    row.displayName ?? "—",
    r.state(row.status ?? "—"),
    row.paired ? r.green("yes") : r.yellow("no"),
    row.paired
      ? r.dim("—")
      : row.pairingCode
        ? r.cyan(row.pairingCode)
        : r.dim("(none yet)"),
  ]);
  write(`${r.table(body, { head })}\n`);
  return 0;
}

async function showPairing({ id, client, r, write }) {
  if (!id) {
    // Mirror the rest of the CLI: a missing target is a usage error.
    const { UsageError } = await import("../index.js");
    throw new UsageError("Usage: comote pairing show <channel>");
  }

  // Confirm the channel exists and is a token-binding channel before reading
  // its config, so we can give a precise note rather than a bare "(none)".
  const list = await client.get("/api/channels");
  const channel = (Array.isArray(list) ? list : []).find((c) => c.id === id);

  if (!channel) {
    write(`${r.red(`No such channel: ${id}`)}\n`);
    return 1;
  }
  if (!isTokenChannel(channel)) {
    write(
      `${r.yellow(`${id} is not a token-binding channel — it has no pairing code.`)}\n`,
    );
    write(`${r.dim(`Its binding is "${bindingOf(channel) ?? "unknown"}". Use \`comote login ${id}\` instead.`)}\n`);
    return 0;
  }

  const config = await client.get(`/api/channels/${encodeURIComponent(id)}/config`);

  if (r.json) {
    write(`${r.jsonText(config)}\n`);
    return 0;
  }

  // Already paired: no live code to send; tell the operator who it's bound to.
  if (config?.linkedChatId) {
    const who = config.linkedUserName || config.linkedChatId;
    write(`${r.green(`${id} is already paired`)} ${r.dim(`(${who})`)}.\n`);
    write(`${r.dim(`To re-pair, clear the link with \`comote config ${id} linkedChatId=\` then run this again.`)}\n`);
    return 0;
  }

  const codeText = typeof config?.pairingCode === "string" ? config.pairingCode.trim() : "";
  if (!codeText) {
    write(`${r.yellow(`No pairing code for ${id} yet.`)}\n`);
    write(`${r.dim(`Configure the bot token first: \`comote config ${id} botToken=<token>\`. A code is generated once the runtime is up.`)}\n`);
    return 0;
  }

  // Print the code prominently with the one-line how-to.
  write(`${r.bold(`Pairing code for ${id}:`)}  ${r.cyan(r.bold(codeText))}\n`);
  write(`${r.dim(`Send this code as a direct message to your ${channel.displayName ?? id} bot to pair.`)}\n`);
  return 0;
}
