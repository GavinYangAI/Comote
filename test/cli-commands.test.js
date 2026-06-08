import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/cli/index.js";
import { matchApproval } from "../src/cli/commands/approvals.js";
import { parseTarget } from "../src/cli/commands/identities.js";
import { runWizard } from "../src/cli/commands/onboard.js";
import { renderQr } from "../src/cli/qr.js";

// ---------------------------------------------------------------------------
// Test harness: a fetch-like double keyed on "METHOD /path". It records every
// call and returns the canned response for the matched route. Tests MUST NOT
// bind a real port — the dev app holds 16208.
// ---------------------------------------------------------------------------

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    calls.push({ method, path, url, init, body: init.body ? JSON.parse(init.body) : undefined });
    // Match exact "METHOD path" first, then by a path predicate function.
    const key = `${method} ${path}`;
    let entry = routes[key];
    if (!entry) {
      // Allow matching on a path prefix (query strings vary): try "METHOD path?"
      const base = path.split("?")[0];
      entry = routes[`${method} ${base}`];
    }
    if (typeof entry === "function") {
      entry = entry({ method, path, calls });
    }
    if (!entry) {
      return { status: 404, text: async () => JSON.stringify({ error: "not found" }) };
    }
    return {
      status: entry.status ?? 200,
      text: async () => (typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body ?? {})),
    };
  };
  fn.calls = calls;
  return fn;
}

