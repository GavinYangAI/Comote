import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createComoteState } from "../src/server/state.js";
import { CodexDesktopConnector } from "../src/connectors/codex-desktop/index.js";
import { setLocale } from "../src/core/i18n/index.js";

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
  });
  return { transport, desktop, state };
}

test("Codex agent output is routed back to the originating WeChat conversation", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();

  // Bind a Codex thread to a WeChat conversation, as the router does when a
  // phone user starts or resumes a session.
  state.commandRouter.conversationByIdentity.set("wechat:acct:peer", {
    channel: "wechat",
    conversationId: "dm_peer",
    accountId: "acct",
  });
  state.commandRouter.bindThreadForIdentity({ channel: "wechat", stableId: "acct:peer" }, "thread_42");

  transport.receive({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: "thread_42",
      item: { type: "agentMessage", id: "item_1", text: "all tests pass" },
    },
  });

  const queued = state.outboundReplies.list({ channel: "wechat" });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].conversationId, "dm_peer");
  assert.equal(queued[0].accountId, "acct");
  assert.equal(queued[0].text, "all tests pass");
});

test("Codex approval requests are pushed to the phone with a short code", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();

  state.commandRouter.conversationByIdentity.set("wechat:acct:peer", {
    channel: "wechat",
    conversationId: "dm_peer",
    accountId: "acct",
  });
  state.commandRouter.bindThreadForIdentity({ channel: "wechat", stableId: "acct:peer" }, "thread_42");

  transport.receive({
    jsonrpc: "2.0",
    method: "item/commandExecution/requestApproval",
    id: "rpc_1",
    params: { threadId: "thread_42", command: "rm -rf build", cwd: "/repo" },
  });

  // routeDesktopEvent now enqueues a channel-neutral SEMANTIC approval reply;
  // the text rendering (请求审批 / rm -rf build / /approve a1) is exercised by
  // the wechat-renderer test. Here we assert the semantic shape.
  const queued = state.outboundReplies.list({ channel: "wechat" });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "approval");
  assert.equal(queued[0].code, "a1");
});

test("auto mode approves the request and still queues a buttonless notification", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();

  state.commandRouter.conversationByIdentity.set("wechat:acct:peer", {
    channel: "wechat",
    conversationId: "dm_peer",
    accountId: "acct",
  });
  state.commandRouter.bindThreadForIdentity({ channel: "wechat", stableId: "acct:peer" }, "thread_auto");
  state.commandRouter.autoModeThreads.add("thread_auto");

  transport.receive({
    jsonrpc: "2.0",
    method: "item/commandExecution/requestApproval",
    id: "rpc_auto",
    params: { threadId: "thread_auto", command: "npm test", cwd: "/repo" },
  });
  await tick();

  const queued = state.outboundReplies.list({ channel: "wechat" });
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "approval");
  assert.equal(queued[0].autoApproved, true);
  assert.deepEqual(transport.sent.at(-1), {
    jsonrpc: "2.0",
    id: "rpc_auto",
    result: { decision: "accept" },
  });
  assert.deepEqual(desktop.listPendingApprovals(), []);
});

test("agent output for an unbound thread is logged but not delivered", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();

  transport.receive({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: "thread_unknown",
      item: { type: "agentMessage", id: "item_1", text: "orphan output" },
    },
  });

  assert.equal(state.outboundReplies.list({ channel: "wechat" }).length, 0);
  assert.ok(state.eventLog.list().some((entry) => /找不到对应会话/.test(entry.message)));
});

