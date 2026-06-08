import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "../src/cli/args.js";
import { createClient, DaemonUnreachable, ApiError } from "../src/cli/client.js";
import {
  run,
  isDaemonInvocation,
  errorToExit,
  usageText,
  UsageError,
  COMMANDS,
} from "../src/cli/index.js";

// A fetch-like double: records the last call and returns a canned response.
// Tests must NOT bind a real port — the dev app holds 16208.
function fakeFetch(response) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return {
      status: response.status ?? 200,
      text: async () => response.body ?? "",
    };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
// arg parser
// ---------------------------------------------------------------------------

test("parseArgs: verb-noun path with trailing positionals", () => {
  const { path, positionals } = parseArgs(["channels", "status", "feishu"]);
  assert.deepEqual(path, ["channels", "status"]);
  assert.deepEqual(positionals, ["feishu"]);
});

test("parseArgs: caps the command path at two segments", () => {
  const { path, positionals } = parseArgs(["channel", "feishu", "config", "set"]);
  assert.deepEqual(path, ["channel", "feishu"]);
  assert.deepEqual(positionals, ["config", "set"]);
});

test("parseArgs: --flag value, --flag=value, and booleans", () => {
  const { flags } = parseArgs(["status", "--json", "--token", "abc", "--base-url=http://x:1"]);
  assert.equal(flags.json, true);
  assert.equal(flags.token, "abc");
  assert.equal(flags["base-url"], "http://x:1");
});

test("parseArgs: --no-X negates X (start/color/qr land as false)", () => {
  const a = parseArgs(["onboard", "--no-start"]);
  assert.equal(a.flags.start, false);
  const b = parseArgs(["status", "--no-color"]);
  assert.equal(b.flags.color, false);
  const c = parseArgs(["channel", "feishu", "login", "--no-qr"]);
  assert.equal(c.flags.qr, false);
});

test("parseArgs: key=value pairs collected for config set", () => {
  const { path, positionals, pairs } = parseArgs([
    "channel",
    "feishu",
    "config",
    "set",
    "botToken=secret",
    "appId=cli_x",
  ]);
  assert.deepEqual(path, ["channel", "feishu"]);
  assert.deepEqual(positionals, ["config", "set"]);
  assert.deepEqual(pairs, { botToken: "secret", appId: "cli_x" });
});

test("parseArgs: value flags swallow even flag-ish/empty values", () => {
  const { flags } = parseArgs(["send", "--text", "", "--name", "-1"]);
  assert.equal(flags.text, "");
  assert.equal(flags.name, "-1");
});

test("parseArgs: bare -- forces remaining tokens to positionals", () => {
  const { positionals, flags } = parseArgs(["send", "--", "--text", "raw"]);
  assert.deepEqual(positionals, ["--text", "raw"]);
  assert.equal(flags.text, undefined);
});

// ---------------------------------------------------------------------------
// daemon-vs-client routing
// ---------------------------------------------------------------------------

test("isDaemonInvocation: no args boots the daemon", () => {
  assert.equal(isDaemonInvocation([]), true);
});

test("isDaemonInvocation: bare `daemon` and `serve` boot the daemon", () => {
  assert.equal(isDaemonInvocation(["daemon"]), true);
  assert.equal(isDaemonInvocation(["daemon", "--background"]), true);
  assert.equal(isDaemonInvocation(["serve"]), true);
});

test("isDaemonInvocation: `daemon stop` is a client command, not a boot", () => {
  assert.equal(isDaemonInvocation(["daemon", "stop"]), false);
});

test("isDaemonInvocation: any other subcommand routes to the client", () => {
  assert.equal(isDaemonInvocation(["status"]), false);
  assert.equal(isDaemonInvocation(["channels", "list"]), false);
});

// ---------------------------------------------------------------------------
// dispatcher: help, version, routing, error mapping
// ---------------------------------------------------------------------------

test("run: bare invocation prints usage and exits 0", async () => {
  let out = "";
  const code = await run([], { write: (s) => (out += s) });
  assert.equal(code, 0);
  assert.match(out, /Usage:/);
  assert.match(out, /comote <command>/);
});

