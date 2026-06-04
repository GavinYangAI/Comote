import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createComoteState } from "../src/server/state.js";
import { CodexDesktopConnector } from "../src/connectors/codex-desktop/index.js";
import { decodeCallback } from "../src/channels/telegram/cards.js";

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

// Lets queued microtasks (the async card + delivery calls) settle.
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

// Creates a temp project root with a small text file and a binary image file,
// both inside the root so buildChangedFiles' isWithinDir keeps them.
async function makeProject() {
  const root = await mkdtemp(join(tmpdir(), "comote-changed-"));
  const mdPath = join(root, "notes.md");
  const pngPath = join(root, "shot.png");
  await writeFile(mdPath, "# hello\nsmall text body\n", "utf8");
  // Minimal but real PNG bytes so classifyFile sees an image and stat succeeds.
  await writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { root, mdPath, pngPath };
}

// Fires a fileChange item (accumulates changedPaths) then the completing
// agentMessage item for a thread.
function fireTurn(transport, threadId, changedPaths, text) {
  transport.receive({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId,
      item: { type: "fileChange", id: `fc:${threadId}`, changes: changedPaths.map((path) => ({ path })) },
    },
  });
  transport.receive({
    jsonrpc: "2.0",
    method: "item/completed",
    params: {
      threadId,
      item: { type: "agentMessage", id: `m:${threadId}`, text },
    },
  });
}

test("feishu (fileButtons): small .md inlines as text, .png becomes a card button", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();
  const { root, mdPath, pngPath } = await makeProject();

  state.commandRouter.conversationByIdentity.set("feishu:ou_owner", {
    channel: "feishu",
    conversationId: "oc_chat",
  });
  state.commandRouter.bindThreadForIdentity({ channel: "feishu", stableId: "ou_owner" }, "thread_f", root);

  const calls = { updated: [] };
  state.runtime.feishu.__setTestDriver({
    getStatus: () => ({ state: "configured" }),
    verifyEvent: () => true,
    async sendCard() {
      return { messageId: "om_live" };
    },
    async updateCard(message) {
      calls.updated.push(message);
      return { code: 0 };
    },
  });

  transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread_f" } });
  await tick();

  fireTurn(transport, "thread_f", [mdPath, pngPath], "all done");
  await tick();

  // The md inlines as one text reply (carries the file name).
  const replies = state.outboundReplies.list({ channel: "feishu", pendingOnly: false });
  const textReplies = replies.filter((r) => r.kind === "text");
  assert.equal(textReplies.length, 1, "one inline text reply for the small .md");
  assert.ok(textReplies[0].text.includes("notes.md"), "inline text carries the md file name");
  assert.equal(replies.filter((r) => r.kind === "media").length, 0, "feishu does NOT auto-send the png as media");

  // The finished card carries ONLY the png as a button file.
  const finalCard = calls.updated.at(-1)?.card;
  assert.ok(finalCard, "the completion card was sent");
  const buttons = finalCard.elements
    .filter((el) => el.tag === "action")
    .flatMap((el) => el.actions);
  const pushButtons = buttons.filter((b) => b.value?.kind === "pushfile");
  assert.equal(pushButtons.length, 1, "only the png renders a button");
  assert.equal(pushButtons[0].value.path, pngPath);
});

test("dingtalk (no fileButtons): .md inlines as text, .png auto-sends as media; card has no buttons", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();
  const { root, mdPath, pngPath } = await makeProject();

  state.commandRouter.conversationByIdentity.set("dingtalk:cid_owner", {
    channel: "dingtalk",
    conversationId: "cid_chat",
  });
  state.commandRouter.bindThreadForIdentity({ channel: "dingtalk", stableId: "cid_owner" }, "thread_d", root);

  // Configure a status template so openThreadCard/finishThreadCard work, then
  // inject a fake driver that records the card param maps and stubs media sends.
  await state.runtime.dingtalk.configure({
    appKey: "ak",
    appSecret: "as",
    statusTemplateId: "status.schema",
  });
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

  transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread_d" } });
  await tick();
  assert.equal(calls.created.length, 1, "turn start opened the status card");

  fireTurn(transport, "thread_d", [mdPath, pngPath], "all done");
  await tick();

  const replies = state.outboundReplies.list({ channel: "dingtalk", pendingOnly: false });
  const textReplies = replies.filter((r) => r.kind === "text");
  const mediaReplies = replies.filter((r) => r.kind === "media");
  assert.equal(textReplies.length, 1, "one inline text reply for the small .md");
  assert.ok(textReplies[0].text.includes("notes.md"), "inline text carries the md file name");
  assert.equal(mediaReplies.length, 1, "the png is auto-sent as a media attachment");
  assert.equal(mediaReplies[0].path, pngPath);
  assert.equal(mediaReplies[0].mediaKind, "image");

  // The finished status card carries NO file buttons (buttonFiles was empty).
  const finalParamMap = calls.updated.at(-1)?.cardParamMap;
  assert.ok(finalParamMap, "the completion card was sent");
  const serialized = JSON.stringify(finalParamMap);
  assert.ok(!serialized.includes("pushfile"), "dingtalk card has no pushfile buttons");
});

test("telegram (fileButtons): .md inlines as text, .png becomes a card button (not a media reply)", async () => {
  const { transport, desktop, state } = buildState();
  await desktop.client.connect();
  const { root, mdPath, pngPath } = await makeProject();

  state.commandRouter.conversationByIdentity.set("telegram:9001", {
    channel: "telegram",
    conversationId: "9001",
  });
  state.commandRouter.bindThreadForIdentity({ channel: "telegram", stableId: "9001" }, "thread_t", root);

  // Telegram is a single-token channel: a fake driver supplies the live-card
  // primitives (sendMessage opens, editMessageText updates/finishes). No
  // configure() step — __setTestDriver makes the runtime "configured".
  const calls = { sent: [], edited: [] };
  state.runtime.telegram.__setTestDriver({
    getStatus: () => ({ state: "configured" }),
    async sendMessage(a) {
      calls.sent.push(a);
      return { message_id: 77 };
    },
    async editMessageText(a) {
      calls.edited.push(a);
    },
  });

  transport.receive({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "thread_t" } });
  await tick();
  assert.equal(calls.sent.length, 1, "turn start opened the live thread card");

  fireTurn(transport, "thread_t", [mdPath, pngPath], "all done");
  await tick();

  const replies = state.outboundReplies.list({ channel: "telegram", pendingOnly: false });
  const textReplies = replies.filter((r) => r.kind === "text");
  const mediaReplies = replies.filter((r) => r.kind === "media");
  assert.equal(textReplies.length, 1, "one inline text reply for the small .md");
  assert.ok(textReplies[0].text.includes("notes.md"), "inline text carries the md file name");
  assert.equal(mediaReplies.length, 0, "the png is NOT auto-sent as media (fileButtons=1)");

  // The final card was edited onto the claimed session (not re-sent fresh) and
  // carries the png as an inline-keyboard pushfile button.
  assert.ok(calls.edited.length >= 1, "the completion card was edited onto the live message");
  const finalEdit = calls.edited.at(-1);
  assert.equal(finalEdit.messageId, 77);
  const buttons = (finalEdit.replyMarkup?.inline_keyboard ?? []).flat();
  assert.equal(buttons.length, 1, "only the png renders one button");
  assert.match(buttons[0].text, /shot\.png/, "the button carries the png file name");
  const decoded = decodeCallback(buttons[0].callback_data);
  assert.equal(decoded.action, "pushfile", "the button is a pushfile callback");
  assert.equal(decoded.fileIndex, 0, "the png is at index 0 of the turn's button files");
});
