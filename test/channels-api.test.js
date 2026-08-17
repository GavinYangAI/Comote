import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server/app.js";
import { createComoteState } from "../src/server/state.js";

// Build a real registry-driven state (no auto-start so nothing reaches the
// network) and exercise the GENERIC /api/channels/:id/* dispatcher.
function startServer() {
  const state = createComoteState({
    autoStartWeChatRuntime: false,
    autoStartFeishuRuntime: false,
  });
  const app = createServer(state);
  const server = app.listen(0, "127.0.0.1");
  return new Promise((resolve) => {
    server.once("listening", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

test("generic dispatch serves runtime status for both channels", async () => {
  const { server, port } = await startServer();
  const wechat = await fetch(`http://127.0.0.1:${port}/api/channels/wechat/runtime`);
  const wechatBody = await wechat.json();
  const feishu = await fetch(`http://127.0.0.1:${port}/api/channels/feishu/runtime`);
  const feishuBody = await feishu.json();
  server.close();

  assert.equal(wechat.status, 200);
  assert.ok(typeof wechatBody.state === "string", "wechat runtime has a state");
  assert.equal(feishu.status, 200);
  assert.ok(typeof feishuBody.state === "string", "feishu runtime has a state");
});

test("generic dispatch serves adapter status (not runtime) for :id/status", async () => {
  const { server, port } = await startServer();
  const response = await fetch(`http://127.0.0.1:${port}/api/channels/wechat/status`);
  const body = await response.json();
  server.close();

  assert.equal(response.status, 200);
  assert.equal(body.id, "wechat");
});

test("generic dispatch PUT config returns the redacted public config", async () => {
  const { server, port } = await startServer();
  const response = await fetch(`http://127.0.0.1:${port}/api/channels/feishu/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, appId: "cli_test", appSecret: "shhh" }),
  });
  const body = await response.json();
  server.close();

  assert.equal(response.status, 200);
  assert.equal(body.appId, "cli_test");
  assert.equal(body.hasAppSecret, true);
  assert.equal(body.appSecret, undefined, "raw secret must never be returned");
});

test("global-manager Feishu config has a dedicated API and never changes project chat", async () => {
  const { server, port } = await startServer();
  const managerResponse = await fetch(
    `http://127.0.0.1:${port}/api/channels/feishu-global-manager/config`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, appId: "cli_manager", appSecret: "manager_secret" }),
    },
  );
  const managerConfig = await managerResponse.json();
  const projectConfig = await fetch(
    `http://127.0.0.1:${port}/api/channels/feishu/config`,
  ).then((response) => response.json());
  server.close();

  assert.equal(managerResponse.status, 200);
  assert.equal(managerConfig.appId, "cli_manager");
  assert.equal(managerConfig.hasAppSecret, true);
  assert.equal(managerConfig.appSecret, undefined);
  assert.equal(projectConfig.appId, null);
  assert.equal(projectConfig.hasAppSecret, false);
});

test("generic dispatch GET config returns the public config", async () => {
  const { server, port } = await startServer();
  const response = await fetch(`http://127.0.0.1:${port}/api/channels/wechat/config`);
  const body = await response.json();
  server.close();

  assert.equal(response.status, 200);
  assert.ok("accountId" in body);
});

test("unknown channel returns 404", async () => {
  const { server, port } = await startServer();
  const response = await fetch(`http://127.0.0.1:${port}/api/channels/nope/runtime`);
  server.close();

  assert.equal(response.status, 404);
});

test("unknown sub returns 404", async () => {
  const { server, port } = await startServer();
  const response = await fetch(`http://127.0.0.1:${port}/api/channels/wechat/bogus`);
  server.close();

  assert.equal(response.status, 404);
});

test("capability gating: poll only on poll-mode channels", async () => {
  const { server, port } = await startServer();
  // wechat is poll-mode → poll is a valid capability (routed, not 404). An
  // unconfigured driver may then error, but it must NOT be gated out as 404.
  const wechat = await fetch(`http://127.0.0.1:${port}/api/channels/wechat/runtime/poll`, {
    method: "POST",
  });
  // feishu is push-mode → poll is not a valid capability → 404.
  const feishu = await fetch(`http://127.0.0.1:${port}/api/channels/feishu/runtime/poll`, {
    method: "POST",
  });
  server.close();

  assert.notEqual(wechat.status, 404, "poll must be routed for a poll-mode channel");
  assert.equal(feishu.status, 404);
});

test("capability gating: deliver only on push-mode channels", async () => {
  const { server, port } = await startServer();
  // feishu is push-mode → deliver is a valid capability (routed, not 404).
  const feishu = await fetch(`http://127.0.0.1:${port}/api/channels/feishu/runtime/deliver`, {
    method: "POST",
  });
  // wechat is poll-mode → deliver is not a valid capability → 404.
  const wechat = await fetch(`http://127.0.0.1:${port}/api/channels/wechat/runtime/deliver`, {
    method: "POST",
  });
  server.close();

  assert.notEqual(feishu.status, 404, "deliver must be routed for a push-mode channel");
  assert.equal(wechat.status, 404);
});

test("GET /api/channels lists channel meta + status", async () => {
  const { server, port } = await startServer();
  const res = await fetch(`http://127.0.0.1:${port}/api/channels`);
  const list = await res.json();
  server.close();

  assert.equal(res.status, 200);
  const byId = Object.fromEntries(list.map((c) => [c.id, c]));
  assert.ok(byId.feishu, "feishu present");
  assert.ok(byId.wechat, "wechat present");
  // meta fields surfaced:
  assert.equal(byId.feishu.inboundMode, "push");
  assert.equal(byId.wechat.inboundMode, "poll");
  assert.equal(byId.feishu.binding, "qr");
  // status + runtime + config attached:
  assert.equal(typeof byId.feishu.status, "object"); // full adapter status object
  assert.equal(typeof byId.feishu.status.state, "string"); // adapter state conveyed via .state
  assert.ok(byId.feishu.runtime); // runtime status object
  assert.ok(byId.wechat.config !== undefined); // public config (or {})
  // config must be the REDACTED public config — never a raw secret.
  assert.equal(byId.feishu.config.appSecret, undefined, "raw secret must never leak");
});

test("GET /api/status channels still reports per-channel state (registry-driven)", async () => {
  const { server, port } = await startServer();
  const res = await fetch(`http://127.0.0.1:${port}/api/status`);
  const body = await res.json();
  server.close();

  assert.ok("wechat" in body.channels);
  assert.ok("feishu" in body.channels);
  assert.equal(typeof body.channels.wechat, "string");
});

test("GET /api/status falls back to hardcoded wechat/feishu when state has no registry", async () => {
  // A hand-built, registry-LESS state (mirrors server.test.js's createFakeState
  // minimal shape) so /api/status takes the `state.registry ? ... : <fallback>`
  // ELSE branch. Stub only the fields the handler dereferences.
  const state = {
    channels: {
      wechat: { getStatus: () => ({ state: "adapter_ready" }) },
      feishu: { getStatus: () => ({ state: "reserved" }) },
    },
    connectors: {
      desktop: { getStatus: () => ({ name: "Codex Desktop", role: "primary", state: "not_connected" }) },
      cli: { getStatus: () => ({ name: "Codex CLI", role: "fallback", state: "available" }) },
    },
    authorization: { listIdentities: () => [] },
    projects: { listProjects: () => [] },
  };
  // Sanity: this state hits the FALLBACK branch, not the registry branch.
  assert.equal("registry" in state, false);

  const app = createServer(state);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/status`);
  const body = await res.json();
  server.close();

  assert.equal(res.status, 200);
  // Fallback resolved each channel's adapter state via getStatus().state.
  assert.equal(body.channels.wechat, "adapter_ready");
  assert.equal(body.channels.feishu, "reserved");
});

test("GET /api/channels carries the enriched binding-page meta", async () => {
  const { server, port } = await startServer();
  const res = await fetch(`http://127.0.0.1:${port}/api/channels`);
  const byId = Object.fromEntries((await res.json()).map((c) => [c.id, c]));
  server.close();

  assert.ok(byId.feishu.states.running.tone);
  assert.ok(byId.feishu.configFields.find((f) => f.name === "domain"));
  assert.ok(byId.wechat.statusFlags.find((f) => f.field === "needsRelogin"));
  assert.equal(byId.wechat.boundWhen.field, "loggedIn");
});

test("outbound-replies (no id) lists across channels", async () => {
  const { server, port } = await startServer();
  const response = await fetch(`http://127.0.0.1:${port}/api/channels/outbound-replies`);
  const body = await response.json();
  server.close();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body));
});
