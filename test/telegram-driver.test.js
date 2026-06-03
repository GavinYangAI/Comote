// test/telegram-driver.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { TelegramDriver } from "../src/channels/telegram/driver.js";

function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
    return responder(url, opts, calls.length);
  };
  fn.calls = calls;
  return fn;
}
const okJson = (result) => ({ ok: true, json: async () => ({ ok: true, result }) });

test("constructor requires botToken + fetch", () => {
  assert.throws(() => new TelegramDriver({}), /botToken/);
  assert.throws(() => new TelegramDriver({ botToken: "T", fetchImpl: null }), /fetch/);
});

test("sendMessage POSTs to the bot method with chat_id + text", async () => {
  const fetchImpl = fakeFetch(() => okJson({ message_id: 7 }));
  const d = new TelegramDriver({ botToken: "T", fetchImpl });
  const res = await d.sendMessage({ chatId: "123", text: "hi" });
  assert.equal(res.message_id, 7);
  assert.match(fetchImpl.calls[0].url, /\/botT\/sendMessage$/);
  assert.equal(fetchImpl.calls[0].body.chat_id, "123");
  assert.equal(fetchImpl.calls[0].body.text, "hi");
});

test("sendMessage includes reply_markup + parse_mode only when provided", async () => {
  const fetchImpl = fakeFetch(() => okJson({}));
  const d = new TelegramDriver({ botToken: "T", fetchImpl });
  await d.sendMessage({ chatId: "1", text: "x", parseMode: "HTML", replyMarkup: { inline_keyboard: [] } });
  assert.equal(fetchImpl.calls[0].body.parse_mode, "HTML");
  assert.deepEqual(fetchImpl.calls[0].body.reply_markup, { inline_keyboard: [] });
  await d.sendMessage({ chatId: "1", text: "y" });
  assert.equal("parse_mode" in fetchImpl.calls[1].body, false);
  assert.equal("reply_markup" in fetchImpl.calls[1].body, false);
});

test("_call throws on Telegram ok:false and tags error_code", async () => {
  const fetchImpl = fakeFetch(() => ({ ok: true, json: async () => ({ ok: false, error_code: 401, description: "Unauthorized" }) }));
  const d = new TelegramDriver({ botToken: "T", fetchImpl });
  await assert.rejects(() => d.sendMessage({ chatId: "1", text: "x" }), (e) => e.code === 401 && /Unauthorized/.test(e.message));
});

test("editMessageText + answerCallbackQuery hit the right methods", async () => {
  const fetchImpl = fakeFetch(() => okJson(true));
  const d = new TelegramDriver({ botToken: "T", fetchImpl });
  await d.editMessageText({ chatId: "1", messageId: 5, text: "z" });
  assert.match(fetchImpl.calls[0].url, /editMessageText$/);
  assert.equal(fetchImpl.calls[0].body.message_id, 5);
  await d.answerCallbackQuery({ callbackQueryId: "cq1" });
  assert.match(fetchImpl.calls[1].url, /answerCallbackQuery$/);
  assert.equal(fetchImpl.calls[1].body.callback_query_id, "cq1");
});

test("getUpdates loop dispatches messages to onEvent + callback_query to onAction, advancing offset", async () => {
  const update = { update_id: 100, message: { message_id: 1, chat: { id: 9, type: "private" }, from: { id: 9 }, text: "hi" } };
  const cbUpdate = { update_id: 101, callback_query: { id: "cq", data: "ap:X", message: { chat: { id: 9 } }, from: { id: 9 } } };
  const fetchImpl = fakeFetch((url, opts, n) => {
    if (url.endsWith("/getUpdates")) return okJson(n === 1 ? [update, cbUpdate] : []);
    return okJson(true);
  });
  const d = new TelegramDriver({ botToken: "T", fetchImpl, longPollSeconds: 0 });
  const events = [], actions = [];
  await d.startEventStream({
    onEvent: async (u) => { events.push(u); },
    onAction: async (cq) => { actions.push(cq); d.stopEventStream(); }, // stop after the callback
  });
  await d._loopPromise;
  assert.equal(events.length, 1);
  assert.equal(events[0].message.text, "hi");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].data, "ap:X");
  assert.equal(d.offset, 102); // max(update_id)+1
});

test("loop calls onError + stops on a fatal 401", async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith("/getUpdates")) return { ok: true, json: async () => ({ ok: false, error_code: 401, description: "Unauthorized" }) };
    return okJson(true);
  });
  const d = new TelegramDriver({ botToken: "T", fetchImpl, longPollSeconds: 0 });
  let err = null;
  await d.startEventStream({ onEvent: async () => {}, onError: (e) => { err = e; } });
  await d._loopPromise;
  assert.ok(err && err.code === 401);
  assert.equal(d.running, false);
});

test("downloadAttachment resolves file_path then fetches the file bytes", async () => {
  const fetchImpl = fakeFetch((url) => {
    if (url.endsWith("/getFile")) return okJson({ file_path: "photos/p.jpg" });
    return { ok: true, arrayBuffer: async () => new TextEncoder().encode("BYTES").buffer };
  });
  const d = new TelegramDriver({ botToken: "T", fetchImpl });
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "tg-"));
  const dest = join(dir, "out.jpg");
  const out = await d.downloadAttachment({ downloadCode: "FID", destPath: dest });
  assert.equal(out, dest);
  const { readFile } = await import("node:fs/promises");
  assert.equal((await readFile(dest)).toString(), "BYTES");
  assert.match(fetchImpl.calls[1].url, /\/file\/botT\/photos\/p\.jpg$/);
});
