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

test("push start that errors synchronously on connect is not left 'running'", async () => {
  const queue = new OutboundQueue();
  const runtime = new BaseChannelRuntime({
    channelId: "test", inboundMode: "push",
    adapter: { handleInbound: async () => {} }, outboundQueue: queue,
    renderer: { render: async () => {} },
    driver: {
      getStatus: () => ({ state: "configured" }),
      startEventStream: async ({ onError }) => { onError(new Error("auth failed")); return { ok: false }; },
      stopEventStream: () => {},
    },
  });
  await runtime.start();
  assert.equal(runtime.running, false);
  assert.match(runtime.lastError, /auth failed/);
});

test("poll mode pollOnce fetches, dedups, routes, delivers, advances cursor", async () => {
  const handled = [];
  const rendered = [];
  const queue = new OutboundQueue();
  const updates = [{ raw: 1 }, { raw: 2 }, { raw: 1 }]; // third is a duplicate by id
  const runtime = new BaseChannelRuntime({
    channelId: "test",
    inboundMode: "poll",
    adapter: {
      handleInbound: async (payload) => {
        handled.push(payload.message.id);
        queue.enqueue({ channel: "test", conversationId: "c1", kind: "text", text: `r${payload.message.id}`, dedupeKey: `t:${payload.message.id}` });
      },
    },
    outboundQueue: queue,
    renderer: { render: async (r) => rendered.push(r.text) },
    driver: {
      getStatus: () => ({ state: "configured" }),
      fetchUpdates: async () => ({ updates, nextCursor: "cur2" }),
      normalizeUpdate: (u) => ({ message: { id: String(u.raw) } }),
    },
  });
  const result = await runtime.pollOnce();
  assert.equal(result.inbound, 2);        // duplicate id "1" skipped
  assert.equal(runtime.cursor, "cur2");
  assert.deepEqual(handled, ["1", "2"]);
  assert.deepEqual(rendered.sort(), ["r1", "r2"]);
});

test("pollOnce guards against overlapping runs", async () => {
  const queue = new OutboundQueue();
  const runtime = new BaseChannelRuntime({
    channelId: "test", inboundMode: "poll",
    adapter: { handleInbound: async () => {} }, outboundQueue: queue,
    renderer: { render: async () => {} },
    driver: { getStatus: () => ({}), fetchUpdates: async () => ({ updates: [], nextCursor: null }), normalizeUpdate: (u) => u },
  });
  runtime._polling = true; // simulate an in-flight poll
  const result = await runtime.pollOnce();
  assert.equal(result.skipped, true);
});

test("pollOnce throws when no driver configured", async () => {
  const queue = new OutboundQueue();
  const runtime = new BaseChannelRuntime({
    channelId: "test", inboundMode: "poll",
    adapter: { handleInbound: async () => {} }, outboundQueue: queue,
    renderer: { render: async () => {} }, driver: null,
  });
  await assert.rejects(() => runtime.pollOnce(), /driver is not configured/);
});

test("handleInbound routes through adapter then drains the queue", async () => {
  const { runtime, queue, rendered } = makeRuntime();
  runtime.adapter.handleInbound = async () => { queue.enqueue({ channel: "test", conversationId: "c1", kind: "text", text: "z", dedupeKey: "t:z" }); };
  await runtime.handleInbound({ id: "x" });
  assert.deepEqual(rendered.map((r) => r.text), ["z"]);
});

test("pollOnce calls _handleFetchError on a fetch failure (override point)", async () => {
  const queue = new OutboundQueue();
  const seen = [];
  class Sub extends BaseChannelRuntime {
    _handleFetchError(error) { seen.push(error.message); this.stop(); }
  }
  const runtime = new Sub({
    channelId: "test", inboundMode: "poll",
    adapter: { handleInbound: async () => {} }, outboundQueue: queue,
    renderer: { render: async () => {} },
    driver: { getStatus: () => ({}), fetchUpdates: async () => { throw new Error("auth failed"); }, normalizeUpdate: (u) => u },
  });
  await assert.rejects(() => runtime.pollOnce(), /auth failed/);
  assert.deepEqual(seen, ["auth failed"]);
});
