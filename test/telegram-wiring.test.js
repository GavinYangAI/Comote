// test/telegram-wiring.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createComoteState } from "../src/server/state.js";
import { TelegramDriver } from "../src/channels/telegram/driver.js";

function deps(persisted = {}) {
  return { desktop: { onEvent: null, async listProjects() { return []; } }, stateStore: null, persisted };
}

test("registry includes telegram and builds its stack + push wrapper, no login", () => {
  const state = createComoteState({ ...deps(), autoStartTelegramRuntime: false });
  assert.ok(state.registry.getChannel("telegram"), "telegram plugin registered");
  assert.ok(state.runtime.telegram, "telegram runtime wrapper present");
  assert.equal(typeof state.runtime.telegram.handleInbound, "function");
  assert.equal(typeof state.runtime.telegram.deliverQueued, "function");
  assert.equal(state.runtime.telegram.startLogin, undefined); // token (non-qr): no login
});

test("configuring a token starts the runtime and generates a pairing code", async (t) => {
  // Avoid the real long-poll loop: patch startEventStream to a clean no-op resolve.
  const original = TelegramDriver.prototype.startEventStream;
  TelegramDriver.prototype.startEventStream = async function () { return { ok: true }; };
  t.after(() => { TelegramDriver.prototype.startEventStream = original; });

  const state = createComoteState({ ...deps(), autoStartTelegramRuntime: false });
  const pub = await state.runtime.telegram.configure({ enabled: true, botToken: "T" });
  assert.equal(pub.configured, true);
  assert.equal(state.runtime.telegram.getStatus().state, "running");
  // pairing code generated on start (unpaired)
  assert.match(state.runtime.telegram.getConfig().pairingCode ?? "", /^[0-9A-Z]{6}$/);
  assert.equal(state.runtime.telegram.getConfig().linkedChatId, null); // not bound yet
});

test("sending the pairing code binds the chat + authorizes the identity", async (t) => {
  const original = TelegramDriver.prototype.startEventStream;
  TelegramDriver.prototype.startEventStream = async function () { return { ok: true }; };
  t.after(() => { TelegramDriver.prototype.startEventStream = original; });

  const state = createComoteState({ ...deps(), autoStartTelegramRuntime: false });
  await state.runtime.telegram.configure({ enabled: true, botToken: "T" });
  const code = state.runtime.telegram.getConfig().pairingCode;
  // Drive an inbound "pairing code" message straight through the runtime wrapper.
  await state.runtime.telegram.handleInbound({ message: { message_id: 1, chat: { id: 555, type: "private" }, from: { id: 555, username: "ann" }, text: code } });
  const cfg = state.runtime.telegram.getConfig();
  assert.equal(cfg.linkedChatId, "555");
  assert.equal(cfg.linkedUserName, "ann");
  assert.equal(cfg.pairingCode, null); // cleared after pairing
  assert.equal(state.authorization.isAuthorized({ channel: "telegram", stableId: "555" }), true);
});