test("run: --version prints package version and exits 0", async () => {
  let out = "";
  const code = await run(["--version"], { write: (s) => (out += s) });
  assert.equal(code, 0);
  assert.match(out.trim(), /^\d+\.\d+\.\d+/);
});

test("run: `help` prints the generated command catalog", async () => {
  let out = "";
  await run(["help"], { write: (s) => (out += s) });
  for (const name of Object.keys(COMMANDS)) {
    assert.ok(out.includes(name), `help should list ${name}`);
  }
});

test("run: unknown command is a usage error (exit 2)", async () => {
  let err = "";
  const code = await run(["frobnicate"], {
    write: () => {},
    writeErr: (s) => (err += s),
  });
  assert.equal(code, 2);
  assert.match(err, /Unknown command: frobnicate/);
});

test("run: dispatches to the resolved command module with a client", async () => {
  let seen = null;
  const code = await run(["status", "--json"], {
    write: () => {},
    fetch: fakeFetch({ body: "{}" }),
    loadCommand: async (moduleFile) => {
      assert.equal(moduleFile, "status.js");
      return {
        run: async (ctx) => {
          seen = ctx;
          return 0;
        },
      };
    },
  });
  assert.equal(code, 0);
  assert.ok(seen, "command handler ran");
  assert.equal(seen.command, "status");
  assert.equal(seen.parsed.flags.json, true);
  assert.equal(typeof seen.client.get, "function");
});

test("run: a thrown DaemonUnreachable from a handler maps to exit 1", async () => {
  let err = "";
  const code = await run(["status"], {
    write: () => {},
    writeErr: (s) => (err += s),
    loadCommand: async () => ({
      run: async () => {
        throw new DaemonUnreachable("http://127.0.0.1:16208");
      },
    }),
  });
  assert.equal(code, 1);
  assert.match(err, /not running on http:\/\/127\.0\.0\.1:16208/);
});

test("run: a not-yet-built handler module degrades to a clean message (exit 1)", async () => {
  let err = "";
  const code = await run(["status"], {
    write: () => {},
    writeErr: (s) => (err += s),
    loadCommand: async () => {
      const e = new Error("Cannot find module status.js");
      e.code = "ERR_MODULE_NOT_FOUND";
      throw e;
    },
  });
  assert.equal(code, 1);
  assert.match(err, /not implemented yet/);
});

test("errorToExit: usage→2, unreachable→1, api→1, generic→1", () => {
  const sink = () => {};
  assert.equal(errorToExit(new UsageError("bad"), { write: sink }), 2);
  assert.equal(errorToExit(new DaemonUnreachable("http://x"), { write: sink }), 1);
  assert.equal(errorToExit(new ApiError(403, { error: "nope" }, "u"), { write: sink }), 1);
  assert.equal(errorToExit(new Error("boom"), { write: sink }), 1);
});

test("usageText: lists every command in the dispatch table", () => {
  const text = usageText();
  for (const name of Object.keys(COMMANDS)) {
    assert.ok(text.includes(name), `usage should mention ${name}`);
  }
});

// ---------------------------------------------------------------------------
// http client: URL + token header + unreachable mapping (injected fetch)
// ---------------------------------------------------------------------------

test("client: builds base URL from HOST/PORT env (no --base-url)", async () => {
  const fetch = fakeFetch({ body: "{}" });
  const client = createClient({ fetch, env: { HOST: "127.0.0.1", PORT: "9999" } });
  await client.get("/api/status");
  assert.equal(fetch.calls[0].url, "http://127.0.0.1:9999/api/status");
});

test("client: defaults to 127.0.0.1:16208 when env unset", async () => {
  const fetch = fakeFetch({ body: "{}" });
  const client = createClient({ fetch, env: {} });
  await client.get("/api/version");
  assert.equal(fetch.calls[0].url, "http://127.0.0.1:16208/api/version");
});

