import test from "node:test";
import assert from "node:assert/strict";

import { AuthorizationStore } from "../src/core/authorization.js";
import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";
import { CommandRouter } from "../src/core/commands.js";
import { FeishuChannelAdapter } from "../src/channels/feishu/adapter.js";
import { FeishuDriver } from "../src/channels/feishu/driver.js";
import { WeChatChannelAdapter } from "../src/channels/wechat/adapter.js";
import { WeChatIlinkDriver } from "../src/channels/wechat/ilink-driver.js";

// ── Feishu inbound parsing ─────────────────────────────────────────────────

test("feishu normalizeInbound parses an image message into an attachment", () => {
  const adapter = new FeishuChannelAdapter({ commandRouter: { handleMessageAsync: async () => ({}) } });
  const msg = adapter.normalizeInbound({
    event: {
      sender: { sender_id: { open_id: "ou_o" } },
      message: {
        message_id: "om1",
        chat_id: "oc1",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_v2_k" }),
      },
    },
  });
  assert.equal(msg.text, "");
  assert.deepEqual(msg.attachments, [{ kind: "image", feishuKey: "img_v2_k", name: "img_v2_k" }]);
});

test("feishu normalizeInbound parses a file message and keeps the file name", () => {
  const adapter = new FeishuChannelAdapter({ commandRouter: { handleMessageAsync: async () => ({}) } });
  const msg = adapter.normalizeInbound({
    event: {
      sender: { sender_id: { open_id: "ou_o" } },
      message: {
        message_id: "om1",
        chat_id: "oc1",
        chat_type: "p2p",
        message_type: "file",
        content: JSON.stringify({ file_key: "file_k", file_name: "report.pdf" }),
      },
    },
  });
  assert.equal(msg.text, "");
  assert.deepEqual(msg.attachments, [{ kind: "file", feishuKey: "file_k", name: "report.pdf" }]);
});

test("feishu normalizeInbound extracts text and image from a pasted post message", () => {
  const adapter = new FeishuChannelAdapter({ commandRouter: { handleMessageAsync: async () => ({}) } });
  const msg = adapter.normalizeInbound({
    event: {
      sender: { sender_id: { open_id: "ou_o" } },
      message: {
        message_id: "om1",
        chat_id: "oc1",
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify({
          title: "",
          content: [[{ tag: "text", text: "识别图片内容" }], [{ tag: "img", image_key: "img_v3_abc" }]],
        }),
      },
    },
  });
  assert.equal(msg.text, "识别图片内容");
  assert.deepEqual(msg.attachments, [{ kind: "image", feishuKey: "img_v3_abc", name: "img_v3_abc" }]);
});

test("feishu normalizeInbound never leaks raw content of an unhandled message type", () => {
  const adapter = new FeishuChannelAdapter({ commandRouter: { handleMessageAsync: async () => ({}) } });
  const msg = adapter.normalizeInbound({
    event: {
      sender: { sender_id: { open_id: "ou_o" } },
      message: {
        message_id: "om1",
        chat_id: "oc1",
        chat_type: "p2p",
        message_type: "audio",
        content: JSON.stringify({ file_key: "audio_secret_key", duration: 3000 }),
      },
    },
  });
  assert.equal(msg.text, "");
  assert.deepEqual(msg.attachments, []);
  assert.doesNotMatch(JSON.stringify(msg), /audio_secret_key/);
});

// ── Feishu inbound → Codex (download + forward) ────────────────────────────

function makeConnectedRouter() {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const startTurns = [];
  const codexDesktop = {
    getStatus: () => ({ state: "connected" }),
    startTurn: async (args) => {
      startTurns.push(args);
      return { ok: true };
    },
  };
  const router = new CommandRouter({ authorization, projects, sessions, codexDesktop });
  const identity = { channel: "feishu", stableId: "ou_o", displayName: "O" };
  authorization.confirmIdentity(identity);
  projects.replaceProjects([{ name: "p", path: "/repo", source: "codex-desktop", status: "available" }]);
  router.currentProjectByIdentity.set(router.identityKey(identity), "/repo");
  sessions.upsertExternalSession({ projectPath: "/repo", id: "thread_1", title: "t" });
  return { router, identity, startTurns };
}

test("an inbound feishu image is downloaded and sent to Codex as an image input", async () => {
  const { router, startTurns } = makeConnectedRouter();
  const adapter = new FeishuChannelAdapter({
    commandRouter: router,
    downloadAttachment: async ({ attachment }) => ({ path: `/inbound/${attachment.feishuKey}.png`, name: attachment.name }),
    sendReply: async () => ({ ok: true }),
  });

  await adapter.handleInbound({
    event: {
      sender: { sender_id: { open_id: "ou_o" } },
      message: {
        message_id: "om1",
        chat_id: "oc1",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_k" }),
      },
    },
  });

  assert.equal(startTurns.length, 1);
  assert.equal(startTurns[0].threadId, "thread_1");
  assert.deepEqual(startTurns[0].images, ["/inbound/img_k.png"]);
  assert.match(startTurns[0].text, /图片/);
});

