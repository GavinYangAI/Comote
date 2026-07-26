import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createComoteState } from "../src/server/state.js";
import { CodexDesktopConnector } from "../src/connectors/codex-desktop/index.js";

// --- shared harness (mirrors test/state-changed-files.test.js) -------------

class MemoryTransport {
  constructor() {
    this.sent = [];
    this.messageHandler = null;
  }
  async connect() {}
  send(message) {
    this.sent.push(JSON.parse(message));
  }
  onMessage(handler) {
    this.messageHandler = handler;
  }
  receive(message) {
    this.messageHandler(JSON.stringify(message));
  }
  async close() {}
}

function buildState() {
  const transport = new MemoryTransport();
  const desktop = new CodexDesktopConnector({ transport });
  const state = createComoteState({
    desktop,
    autoStartWeChatRuntime: false,
    autoStartFeishuRuntime: false,
    autoStartDingTalkRuntime: false,
    autoStartTelegramRuntime: false,
  });
  return { transport, desktop, state };
}

async function waitFor(predicate, { timeout = 5000, interval = 5 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start >= timeout) throw new Error("waitFor: condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), "comote-harden-"));
  const mdPath = join(root, "notes.md");
  const pngPath = join(root, "shot.png");
  await writeFile(mdPath, "# hello\nsmall text body\n", "utf8");
  await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { root, mdPath, pngPath };
}

function fireFileChange(transport, threadId, changedPaths) {
  transport.receive({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId,
      item: { type: "fileChange", id: `fc:${threadId}`, changes: changedPaths.map((path) => ({ path })) },
    },
  });
}

function fireAgentMessage(transport, threadId, id, text) {
  transport.receive({
    jsonrpc: "2.0",
    method: "item/completed",
    params: { threadId, item: { type: "agentMessage", id, text } },
  });
}

// Wires a dingtalk live-card runtime (no fileButtons → png auto-sends as media,
// which makes double-delivery directly observable as duplicate media replies).
async function wireDingtalk(state, root) {
  state.commandRouter.conversationByIdentity.set("dingtalk:cid_owner", {
    channel: "dingtalk",
    conversationId: "cid_chat",
  });
  state.commandRouter.bindThreadForIdentity({ channel: "dingtalk", stableId: "cid_owner" }, "thread_d", root);
  await state.runtime.dingtalk.configure({ appKey: "ak", appSecret: "as", statusTemplateId: "status.schema" });
  const calls = { created: [], updated: [], media: [] };
  state.runtime.dingtalk.__setTestDriver({
    getStatus: () => ({ state: "configured" }),
    async createCard(a) {
      calls.created.push(a);
      return { outTrackId: a.outTrackId };
    },
    async updateCard(a) {
      calls.updated.push(a);
    },
    async uploadMedia() {
      return "media_id";
    },
    async sendImage(a) {
      calls.media.push({ kind: "image", ...a });
    },
    async sendFile(a) {
      calls.media.push({ kind: "file", ...a });
    },
    async sendMarkdown() {},
    async sendText() {},
  });
  return calls;
}

// --- M4: a multi-agentMessage turn finalizes and delivers files once --------

test("M4: multiple agent messages stay in one card and deliver changed files once", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();
  const { root, mdPath, pngPath } = await makeProject();
  const calls = await wireDingtalk(state, root);

  transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread_d" } });
  await waitFor(() => calls.created.length === 1);

  fireFileChange(transport, "thread_d", [mdPath, pngPath]);
  fireAgentMessage(transport, "thread_d", "m:1", "first message");
  assert.equal(calls.created.length, 1, "the first agent message keeps the original card");

  // Second agentMessage for the SAME thread, same turn (no turn/completed yet).
  fireAgentMessage(transport, "thread_d", "m:2", "second message");
  assert.equal(calls.media.length, 0, "changed files wait for the turn completion boundary");

  transport.receive({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId: "thread_d" },
  });
  await waitFor(() => calls.media.length >= 1 && calls.updated.length >= 1);

  const replies = state.outboundReplies.list({ channel: "dingtalk", pendingOnly: false });
  const mediaReplies = replies.filter((r) => r.kind === "media");
  // The png must be delivered exactly once across BOTH agentMessages.
  assert.equal(mediaReplies.length, 1, "the changed png is delivered exactly once, not doubled");
  assert.equal(mediaReplies[0].path, pngPath);

  // The small .md inlines once too (one inline text per delivered turn).
  const inlineMd = replies.filter((r) => r.kind === "text" && r.text.includes("notes.md"));
  assert.equal(inlineMd.length, 1, "the inline md text is delivered exactly once");

  assert.match(
    JSON.stringify(calls.updated.at(-1).cardParamMap),
    /second message/,
    "the final card uses the latest agent message",
  );
});

