import test from "node:test";
import assert from "node:assert/strict";
import feishuPlugin from "../src/channels/feishu/index.js";
import { FeishuChannelAdapter } from "../src/channels/feishu/adapter.js";
import { FeishuRuntimeService } from "../src/channels/feishu/runtime.js";

test("feishu plugin exposes meta + factories", () => {
  assert.equal(feishuPlugin.meta.id, "feishu");
  assert.equal(feishuPlugin.meta.inboundMode, "push");
  assert.equal(feishuPlugin.meta.binding, "qr");
  assert.deepEqual(feishuPlugin.meta.capabilities, { cards: 1, media: 1, liveUpdates: 1, typing: 0 });
  for (const fn of ["createDriver", "createAdapter", "createRuntime", "createRenderer", "normalizeConfig", "publicConfig"]) {
    assert.equal(typeof feishuPlugin[fn], "function");
  }
});

test("createDriver returns null when disabled or unconfigured", () => {
  assert.equal(feishuPlugin.createDriver({ enabled: false }), null);
  assert.equal(feishuPlugin.createDriver({ enabled: true }), null); // no appId/appSecret
});

test("publicConfig redacts secrets", () => {
  const pub = feishuPlugin.publicConfig(feishuPlugin.normalizeConfig({ enabled: true, appId: "a", appSecret: "s" }));
  assert.equal(pub.hasAppSecret, true);
  assert.equal(pub.appSecret, undefined);
});

test("normalizeSecretPatch drops masked secret placeholders so they don't overwrite stored secrets", () => {
  // The real normalizeFeishuSecretPatch strips two placeholders — "" and
  // "********" — from three guarded fields: appSecret, verificationToken,
  // encryptKey. Stripping a field means a PUT of the redacted public config
  // does NOT overwrite the stored real secret.
  for (const placeholder of ["", "********"]) {
    const stripped = feishuPlugin.normalizeSecretPatch({
      appId: "a",
      appSecret: placeholder,
      verificationToken: placeholder,
      encryptKey: placeholder,
    });
    assert.equal(stripped.appId, "a"); // non-secret fields are preserved
    assert.equal("appSecret" in stripped, false);
    assert.equal("verificationToken" in stripped, false);
    assert.equal("encryptKey" in stripped, false);
  }

  // Real new secret values pass through unchanged.
  const real = feishuPlugin.normalizeSecretPatch({
    appId: "a",
    appSecret: "brand-new-secret",
    verificationToken: "brand-new-token",
    encryptKey: "brand-new-key",
  });
  assert.equal(real.appSecret, "brand-new-secret");
  assert.equal(real.verificationToken, "brand-new-token");
  assert.equal(real.encryptKey, "brand-new-key");
});

test("createAdapter/createRuntime construct the feishu classes", () => {
  const adapter = feishuPlugin.createAdapter({
    commandRouter: { handleMessageAsync: async () => ({}) },
    sendReply: async () => {},
  });
  assert.ok(adapter instanceof FeishuChannelAdapter);

  const runtime = feishuPlugin.createRuntime({
    adapter,
    outboundQueue: {},
    renderer: feishuPlugin.createRenderer(),
  });
  assert.ok(runtime instanceof FeishuRuntimeService);
});

test("meta is complete", () => {
  assert.equal(feishuPlugin.meta.displayName, "飞书 / Lark");
  assert.deepEqual(feishuPlugin.meta.configFields, []);
});
