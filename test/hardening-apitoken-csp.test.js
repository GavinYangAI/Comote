import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createServer } from "../src/server/app.js";

// Minimal state: /api/status only needs these shapes. The auth gate runs before
// any handler, so the body for authorized requests is incidental to these tests.
function createMinimalState() {
  return {
    registry: null,
    channels: {},
    connectors: {
      desktop: { getStatus: () => ({ state: "not_connected" }) },
      cli: { getStatus: () => ({ state: "available" }) },
    },
    authorization: { listIdentities: () => [] },
    projects: { listProjects: () => [] },
  };
}

async function withServer(apiToken, fn) {
  const server = createServer(createMinimalState(), { apiToken });
  server.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    server.close();
  }
}

const TOKEN = "s3cr3t-local-token";

test("rejects API requests with no token when a token is configured", async () => {
  await withServer(TOKEN, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(res.status, 401);
  });
});

test("rejects a wrong token of the SAME length (exercises constant-time path)", async () => {
  await withServer(TOKEN, async (port) => {
    const wrong = "x".repeat(TOKEN.length);
    assert.equal(wrong.length, TOKEN.length);
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { "x-comote-token": wrong },
    });
    assert.equal(res.status, 401);
  });
});

test("rejects a token of a DIFFERENT length without throwing (length-safe compare)", async () => {
  await withServer(TOKEN, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { "x-comote-token": "short" },
    });
    // A naive timingSafeEqual would throw on unequal lengths and surface as 500;
    // the length-safe guard must return a clean 401 instead.
    assert.equal(res.status, 401);
  });
});

test("accepts the correct token via x-comote-token header", async () => {
  await withServer(TOKEN, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { "x-comote-token": TOKEN },
    });
    assert.equal(res.status, 200);
  });
});

test("accepts the correct token via Authorization: Bearer", async () => {
  await withServer(TOKEN, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
  });
});

test("rejects a Bearer token of a different length without throwing", async () => {
  await withServer(TOKEN, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { authorization: "Bearer short" },
    });
    assert.equal(res.status, 401);
  });
});

test("read endpoints that expose secrets-adjacent data require the token", async () => {
  // /api/identities surfaces authorized identity records; the token gate must
  // apply to reads, not just writes.
  await withServer(TOKEN, async (port) => {
    const denied = await fetch(`http://127.0.0.1:${port}/api/identities`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(`http://127.0.0.1:${port}/api/identities`, {
      headers: { "x-comote-token": TOKEN },
    });
    assert.equal(allowed.status, 200);
  });
});

test("with no token configured, the loopback bind alone gates access (unchanged)", async () => {
  await withServer(null, async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(res.status, 200);
  });
});

test("tauri.conf.json sets a non-null CSP allowing self and the loopback API", () => {
  const confPath = fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url));
  const conf = JSON.parse(readFileSync(confPath, "utf8"));
  const csp = conf.app?.security?.csp;
  assert.equal(typeof csp, "string", "csp must be a string, not null");
  // default-src locks the baseline; connect-src must still permit the loopback
  // daemon the webview talks to so the app does not white-screen on fetch.
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /connect-src[^;]*127\.0\.0\.1/);
  // boot.html ships an inline <script> and <style>; both must be permitted.
  assert.match(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /style-src[^;]*'unsafe-inline'/);
  // QR codes / images use data: and blob: URLs.
  assert.match(csp, /img-src[^;]*data:/);
  assert.match(csp, /img-src[^;]*blob:/);
});