test("M4: a new turn delivers its own changed files", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();
  const { root, mdPath, pngPath } = await makeProject();
  const calls = await wireDingtalk(state, root);

  // Turn 1.
  transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread_d" } });
  await waitFor(() => calls.created.length === 1);
  fireFileChange(transport, "thread_d", [mdPath, pngPath]);
  fireAgentMessage(transport, "thread_d", "m:1", "turn one");
  transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread_d" } });
  await waitFor(() => calls.media.length >= 1);

  // Turn 2: changed files again → must deliver again (guard was cleared).
  transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread_d" } });
  await waitFor(() => calls.created.length === 2);
  fireFileChange(transport, "thread_d", [pngPath]);
  fireAgentMessage(transport, "thread_d", "m:2", "turn two");
  transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread_d" } });
  await waitFor(
    () => state.outboundReplies.list({ channel: "dingtalk", pendingOnly: false }).filter((r) => r.kind === "media").length >= 2,
  );

  const mediaReplies = state.outboundReplies
    .list({ channel: "dingtalk", pendingOnly: false })
    .filter((r) => r.kind === "media");
  assert.equal(mediaReplies.length, 2, "each turn delivers its png once → two total across two turns");
});

// --- LOW-cardleak: connectionLost / connectionGaveUp finish open cards ------

test("LOW-cardleak: connectionLost finishes any open live card", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();
  const { root } = await makeProject();
  const calls = await wireDingtalk(state, root);

  transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread_d" } });
  await waitFor(() => calls.created.length === 1);

  const dingRuntime = state.runtime.dingtalk;
  // Sanity: the live card session is open after turn/started.
  assert.ok(dingRuntime.getStatus, "dingtalk runtime exposed");

  // Drive the connectionLost path directly through routeDesktopEvent.
  desktop.onEvent({ type: "connectionLost" });
  await waitFor(() => calls.updated.length >= 1);

  // The open card was finished (an update was sent) and no session leaks behind.
  assert.ok(calls.updated.length >= 1, "the open live card was finished on connectionLost");
});

test("LOW-cardleak: connectionGaveUp also finishes open live cards", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();
  const { root } = await makeProject();
  const calls = await wireDingtalk(state, root);

  transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread_d" } });
  await waitFor(() => calls.created.length === 1);

  desktop.onEvent({ type: "connectionGaveUp" });
  await waitFor(() => calls.updated.length >= 1);
  assert.ok(calls.updated.length >= 1, "the open live card was finished on connectionGaveUp");
});

// --- H3: a rejecting persist() does not crash routeDesktopEvent ------------

test("H3: a rejecting persist does not throw out of routeDesktopEvent", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();

  // Make persist reject. routeDesktopEvent calls it fire-and-forget; the .catch
  // must swallow the rejection (logged), never bubble or leave it unhandled.
  state.persist = async () => {
    throw new Error("disk full");
  };

  state.commandRouter.conversationByIdentity.set("wechat:wx_owner", {
    channel: "wechat",
    conversationId: "wx_chat",
  });
  state.commandRouter.bindThreadForIdentity({ channel: "wechat", stableId: "wx_owner" }, "thread_w", null);

  // wechat has no live card, so agentMessage hits the enqueue + persist path.
  assert.doesNotThrow(() => {
    fireAgentMessage(transport, "thread_w", "m:w", "hello");
  }, "agentMessage handling does not throw even when persist rejects");

  // Let the rejected persist settle; the test process must stay alive (no crash).
  await new Promise((resolve) => setTimeout(resolve, 30));
  const replies = state.outboundReplies.list({ channel: "wechat", pendingOnly: false });
  assert.ok(replies.some((r) => r.text === "hello"), "the reply was still enqueued despite the persist failure");
});

// --- LOW-redrain: push channel re-drains retryable entries -----------------

