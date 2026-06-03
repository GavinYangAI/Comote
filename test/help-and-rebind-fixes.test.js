import test from "node:test";
import assert from "node:assert/strict";

import { AuthorizationStore } from "../src/core/authorization.js";
import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";
import { CommandRouter } from "../src/core/commands.js";
import { WeChatIlinkDriver } from "../src/channels/wechat/ilink-driver.js";
import { FeishuRuntimeService } from "../src/channels/feishu/runtime.js";

const MENU_MARKER = "Comote 命令（命令大小写不敏感";
const menuCount = (text) => (String(text).match(new RegExp(MENU_MARKER, "g")) || []).length;

// ---- Issue A: /help must not print the command menu twice on first contact ----
test("first-contact /help shows the welcome greeting + command menu exactly once", async () => {
  const authorization = new AuthorizationStore();
  const identity = { channel: "feishu", stableId: "ou_owner", displayName: "Owner" };
  authorization.confirmIdentity(identity);
  const router = new CommandRouter({
    authorization,
    projects: new ProjectStore(),
    sessions: new SessionStore(),
  });

  const reply = await router.handleMessageAsync({ identity, text: "/help" });

  assert.ok(reply.text.startsWith("已确认你的身份，欢迎使用 Comote。"), "keeps the welcome greeting");
  assert.equal(menuCount(reply.text), 1, "command menu appears once, not twice");
});

test("an already-greeted /help shows the menu once and drops the welcome banner", async () => {
  const authorization = new AuthorizationStore();
  const identity = { channel: "wechat", stableId: "acc:wxid_owner", displayName: "Owner" };
  authorization.confirmIdentity(identity);
  const router = new CommandRouter({
    authorization,
    projects: new ProjectStore(),
    sessions: new SessionStore(),
  });

  await router.handleMessageAsync({ identity, text: "/status" }); // first contact greets
  const reply = await router.handleMessageAsync({ identity, text: "/help" });

  assert.equal(menuCount(reply.text), 1);
  assert.ok(!reply.text.startsWith("已确认你的身份"), "no second welcome banner once greeted");
});

// ---- Issue B: WeChat desktop collapses lone "\n"; outbound text is sent as CRLF ----
test("WeChat sendText normalises newlines to CRLF so the desktop client breaks lines", async () => {
  const requests = [];
  const driver = new WeChatIlinkDriver({
    baseUrl: "https://wechat.example/api",
    token: "secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" };
    },
  });

  await driver.sendText({
    conversationId: "dm_wxid_owner",
    text: "line1\nline2\nline3",
  });

  const sentText = JSON.parse(requests[0].options.body).msg.item_list[0].text_item.text;
  assert.equal(sentText, "line1\r\nline2\r\nline3");
});

test("WeChat sendText leaves already-CRLF text unchanged (idempotent)", async () => {
  const requests = [];
  const driver = new WeChatIlinkDriver({
    baseUrl: "https://wechat.example/api",
    token: "secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" };
    },
  });

  await driver.sendText({ conversationId: "dm_wxid_owner", text: "a\r\nb" });

  const sentText = JSON.parse(requests[0].options.body).msg.item_list[0].text_item.text;
  assert.equal(sentText, "a\r\nb");
});

// ---- Issue C: a failing close on the old driver must not abort re-bind ----
test("configureDriver swaps in the new driver even when the old close throws (re-bind)", async () => {
  const runtime = new FeishuRuntimeService({ adapter: {}, outboundQueue: {} });
  const oldDriver = {
    startEventStream: async () => ({ ok: true }),
    stopEventStream: () => {
      throw new Error("WSClient.close failed (simulated Lark close on rebind)");
    },
    getStatus: () => ({ state: "configured", appId: "cli_old", domain: "feishu" }),
  };
  runtime.configureDriver(oldDriver);
  await runtime.start();
  assert.equal(runtime.running, true, "runtime is running before re-bind");

  const newDriver = {
    startEventStream: async () => ({ ok: true }),
    stopEventStream: () => {},
    getStatus: () => ({ state: "configured", appId: "cli_new", domain: "feishu" }),
  };

  // Pre-fix this threw (old close error) and the new driver was never installed,
  // surfacing as HTTP 500 in the login confirm path. It must not throw now.
  assert.doesNotThrow(() => runtime.configureDriver(newDriver));
  assert.equal(runtime.driver, newDriver, "new driver is installed despite the failed close");
});
