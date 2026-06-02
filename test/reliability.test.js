import assert from "node:assert/strict";
import test from "node:test";

import { JsonRpcClient } from "../src/connectors/codex-desktop/json-rpc.js";
import { CodexDesktopConnector } from "../src/connectors/codex-desktop/index.js";
import { WeChatRuntimeService } from "../src/channels/wechat/runtime.js";

class ControllableTransport {
  constructor() {
    this.sent = [];
    this.messageHandler = null;
    this.closeHandler = null;
  }
  async connect() {}
  send(message) {
    this.sent.push(JSON.parse(message));
  }
  onMessage(handler) {
    this.messageHandler = handler;
  }
  onClose(handler) {
    this.closeHandler = handler;
  }
  receive(message) {
    this.messageHandler(JSON.stringify(message));
  }
  drop() {
    this.closeHandler?.();
  }
  async close() {}
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a request rejects on timeout instead of hanging forever", async () => {
  const client = new JsonRpcClient({ transport: new ControllableTransport(), requestTimeoutMs: 25 });
  // The request's timeout timer is unref'd (production-correct); hold the
  // event loop open so the test can observe it firing.
  const keepAlive = setTimeout(() => {}, 1000);
  await assert.rejects(client.request("thread/list", {}), /请求超时/);
  clearTimeout(keepAlive);
});

test("a dropped connection rejects in-flight requests and notifies the owner", async () => {
  const transport = new ControllableTransport();
  const client = new JsonRpcClient({ transport });
  let closed = false;
  client.onClose(() => {
    closed = true;
  });
  const pending = client.request("thread/list", {});
  await flush();
  transport.drop();
  await assert.rejects(pending, /连接已断开/);
  assert.equal(closed, true);
});

test("connector enters reconnecting state and emits connectionLost when the socket drops", async () => {
  const transport = new ControllableTransport();
  const connector = new CodexDesktopConnector({ transport });
  const events = [];
  connector.onEvent = (event) => events.push(event.type);
  await connector.client.connect();

  transport.drop();

  assert.equal(connector.state, "reconnecting");
  assert.ok(events.includes("connectionLost"));
  clearTimeout(connector.reconnectTimer); // don't let the background retry run during the suite
});

test("connector emits throttleable progress events and captures token usage", async () => {
  const transport = new ControllableTransport();
  const connector = new CodexDesktopConnector({ transport });
  const events = [];
  connector.onEvent = (event) => events.push(event);
  await connector.client.connect();

  transport.receive({
    jsonrpc: "2.0",
    method: "item/started",
    params: { threadId: "t1", item: { type: "commandExecution", id: "i1" } },
  });
  transport.receive({
    jsonrpc: "2.0",
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "t1",
      turnId: "u1",
      tokenUsage: { total: { totalTokens: 1234 }, last: { totalTokens: 200 } },
    },
  });

  assert.ok(events.some((event) => event.type === "progress" && event.threadId === "t1"));
  assert.equal(connector.getUsage().tokenUsage.total.totalTokens, 1234);
});

test("wechat runtime ignores a re-delivered message instead of re-routing it", async () => {
  const routed = [];
  const runtime = new WeChatRuntimeService({
    adapter: { handleInbound: async (payload) => routed.push(payload) },
    outboundQueue: { list: () => [] },
    driver: {
      getStatus: () => ({ state: "configured" }),
      // Every poll returns the same message — the cursor never advances past it.
      fetchUpdates: async () => ({ updates: [{ raw: 1 }], nextCursor: "c1" }),
      normalizeUpdate: () => ({ message: { id: "msg_1", text: "暂停" }, peer: {}, conversation: {} }),
    },
  });
  await runtime.pollOnce();
  await runtime.pollOnce();
  await runtime.pollOnce();
  assert.equal(routed.length, 1);
});

test("wechat runtime does not run overlapping polls", async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const runtime = new WeChatRuntimeService({
    adapter: { handleInbound: async () => {} },
    outboundQueue: { list: () => [] },
    driver: {
      getStatus: () => ({ state: "configured" }),
      fetchUpdates: async () => {
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return { updates: [], nextCursor: null };
      },
      normalizeUpdate: (update) => update,
    },
  });
  const [, second] = await Promise.all([runtime.pollOnce(), runtime.pollOnce()]);
  assert.equal(maxConcurrent, 1);
  assert.equal(second.skipped, true);
});

test("wechat runtime flags needsRelogin and stops polling on an auth error", async () => {
  const runtime = new WeChatRuntimeService({
    adapter: { handleInbound: async () => {} },
    outboundQueue: { list: () => [] },
    driver: {
      getStatus: () => ({ state: "configured" }),
      fetchUpdates: async () => {
        throw new Error("WeChat API ilink/bot/getupdates failed: 401 unauthorized");
      },
    },
  });

  await assert.rejects(runtime.pollOnce(), /401/);
  assert.equal(runtime.getStatus().needsRelogin, true);
});