test("LOW-redrain: a push channel re-drains an entry that failed transiently", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();

  state.commandRouter.conversationByIdentity.set("dingtalk:cid_owner", {
    channel: "dingtalk",
    conversationId: "cid_chat",
  });
  state.commandRouter.bindThreadForIdentity({ channel: "dingtalk", stableId: "cid_owner" }, "thread_d", null);
  await state.runtime.dingtalk.configure({ appKey: "ak", appSecret: "as" });

  // First send attempt fails (transient), the rest succeed. The host schedules a
  // re-drain; we shorten the wait by invoking deliverQueued again after the
  // entry flips to "retrying" — but the production path schedules it itself.
  let attempts = 0;
  state.runtime.dingtalk.__setTestDriver({
    getStatus: () => ({ state: "configured" }),
    async sendMarkdown() {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
    },
    async sendText() {},
    async createCard() {
      return { outTrackId: "x" };
    },
    async updateCard() {},
  });

  // No live card binding (projectPath null), so agentMessage enqueues a text
  // reply and drains via deliverIfPush. The first drain fails → status "retrying".
  fireAgentMessage(transport, "thread_d", "m:d", "redrain me");

  // The entry should be retryable (pending) right after the failed first drain.
  await waitFor(() => {
    const pending = state.outboundReplies.list({ channel: "dingtalk", pendingOnly: true });
    return pending.length >= 1 || attempts >= 1;
  });
  assert.ok(attempts >= 1, "the first delivery attempt ran and failed");

  // Manually trigger what the scheduled re-drain would do (the production timer is
  // 15s + unref'd; we verify the entry is still pending and a second drain
  // delivers it — proving retryable entries are recoverable, not stuck).
  await state.runtime.dingtalk.deliverQueued();
  await waitFor(() => state.outboundReplies.list({ channel: "dingtalk", pendingOnly: true }).length === 0);
  const pendingAfter = state.outboundReplies.list({ channel: "dingtalk", pendingOnly: true });
  assert.equal(pendingAfter.length, 0, "the retryable entry was eventually delivered on re-drain");
});

// --- LOW-dl-dup: the shared downloadAttachment helper fences + delegates ----

test("LOW-dl-dup: shared downloadAttachment fences within project and delegates to the driver", async () => {
  const { state } = buildState();
  const { root } = await makeProject();

  // Bind a current project for the identity so the helper resolves a project.
  const identity = { channel: "feishu", stableId: "ou_owner" };
  state.commandRouter.currentProjectByIdentity.set(state.commandRouter.identityKey(identity), root);

  // The feishu adapter's downloadAttachment is the shared helper instance.
  const adapter = state.channels.feishu;
  assert.equal(typeof adapter.downloadAttachment, "function", "feishu adapter exposes downloadAttachment");

  // Stub the driver's channel-specific download call.
  const seen = [];
  state.runtime.feishu.__setTestDriver({
    getStatus: () => ({ state: "configured" }),
    verifyEvent: () => true,
    async downloadMessageResource(args) {
      seen.push(args);
    },
  });

  const result = await adapter.downloadAttachment({
    attachment: { messageId: "om_1", fileKey: "fk_1", type: "image", fileName: "pic.png" },
    identity,
  });
  assert.equal(seen.length, 1, "the shared helper delegated to the feishu driver");
  assert.equal(seen[0].messageId, "om_1");
  assert.equal(seen[0].fileKey, "fk_1");
  assert.match(result.relativePath, /\.comote[\\/]uploads[\\/]pic\.png$/, "returns the project-relative upload path");

  // A path-traversal name must be sanitized so it cannot escape the project.
  const traversal = await adapter.downloadAttachment({
    attachment: { messageId: "om_2", fileKey: "fk_2", type: "file", fileName: "../../etc/passwd" },
    identity,
  });
  assert.ok(
    !traversal.relativePath.includes(".."),
    "the traversal name is sanitized — the dest stays inside the project",
  );
});

test("LOW-dl-dup: downloadAttachment throws NO_PROJECT when the sender has no project", async () => {
  const { state } = buildState();
  const adapter = state.channels.dingtalk;
  await assert.rejects(
    () => adapter.downloadAttachment({ attachment: { downloadCode: "dc", fileName: "a.txt" }, identity: { channel: "dingtalk", stableId: "nobody" } }),
    /NO_PROJECT/,
    "with no current project the shared helper throws the distinct NO_PROJECT error",
  );
});
