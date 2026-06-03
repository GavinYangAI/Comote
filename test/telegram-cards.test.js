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
} from "../src/channels/telegram/cards.js";

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

test("generatePairingCode is 6 chars from the safe alphabet, deterministic under injected rng", () => {
  const code = generatePairingCode(() => 0); // always picks alphabet[0]
  assert.equal(code.length, 6);
  assert.match(code, /^[0-9A-Z]+$/);
  assert.equal(code, code[0].repeat(6));
});
