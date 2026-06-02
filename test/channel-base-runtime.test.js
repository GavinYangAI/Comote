import test from "node:test";
import assert from "node:assert/strict";
import { BaseChannelRuntime } from "../src/channels/base/runtime.js";
import { OutboundQueue } from "../src/core/outbound-queue.js";

function makeRuntime(overrides = {}) {
  const rendered = [];
  const queue = new OutboundQueue();
  const runtime = new BaseChannelRuntime({
    channelId: "test",
    inboundMode: "push",
    adapter: { handleInbound: async () => ({}) },
    outboundQueue: queue,
    renderer: { render: async (reply) => { rendered.push(reply); } },
    driver: { startEventStream: async () => ({ ok: true }), stopEventStream: () => {} },
    ...overrides,
  });
  return { runtime, queue, rendered };
}

test("deliverQueued renders each queued reply for this channel and marks delivered", async () => {
  const { runtime, queue, rendered } = makeRuntime();
  queue.enqueue({ channel: "test", conversationId: "c1", kind: "text", text: "a", dedupeKey: "t:a" });
  queue.enqueue({ channel: "other", conversationId: "c1", kind: "text", text: "b", dedupeKey: "t:b" });
  const result = await runtime.deliverQueued();
  assert.equal(result.outbound, 1);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].text, "a");
  assert.deepEqual(queue.list({ channel: "test" }), []);
});

test("deliverQueued coalesces concurrent re-entry (no double render)", async () => {
  const { runtime, queue, rendered } = makeRuntime();
  let reentered = false;
  runtime.renderer.render = async (reply) => {
    rendered.push(reply.text);
    if (!reentered) { reentered = true; await runtime.deliverQueued().catch(() => {}); }
  };
  queue.enqueue({ channel: "test", conversationId: "c1", kind: "text", text: "x", dedupeKey: "t:x" });
  await runtime.deliverQueued();
  assert.deepEqual(rendered, ["x"]);
});

test("a render failure marks the entry failed and continues", async () => {
  const { runtime, queue } = makeRuntime();
  runtime.renderer.render = async () => { throw new Error("boom"); };
  queue.enqueue({ channel: "test", conversationId: "c1", kind: "text", text: "a", dedupeKey: "t:a" });
  const result = await runtime.deliverQueued();
  assert.equal(result.outbound, 0);
  assert.doesNotThrow(() => queue.snapshot());
});

test("deliverQueued throws when no driver configured", async () => {
  const { runtime } = makeRuntime({ driver: null });
  await assert.rejects(() => runtime.deliverQueued(), /driver is not configured/);
});

test("push mode start wires the driver event stream; inbound routes + delivers", async () => {
  let handlers = null;
  const handled = [];
  const rendered = [];
  const queue = new OutboundQueue();
  const runtime = new BaseChannelRuntime({
    channelId: "test",
    inboundMode: "push",
    adapter: {
      handleInbound: async (payload) => {
        handled.push(payload);
        queue.enqueue({ channel: "test", conversationId: "c1", kind: "text", text: "reply", dedupeKey: `t:${payload.id}` });
      },
    },
    outboundQueue: queue,
    renderer: { render: async (r) => rendered.push(r.text) },
    driver: {
      getStatus: () => ({ state: "configured" }),
      startEventStream: async (h) => { handlers = h; return { ok: true }; },
      stopEventStream: () => {},
    },
  });
  await runtime.start();
  assert.equal(runtime.getStatus().state, "running");
  await handlers.onEvent({ id: "m1" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(handled.length, 1);
  assert.deepEqual(rendered, ["reply"]);
  runtime.stop();
  assert.equal(runtime.running, false);
});

test("push start is a no-op without a driver", async () => {
  const queue = new OutboundQueue();
  const runtime = new BaseChannelRuntime({
    channelId: "test", inboundMode: "push",
    adapter: { handleInbound: async () => ({}) },
    outboundQueue: queue, renderer: { render: async () => {} }, driver: null,
  });
  await runtime.start();
  assert.equal(runtime.running, false);
});