// Run a CLI command capturing stdout/stderr separately; color is off because
// the env has no TTY and we pass --plain where masking matters.
async function runCli(argv, routes, { sleep, env = {} } = {}) {
  const out = [];
  const err = [];
  const f = mockFetch(routes);
  const deps = {
    fetch: f,
    write: (s) => out.push(s),
    writeErr: (s) => err.push(s),
    env,
  };
  if (sleep) {
    // login uses an injectable sleep; route it through loadCommand wrapping.
    deps.loadCommand = async (mod) => {
      const m = await import(`../src/cli/commands/${mod}`);
      if (mod === "login.js") {
        return { run: (ctx) => m.run({ ...ctx, sleep }) };
      }
      return m;
    };
  }
  const code = await run(argv, deps);
  return { code, out: out.join(""), err: err.join("") };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

test("status: renders daemon + channels + connectors", async () => {
  const { code, out } = await runCli(["status"], {
    "GET /api/status": {
      body: {
        bridge: "running",
        channels: { feishu: "running", telegram: "configured" },
        connectors: { desktop: { state: "connected" } },
        counts: { identities: 2, projects: 3 },
      },
    },
    "GET /api/version": { body: { version: "0.5.1", pid: 4242 } },
  });
  assert.equal(code, 0);
  assert.match(out, /Daemon\s+running/);
  assert.match(out, /Version\s+0\.5\.1/);
  assert.match(out, /PID\s+4242/);
  assert.match(out, /feishu\s+running/);
  assert.match(out, /telegram\s+configured/);
  assert.match(out, /desktop\s+connected/);
});

test("status --json: raw merged object passthrough", async () => {
  const { code, out } = await runCli(["status", "--json"], {
    "GET /api/status": { body: { bridge: "running", channels: {}, counts: {} } },
    "GET /api/version": { body: { version: "0.5.1" } },
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.bridge, "running");
  assert.equal(parsed.version.version, "0.5.1");
});

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

const CHANNELS_FIXTURE = [
  {
    id: "feishu",
    displayName: "飞书 / Lark",
    binding: "qr",
    inboundMode: "push",
    boundWhen: { field: "configured" },
    status: { state: "running" },
    runtime: { state: "running" },
    config: { configured: true, appId: "cli_x" },
  },
  {
    id: "telegram",
    displayName: "Telegram",
    binding: "token",
    inboundMode: "poll",
    boundWhen: { field: "configured" },
    status: { state: "configured" },
    runtime: { state: "configured" },
    config: { configured: false },
  },
];

test("channels list: tabular, one row per channel, bound flag", async () => {
  const { code, out } = await runCli(["channels", "list"], {
    "GET /api/channels": { body: CHANNELS_FIXTURE },
  });
  assert.equal(code, 0);
  assert.match(out, /ID\s+NAME\s+BINDING/);
  assert.match(out, /feishu/);
  assert.match(out, /telegram/);
  // feishu is bound (configured:true) → yes; telegram (false) → no
  const feishuLine = out.split("\n").find((l) => l.includes("feishu"));
  assert.match(feishuLine, /yes/);
  const tgLine = out.split("\n").find((l) => l.includes("telegram"));
  assert.match(tgLine, /no/);
});

test("channels defaults to list when no sub-verb", async () => {
  const { code, out } = await runCli(["channels"], {
    "GET /api/channels": { body: CHANNELS_FIXTURE },
  });
  assert.equal(code, 0);
  assert.match(out, /feishu/);
});

test("channels status <id> --probe: detail + live runtime probe", async () => {
  const { code, out } = await runCli(["channels", "status", "feishu", "--probe"], {
    "GET /api/channels": { body: CHANNELS_FIXTURE },
    "GET /api/channels/feishu/runtime": { body: { state: "running" } },
  });
  assert.equal(code, 0);
  assert.match(out, /id\s+feishu/);
  assert.match(out, /binding\s+qr/);
  assert.match(out, /probe\s+running/);
});

test("channels status: unknown id → exit 1", async () => {
  const { code, out } = await runCli(["channels", "status", "nope"], {
    "GET /api/channels": { body: CHANNELS_FIXTURE },
  });
  assert.equal(code, 1);
  assert.match(out, /No such channel: nope/);
});

// ---------------------------------------------------------------------------
// pairing (list / show) — token-channel pairing codes for headless operators
// ---------------------------------------------------------------------------

test("pairing list: filters to token channels and shows their codes", async () => {
  const { code, out } = await runCli(["pairing", "list"], {
    "GET /api/channels": { body: CHANNELS_FIXTURE },
    "GET /api/channels/telegram/config": {
      body: { configured: false, hasBotToken: true, pairingCode: "AB12CD34", linkedChatId: null },
    },
  });
  assert.equal(code, 0);
  // feishu is a qr-binding channel → excluded; telegram (token) → included.
  assert.doesNotMatch(out, /feishu/);
  assert.match(out, /telegram/);
  assert.match(out, /AB12CD34/);
  // unpaired → no
  const tgLine = out.split("\n").find((l) => l.includes("telegram"));
  assert.match(tgLine, /no/);
});

test("pairing defaults to list when no sub-verb", async () => {
  const { code, out } = await runCli(["pairing"], {
    "GET /api/channels": { body: CHANNELS_FIXTURE },
    "GET /api/channels/telegram/config": {
      body: { pairingCode: "ZZ99", linkedChatId: null },
    },
  });
  assert.equal(code, 0);
  assert.match(out, /telegram/);
  assert.match(out, /ZZ99/);
});

test("pairing list: no token channels → clean note", async () => {
  const { code, out } = await runCli(["pairing", "list"], {
    "GET /api/channels": {
      body: [{ id: "feishu", displayName: "Lark", binding: "qr", status: { state: "running" } }],
    },
  });
  assert.equal(code, 0);
  assert.match(out, /No token-binding channels/);
});

test("pairing show <channel>: prints the code prominently with a send hint", async () => {
  const { code, out } = await runCli(["pairing", "show", "telegram"], {
    "GET /api/channels": { body: CHANNELS_FIXTURE },
    "GET /api/channels/telegram/config": {
      body: { pairingCode: "AB12CD34", linkedChatId: null },
    },
  });
  assert.equal(code, 0);
  assert.match(out, /Pairing code for telegram/);
  assert.match(out, /AB12CD34/);
  assert.match(out, /Send this code as a direct message/);
});

test("pairing show: already paired → bound note, no code", async () => {
  const { code, out } = await runCli(["pairing", "show", "telegram"], {
    "GET /api/channels": { body: CHANNELS_FIXTURE },
    "GET /api/channels/telegram/config": {
      body: { pairingCode: null, linkedChatId: "12345", linkedUserName: "Bob" },
    },
  });
  assert.equal(code, 0);
  assert.match(out, /already paired/);
  assert.match(out, /Bob/);
});

test("pairing show: non-token channel → clear note, exit 0", async () => {
  const { code, out } = await runCli(["pairing", "show", "feishu"], {
    "GET /api/channels": { body: CHANNELS_FIXTURE },
  });
  assert.equal(code, 0);
  assert.match(out, /not a token-binding channel/);
  assert.match(out, /comote login feishu/);
});

test("pairing show: unknown channel → exit 1", async () => {
  const { code, out } = await runCli(["pairing", "show", "nope"], {
    "GET /api/channels": { body: CHANNELS_FIXTURE },
  });
  assert.equal(code, 1);
  assert.match(out, /No such channel: nope/);
});

test("pairing show: missing channel → usage error (exit 2)", async () => {
  const { code, err } = await runCli(["pairing", "show"], {
    "GET /api/channels": { body: CHANNELS_FIXTURE },
  });
  assert.equal(code, 2);
  assert.match(err, /Usage: comote pairing show/);
});

test("pairing list --json: assembled rows passthrough", async () => {
  const { code, out } = await runCli(["pairing", "list", "--json"], {
    "GET /api/channels": { body: CHANNELS_FIXTURE },
    "GET /api/channels/telegram/config": {
      body: { pairingCode: "AB12CD34", linkedChatId: null, linkedUserName: null },
    },
  });
  assert.equal(code, 0);
  const parsed = JSON.parse(out);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "telegram");
  assert.equal(parsed[0].pairingCode, "AB12CD34");
  assert.equal(parsed[0].paired, false);
});

// ---------------------------------------------------------------------------
// config (get/set + secret masking)
// ---------------------------------------------------------------------------

test("config <channel> (GET): prints redacted public config", async () => {
  const { code, out } = await runCli(["config", "feishu"], {
    "GET /api/channels/feishu/config": {
      body: { appId: "cli_x", hasAppSecret: true, configured: true },
    },
  });
  assert.equal(code, 0);
  assert.match(out, /appId\s+cli_x/);
  assert.match(out, /hasAppSecret\s+true/);
});

test("config set: PUTs the pairs and masks secret-looking values on echo", async () => {
  const { code, out, err } = await runCli(
    ["config", "telegram", "botToken=123:ABCDEF"],
    {
      // server returns the redacted public config (botToken NOT echoed raw)
      "PUT /api/channels/telegram/config": {
        body: { hasBotToken: true, botToken: "123:ABCDEF", pairingCode: "AB12CD34" },
      },
    },
  );
  assert.equal(code, 0);
  // the PUT carried the pair as the request body
  // and the raw botToken must NOT appear in output (masked)
  assert.doesNotMatch(out, /123:ABCDEF/);
  assert.match(out, /botToken\s+\*{8}/);
  assert.match(out, /Updated telegram config/);
});

test("config set: request body carries the field=value pairs", async () => {
  let captured = null;
  const routes = {
    "PUT /api/channels/feishu/config": ({ calls }) => {
      captured = calls[calls.length - 1].body;
      return { body: { configured: true } };
    },
  };
  const { code } = await runCli(["config", "feishu", "domain=lark"], routes);
  assert.equal(code, 0);
  assert.deepEqual(captured, { domain: "lark" });
});

test("config: bare form without channel → usage error (exit 2)", async () => {
  const { code, err } = await runCli(["config"], {});
  assert.equal(code, 2);
  assert.match(err, /Usage: comote config/);
});

// ---------------------------------------------------------------------------
// start / stop (channel runtime)
// ---------------------------------------------------------------------------

test("start <channel>: POSTs runtime/start", async () => {
  const { code, out } = await runCli(["start", "feishu"], {
    "POST /api/channels/feishu/runtime/start": { body: { state: "running" } },
  });
  assert.equal(code, 0);
  assert.match(out, /Channel feishu started/);
  assert.match(out, /running/);
});

test("stop <channel>: POSTs runtime/stop", async () => {
  const { code, out } = await runCli(["stop", "feishu"], {
    "POST /api/channels/feishu/runtime/stop": { body: { state: "configured" } },
  });
  assert.equal(code, 0);
  assert.match(out, /Channel feishu stopped/);
});

test("start: API error (not configured) surfaces verbatim, exit 1", async () => {
  const { code, err } = await runCli(["start", "feishu"], {
    "POST /api/channels/feishu/runtime/start": {
      status: 400,
      body: { error: "channel not configured" },
    },
  });
  assert.equal(code, 1);
  assert.match(err, /channel not configured/);
});

test("start: missing channel → usage error", async () => {
  const { code, err } = await runCli(["start"], {});
  assert.equal(code, 2);
  assert.match(err, /Usage: comote start <channel>/);
});

// ---------------------------------------------------------------------------
// identities (list / pending) + confirm / revoke
// ---------------------------------------------------------------------------

test("identities list: tabular authorized senders", async () => {
  const { code, out } = await runCli(["identities"], {
    "GET /api/identities": {
      body: [{ channel: "feishu", stableId: "ou_1", displayName: "Alice" }],
    },
  });
  assert.equal(code, 0);
  assert.match(out, /CHANNEL\s+STABLE ID\s+DISPLAY NAME/);
  assert.match(out, /feishu\s+ou_1\s+Alice/);
});

test("identities --pending: hits candidates route", async () => {
  let hit = null;
  const { code, out } = await runCli(["identities", "--pending"], {
    "GET /api/identities/candidates": ({ path }) => {
      hit = path;
      return { body: [{ channel: "telegram", stableId: "99", displayName: "Bob" }] };
    },
  });
  assert.equal(code, 0);
  assert.equal(hit, "/api/identities/candidates");
  assert.match(out, /Bob/);
});

test("identities pending (sub-verb form) hits candidates", async () => {
  const { code, out } = await runCli(["identities", "pending"], {
    "GET /api/identities/candidates": { body: [] },
  });
  assert.equal(code, 0);
  assert.match(out, /No pending candidates/);
});

test("confirm <channel>:<id> --name: POSTs confirm with displayName", async () => {
  let body = null;
  const { code, out } = await runCli(["confirm", "feishu:ou_1", "--name", "Alice"], {
    "POST /api/identities/confirm": ({ calls }) => {
      body = calls[calls.length - 1].body;
      return { status: 201, body: { channel: "feishu", stableId: "ou_1", displayName: "Alice" } };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(body, { channel: "feishu", stableId: "ou_1", displayName: "Alice" });
  assert.match(out, /Confirmed Alice/);
});

test("confirm with two-positional form (channel id)", async () => {
  let body = null;
  const { code } = await runCli(["confirm", "telegram", "12345"], {
    "POST /api/identities/confirm": ({ calls }) => {
      body = calls[calls.length - 1].body;
      return { status: 201, body: { channel: "telegram", stableId: "12345" } };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(body, { channel: "telegram", stableId: "12345" });
});

test("revoke <channel>:<id>: DELETEs the identity (204)", async () => {
  let path = null;
  const { code, out } = await runCli(["revoke", "feishu:ou_1"], {
    "DELETE /api/identities/feishu/ou_1": ({ calls }) => {
      path = calls[calls.length - 1].path;
      return { status: 204, body: "" };
    },
  });
  assert.equal(code, 0);
  assert.equal(path, "/api/identities/feishu/ou_1");
  assert.match(out, /Revoked ou_1/);
});

test("confirm: missing target → usage error", async () => {
  const { code, err } = await runCli(["confirm"], {});
  assert.equal(code, 2);
  assert.match(err, /Usage: comote confirm/);
});

test("parseTarget: colon and two-positional forms; splits on first colon", () => {
  assert.deepEqual(parseTarget(["feishu:ou_1"]), { channel: "feishu", stableId: "ou_1" });
  assert.deepEqual(parseTarget(["tg", "99"]), { channel: "tg", stableId: "99" });
  assert.deepEqual(parseTarget(["c:a:b"]), { channel: "c", stableId: "a:b" });
  assert.equal(parseTarget([]), null);
});

// ---------------------------------------------------------------------------
// logs (tail the daemon event log)
// ---------------------------------------------------------------------------

const LOGS_FIXTURE = {
  entries: [
    { id: 3, at: "2026-06-08T12:00:03.000Z", level: "error", message: "boom", detail: { channel: "feishu", code: 500 } },
    { id: 2, at: "2026-06-08T12:00:02.000Z", level: "warn", message: "slow inbound" },
    { id: 1, at: "2026-06-08T12:00:01.000Z", level: "info", message: "daemon up", detail: "pid 4242" },
  ],
  total: 3,
  hasMore: false,
};

test("logs: renders compact timestamp · level · message lines", async () => {
  const { code, out } = await runCli(["logs", "--plain"], {
    "GET /api/logs": { body: LOGS_FIXTURE },
  });
  assert.equal(code, 0);
  // Newest-first, one line per entry, HH:MM:SS time + uppercased level + message.
  assert.match(out, /12:00:03 ERROR\s*boom/);
  assert.match(out, /12:00:02 WARN\s*slow inbound/);
  assert.match(out, /12:00:01 INFO\s*daemon up/);
  // Detail summaries: object → key=value, string → passthrough.
  assert.match(out, /channel=feishu code=500/);
  assert.match(out, /pid 4242/);
});

test("logs --limit N: forwards limit as a query param and slices server-side", async () => {
  let seenPath = null;
  const { code, out } = await runCli(["logs", "--limit", "1", "--plain"], {
    "GET /api/logs": ({ calls }) => {
      seenPath = calls[calls.length - 1].path;
      // Server honors limit; the daemon would return just the newest entry.
      return { body: { entries: [LOGS_FIXTURE.entries[0]], total: 3, hasMore: true } };
    },
  });
  assert.equal(code, 0);
  assert.match(seenPath, /\/api\/logs\?.*limit=1/);
  assert.match(out, /12:00:03 ERROR\s*boom/);
  assert.doesNotMatch(out, /slow inbound/);
});

test("logs --offset N: forwards offset alongside limit", async () => {
  let seenPath = null;
  const { code } = await runCli(["logs", "--limit", "2", "--offset", "1", "--plain"], {
    "GET /api/logs": ({ calls }) => {
      seenPath = calls[calls.length - 1].path;
      return { body: { entries: [], total: 3, hasMore: false } };
    },
  });
  assert.equal(code, 0);
  assert.match(seenPath, /limit=2/);
  assert.match(seenPath, /offset=1/);
});

test("logs --json: passes the raw { entries, total, hasMore } through", async () => {
  const { code, out } = await runCli(["logs", "--json"], {
    "GET /api/logs": { body: LOGS_FIXTURE },
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), LOGS_FIXTURE);
});

test("logs: empty log prints a friendly placeholder, exit 0", async () => {
  const { code, out } = await runCli(["logs", "--plain"], {
    "GET /api/logs": { body: { entries: [], total: 0, hasMore: false } },
  });
  assert.equal(code, 0);
  assert.match(out, /\(no log entries\)/);
});

test("logs --limit junk: rejected as a usage error (exit 2)", async () => {
  const { code, err } = await runCli(["logs", "--limit", "foo"], {
    "GET /api/logs": { body: LOGS_FIXTURE },
  });
  assert.equal(code, 2);
  assert.match(err, /--limit must be a non-negative integer/);
});

// ---------------------------------------------------------------------------
// approvals (list / approve / deny)
// ---------------------------------------------------------------------------

const APPROVALS_FIXTURE = [
  { id: "rpc-1", shortCode: "a1", method: "exec/approve", params: { command: ["rm", "-rf", "x"] } },
];

test("approvals: lists pending with codes", async () => {
  const { code, out } = await runCli(["approvals"], {
    "GET /api/approvals": { body: APPROVALS_FIXTURE },
  });
  assert.equal(code, 0);
  assert.match(out, /CODE\s+METHOD\s+DETAIL/);
  assert.match(out, /a1\s+exec\/approve\s+rm -rf x/);
});

test("approve <code>: resolves code→id then POSTs accept", async () => {
  let posted = null;
  const { code, out } = await runCli(["approve", "a1"], {
    "GET /api/approvals": { body: APPROVALS_FIXTURE },
    "POST /api/approvals/rpc-1": ({ calls }) => {
      posted = calls[calls.length - 1].body;
      return { body: { ok: true } };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(posted, { decision: "accept" });
  assert.match(out, /Approved approval a1/);
});

test("deny <code>: POSTs decline to the resolved id", async () => {
  let posted = null;
  const { code, out } = await runCli(["deny", "a1"], {
    "GET /api/approvals": { body: APPROVALS_FIXTURE },
    "POST /api/approvals/rpc-1": ({ calls }) => {
      posted = calls[calls.length - 1].body;
      return { body: { ok: true } };
    },
  });
  assert.equal(code, 0);
  assert.deepEqual(posted, { decision: "decline" });
  assert.match(out, /Denied approval a1/);
});

test("approve: unknown code with a non-empty list → exit 1", async () => {
  const { code, out } = await runCli(["approve", "zzz"], {
    "GET /api/approvals": { body: APPROVALS_FIXTURE },
  });
  assert.equal(code, 1);
  assert.match(out, /No pending approval matches code: zzz/);
});

test("matchApproval: by shortCode then id, case-insensitive", () => {
  assert.equal(matchApproval(APPROVALS_FIXTURE, "A1").id, "rpc-1");
  assert.equal(matchApproval(APPROVALS_FIXTURE, "rpc-1").shortCode, "a1");
  assert.equal(matchApproval(APPROVALS_FIXTURE, "nope"), null);
});

// ---------------------------------------------------------------------------
// login (QR/pairing poll loop) — injected sleep, fake status sequence
// ---------------------------------------------------------------------------

test("login feishu: prints URL + user code + QR, polls to confirmed (exit 0)", async () => {
  let polls = 0;
  const { code, out } = await runCli(
    ["login", "feishu"],
    {
      "GET /api/channels": { body: CHANNELS_FIXTURE },
      "POST /api/channels/feishu/login/start": {
        body: { loginId: "dev-1", qrUrl: "https://example.com/qr?x=1", userCode: "WXYZ-9", interval: 1, expireIn: 30 },
      },
      "GET /api/channels/feishu/login/status": () => {
        polls += 1;
        if (polls < 2) {
          return { body: { state: "pending" } };
        }
        return { body: { state: "confirmed", account: { name: "Alice", id: "cli_x" } } };
      },
    },
    { sleep: async () => {} },
  );
  assert.equal(code, 0);
  assert.match(out, /Scan to authorize: https:\/\/example\.com\/qr/);
  assert.match(out, /User code: WXYZ-9/);
  // QR art uses half-block glyphs
  assert.match(out, /[█▀▄]/u);
  assert.match(out, /login confirmed as Alice/);
});

test("login --no-qr: omits art but still prints URL + code", async () => {
  const { code, out } = await runCli(
    ["login", "feishu", "--no-qr"],
    {
      "GET /api/channels": { body: CHANNELS_FIXTURE },
      "POST /api/channels/feishu/login/start": {
        body: { loginId: "dev-1", qrUrl: "https://example.com/qr", userCode: "CODE-1", interval: 1, expireIn: 10 },
      },
      "GET /api/channels/feishu/login/status": { body: { state: "confirmed", account: { name: "Bob" } } },
    },
    { sleep: async () => {} },
  );
  assert.equal(code, 0);
  assert.match(out, /User code: CODE-1/);
  assert.doesNotMatch(out, /[█▀▄]/u);
});

test("login: token channel is redirected to config, not a QR (exit 0)", async () => {
  const { code, out } = await runCli(
    ["login", "telegram"],
    { "GET /api/channels": { body: CHANNELS_FIXTURE } },
    { sleep: async () => {} },
  );
  assert.equal(code, 0);
  assert.match(out, /token-binding channel/);
  assert.match(out, /comote config telegram/);
  assert.match(out, /comote pairing show telegram/);
});

test("login: expired status → exit 1 with re-run hint", async () => {
  const { code, out } = await runCli(
    ["login", "feishu"],
    {
      "GET /api/channels": { body: CHANNELS_FIXTURE },
      "POST /api/channels/feishu/login/start": {
        body: { loginId: "dev-1", qrUrl: "https://x/y", userCode: "C", interval: 1, expireIn: 5 },
      },
      "GET /api/channels/feishu/login/status": { body: { state: "expired" } },
    },
    { sleep: async () => {} },
  );
  assert.equal(code, 1);
  assert.match(out, /login code expired/);
});

test("login --json: streams start + status events", async () => {
  const { code, out } = await runCli(
    ["login", "feishu", "--json"],
    {
      "GET /api/channels": { body: CHANNELS_FIXTURE },
      "POST /api/channels/feishu/login/start": {
        body: { loginId: "d", qrUrl: "https://x", userCode: "C", interval: 1, expireIn: 5 },
      },
      "GET /api/channels/feishu/login/status": { body: { state: "confirmed", account: { name: "Z" } } },
    },
    { sleep: async () => {} },
  );
  assert.equal(code, 0);
  const events = out.trim().split("\n").filter(Boolean);
  // Each line is a JSON object; first is the start event.
  const startEvt = JSON.parse(events[0]);
  assert.equal(startEvt.event, "start");
});

// ---------------------------------------------------------------------------
// onboard (interactive first-run wizard) — driven via runWizard with a SCRIPTED
// prompt + a mock client (no readline, no port).
// ---------------------------------------------------------------------------

// A minimal client double for runWizard: records every call and returns the
// canned response for "METHOD path" (query strings stripped). Functions are
// invoked so a poll route can vary its answer per call.
function mockWizardClient(routes) {
  const calls = [];
  const resolve = (method, path) => {
    const key = `${method} ${path}`;
    let entry = routes[key];
    if (entry === undefined) {
      entry = routes[`${method} ${path.split("?")[0]}`];
    }
    if (typeof entry === "function") {
      entry = entry({ calls });
    }
    return entry ?? null;
  };
  return {
    calls,
    get: async (path) => {
      calls.push({ method: "GET", path });
      return resolve("GET", path);
    },
    post: async (path, body) => {
      calls.push({ method: "POST", path, body });
      return resolve("POST", path);
    },
    put: async (path, body) => {
      calls.push({ method: "PUT", path, body });
      return resolve("PUT", path);
    },
    del: async (path) => {
      calls.push({ method: "DELETE", path });
      return resolve("DELETE", path);
    },
  };
}

// Scripted prompt: hands back canned answers in order, throwing if the wizard
// asks more questions than the script provides (so over-prompting is caught).
function scriptedPrompt(answers) {
  const queue = answers.slice();
  const asked = [];
  const fn = async (question) => {
    asked.push(question);
    if (queue.length === 0) {
      throw new Error(`unexpected prompt: ${question}`);
    }
    return queue.shift();
  };
  fn.asked = asked;
  return fn;
}

// Channel fixture carrying configFields so the token branch can read the field
// name (the bare CHANNELS_FIXTURE omits them).
const ONBOARD_CHANNELS = [
  {
    id: "telegram",
    displayName: "Telegram",
    binding: "token",
    configFields: [{ name: "botToken", type: "text", secret: true }],
  },
  {
    id: "feishu",
    displayName: "飞书 / Lark",
    binding: "qr",
    configFields: [],
  },
];

test("onboard: happy token-channel path configures + starts the channel", async () => {
  const out = [];
  const client = mockWizardClient({
    "POST /api/connectors/codex-desktop/auto-connect": { ok: true },
    "GET /api/status": { connectors: { desktop: { state: "connected" } } },
    "GET /api/channels": ONBOARD_CHANNELS,
    "PUT /api/channels/telegram/config": { configured: true, hasBotToken: true },
    "POST /api/channels/telegram/runtime/start": { state: "running" },
    "GET /api/channels/telegram/status": { state: "running" },
  });
  // Answers: pick channel #1 (telegram), then the bot token.
  const prompt = scriptedPrompt(["1", "12345:secret-bot-token"]);

  const code = await runWizard({
    client,
    prompt,
    write: (s) => out.push(s),
    env: {},
    sleep: async () => {},
  });
  const text = out.join("");

  assert.equal(code, 0);

  // The PUT config call carried the token under the configFields name.
  const put = client.calls.find((c) => c.method === "PUT" && c.path === "/api/channels/telegram/config");
  assert.ok(put, "expected a PUT to telegram config");
  assert.deepEqual(put.body, { botToken: "12345:secret-bot-token" });

  // The runtime/start call fired.
  const start = client.calls.find(
    (c) => c.method === "POST" && c.path === "/api/channels/telegram/runtime/start",
  );
  assert.ok(start, "expected runtime/start to fire");

  // Codex connected + final guidance about authorizing the first sender.
  assert.match(text, /Codex Desktop connected/);
  assert.match(text, /telegram is running/);
  assert.match(text, /comote identities pending/);
  assert.match(text, /comote confirm telegram:<id>/);
  assert.match(text, /Setup complete/);
});

test("onboard: codex-not-connected warns but continues to channel setup", async () => {
  const out = [];
  const client = mockWizardClient({
    "POST /api/connectors/codex-desktop/auto-connect": { ok: false },
    "GET /api/status": { connectors: { desktop: { state: "disconnected" } } },
    "GET /api/channels": ONBOARD_CHANNELS,
    "PUT /api/channels/telegram/config": { configured: true },
    "POST /api/channels/telegram/runtime/start": { state: "running" },
    "GET /api/channels/telegram/status": { state: "running" },
  });
  const prompt = scriptedPrompt(["1", "tok"]);

  const code = await runWizard({
    client,
    prompt,
    write: (s) => out.push(s),
    env: {},
    sleep: async () => {},
  });
  const text = out.join("");

  // Warns about Codex but still completes the rest of the wizard (exit 0).
  assert.equal(code, 0);
  assert.match(text, /Codex Desktop is not connected/);
  assert.match(text, /Install Codex Desktop and sign in/);
  assert.match(text, /Continuing setup anyway/);
  // Config still happened despite the warning.
  assert.ok(
    client.calls.some((c) => c.method === "PUT" && c.path === "/api/channels/telegram/config"),
  );
  assert.match(text, /Reminder: Codex Desktop was not connected/);
});

// ---------------------------------------------------------------------------
// qr render helper
// ---------------------------------------------------------------------------

test("renderQr: produces half-block art for a URL; null for empty", () => {
  const art = renderQr("https://example.com/qr");
  assert.ok(art && art.length > 0);
  assert.match(art, /[█▀▄ ]/u);
  assert.equal(renderQr(""), null);
  assert.equal(renderQr(null), null);
});

// ---------------------------------------------------------------------------
// auth header injection (shared client) — verify x-comote-token reaches fetch
// ---------------------------------------------------------------------------

test("commands send x-comote-token when a token is resolved", async () => {
  const f = mockFetch({ "GET /api/identities": { body: [] } });
  const out = [];
  const code = await run(["identities", "--token", "secret-tok"], {
    fetch: f,
    write: (s) => out.push(s),
    env: {},
  });
  assert.equal(code, 0);
  assert.equal(f.calls[0].init.headers["x-comote-token"], "secret-tok");
});

// ---------------------------------------------------------------------------
// doctor (preflight health checks — must work even when the daemon is down)
// ---------------------------------------------------------------------------

test("doctor: all-good path → PASS lines + exit 0", async () => {
  // A real 0600 state file at an injected path so the state + mode checks pass.
  const dir = await mkdtemp(join(tmpdir(), "comote-doctor-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, JSON.stringify({ schemaVersion: 1 }), { mode: 0o600 });
  await chmod(statePath, 0o600);
  try {
    const { code, out } = await runCli(["doctor", "--state-path", statePath, "--plain"], {
      "GET /api/version": { body: { version: "0.5.1", pid: 4242 } },
      "GET /api/status": {
        body: { bridge: "running", channels: {}, connectors: { desktop: { state: "connected" } } },
      },
    });
    assert.equal(code, 0);
    assert.match(out, /PASS\s+Bind safety/);
    assert.match(out, /PASS\s+Daemon: reachable \(version 0\.5\.1, pid 4242\)/);
    assert.match(out, /PASS\s+Codex connector: desktop connected/);
    // POSIX-only: the mode check should report 0600 (skip the assertion on win32).
    if (process.platform !== "win32") {
      assert.match(out, /PASS\s+State file:.*mode 0600/);
    }
    assert.match(out, /All checks passed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor: daemon down → Daemon WARN (not FAIL), still exit 0", async () => {
  // No /api/version route registered AND the mockFetch never throws ECONNREFUSED,
  // so simulate unreachability with a fetch that throws a connection error.
  const dir = await mkdtemp(join(tmpdir(), "comote-doctor-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, "{}", { mode: 0o600 });
  await chmod(statePath, 0o600);
  try {
    const out = [];
    const err = [];
    const throwingFetch = async () => {
      const e = new Error("fetch failed");
      e.cause = { code: "ECONNREFUSED" };
      throw e;
    };
    const code = await run(["doctor", "--state-path", statePath, "--plain"], {
      fetch: throwingFetch,
      write: (s) => out.push(s),
      writeErr: (s) => err.push(s),
      env: {},
    });
    const text = out.join("");
    assert.equal(code, 0, "daemon-down must NOT fail doctor");
    assert.match(text, /WARN\s+Daemon: not running; start with `comote`/);
    // Connector check is skipped when the daemon is unreachable.
    assert.doesNotMatch(text, /Codex connector/);
    assert.match(text, /All checks passed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor: non-loopback HOST without token → Bind safety FAIL, exit 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-doctor-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, "{}", { mode: 0o600 });
  await chmod(statePath, 0o600);
  try {
    const { code, out } = await runCli(
      ["doctor", "--state-path", statePath, "--plain"],
      {
        "GET /api/version": { body: { version: "0.5.1", pid: 1 } },
        "GET /api/status": { body: { connectors: { desktop: { state: "connected" } } } },
      },
      { env: { HOST: "0.0.0.0" } }, // no COMOTE_LOCAL_API_TOKEN → unsafe bind
    );
    assert.equal(code, 1, "a FAIL check must drive exit 1");
    assert.match(out, /FAIL\s+Bind safety:.*0\.0\.0\.0/);
    assert.match(out, /1 check\(s\) failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor: missing state file → WARN, exit 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-doctor-"));
  const statePath = join(dir, "does-not-exist.json");
  try {
    const { code, out } = await runCli(["doctor", "--state-path", statePath, "--plain"], {
      "GET /api/version": { body: { version: "0.5.1", pid: 1 } },
      "GET /api/status": { body: { connectors: { desktop: { state: "connected" } } } },
    });
    assert.equal(code, 0);
    assert.match(out, /WARN\s+State file: not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("doctor --json: array of checks passthrough", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-doctor-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, "{}", { mode: 0o600 });
  await chmod(statePath, 0o600);
  try {
    const { code, out } = await runCli(["doctor", "--state-path", statePath, "--json"], {
      "GET /api/version": { body: { version: "0.5.1", pid: 7 } },
      "GET /api/status": { body: { connectors: { desktop: { state: "connected" } } } },
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed));
    const names = parsed.map((c) => c.name);
    assert.ok(names.includes("Daemon"));
    assert.ok(names.includes("Codex connector"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
