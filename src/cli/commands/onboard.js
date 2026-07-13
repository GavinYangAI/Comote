// `comote onboard` — interactive first-run wizard for headless operators.
//
// Walks a fresh operator from zero to a working channel entirely from the
// terminal (the OpenClaw `onboard` analog, adapted to Comote's connector +
// channel model). Ordered flow:
//
//   1. Connect Codex   — POST /api/connectors/codex-desktop/auto-connect, then
//                        GET /api/status; warn (but continue) if the desktop
//                        connector is not "connected".
//   2. Pick a channel  — GET /api/channels, print an indexed list, prompt.
//   3. Configure it     — branch on the plugin meta.binding:
//                          "token"       → prompt the token, PUT config.
//                          "qr"          → POST login/start, print URL + code +
//                                          ASCII QR, poll login/status.
//                          "credentials" → prompt each configField, PUT config.
//   4. Start it         — POST runtime/start, GET status to confirm running.
//   5. Final summary    — tell the operator to message their bot, that the first
//                        message needs authorizing via `comote identities
//                        pending` + `comote confirm <channel>:<id>` (or the UI).
//
// CRITICAL for testability: the whole flow lives in the pure async
// `runWizard({ client, prompt, write, env, sleep })`, where `prompt` is an
// injected `(question) => answer` async fn. run() wires a real
// readline/promises prompt and calls runWizard; tests call runWizard directly
// with a SCRIPTED prompt array + a mock client (no stdin, no port).

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { createRenderer } from "../render.js";
import { renderQr } from "../qr.js";

const QR_TERMINAL_STATES = new Set(["confirmed", "expired", "failed"]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The pure wizard. Every side effect (I/O, prompting, sleeping) is injected so
// tests drive it with canned answers + a mock client.
// ---------------------------------------------------------------------------
export async function runWizard({
  client,
  prompt,
  write,
  env = {},
  flags = {},
  sleep = defaultSleep,
  // Safety cap so a never-confirming QR login can't loop forever.
  maxPolls = 1000,
} = {}) {
  const r = createRenderer({ flags, env });
  const line = (s = "") => write(`${s}\n`);

  line(r.bold("Comote setup wizard"));
  line(r.dim("Get your bot talking to Codex in a few steps."));
  line();

  // --- Step 1: connect Codex -----------------------------------------------
  line(r.bold("[1/5] Connecting Codex…"));
  let connected = false;
  try {
    await client.post("/api/connectors/codex-desktop/auto-connect");
    const status = await client.get("/api/status");
    connected = status?.connectors?.desktop?.state === "connected";
  } catch (error) {
    // A reachable-but-failing auto-connect must not abort onboarding — the
    // operator can install/login Codex and re-run. Surface the reason.
    line(r.yellow(`  Could not reach the Codex connector: ${error?.message || error}`));
  }
  if (connected) {
    line(r.green("  Codex connected."));
  } else {
    line(r.yellow("  Codex is not connected."));
    line(r.dim("  Install the ChatGPT desktop app or Codex CLI (npm install -g @openai/codex) and sign in, then re-run `comote onboard`."));
    line(r.dim("  Continuing setup anyway so your channel is ready."));
  }
  line();

  // --- Step 2: pick a channel ----------------------------------------------
  line(r.bold("[2/5] Choose a channel"));
  const channels = (await client.get("/api/channels")) ?? [];
  if (channels.length === 0) {
    line(r.red("  No channels are available. Cannot continue."));
    return 1;
  }
  channels.forEach((ch, i) => {
    const label = ch.displayName ?? ch.id;
    line(`  ${r.bold(String(i + 1))}. ${label} ${r.dim(`(${ch.id}, ${ch.binding ?? "?"})`)}`);
  });
  const channel = await promptChoice({ prompt, write, r, channels });
  if (!channel) {
    line(r.red("  No channel selected. Exiting."));
    return 1;
  }
  line(r.dim(`  Selected: ${channel.displayName ?? channel.id}`));
  line();

  // --- Step 3: configure based on binding ----------------------------------
  line(r.bold("[3/5] Configure " + (channel.displayName ?? channel.id)));
  const binding = channel.binding ?? "credentials";
  let configured = true;
  if (binding === "token") {
    configured = await configureToken({ client, prompt, write, r, channel });
  } else if (binding === "qr") {
    configured = await configureQr({ client, prompt, write, r, channel, sleep, maxPolls, flags });
  } else {
    // "credentials" (dingtalk) and any future credential-style channel.
    configured = await configureCredentials({ client, prompt, write, r, channel });
  }
  if (!configured) {
    line(r.yellow("  Configuration did not complete — you can finish it later with"));
    line(r.dim(`  \`comote config ${channel.id} <field=value...>\` or \`comote login ${channel.id}\`.`));
    return 1;
  }
  line();

  // --- Step 4: start the channel -------------------------------------------
  line(r.bold("[4/5] Starting the channel runtime…"));
  let running = false;
  try {
    await client.post(`/api/channels/${encodeURIComponent(channel.id)}/runtime/start`);
    const status = await client.get(`/api/channels/${encodeURIComponent(channel.id)}/status`);
    running = status?.state === "running";
    if (running) {
      line(r.green(`  ${channel.id} is running.`));
    } else {
      line(r.yellow(`  ${channel.id} runtime state: ${r.state(status?.state ?? "unknown")}`));
    }
  } catch (error) {
    line(r.yellow(`  Could not start ${channel.id}: ${error?.message || error}`));
    line(r.dim(`  Try \`comote start ${channel.id}\` once configuration is complete.`));
  }
  line();

  // --- Step 5: final summary -----------------------------------------------
  line(r.bold("[5/5] You're set."));
  line(`  Message your ${channel.displayName ?? channel.id} bot to start a session.`);
  line(r.dim("  The FIRST message from a new sender must be authorized:"));
  line(`    • run ${r.bold("comote identities pending")} to see who's waiting, then`);
  line(`    • run ${r.bold(`comote confirm ${channel.id}:<id>`)} to authorize them`);
  line(r.dim("    • (the pending sender also appears in the desktop UI)."));
  line();
  line(r.green("Setup complete."));
  if (!connected) {
    line(r.yellow("Reminder: Codex was not connected — sign in before you chat."));
  }
  return 0;
}

// Prompt the operator to pick a channel by 1-based index. Re-prompts on an
// out-of-range / non-numeric answer; an empty answer aborts (returns null).
async function promptChoice({ prompt, write, r, channels }) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const answer = (await prompt(`  Pick a channel [1-${channels.length}]: `))?.trim();
    if (!answer) {
      return null;
    }
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= channels.length) {
      return channels[n - 1];
    }
    write(`  ${r.yellow(`Please enter a number between 1 and ${channels.length}.`)}\n`);
  }
  return null;
}