test("Codex streaming for a Feishu thread drives a live card", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();

  // Bind a Codex thread to a Feishu conversation.
  state.commandRouter.conversationByIdentity.set("feishu:ou_owner", {
    channel: "feishu",
    conversationId: "oc_chat",
  });
  state.commandRouter.bindThreadForIdentity(
    { channel: "feishu", stableId: "ou_owner" },
    "thread_f",
  );

  // Capture driver card calls by swapping in a fake driver.
  const calls = { sent: [], updated: [] };
  state.runtime.feishu.__setTestDriver({
    getStatus: () => ({ state: "configured" }),
    verifyEvent: () => true,
    async sendCard(message) {
      calls.sent.push(message);
      return { messageId: "om_live" };
    },
    async updateCard(message) {
      calls.updated.push(message);
      return { code: 0 };
    },
  });

  transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread_f" } });
  await tick();
  assert.equal(calls.sent.length, 1, "turn start opens a card");

  transport.receive({
    jsonrpc: "2.0",
    method: "item/started",
    params: {
      threadId: "thread_f",
      item: { type: "commandExecution", id: "cmd1", command: "npm test" },
    },
  });
  await tick();

  transport.receive({
    jsonrpc: "2.0",
    method: "item/updated",
    params: { threadId: "thread_f", item: { type: "agentMessage", id: "i1", text: "half" } },
  });
  await tick();
  transport.receive({
    jsonrpc: "2.0",
    method: "item/completed",
    params: { threadId: "thread_f", item: { type: "agentMessage", id: "i1", text: "final answer" } },
  });
  await tick();
  assert.equal(calls.sent.length, 1, "an agent message does not create a replacement card");
  transport.receive({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread_f" } });
  await tick();

  const lastUpdate = calls.updated.at(-1);
  assert.ok(lastUpdate, "the card was updated");
  assert.ok(
    JSON.stringify(lastUpdate.card).includes("final answer"),
    "final card carries the completed answer",
  );
  assert.ok(
    JSON.stringify(lastUpdate.card).includes("npm"),
    "final card keeps the tool summary in the same message",
  );
  // Feishu streaming must not also enqueue chunked text.
  assert.equal(state.outboundReplies.list({ channel: "feishu" }).length, 0);
});

// Lets queued microtasks (the async card calls) settle.
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

async function waitFor(predicate, { timeout = 5000, interval = 5 } = {}) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeout) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

test("completed card includes push buttons for changed files", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();

  // A real temp project root with an in-project image (becomes a button) and a
  // sibling dir OUTSIDE the root that shares the root's string prefix.
  const root = await mkdtemp(join(tmpdir(), "comote-proj-"));
  const evil = `${root}-evil`;
  await mkdir(join(root, "out"), { recursive: true });
  await mkdir(evil, { recursive: true });
  const inProjectPng = join(root, "out", "a.png");
  const evilPng = join(evil, "x.png");
  await writeFile(inProjectPng, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(evilPng, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  // Bind a Codex thread to a Feishu conversation with a known project root.
  state.commandRouter.conversationByIdentity.set("feishu:ou_owner", {
    channel: "feishu",
    conversationId: "oc_chat",
  });
  state.commandRouter.bindThreadForIdentity(
    { channel: "feishu", stableId: "ou_owner" },
    "thread_f",
    root,
  );

  // finishThreadCard sends the final card through driver.updateCard — capture it.
  const calls = { sent: [], updated: [] };
  state.runtime.feishu.__setTestDriver({
    getStatus: () => ({ state: "configured" }),
    verifyEvent: () => true,
    async sendCard(message) {
      calls.sent.push(message);
      return { messageId: "om_live" };
    },
    async updateCard(message) {
      calls.updated.push(message);
      return { code: 0 };
    },
  });

  // Open the active thread card.
  transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread_f" } });
  await tick();

  // Codex changes files during the turn: one in-project, one OUTSIDE the root
  // (a sibling dir that shares the root's string prefix).
  transport.receive({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: "thread_f",
      item: {
        type: "fileChange",
        id: "fc1",
        changes: [{ path: inProjectPng }, { path: evilPng }],
      },
    },
  });

  // The agent reply arrives before turn/completed. It updates the live card but
  // must not close it because another agent item or approval can still follow.
  transport.receive({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: "thread_f",
      item: { type: "agentMessage", id: "m1", text: "all done" },
    },
  });
  await tick();
  assert.equal(calls.sent.length, 1, "the live turn still owns its original card");

  // turn/completed is the sole completion boundary and adds the file buttons.
  transport.receive({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId: "thread_f" },
  });
  await tick();

  const finalCard = calls.updated.at(-1)?.card;
  assert.ok(finalCard, "the completion card was sent");
  const buttons = finalCard.elements
    .filter((el) => el.tag === "action")
    .flatMap((el) => el.actions);
  const pushButtons = buttons.filter((b) => b.value?.kind === "pushfile");
  assert.equal(pushButtons.length, 1, "only the in-project file renders a pushfile button");
  assert.equal(pushButtons[0].value.path, inProjectPng);
  // The out-of-project sibling path must NOT produce a button.
  assert.ok(
    !pushButtons.some((b) => b.value.path === evilPng),
    "out-of-project path must be excluded",
  );
});

