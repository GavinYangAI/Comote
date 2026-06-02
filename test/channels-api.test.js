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

test("outbound-replies (no id) lists across channels", async () => {
  const { server, port } = await startServer();
  const response = await fetch(`http://127.0.0.1:${port}/api/channels/outbound-replies`);
  const body = await response.json();
  server.close();

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(body));
});