test("client: --base-url overrides discovery and trims trailing slash", async () => {
  const fetch = fakeFetch({ body: "{}" });
  const client = createClient({ fetch, env: {}, baseUrl: "http://box:4321/" });
  await client.get("/api/status");
  assert.equal(fetch.calls[0].url, "http://box:4321/api/status");
});

test("client: injects x-comote-token from env on every request", async () => {
  const fetch = fakeFetch({ body: "{}" });
  const client = createClient({ fetch, env: { COMOTE_LOCAL_API_TOKEN: "tok123" } });
  await client.get("/api/status");
  assert.equal(fetch.calls[0].init.headers["x-comote-token"], "tok123");
});

test("client: explicit --token beats env, sets the header", async () => {
  const fetch = fakeFetch({ body: "{}" });
  const client = createClient({
    fetch,
    env: { COMOTE_LOCAL_API_TOKEN: "env-tok" },
    token: "flag-tok",
  });
  await client.get("/api/status");
  assert.equal(fetch.calls[0].init.headers["x-comote-token"], "flag-tok");
});

test("client: sends NO token header when none is resolved", async () => {
  const fetch = fakeFetch({ body: "{}" });
  const client = createClient({ fetch, env: {} });
  await client.get("/api/status");
  assert.equal("x-comote-token" in fetch.calls[0].init.headers, false);
});

test("client: POST sets content-type and JSON-encodes the body", async () => {
  const fetch = fakeFetch({ status: 201, body: "{}" });
  const client = createClient({ fetch, env: {} });
  await client.post("/api/identities/confirm", { channel: "feishu", stableId: "ou_x" });
  const { init } = fetch.calls[0];
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(init.body), { channel: "feishu", stableId: "ou_x" });
});

test("client: parses JSON response bodies", async () => {
  const client = createClient({ fetch: fakeFetch({ body: '{"version":"9.9.9"}' }), env: {} });
  const result = await client.get("/api/version");
  assert.deepEqual(result, { version: "9.9.9" });
});

test("client: 204 returns null", async () => {
  const client = createClient({ fetch: fakeFetch({ status: 204, body: "" }), env: {} });
  assert.equal(await client.del("/api/identities/feishu/ou_x"), null);
});

test("client: non-2xx throws ApiError carrying status + body", async () => {
  const client = createClient({
    fetch: fakeFetch({ status: 403, body: '{"error":"forbidden"}' }),
    env: {},
  });
  await assert.rejects(
    () => client.get("/api/status"),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 403);
      assert.equal(error.message, "forbidden");
      return true;
    },
  );
});

test("client: ECONNREFUSED maps to DaemonUnreachable with the friendly hint", async () => {
  const refusing = async () => {
    const error = new Error("connect ECONNREFUSED 127.0.0.1:16208");
    error.code = "ECONNREFUSED";
    throw error;
  };
  const client = createClient({ fetch: refusing, env: {} });
  await assert.rejects(
    () => client.get("/api/status"),
    (error) => {
      assert.ok(error instanceof DaemonUnreachable);
      assert.match(error.message, /not running on http:\/\/127\.0\.0\.1:16208/);
      assert.match(error.message, /Start it with `comote`/);
      return true;
    },
  );
});

test("client: undici 'fetch failed' with ECONNREFUSED cause also maps to DaemonUnreachable", async () => {
  const refusing = async () => {
    const cause = new Error("connect ECONNREFUSED");
    cause.code = "ECONNREFUSED";
    const wrapper = new TypeError("fetch failed");
    wrapper.cause = cause;
    throw wrapper;
  };
  const client = createClient({ fetch: refusing, env: {} });
  await assert.rejects(() => client.get("/api/status"), DaemonUnreachable);
});

test("client: a non-connection error is NOT swallowed as unreachable", async () => {
  const boom = async () => {
    throw new Error("something else");
  };
  const client = createClient({ fetch: boom, env: {} });
  await assert.rejects(
    () => client.get("/api/status"),
    (error) => {
      assert.ok(!(error instanceof DaemonUnreachable));
      assert.equal(error.message, "something else");
      return true;
    },
  );
});
