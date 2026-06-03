// test/telegram-plugin.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import telegramPlugin from "../src/channels/telegram/index.js";

test("meta declares a token channel with the right shape", () => {
  const m = telegramPlugin.meta;
  assert.equal(m.id, "telegram");
  assert.equal(m.inboundMode, "push");
  assert.equal(m.binding, "token");
  assert.equal(m.capabilities.cards, 1);
  assert.equal(m.capabilities.liveUpdates, 1);
  assert.deepEqual(m.configFields.map((f) => f.name), ["botToken"]);
  assert.equal(m.configFields[0].secret, true);
  assert.deepEqual(m.boundWhen, { source: "config", field: "linkedChatId" });
});

test("statusRows expose account + pairing code from config", () => {
  const rows = telegramPlugin.meta.statusRows;
  const pairing = rows.find((r) => r.field === "pairingCode");
  assert.equal(pairing.source, "config");
});

test("normalizeConfig keeps token + binding/pairing fields", () => {
  const c = telegramPlugin.normalizeConfig({ enabled: true, botToken: "T", linkedChatId: "9", linkedUserName: "ann", pairingCode: "AB23CD", offset: 5 });
  assert.equal(c.botToken, "T");
  assert.equal(c.linkedChatId, "9");
  assert.equal(c.linkedUserName, "ann");
  assert.equal(c.pairingCode, "AB23CD");
  assert.equal(c.offset, 5);
});

test("publicConfig masks the token, exposes configured + pairing fields", () => {
  const pub = telegramPlugin.publicConfig(telegramPlugin.normalizeConfig({ enabled: true, botToken: "T", linkedChatId: "9", pairingCode: "AB23CD" }));
  assert.equal(pub.hasBotToken, true);
  assert.equal(pub.botToken, undefined);
  assert.equal(pub.configured, true); // enabled && botToken (pre-pairing)
  assert.equal(pub.linkedChatId, "9");
  assert.equal(pub.pairingCode, "AB23CD");
});

test("configured is false without a token", () => {
  assert.equal(telegramPlugin.publicConfig(telegramPlugin.normalizeConfig({ enabled: true })).configured, false);
});

test("normalizeSecretPatch drops a masked token", () => {
  const patch = telegramPlugin.normalizeSecretPatch({ botToken: "********", enabled: true });
  assert.equal("botToken" in patch, false);
  assert.equal(patch.enabled, true);
});

test("createDriver returns null until enabled + token present", () => {
  assert.equal(telegramPlugin.createDriver(telegramPlugin.normalizeConfig({ enabled: false })), null);
  assert.equal(telegramPlugin.createDriver(telegramPlugin.normalizeConfig({ enabled: true })), null);
  assert.ok(telegramPlugin.createDriver(telegramPlugin.normalizeConfig({ enabled: true, botToken: "T" })));
});

test("createRenderer/createAdapter/createRuntime build", () => {
  assert.ok(telegramPlugin.createRenderer(telegramPlugin.normalizeConfig({})));
  assert.ok(telegramPlugin.createAdapter({ commandRouter: {}, sendReply: async () => {} }));
  assert.ok(telegramPlugin.createRuntime({ adapter: { commandRouter: {} }, outboundQueue: { list: () => [] }, renderer: telegramPlugin.createRenderer({}) }));
});
