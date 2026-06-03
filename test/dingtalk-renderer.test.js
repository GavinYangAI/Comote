// test/dingtalk-renderer.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDingTalkRenderer } from "../src/channels/dingtalk/renderer.js";

function fakeDriver() {
  return {
    calls: [],
    async createCard(a) { this.calls.push(["createCard", a]); return { outTrackId: a.outTrackId }; },
    async sendText(a) { this.calls.push(["sendText", a]); },
    async sendMarkdown(a) { this.calls.push(["sendMarkdown", a]); },
    async uploadMedia() { return "media-1"; },
    async sendImage(a) { this.calls.push(["sendImage", a]); },
    async sendFile(a) { this.calls.push(["sendFile", a]); },
  };
}

test("text reply goes out as markdown", async () => {
  const r = createDingTalkRenderer({ templates: {} });
  const d = fakeDriver();
  await r.render({ kind: "text", conversationId: "s", text: "hi" }, { driver: d });
  assert.equal(d.calls[0][0], "sendMarkdown");
  assert.equal(d.calls[0][1].receiveId, "s");
});

test("approval with a template id sends an interactive card", async () => {
  const r = createDingTalkRenderer({ templates: { approval: "appr.schema" } });
  const d = fakeDriver();
  await r.render({ kind: "approval", conversationId: "s", code: "a1", approval: { shortCode: "a1", method: "run", params: { command: "ls" } } }, { driver: d });
  const [name, arg] = d.calls[0];
  assert.equal(name, "createCard");
  assert.equal(arg.cardTemplateId, "appr.schema");
  assert.equal(arg.receiveId, "s");
  assert.ok(arg.outTrackId, "an outTrackId was generated");
  assert.equal(typeof arg.cardParamMap.title, "string");
});

test("approval without a template id degrades to markdown text", async () => {
  const r = createDingTalkRenderer({ templates: {} });
  const d = fakeDriver();
  await r.render({ kind: "approval", conversationId: "s", code: "a1", approval: { shortCode: "a1", method: "run", params: { command: "ls" } } }, { driver: d });
  assert.equal(d.calls[0][0], "sendMarkdown");
  assert.match(d.calls[0][1].text, /a1/);
});

test("picker with a template id sends a card carrying the options param", async () => {
  const r = createDingTalkRenderer({ templates: { picker: "pick.schema" } });
  const d = fakeDriver();
  await r.render({ kind: "picker", conversationId: "s", pickKind: "project", items: [{ index: 1, label: "alpha" }], text: "" }, { driver: d });
  const [name, arg] = d.calls[0];
  assert.equal(name, "createCard");
  assert.equal(arg.cardTemplateId, "pick.schema");
  assert.ok(arg.cardParamMap.options, "options param present");
  const options = JSON.parse(arg.cardParamMap.options);
  assert.equal(options[0].params.conv, "s");
});

test("approvalResolved is silent (resolution surfaces via next reply / card PUT)", async () => {
  const r = createDingTalkRenderer({ templates: { approval: "appr.schema" } });
  const d = fakeDriver();
  await r.render({ kind: "approvalResolved", conversationId: "s", code: "a1", decision: "accept" }, { driver: d });
  assert.equal(d.calls.length, 0);
});

test("media uploads then sends as file", async () => {
  const r = createDingTalkRenderer({ templates: {} });
  const d = fakeDriver();
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "dt-"));
  const p = join(dir, "a.txt");
  await writeFile(p, "x");
  await r.render({ kind: "media", conversationId: "s", mediaKind: "file", path: p, fileName: "a.txt" }, { driver: d });
  const send = d.calls.find((c) => c[0] === "sendFile");
  assert.ok(send);
  assert.equal(send[1].mediaId, "media-1");
});

test("buildStatusCard returns a cardParamMap", () => {
  const r = createDingTalkRenderer({ templates: { status: "st.schema" } });
  const map = r.buildStatusCard({ phase: "completed", text: "done", done: true });
  assert.equal(typeof map.title, "string");
  assert.equal(map.body, "done");
});

test("buildStatusCard carries a cancel button while in-flight, drops it when done", () => {
  const r = createDingTalkRenderer({ templates: { status: "st.schema" } });
  const live = r.buildStatusCard({ phase: "progress", threadId: "t9", steps: 1, done: false });
  assert.equal(typeof live.cancelLabel, "string");
  assert.deepEqual(JSON.parse(live.cancelParams), { action: "cancel", threadId: "t9" });
  const finished = r.buildStatusCard({ phase: "completed", threadId: "t9", text: "done", done: true });
  assert.equal(finished.cancelParams, ""); // null params → "" via toParamMap (no working button)
});

test("buildStatusCard maps each phase to a title + steps", () => {
  const r = createDingTalkRenderer({ templates: { status: "st.schema" } });
  const started = r.buildStatusCard({ phase: "started", threadId: "t", steps: 0 });
  assert.equal(typeof started.title, "string");
  assert.equal(typeof started.steps, "string"); // "starting…" localized
  const progress = r.buildStatusCard({ phase: "progress", threadId: "t", steps: 3 });
  assert.match(progress.steps, /3/);
  const err = r.buildStatusCard({ phase: "error", text: "boom", done: true });
  assert.equal(err.body, "boom");
  assert.equal(err.done, "true"); // toParamMap stringifies the boolean
});
