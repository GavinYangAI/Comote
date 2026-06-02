// test/channel-registry.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "../src/channels/registry.js";

function plugin(id, extra = {}) {
  return {
    meta: { id, displayName: id, inboundMode: "push", binding: "qr", capabilities: { cards: true, media: false, liveUpdates: false, typing: false }, ...extra },
    createDriver: () => ({}),
    createAdapter: () => ({}),
    createRuntime: () => ({}),
  };
}

test("register + getChannel + listChannels", () => {
  const reg = createRegistry([plugin("feishu"), plugin("wechat", { inboundMode: "poll" })]);
  assert.equal(reg.getChannel("feishu").meta.id, "feishu");
  assert.equal(reg.getChannel("wechat").meta.inboundMode, "poll");
  assert.deepEqual(reg.listChannels().map((p) => p.meta.id).sort(), ["feishu", "wechat"]);
  assert.equal(reg.getChannel("nope"), null);
});

test("rejects a plugin missing required meta or factories", () => {
  assert.throws(() => createRegistry([{ meta: { id: "x" } }]), /factory|meta/i);
  assert.throws(() => createRegistry([plugin("dup"), plugin("dup")]), /duplicate/i);
});