test("a Codex approval for a Feishu thread is delivered as a card", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();

  state.commandRouter.conversationByIdentity.set("feishu:ou_owner", {
    channel: "feishu",
    conversationId: "oc_chat",
  });
  state.commandRouter.bindThreadForIdentity(
    { channel: "feishu", stableId: "ou_owner" },
    "thread_f",
  );

  const calls = { sent: [], updated: [] };
  state.runtime.feishu.__setTestDriver({
    getStatus: () => ({ state: "configured" }),
    verifyEvent: () => true,
    async sendCard(message) {
      calls.sent.push(message);
      return { messageId: "om_approval" };
    },
    async updateCard(message) {
      calls.updated.push(message);
    },
  });

  transport.receive({
    jsonrpc: "2.0",
    method: "item/commandExecution/requestApproval",
    id: "rpc_1",
    params: { threadId: "thread_f", command: "rm -rf build", cwd: "/repo" },
  });
  await tick();

  assert.equal(calls.sent.length, 1);
  const action = calls.sent[0].card.elements.find((el) => el.tag === "action");
  assert.deepEqual(action.actions.map((b) => b.value.decision), ["accept", "acceptForSession", "decline"]);

  await desktop.resolveApproval("a1", "acceptForSession");
  await tick();

  assert.equal(calls.updated.length, 1, "the original approval card was edited in place");
  assert.equal(calls.updated[0].messageId, "om_approval");
  const resolvedActions = calls.updated[0].card.elements.find((el) => el.tag === "action").actions;
  assert.equal(resolvedActions.length, 1);
  assert.equal(resolvedActions[0].type, "primary");
  assert.equal("value" in resolvedActions[0], false);

  const approvalLogs = state.eventLog.list({ limit: 20 }).filter((entry) => entry.message.includes("审批 a1"));
  assert.equal(approvalLogs.length, 1);
  assert.match(approvalLogs[0].message, /本次会话/);
  assert.doesNotMatch(approvalLogs[0].message, /拒绝/);
});

test("a live Feishu turn shows approval and resumes work in the same card", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();
  state.commandRouter.conversationByIdentity.set("feishu:ou_owner", {
    channel: "feishu",
    conversationId: "oc_chat",
  });
  state.commandRouter.bindThreadForIdentity(
    { channel: "feishu", stableId: "ou_owner" },
    "thread_live_approval",
  );

  const calls = { sent: [], updated: [] };
  state.runtime.feishu.__setTestDriver({
    getStatus: () => ({ state: "configured" }),
    verifyEvent: () => true,
    async sendCard(message) {
      calls.sent.push(message);
      return { messageId: "om_one_message" };
    },
    async updateCard(message) {
      calls.updated.push(message);
      return { code: 0 };
    },
  });

  transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread_live_approval" } });
  await tick();
  transport.receive({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: "thread_live_approval",
      item: { type: "agentMessage", id: "commentary_1", text: "I will inspect the pull request first." },
    },
  });
  await tick();
  assert.equal(calls.sent.length, 1, "commentary keeps using the original live card");
  transport.receive({
    jsonrpc: "2.0",
    method: "item/commandExecution/requestApproval",
    id: "rpc_live",
    params: { threadId: "thread_live_approval", command: "npm test", cwd: "/repo" },
  });
  await tick();

  assert.equal(calls.sent.length, 1, "the turn owns one card message");
  assert.equal(calls.updated.at(-1).messageId, "om_one_message");
  assert.match(JSON.stringify(calls.updated.at(-1).card), /npm test/);

  await desktop.resolveApproval("a1", "accept");
  await tick();
  assert.equal(calls.sent.length, 1, "approval resolution sends no new card");
  assert.equal(calls.updated.at(-1).messageId, "om_one_message");
  assert.match(
    JSON.stringify(calls.updated.at(-1).card),
    /已批准 \[a1\]/,
    "the resumed live card visibly records the approval decision",
  );

  transport.receive({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId: "thread_live_approval",
      item: { type: "agentMessage", id: "final_1", text: "The pull request review is complete." },
    },
  });
  transport.receive({
    jsonrpc: "2.0",
    method: "turn/completed",
    params: { threadId: "thread_live_approval" },
  });
  await tick();
  assert.equal(calls.sent.length, 1, "the complete turn used one Feishu message");
  assert.match(JSON.stringify(calls.updated.at(-1).card), /review is complete/);
});

