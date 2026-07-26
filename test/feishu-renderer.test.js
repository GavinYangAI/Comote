import test from "node:test";
import assert from "node:assert/strict";
import { createFeishuRenderer } from "../src/channels/feishu/renderer.js";

function stubDriver() {
  const calls = [];
  return {
    calls,
    sendText: async (a) => { calls.push(["sendText", a]); return { messageId: "t" }; },
    sendCard: async (a) => { calls.push(["sendCard", a]); return { messageId: "c" }; },
    uploadImage: async (p) => { calls.push(["uploadImage", p]); return "img_1"; },
    uploadFile: async (p, n) => { calls.push(["uploadFile", p, n]); return "file_1"; },
    sendImage: async (a) => { calls.push(["sendImage", a]); return { messageId: "i" }; },
    sendFile: async (a) => { calls.push(["sendFile", a]); return { messageId: "f" }; },
  };
}

test("text reply renders as a card via sendCard", async () => {
  const r = createFeishuRenderer();
  const driver = stubDriver();
  await r.render({ kind: "text", conversationId: "oc", text: "hi" }, { driver });
  assert.equal(driver.calls[0][0], "sendCard");
  assert.equal(driver.calls[0][1].receiveId, "oc");
});

test("approval reply renders all approval choices", async () => {
  const r = createFeishuRenderer();
  const driver = stubDriver();
  await r.render({ kind: "approval", conversationId: "oc", code: "a1",
    approval: { shortCode: "a1", method: "exec", params: { command: "rm -rf build" } } }, { driver });
  const card = driver.calls[0][1].card;
  const action = card.elements.find((e) => e.tag === "action");
  assert.deepEqual(action.actions.map((b) => b.value.decision), ["accept", "acceptForSession", "decline"]);
});

test("auto-approved reply renders a notification card without actions", async () => {
  const r = createFeishuRenderer();
  const driver = stubDriver();
  await r.render({
    kind: "approval",
    conversationId: "oc",
    code: "a1",
    autoApproved: true,
    approval: { shortCode: "a1", method: "exec", params: { command: "npm test" } },
  }, { driver });
  const card = driver.calls[0][1].card;
  assert.ok(!card.elements.some((element) => element.tag === "action"));
});

test("picker reply renders pick buttons", async () => {
  const r = createFeishuRenderer();
  const driver = stubDriver();
  await r.render({ kind: "picker", conversationId: "oc", pickKind: "project", text: "pick",
    items: [{ label: "p", index: 1 }] }, { driver });
  const action = driver.calls[0][1].card.elements.find((e) => e.tag === "action");
  assert.equal(action.actions[0].value.kind, "pick");
});

test("media image reply uploads then sends image", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const p = path.join(os.tmpdir(), "comote-renderer-img.png");
  fs.writeFileSync(p, "x");
  const r = createFeishuRenderer();
  const driver = stubDriver();
  await r.render({ kind: "media", conversationId: "oc", mediaKind: "image", path: p }, { driver });
  assert.deepEqual(driver.calls[0], ["uploadImage", p]);
  assert.equal(driver.calls[1][0], "sendImage");
  fs.unlinkSync(p);
});

test("oversize media falls back to localized text", async () => {
  const r = createFeishuRenderer();
  const driver = stubDriver();
  await r.render({ kind: "media", conversationId: "oc", mediaKind: "file", path: "/does/not/exist" }, { driver });
  assert.equal(driver.calls[0][0], "sendText"); // missing/oversize -> text fallback
});

test("buildStatusCard delegates to statusCard (has a header)", () => {
  const r = createFeishuRenderer();
  const card = r.buildStatusCard({ phase: "started", threadId: "th" });
  assert.ok(card.header);
});
