// test/telegram-renderer.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTelegramRenderer, MAX_IMAGE_BYTES } from "../src/channels/telegram/renderer.js";

function fakeDriver() {
  const calls = [];
  return {
    calls,
    async sendMessage(a) { calls.push(["sendMessage", a]); return { message_id: 41 }; },
    async sendPhoto(a) { calls.push(["sendPhoto", a]); },
    async sendDocument(a) { calls.push(["sendDocument", a]); },
  };
}

test("text reply sends an HTML-formatted message (B-8)", async () => {
  const r = createTelegramRenderer();
  const d = fakeDriver();
  await r.render({ kind: "text", conversationId: "9", text: "hello" }, { driver: d });
  assert.deepEqual(d.calls[0][0], "sendMessage");
  assert.equal(d.calls[0][1].chatId, "9");
  assert.equal(d.calls[0][1].text, "hello");
  assert.equal(d.calls[0][1].parseMode, "HTML");
});

test("B-8: markdown bold/code/pre are converted to Telegram HTML and content is escaped", async () => {
  const r = createTelegramRenderer();
  const d = fakeDriver();
  await r.render(
    { kind: "text", conversationId: "9", text: "**done** run `a < b`\n```\nx & y\n```" },
    { driver: d },
  );
  const sent = d.calls[0][1];
  assert.equal(sent.parseMode, "HTML");
  assert.ok(sent.text.includes("<b>done</b>"), "bold converted");
  assert.ok(sent.text.includes("<code>a &lt; b</code>"), "inline code converted + escaped");
  assert.ok(sent.text.includes("<pre>x &amp; y</pre>"), "fence converted + escaped");
});

test("B-8: a 400 \"can't parse entities\" falls back to plain text — the message is never lost", async () => {
  const r = createTelegramRenderer();
  const calls = [];
  const d = {
    async sendMessage(a) {
      calls.push(a);
      if (a.parseMode === "HTML") {
        const err = new Error("Telegram sendMessage failed: 400 Bad Request: can't parse entities");
        err.code = 400;
        throw err;
      }
      return { message_id: 1 };
    },
  };
  await r.render({ kind: "text", conversationId: "9", text: "**broken md" }, { driver: d });
  assert.equal(calls.length, 2, "HTML attempt then plain resend");
  assert.equal(calls[0].parseMode, "HTML");
  assert.equal(calls[1].parseMode ?? null, null, "fallback is plain text");
  assert.equal(calls[1].text, "**broken md", "fallback carries the raw original chunk");
});

test("B-8: a non-parse error still propagates so the outbound queue retries", async () => {
  const r = createTelegramRenderer();
  const d = {
    async sendMessage() {
      const err = new Error("Telegram sendMessage failed: 429 Too Many Requests");
      err.code = 429;
      throw err;
    },
  };
  await assert.rejects(
    () => r.render({ kind: "text", conversationId: "9", text: "hi" }, { driver: d }),
    /429/,
  );
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

test("approval reply sends message with all approval choices", async () => {
  const r = createTelegramRenderer();
  const d = fakeDriver();
  await r.render({ kind: "approval", conversationId: "9", code: "A1", approval: { command: "rm -rf", cwd: "/tmp" } }, { driver: d });
  assert.equal(d.calls[0][0], "sendMessage");
  assert.equal(d.calls[0][1].replyMarkup.inline_keyboard[0][0].callback_data, "ap:A1");
  assert.equal(d.calls[0][1].replyMarkup.inline_keyboard[0][1].callback_data, "as:A1");
});

test("auto-approved notification has no inline keyboard or manual commands", async () => {
  const r = createTelegramRenderer();
  const d = fakeDriver();
  await r.render({
    kind: "approval",
    conversationId: "9",
    code: "A1",
    autoApproved: true,
    approval: { shortCode: "A1", method: "exec", params: { command: "npm test" } },
  }, { driver: d });
  assert.equal(d.calls[0][0], "sendMessage");
  assert.equal(d.calls[0][1].replyMarkup, undefined);
  assert.doesNotMatch(d.calls[0][1].text, /\/approve|\/deny/);
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

test("approvalResolved edits through the runtime and sends no second message", async () => {
  const r = createTelegramRenderer();
  const d = fakeDriver();
  const resolved = [];
  await r.render({ kind: "approvalResolved", conversationId: "9", code: "A1", decision: "accept" }, {
    driver: d,
    runtime: { resolveApprovalMessage: async (reply) => resolved.push(reply) },
  });
  assert.equal(d.calls.length, 0);
  assert.equal(resolved[0].code, "A1");
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
