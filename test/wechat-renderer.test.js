import test from "node:test";
import assert from "node:assert/strict";
import { createWeChatRenderer } from "../src/channels/wechat/renderer.js";
import { t } from "../src/core/i18n/index.js";

function stubDriver() {
  const sent = [];
  return { sent, sendText: async (a) => { sent.push(a); return { ok: true }; } };
}

test("text reply is sent as one sendText when short", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render({ kind: "text", conversationId: "dm_x", text: "hi" }, { driver });
  assert.equal(driver.sent.length, 1);
  assert.equal(driver.sent[0].text, "hi");
});

test("long text reply is chunked with (i/n) prefixes", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render({ kind: "text", conversationId: "dm_x", text: "a".repeat(3200) }, { driver });
  assert.equal(driver.sent.length, 3);            // 1500-char chunks
  assert.match(driver.sent[0].text, /^\(1\/3\)/);
});

test("approval reply degrades to chat text (code + command + /approve)", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render({ kind: "approval", conversationId: "dm_x", code: "a1",
    approval: { shortCode: "a1", method: "exec", params: { command: "rm -rf build" } } }, { driver });
  assert.match(driver.sent[0].text, /rm -rf build/);
  assert.match(driver.sent[0].text, /\/approve a1/);
});

test("picker reply degrades to the picker text", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render({ kind: "picker", conversationId: "dm_x", text: "1. p\n2. q", items: [] }, { driver });
  assert.equal(driver.sent[0].text, "1. p\n2. q");
});

test("empty text reply sends nothing", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render({ kind: "text", conversationId: "dm_x", text: "" }, { driver });
  assert.equal(driver.sent.length, 0);
});

test("render passes accountId and inReplyTo through to sendText when present", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render({ kind: "text", conversationId: "dm_x", accountId: "acc1", inReplyTo: "m9", text: "hi" }, { driver });
  assert.equal(driver.sent[0].accountId, "acc1");
  assert.equal(driver.sent[0].inReplyTo, "m9");
});

test("render omits accountId and inReplyTo when absent", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render({ kind: "text", conversationId: "dm_x", text: "hi" }, { driver });
  assert.ok(!("accountId" in driver.sent[0]));
  assert.ok(!("inReplyTo" in driver.sent[0]));
});

test("a reply longer than maxChunks is capped at 6 chunks with a truncation marker", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render({ kind: "text", conversationId: "dm_x", text: "a".repeat(10000) }, { driver });
  assert.equal(driver.sent.length, 6);
  assert.match(driver.sent[5].text, /^\(6\/6\)/);
  // last chunk carries the truncation notice (t("state.chunk.truncated"))
  assert.ok(driver.sent[5].text.includes(t("state.chunk.truncated")));
});

test("approvalResolved reply sends nothing", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render({ kind: "approvalResolved", conversationId: "dm_x", code: "a1", decision: "accept" }, { driver });
  assert.equal(driver.sent.length, 0);
});

test("media reply degrades to a paperclip filename line", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render({ kind: "media", conversationId: "dm_x", mediaKind: "file", path: "/p/report.pdf", fileName: "report.pdf" }, { driver });
  assert.match(driver.sent[0].text, /report\.pdf/);
});

test("wechat media degrades to a local-path notice with the path", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render({ kind: "media", conversationId: "dm_x", mediaKind: "file", path: "/repo/out/a.png", fileName: "a.png" }, { driver });
  const joined = driver.sent.map((m) => m.text).join("\n");
  assert.match(joined, /a\.png/);
  assert.match(joined, /\/repo\/out\/a\.png/);
});

test("render forwards a chunk-indexed dedupeKey when reply.dedupeKey is present", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render(
    { kind: "text", conversationId: "dm_x", dedupeKey: "reply-7", text: "a".repeat(3200) },
    { driver },
  );
  assert.equal(driver.sent.length, 3);
  // Each chunk carries a distinct, deterministic dedupeKey so chunks 2..N are
  // not dropped as duplicates of chunk 1.
  assert.equal(driver.sent[0].dedupeKey, "reply-7:0");
  assert.equal(driver.sent[1].dedupeKey, "reply-7:1");
  assert.equal(driver.sent[2].dedupeKey, "reply-7:2");
});

test("render omits dedupeKey when reply.dedupeKey is absent", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render({ kind: "text", conversationId: "dm_x", text: "hi" }, { driver });
  assert.ok(!("dedupeKey" in driver.sent[0]));
});

test("B-9: long multi-line replies are chunked at line boundaries, not mid-sentence", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  const lines = Array.from({ length: 60 }, (_, i) => `sentence number ${String(i).padStart(2, "0")} ${"word ".repeat(8)}`.trim());
  await r.render({ kind: "text", conversationId: "dm_x", text: lines.join("\n") }, { driver });
  assert.ok(driver.sent.length > 1, "long reply was chunked");
  for (const msg of driver.sent) {
    // Strip the "(i/n)\n" prefix, then every remaining line must be a whole input line.
    const body = msg.text.replace(/^\(\d+\/\d+\)\n/, "");
    for (const line of body.split("\n")) {
      assert.ok(lines.includes(line), `chunk line is a whole input line: ${line}`);
    }
  }
});

test("B-9: a hard split never cuts an emoji surrogate pair", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render({ kind: "text", conversationId: "dm_x", text: "🚀".repeat(1200) }, { driver });
  assert.ok(driver.sent.length >= 2);
  for (const msg of driver.sent) {
    assert.ok(!/[\uD800-\uDBFF]$/.test(msg.text), "no lone high surrogate at a chunk end");
  }
});

test("media reply with no name/path sends nothing", async () => {
  const r = createWeChatRenderer();
  const driver = stubDriver();
  await r.render({ kind: "media", conversationId: "dm_x", mediaKind: "file" }, { driver });
  assert.equal(driver.sent.length, 0);
});
