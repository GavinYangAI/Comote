import test from "node:test";
import assert from "node:assert/strict";
import { encodeCallback, decodeCallback, filesKeyboard } from "../src/channels/telegram/cards.js";

test("pushfile callback round-trips threadId + index within 64 bytes", () => {
  const data = encodeCallback({ action: "pushfile", threadId: "t-abc-123", fileIndex: 2 });
  assert.ok(Buffer.byteLength(data, "utf8") <= 64);
  assert.deepEqual(decodeCallback(data), { action: "pushfile", threadId: "t-abc-123", fileIndex: 2 });
});

test("filesKeyboard renders one button per file with pushfile callbacks", () => {
  const kb = filesKeyboard("t1", [{ path: "/p/a.png", name: "a.png" }, { path: "/p/b.zip", name: "b.zip" }]);
  const rows = kb.inline_keyboard;
  assert.equal(rows.length, 2);
  assert.match(rows[0][0].text, /a\.png/);
  assert.equal(decodeCallback(rows[0][0].callback_data).fileIndex, 0);
  assert.equal(decodeCallback(rows[1][0].callback_data).fileIndex, 1);
});
