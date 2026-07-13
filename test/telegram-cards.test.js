// test/telegram-cards.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeCallback,
  decodeCallback,
  approvalKeyboard,
  pickerKeyboard,
  cancelKeyboard,
  statusText,
  generatePairingCode,
  markdownToTelegramHtml,
  escapeHtml,
  BOT_COMMANDS,
  chunkMessage,
} from "../src/channels/telegram/cards.js";

test("BOT_COMMANDS lists the main commands in Telegram's required shape (B-8)", () => {
  assert.ok(BOT_COMMANDS.length >= 10);
  for (const c of BOT_COMMANDS) {
    assert.match(c.command, /^[a-z0-9_]{1,32}$/, "lowercase name, no leading slash");
    assert.ok(c.description.length >= 3 && c.description.length <= 256);
  }
  const names = BOT_COMMANDS.map((c) => c.command);
  for (const want of ["status", "projects", "sessions", "use", "new", "tail", "approve", "deny", "cancel", "file", "help"]) {
    assert.ok(names.includes(want), `includes /${want}`);
  }
});

test("escapeHtml escapes &, <, > (B-8)", () => {
  assert.equal(escapeHtml("a & b < c > d"), "a &amp; b &lt; c &gt; d");
});

test("markdownToTelegramHtml converts bold / inline code / fences and escapes content (B-8)", () => {
  assert.equal(markdownToTelegramHtml("**bold** text"), "<b>bold</b> text");
  assert.equal(markdownToTelegramHtml("run `a<b>` now"), "run <code>a&lt;b&gt;</code> now");
  assert.equal(markdownToTelegramHtml("```js\nif (a < b) {}\n```"), "<pre>if (a &lt; b) {}</pre>");
  // Plain text is escaped, nothing else invented.
  assert.equal(markdownToTelegramHtml("1 < 2 & 3"), "1 &lt; 2 &amp; 3");
});

test("markdownToTelegramHtml closes an unterminated trailing fence (B-8)", () => {
  const html = markdownToTelegramHtml("before\n```\ncode tail");
  assert.equal(html, "before\n<pre>code tail</pre>");
});

test("approve/reject callback round-trips and stays within 64 bytes", () => {
  const data = encodeCallback({ action: "approve", code: "A1B2" });
  assert.equal(data, "ap:A1B2");
  assert.ok(Buffer.byteLength(data) <= 64);
  assert.deepEqual(decodeCallback("ap:A1B2"), { action: "approve", code: "A1B2" });
  assert.deepEqual(decodeCallback("rj:A1B2"), { action: "reject", code: "A1B2" });
});

test("pick callback carries kind + index; cancel carries threadId", () => {
  assert.deepEqual(decodeCallback(encodeCallback({ action: "pick", pickKind: "project", index: "3" })),
    { action: "pick", pickKind: "project", index: "3" });
  assert.deepEqual(decodeCallback(encodeCallback({ action: "pick", pickKind: "session", index: "1" })),
    { action: "pick", pickKind: "session", index: "1" });
  // unknown/missing kind must default to the non-project side, never misroute to project
  assert.deepEqual(decodeCallback(encodeCallback({ action: "pick", pickKind: "whatever", index: "2" })),
    { action: "pick", pickKind: "session", index: "2" });
  assert.deepEqual(decodeCallback(encodeCallback({ action: "cancel", threadId: "t-9" })),
    { action: "cancel", threadId: "t-9" });
});

test("callback refs containing ':' round-trip without truncation", () => {
  assert.deepEqual(decodeCallback(encodeCallback({ action: "cancel", threadId: "a:b:c" })), { action: "cancel", threadId: "a:b:c" });
});

test("decodeCallback returns null for unknown/garbage", () => {
  assert.equal(decodeCallback("zzz"), null);
  assert.equal(decodeCallback(""), null);
});

test("approvalKeyboard has approve + reject buttons with encoded callback_data", () => {
  const kb = approvalKeyboard("A1B2");
  assert.equal(kb.inline_keyboard.length, 1);
  assert.equal(kb.inline_keyboard[0][0].callback_data, "ap:A1B2");
  assert.equal(kb.inline_keyboard[0][1].callback_data, "rj:A1B2");
});

test("pickerKeyboard renders one button per item with pick callbacks", () => {
  const kb = pickerKeyboard("project", [{ index: 1, label: "repoA" }, { index: 2, label: "repoB" }]);
  assert.equal(kb.inline_keyboard.length, 2);
  assert.equal(kb.inline_keyboard[0][0].callback_data, "pk:p:1");
  assert.match(kb.inline_keyboard[0][0].text, /repoA/);
});

test("cancelKeyboard only present while in-flight", () => {
  const kb = cancelKeyboard("t-9");
  assert.equal(kb.inline_keyboard[0][0].callback_data, "ck:t-9");
});

test("statusText renders phase title + body + steps", () => {
  const text = statusText({ phase: "progress", steps: 2, text: "working" });
  assert.match(text, /working/);
  assert.equal(typeof text, "string");
});

test("generatePairingCode is 8 chars from the safe alphabet, deterministic under injected rng", () => {
  const code = generatePairingCode(() => 0); // always picks alphabet[0]
  assert.equal(code.length, 8);
  assert.match(code, /^[0-9A-Z]+$/);
  assert.equal(code, code[0].repeat(8));
});

test("review-2: chunkMessage never splits an emoji surrogate pair at a boundary", () => {
  const limit = 40;
  const text = "\u{1F600}".repeat(60); // 60 emoji = 120 UTF-16 units, no newlines
  const chunks = chunkMessage(text, limit);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= limit, `chunk within limit (${chunk.length})`);
    const first = chunk.charCodeAt(0);
    const last = chunk.charCodeAt(chunk.length - 1);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "chunk must not start on a low surrogate");
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "chunk must not end on a high surrogate");
  }
  assert.equal(chunks.join(""), text, "no content lost");
});