// "token" channels (telegram): one secret field. PUT it under the field's
// configFields name (defaulting to botToken when meta is absent).
async function configureToken({ client, prompt, write, r, channel }) {
  const field = firstConfigField(channel) ?? { name: "botToken" };
  const value = (await prompt(`  Enter the ${labelFor(field)}: `))?.trim();
  if (!value) {
    write(`  ${r.yellow("No token entered.")}\n`);
    return false;
  }
  await client.put(`/api/channels/${encodeURIComponent(channel.id)}/config`, {
    [field.name]: value,
  });
  write(`  ${r.green(`Saved ${field.name}.`)}\n`);
  return true;
}

// "credentials" channels (dingtalk): prompt each configField in order and PUT
// the assembled patch. Skips empty optional answers; a fully empty patch fails.
async function configureCredentials({ client, prompt, write, r, channel }) {
  const fields = Array.isArray(channel.configFields) ? channel.configFields : [];
  if (fields.length === 0) {
    write(`  ${r.yellow("This channel exposes no config fields to fill in.")}\n`);
    return false;
  }
  const patch = {};
  for (const field of fields) {
    const value = (await prompt(`  ${labelFor(field)}: `))?.trim();
    if (value) {
      patch[field.name] = value;
    }
  }
  if (Object.keys(patch).length === 0) {
    write(`  ${r.yellow("Nothing entered.")}\n`);
    return false;
  }
  await client.put(`/api/channels/${encodeURIComponent(channel.id)}/config`, patch);
  write(`  ${r.green(`Saved ${Object.keys(patch).length} field(s).`)}\n`);
  return true;
}

// "qr" channels (feishu/wechat): kick off a login, print the URL + user code +
// an ASCII QR, then poll until a terminal state. Mirrors commands/login.js.
async function configureQr({ client, prompt, write, r, channel, sleep, maxPolls, flags }) {
  const domain = flags.domain || "feishu";
  const started = await client.post(
    `/api/channels/${encodeURIComponent(channel.id)}/login/start`,
    { domain },
  );
  const qrUrl = started?.qrUrl ?? null;
  const userCode = started?.userCode ?? started?.user_code ?? null;
  const loginId = started?.loginId ?? null;
  const interval = Number(started?.interval) || 5;
  const expireIn = Number(started?.expireIn) || 600;

  if (qrUrl) {
    write(`  ${r.bold("Scan to authorize:")} ${qrUrl}\n`);
  }
  if (userCode) {
    write(`  ${r.bold("User code:")} ${userCode}\n`);
  }
  if (qrUrl && flags.qr !== false) {
    const art = renderQr(qrUrl);
    if (art) {
      write(`${art}\n`);
    }
  }
  write(`  ${r.dim("Waiting for confirmation… (Ctrl-C to cancel)")}\n`);

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
      `/api/channels/${encodeURIComponent(channel.id)}/login/status?${params.toString()}`,
    );
    last = status;
    if (QR_TERMINAL_STATES.has(status?.state)) {
      break;
    }
  }

  if (last?.state === "confirmed") {
    const who = last.account ? ` as ${last.account.name ?? last.account.id ?? "(account)"}` : "";
    write(`  ${r.green(`Login confirmed${who}.`)}\n`);
    return true;
  }
  if (last?.state === "expired") {
    write(`  ${r.yellow("Login code expired.")}\n`);
  } else {
    write(`  ${r.red(`Login did not complete${last?.message ? `: ${last.message}` : "."}`)}\n`);
  }
  return false;
}

function firstConfigField(channel) {
  const fields = Array.isArray(channel.configFields) ? channel.configFields : [];
  return fields[0] ?? null;
}

// A human label for a config field. The meta carries i18n labelKeys (IM side
// only); the operator-facing CLI just shows the field name.
function labelFor(field) {
  if (!field) {
    return "value";
  }
  return field.name;
}

// ---------------------------------------------------------------------------
// run(): wire a real readline-backed prompt and delegate to runWizard.
// ---------------------------------------------------------------------------
export async function run({ parsed, client, env, write }) {
  const rl = readline.createInterface({ input, output });
  const prompt = async (question) => {
    const answer = await rl.question(question);
    return answer;
  };
  try {
    return await runWizard({
      client,
      prompt,
      write,
      env,
      flags: parsed.flags,
    });
  } finally {
    rl.close();
  }
}

export const __test__ = { promptChoice, configureToken, configureQr, configureCredentials };
