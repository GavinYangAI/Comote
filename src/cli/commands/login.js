// `comote login <channel>` — headless QR/credential pairing in the terminal.
//
// For qr-binding channels (feishu): POST /api/channels/:id/login/start, then
// print the verification URL + user code as PLAIN TEXT plus an ASCII-art QR
// (reusing the qrcode-generator dep) so a no-browser VPS operator can scan from
// a phone. Then poll GET /api/channels/:id/login/status?loginId=...&domain=...
// until the state is confirmed/expired/failed, honoring the interval/expireIn
// the start response echoes.
//
//   --no-qr   suppress the ASCII art (URL + code still print)
//   --json    stream each status object as it arrives
//
// For token channels (telegram), there is nothing to scan — we point the user
// at `comote config <channel>` / `comote pairing show <channel>` instead.
//
// The poll loop takes an injectable `sleep` and `maxPolls` so tests drive a
// fake login/status sequence without real timers or a real port.

import { createRenderer } from "../render.js";
import { renderQr } from "../qr.js";
import { UsageError } from "../index.js";

const TERMINAL_STATES = new Set(["confirmed", "expired", "failed"]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run({
  parsed,
  client,
  env,
  write,
  sleep = defaultSleep,
  // Safety cap so a never-confirming daemon can't loop forever; derived from
  // expireIn/interval at runtime but bounded here.
  maxPolls = 1000,
} = {}) {
  const r = createRenderer({ flags: parsed.flags, env });
  const id = parsed.path[1] ?? parsed.positionals[0];
  if (!id) {
    throw new UsageError("Usage: comote login <channel>");
  }

  // Confirm the channel is a qr-binding channel before starting; a token
  // channel has no QR to scan.
  const channels = (await client.get("/api/channels")) ?? [];
  const meta = channels.find((c) => c.id === id);
  if (meta && meta.binding && meta.binding !== "qr") {
    write(
      `${r.yellow(`${id} is a ${meta.binding}-binding channel — there is no QR to scan.`)}\n` +
        `Configure it with \`comote config ${id} <field=value...>\`` +
        (meta.binding === "token" ? ` or get the pairing code with \`comote pairing show ${id}\`` : "") +
        `.\n`,
    );
    return 0;
  }

  const domain = parsed.flags.domain || "feishu";
  const started = await client.post(
    `/api/channels/${encodeURIComponent(id)}/login/start`,
    { domain },
  );

  const qrUrl = started.qrUrl ?? null;
  const userCode = started.userCode ?? started.user_code ?? null;
  const loginId = started.loginId ?? null;
  const interval = Number(started.interval) || 5;
  const expireIn = Number(started.expireIn) || 600;

  if (r.json) {
    // NDJSON: one compact object per line so consumers can stream events.
    write(`${JSON.stringify({ event: "start", ...started })}\n`);
  } else {
    const lines = [];
    if (qrUrl) {
      lines.push(`${r.bold("Scan to authorize:")} ${qrUrl}`);
    }
    if (userCode) {
      lines.push(`${r.bold("User code:")} ${userCode}`);
    }
    if (qrUrl && parsed.flags.qr !== false) {
      const art = renderQr(qrUrl);
      if (art) {
        lines.push("");
        lines.push(art);
      }
    }
    lines.push("");
    lines.push(r.dim("Waiting for confirmation… (Ctrl-C to cancel)"));
    write(`${lines.join("\n")}\n`);
  }

  // Poll until a terminal state. Cap iterations at expireIn/interval (+1) and
  // the hard maxPolls so the loop always ends.
  const budget = Math.min(maxPolls, Math.ceil(expireIn / Math.max(interval, 1)) + 1);
  let last = null;
  for (let i = 0; i < budget; i += 1) {
    await sleep(interval * 1000);
    const params = new URLSearchParams({
      loginId: loginId ?? "",
      domain,
      interval: String(interval),
      expireIn: String(expireIn),
    });
    const status = await client.get(
      `/api/channels/${encodeURIComponent(id)}/login/status?${params.toString()}`,
    );
    last = status;
    if (r.json) {
      write(`${JSON.stringify({ event: "status", ...status })}\n`);
    }
    if (TERMINAL_STATES.has(status.state)) {
      break;
    }
  }

  if (!r.json) {
    write(`${renderOutcome(last, id, r)}\n`);
  }
  return last && last.state === "confirmed" ? 0 : 1;
}

function renderOutcome(status, id, r) {
  if (!status) {
    return r.red("Login did not complete (no status received).");
  }
  if (status.state === "confirmed") {
    const acct = status.account;
    const who = acct ? ` as ${acct.name ?? acct.id ?? "(account)"}` : "";
    return r.green(`${id} login confirmed${who}.`);
  }
  if (status.state === "expired") {
    return r.yellow(`${id} login code expired. Re-run \`comote login ${id}\`.`);
  }
  return r.red(`${id} login failed${status.message ? `: ${status.message}` : "."}`);
}

export const __test__ = { renderOutcome, TERMINAL_STATES };