test("an inbound file is referenced by local path in the Codex prompt", async () => {
  const { router, identity, startTurns } = makeConnectedRouter();

  await router.sendToActiveSession(identity, "看看这个", [{ kind: "file", path: "/repo/a.pdf", name: "a.pdf" }]);

  assert.equal(startTurns.length, 1);
  assert.deepEqual(startTurns[0].images, []);
  assert.match(startTurns[0].text, /看看这个/);
  assert.match(startTurns[0].text, /\[用户发来文件：\/repo\/a\.pdf\]/);
});

test("a pasted post image is downloaded and sent to Codex with its caption", async () => {
  const { router, startTurns } = makeConnectedRouter();
  const adapter = new FeishuChannelAdapter({
    commandRouter: router,
    downloadAttachment: async ({ attachment }) => ({ path: `/inbound/${attachment.feishuKey}.png`, name: attachment.name }),
    sendReply: async () => ({ ok: true }),
  });

  await adapter.handleInbound({
    event: {
      sender: { sender_id: { open_id: "ou_o" } },
      message: {
        message_id: "om1",
        chat_id: "oc1",
        chat_type: "p2p",
        message_type: "post",
        content: JSON.stringify({
          title: "",
          content: [[{ tag: "text", text: "识别图片内容" }], [{ tag: "img", image_key: "img_k" }]],
        }),
      },
    },
  });

  assert.equal(startTurns.length, 1);
  assert.deepEqual(startTurns[0].images, ["/inbound/img_k.png"]);
  assert.match(startTurns[0].text, /识别图片内容/);
});

test("transcript records attachment placeholders for the local conversation view", async () => {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const recorded = [];
  const transcript = { record: (threadId, role, text) => recorded.push({ role, text }) };
  const codexDesktop = { getStatus: () => ({ state: "connected" }), startTurn: async () => ({}) };
  const router = new CommandRouter({ authorization, projects, sessions, codexDesktop, transcript });
  const identity = { channel: "feishu", stableId: "ou_o", displayName: "O" };
  router.currentProjectByIdentity.set(router.identityKey(identity), "/repo");
  sessions.upsertExternalSession({ projectPath: "/repo", id: "thread_1", title: "t" });

  await router.sendToActiveSession(identity, "这是什么", [{ kind: "file", path: "/repo/report.pptx", name: "report.pptx" }]);
  await router.sendToActiveSession(identity, "识别图片内容", [{ kind: "image", path: "/inbound/x.png", name: "img_v3_k" }]);
  await router.sendToActiveSession(identity, "这是哈", [{ kind: "image" }]);

  const texts = recorded.filter((r) => r.role === "user").map((r) => r.text);
  assert.equal(texts[0], "[PPTX文件] report.pptx\n这是什么"); // real filename shown
  assert.equal(texts[1], "[PNG图片]\n识别图片内容"); // image key has no extension → no name, type from path
  assert.equal(texts[2], "[图片]\n这是哈"); // wechat image: no path/name
});

// ── Feishu driver resource download ────────────────────────────────────────

test("downloadResource fetches binary and reports the content-type", async () => {
  const requests = [];
  const driver = new FeishuDriver({
    appId: "a",
    appSecret: "s",
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return { ok: true, status: 200, json: async () => ({ tenant_access_token: "tok", expire: 7200 }), text: async () => "" };
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => "image/png" },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        text: async () => "",
      };
    },
  });

  const { buffer, contentType } = await driver.downloadResource({ messageId: "om1", fileKey: "img_k", type: "image" });

  assert.equal(contentType, "image/png");
  assert.equal(buffer.length, 3);
  const resourceUrl = requests.find((u) => u.includes("/resources/"));
  assert.match(resourceUrl, /\/im\/v1\/messages\/om1\/resources\/img_k\?type=image/);
});

// ── WeChat inbound media: not supported, notify ────────────────────────────

test("wechat inbound media triggers a not-supported notice and is not routed", async () => {
  const sent = [];
  const adapter = new WeChatChannelAdapter({
    commandRouter: {
      handleMessageAsync: async () => {
        throw new Error("router must not be called for media-only inbound");
      },
    },
    sendReply: async (reply) => {
      sent.push(reply);
      return { ok: true };
    },
  });

  const result = await adapter.handleInbound({
    accountId: "acc",
    peer: { id: "wx", name: "W" },
    conversation: { id: "dm_wx", type: "direct" },
    message: { id: "m1", text: "", attachments: [{ type: "image" }] },
  });

  assert.equal(result.kind, "ignored");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /微信暂不支持/);
});

test("ilink normalizeUpdate flags a non-text item as a media attachment", () => {
  const driver = new WeChatIlinkDriver({ token: "t" });
  const update = driver.normalizeUpdate({ from_user_id: "u1", item_list: [{ type: 2, image_item: {} }] });
  assert.deepEqual(update.message.attachments, [{ kind: "image" }]);
});
