// test/telegram-renderer.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelegramRenderer, MAX_IMAGE_BYTES } from "../src/channels/telegram/renderer.js";

function fakeDriver() {
  const calls = [];
  return {
    calls,
    async sendMessage(a) { calls.push(["sendMessage", a]); },
    async sendPhoto(a) { calls.push(["sendPhoto", a]); },
    async sendDocument(a) { calls.push(["sendDocument", a]); },
  };
}

test("text reply sends a plain message", async () => {
  const r = createTelegramRenderer();
  const d = fakeDriver();
  await r.render({ kind: "text", conversationId: "9", text: "hello" }, { driver: d });
  assert.deepEqual(d.calls[0][0], "sendMessage");
  assert.equal(d.calls[0][1].chatId, "9");
  assert.equal(d.calls[0][1].text, "hello");
  assert.equal(d.calls[0][1].parseMode ?? null, null); // plain text, no parse_mode
});

test("text reply longer than Telegram's 4096 limit is chunked with (i/n) prefixes", async () => {
  const r = createTelegramRenderer();
  const d = fakeDriver();
  const long = "x".repeat(9000);
  await r.render({ kind: "text", conversationId: "9", text: long }, { driver: d });

  assert.ok(d.calls.length >= 3, `expected ≥3 chunks, got ${d.calls.length}`);
  let reassembled = "";
  for (let i = 0; i < d.calls.length; i += 1) {
    const [method, args] = d.calls[i];
    assert.equal(method, "sendMessage");
    assert.ok(args.text.length <= 4096, `chunk ${i} exceeds 4096 (${args.text.length})`);
    const prefix = `(${i + 1}/${d.calls.length})\n`;
    assert.ok(args.text.startsWith(prefix), `chunk ${i} missing ${prefix.trim()} prefix`);
    reassembled += args.text.slice(prefix.length);
  }
  assert.equal(reassembled, long, "no content lost across chunks");
});

test("empty text reply sends nothing", async () => {
  const r = createTelegramRenderer();
  const d = fakeDriver();
  await r.render({ kind: "text", conversationId: "9", text: "" }, { driver: d });
  assert.equal(d.calls.length, 0);
});

test("approval reply sends message with approve/reject inline keyboard", async () => {
  const r = createTelegramRenderer();
  const d = fakeDriver();
  await r.render({ kind: "approval", conversationId: "9", code: "A1", approval: { command: "rm -rf", cwd: "/tmp" } }, { driver: d });
  assert.equal(d.calls[0][0], "sendMessage");
  assert.equal(d.calls[0][1].replyMarkup.inline_keyboard[0][0].callback_data, "ap:A1");
});

test("picker with items renders inline buttons; empty items → numbered text", async () => {
  const r = createTelegramRenderer();
  const d = fakeDriver();
  await r.render({ kind: "picker", conversationId: "9", pickKind: "project", text: "pick", items: [{ index: 1, label: "repoA" }] }, { driver: d });
  assert.equal(d.calls[0][1].replyMarkup.inline_keyboard[0][0].callback_data, "pk:p:1");
  d.calls.length = 0;
  await r.render({ kind: "picker", conversationId: "9", pickKind: "project", text: "pick", items: [] }, { driver: d });
  assert.equal(d.calls[0][1].replyMarkup ?? null, null);
});

test("approvalResolved is silent", async () => {
  const r = createTelegramRenderer();
  const d = fakeDriver();
  await r.render({ kind: "approvalResolved", conversationId: "9" }, { driver: d });
  assert.equal(d.calls.length, 0);
});

test("media image under the limit sends a photo; missing file degrades to text", async () => {
  const r = createTelegramRenderer();
  const d = fakeDriver();
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "tgr-"));
  const img = join(dir, "p.jpg");
  await writeFile(img, Buffer.alloc(100));
  await r.render({ kind: "media", conversationId: "9", mediaKind: "image", path: img }, { driver: d });
  assert.equal(d.calls[0][0], "sendPhoto");
  d.calls.length = 0;
  await r.render({ kind: "media", conversationId: "9", mediaKind: "image", path: join(dir, "nope.jpg") }, { driver: d });
  assert.equal(d.calls[0][0], "sendMessage"); // degrade
});

test("buildStatusCard returns text + cancel keyboard while in-flight, no keyboard when done", () => {
  const r = createTelegramRenderer();
  const live = r.buildStatusCard({ phase: "progress", threadId: "t1", steps: 1, text: "go" });
  assert.match(live.text, /go/);
  assert.equal(live.replyMarkup.inline_keyboard[0][0].callback_data, "ck:t1");
  const done = r.buildStatusCard({ phase: "completed", threadId: "t1", text: "done", done: true });
  assert.equal(done.replyMarkup ?? null, null);
});
