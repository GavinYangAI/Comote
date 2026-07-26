import test from "node:test";
import assert from "node:assert/strict";
import wechatPlugin from "../src/channels/wechat/index.js";
import { WeChatChannelAdapter } from "../src/channels/wechat/adapter.js";
import { WeChatRuntimeService } from "../src/channels/wechat/runtime.js";

test("wechat plugin exposes meta + factories", () => {
  assert.equal(wechatPlugin.meta.id, "wechat");
  assert.equal(wechatPlugin.meta.inboundMode, "poll");
  assert.equal(wechatPlugin.meta.binding, "qr");
  assert.deepEqual(wechatPlugin.meta.capabilities, { cards: 0, media: 0, liveUpdates: 0, milestones: 1, typing: 1, fileButtons: 0, reactions: 0 });
  for (const fn of ["createDriver", "createAdapter", "createRuntime", "createRenderer", "normalizeConfig", "publicConfig"]) {
    assert.equal(typeof wechatPlugin[fn], "function");
  }
});

test("createDriver returns null when disabled", () => {
  assert.equal(wechatPlugin.createDriver({ enabled: false }), null);
});

test("publicConfig reflects login state without leaking the token", () => {
  // publicWeChatConfig reports a `loggedIn` boolean (Boolean(config.token))
  // and never includes the raw token field.
  const loggedIn = wechatPlugin.publicConfig(
    wechatPlugin.normalizeConfig({ enabled: true, token: "secret-token", accountId: "acct" }),
  );
  assert.equal(loggedIn.loggedIn, true);
  assert.equal("token" in loggedIn, false);
  assert.equal(loggedIn.accountId, "acct");

  const loggedOut = wechatPlugin.publicConfig(
    wechatPlugin.normalizeConfig({ enabled: true }),
  );
  assert.equal(loggedOut.loggedIn, false);
  assert.equal("token" in loggedOut, false);
});

test("createAdapter/createRuntime construct the wechat classes", () => {
  const adapter = wechatPlugin.createAdapter({
    commandRouter: { handleMessageAsync: async () => ({}) },
    sendReply: async () => {},
  });
  assert.ok(adapter instanceof WeChatChannelAdapter);

  const runtime = wechatPlugin.createRuntime({
    adapter,
    outboundQueue: {},
    renderer: wechatPlugin.createRenderer(),
  });
  assert.ok(runtime instanceof WeChatRuntimeService);
});

test("meta is complete", () => {
  assert.equal(typeof wechatPlugin.meta.displayName, "string");
  // C1: configFields was previously [] — it now declares the enabled checkbox
  // and the (hidden) accountId field the generic binding page reads. Behavior-
  // preserving: defaults (enabled:true, accountId:"default") match the existing
  // normalizeConfig defaults, so nothing changes at runtime.
  assert.equal(Array.isArray(wechatPlugin.meta.configFields), true);
  assert.deepEqual(
    wechatPlugin.meta.configFields.map((f) => f.name),
    ["enabled", "accountId"],
  );
});

test("wechat normalizeLoginStatus maps raw login states", () => {
  const n = wechatPlugin.normalizeLoginStatus;
  assert.equal(n({ token: "t", accountId: "acc", userName: "u" }).state, "confirmed");
  assert.equal(n({ token: "t", accountId: "acc", userName: "u" }).account.id, "acc");
  assert.equal(n({ state: "confirmed", accountId: "acc" }).state, "confirmed");
  assert.equal(n({ state: "scanned", qrUrl: "Q" }).state, "scanned");
  assert.equal(n({ state: "cancelled" }).state, "failed");
  assert.equal(n({ state: "expired" }).state, "expired");
  assert.equal(n({}).state, "pending");
});

test("wechat meta declares the binding-page schema", () => {
  const m = wechatPlugin.meta;
  assert.equal(typeof m.descriptionKey, "string");
  assert.equal(typeof m.icon, "string");
  assert.ok(m.states.running && m.states.configured);
  const flag = m.statusFlags.find((f) => f.field === "needsRelogin");
  assert.equal(flag.source, "runtime");
  assert.equal(flag.tone, "warning");
  assert.equal(typeof flag.badgeKey, "string");
  assert.equal(typeof flag.labelKey, "string");
  const enabled = m.configFields.find((f) => f.name === "enabled");
  assert.equal(enabled.type, "checkbox");
  const accountId = m.configFields.find((f) => f.name === "accountId");
  assert.equal(accountId.hidden, true);
  assert.equal(accountId.default, "default");
  const host = m.statusRows.find((r) => r.field === "externalAgentHostRequired");
  assert.equal(host.source, "status");
  assert.ok(host.map);
  assert.deepEqual(m.boundWhen, { source: "config", field: "loggedIn" });
});