test("a failed live approval update falls back to a fresh Feishu approval card", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();
  state.commandRouter.conversationByIdentity.set("feishu:ou_owner", {
    channel: "feishu",
    conversationId: "oc_chat",
  });
  state.commandRouter.bindThreadForIdentity(
    { channel: "feishu", stableId: "ou_owner" },
    "thread_approval_fallback",
  );

  const calls = { sent: [], updated: [] };
  state.runtime.feishu.__setTestDriver({
    getStatus: () => ({ state: "configured" }),
    verifyEvent: () => true,
    async sendCard(message) {
      calls.sent.push(message);
      return { messageId: `om_${calls.sent.length}` };
    },
    async updateCard(message) {
      calls.updated.push(message);
      throw new Error("temporary Feishu card update failure");
    },
  });

  transport.receive({
    jsonrpc: "2.0",
    method: "turn/started",
    params: { threadId: "thread_approval_fallback" },
  });
  await waitFor(() => calls.sent.length === 1);
  transport.receive({
    jsonrpc: "2.0",
    method: "item/commandExecution/requestApproval",
    id: "rpc_fallback",
    params: { threadId: "thread_approval_fallback", command: "npm test", cwd: "/repo" },
  });

  await waitFor(() => calls.sent.length === 2);
  assert.equal(calls.updated.length, 1, "the runtime first attempts the in-place approval update");
  assert.match(JSON.stringify(calls.sent[1].card), /npm test/);
  assert.match(JSON.stringify(calls.sent[1].card), /批准/);
});

test("completed card fallback tail localizes to en", async () => {
  try {
    // buildState() constructs the server, which resets i18n to the persisted
    // (default) locale — so switch to en AFTER it is built.
    const { transport, desktop, state } = buildState();
    setLocale("en");
    await desktop.client.connect();

    state.commandRouter.conversationByIdentity.set("feishu:ou_owner", {
      channel: "feishu",
      conversationId: "oc_chat",
    });
    state.commandRouter.bindThreadForIdentity(
      { channel: "feishu", stableId: "ou_owner" },
      "thread_f",
    );

    const calls = { sent: [], updated: [] };
    state.runtime.feishu.__setTestDriver({
      getStatus: () => ({ state: "configured" }),
      verifyEvent: () => true,
      async sendCard(message) {
        calls.sent.push(message);
        return { messageId: "om_live" };
      },
      async updateCard(message) {
        calls.updated.push(message);
        return { code: 0 };
      },
    });

    // Open the active card, then complete the turn WITHOUT any stream text so
    // the completed card falls back to the localized "task finished" tail.
    transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread_f" } });
    await tick();
    transport.receive({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: "thread_f" },
    });
    await tick();

    const finalCard = calls.updated.at(-1)?.card;
    assert.ok(finalCard, "the completion card was sent");
    assert.ok(
      JSON.stringify(finalCard).includes("This task is finished."),
      "completed-card fallback tail uses the localized string",
    );
  } finally {
    setLocale("zh");
  }
});
