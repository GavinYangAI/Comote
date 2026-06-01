import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthorizationStore } from "../src/core/authorization.js";
import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";
import { CommandRouter } from "../src/core/commands.js";
import { FeishuDriver } from "../src/channels/feishu/driver.js";
import { FeishuChannelAdapter } from "../src/channels/feishu/adapter.js";
import { FeishuRuntimeService } from "../src/channels/feishu/runtime.js";
import { OutboundQueue } from "../src/core/outbound-queue.js";

// ── Driver: multipart upload + image/file message sending ──────────────────

test("uploadImage posts multipart image_type=message and returns image_key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-media-"));
  const imgPath = join(dir, "shot.png");
  await writeFile(imgPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const requests = [];
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok", expire: 7200 });
      }
      return jsonResponse({ code: 0, data: { image_key: "img_v2_abc" } });
    },
  });

  const key = await driver.uploadImage(imgPath);

  assert.equal(key, "img_v2_abc");
  const upload = requests.find((r) => r.url.endsWith("/im/v1/images"));
  assert.ok(upload, "should POST to /im/v1/images");
  assert.equal(upload.options.headers["content-type"], undefined, "no manual content-type for multipart");
  assert.equal(upload.options.body.get("image_type"), "message");
  assert.ok(upload.options.body.get("image"), "image field present");
  await rm(dir, { recursive: true, force: true });
});

test("uploadFile maps the extension to file_type and returns file_key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-media-"));
  const pdfPath = join(dir, "report.pdf");
  await writeFile(pdfPath, Buffer.from("%PDF-1.4"));
  const requests = [];
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok", expire: 7200 });
      }
      return jsonResponse({ code: 0, data: { file_key: "file_v2_xyz" } });
    },
  });

  const key = await driver.uploadFile(pdfPath);

  assert.equal(key, "file_v2_xyz");
  const upload = requests.find((r) => r.url.endsWith("/im/v1/files"));
  assert.equal(upload.options.body.get("file_type"), "pdf");
  assert.equal(upload.options.body.get("file_name"), "report.pdf");
  assert.ok(upload.options.body.get("file"), "file field present");
  await rm(dir, { recursive: true, force: true });
});

test("sendImage and sendFile build the right msg_type and content", async () => {
  const requests = [];
  const driver = new FeishuDriver({
    appId: "cli_a",
    appSecret: "secret",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.endsWith("/auth/v3/tenant_access_token/internal")) {
        return jsonResponse({ tenant_access_token: "tok", expire: 7200 });
      }
      return jsonResponse({ code: 0 });
    },
  });

  await driver.sendImage({ receiveId: "oc_chat", imageKey: "img_1" });
  await driver.sendFile({ receiveId: "oc_chat", fileKey: "file_1" });

  const sends = requests
    .filter((r) => r.options.method === "POST" && r.url.includes("/im/v1/messages?"))
    .map((r) => JSON.parse(r.options.body));
  const imageMsg = sends.find((b) => b.msg_type === "image");
  const fileMsg = sends.find((b) => b.msg_type === "file");
  assert.equal(imageMsg.content, JSON.stringify({ image_key: "img_1" }));
  assert.equal(fileMsg.content, JSON.stringify({ file_key: "file_1" }));
});

// ── Router: /img /file security boundary ───────────────────────────────────

function makeRouter() {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const router = new CommandRouter({ authorization, projects, sessions });
  return { router };
}

const OWNER = { channel: "feishu", stableId: "ou_owner", displayName: "Owner" };

test("/img is rejected without a current project", async () => {
  const { router } = makeRouter();
  const reply = await router.dispatchAuthorizedMessage({ identity: OWNER, text: "/img a.png" });
  assert.equal(reply.kind, "error");
  assert.match(reply.text, /\/open/);
});

test("/img returns a media reply for a file inside the project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-proj-"));
  await writeFile(join(dir, "a.png"), Buffer.from([1, 2, 3]));
  const { router } = makeRouter();
  router.currentProjectByIdentity.set(router.identityKey(OWNER), dir);

  const reply = await router.dispatchAuthorizedMessage({ identity: OWNER, text: "/img a.png" });

  assert.equal(reply.kind, "media");
  assert.equal(reply.media.kind, "image");
  assert.equal(reply.media.name, "a.png");
  assert.match(reply.media.path, /a\.png$/);
  await rm(dir, { recursive: true, force: true });
});

test("/file outside the project directory is rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-proj-"));
  const outside = await mkdtemp(join(tmpdir(), "comote-out-"));
  const outsideFile = join(outside, "secret.txt");
  await writeFile(outsideFile, "x");
  const { router } = makeRouter();
  router.currentProjectByIdentity.set(router.identityKey(OWNER), dir);

  const reply = await router.dispatchAuthorizedMessage({ identity: OWNER, text: `/file ${outsideFile}` });

  assert.equal(reply.kind, "error");
  assert.match(reply.text, /只能发送当前项目目录内/);
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("/img over the 10MB image cap is rejected before upload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comote-proj-"));
  await writeFile(join(dir, "big.png"), Buffer.alloc(10 * 1024 * 1024 + 1));
  const { router } = makeRouter();
  router.currentProjectByIdentity.set(router.identityKey(OWNER), dir);

  const reply = await router.dispatchAuthorizedMessage({ identity: OWNER, text: "/img big.png" });

  assert.equal(reply.kind, "error");
  assert.match(reply.text, /超过飞书 10MB/);
  await rm(dir, { recursive: true, force: true });
});

// ── Integration: adapter enqueue → runtime upload+send ─────────────────────

test("a media reply flows from adapter enqueue to driver upload+send", async () => {
  const calls = [];
  const driver = {
    getStatus: () => ({}),
    verifyEvent: () => true,
    async uploadImage(path) {
      calls.push(["uploadImage", path]);
      return "img_key_1";
    },
    async sendImage(args) {
      calls.push(["sendImage", args]);
    },
  };
  const outboundQueue = new OutboundQueue({});
  const adapter = new FeishuChannelAdapter({
    commandRouter: {
      handleMessageAsync: async () => ({
        kind: "media",
        text: "",
        media: { kind: "image", path: "/tmp/x.png", name: "x.png" },
      }),
    },
    sendReply: async (reply) => {
      outboundQueue.enqueue(reply);
      return { ok: true };
    },
  });
  const runtime = new FeishuRuntimeService({ adapter, outboundQueue, driver });

  await adapter.handleInbound({
    event: {
      message: { message_id: "om1", chat_id: "oc1", chat_type: "p2p", content: JSON.stringify({ text: "/img x.png" }) },
      sender: { sender_id: { open_id: "ou_owner" } },
    },
  });
  await runtime.deliverQueued();

  assert.deepEqual(calls.find((c) => c[0] === "uploadImage"), ["uploadImage", "/tmp/x.png"]);
  const send = calls.find((c) => c[0] === "sendImage");
  assert.equal(send[1].imageKey, "img_key_1");
  assert.equal(send[1].receiveId, "oc1");
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
