import test from "node:test";
import assert from "node:assert/strict";
import feishuPlugin from "../src/channels/feishu/index.js";
import { FeishuChannelAdapter } from "../src/channels/feishu/adapter.js";
import { FeishuRuntimeService } from "../src/channels/feishu/runtime.js";

test("feishu plugin exposes meta + factories", () => {
  assert.equal(feishuPlugin.meta.id, "feishu");
  assert.equal(feishuPlugin.meta.inboundMode, "push");
  assert.equal(feishuPlugin.meta.binding, "qr");
  assert.deepEqual(feishuPlugin.meta.capabilities, { cards: 1, media: 1, liveUpdates: 1, milestones: 0, typing: 0, fileButtons: 1 });
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
  // C1: configFields was previously [] — it now declares the domain select the
  // generic binding page renders. Behavior-preserving: an empty list rendered
  // nothing; this list still has no default-changing effect on config.
  assert.equal(Array.isArray(feishuPlugin.meta.configFields), true);
  assert.deepEqual(
    feishuPlugin.meta.configFields.map((f) => f.name),
    ["domain"],
  );
});

test("feishu normalizeLoginStatus maps raw login states", () => {
  const n = feishuPlugin.normalizeLoginStatus;
  assert.equal(n({ state: "confirmed", appId: "a", userName: "u" }).state, "confirmed");
  assert.equal(n({ state: "confirmed", appId: "a", userName: "u" }).account.name, "u");
  assert.equal(n({ state: "waiting", qrUrl: "Q" }).state, "pending");
  assert.equal(n({ state: "waiting", qrUrl: "Q" }).qrUrl, "Q");
  assert.equal(n({ state: "scanned", qrUrl: "Q" }).state, "scanned");
  assert.equal(n({ state: "access_denied" }).state, "failed");
  assert.equal(n({ state: "timeout" }).state, "failed");
  assert.equal(n({ state: "expired" }).state, "expired");
});

test("feishu meta declares the binding-page schema", () => {
  const m = feishuPlugin.meta;
  assert.equal(typeof m.descriptionKey, "string");
  assert.equal(typeof m.icon, "string");
  for (const [, v] of Object.entries(m.states)) {
    assert.equal(typeof v.labelKey, "string");
    assert.ok(["success", "warning", "neutral"].includes(v.tone));
  }
  assert.ok(m.states.running && m.states.not_configured);
  const domain = m.configFields.find((f) => f.name === "domain");
  assert.equal(domain.type, "select");
  assert.equal(typeof domain.labelKey, "string");
  assert.ok(domain.options.every((o) => o.value && o.labelKey));
  assert.ok(m.statusRows.length >= 1);
  for (const r of m.statusRows) {
    assert.equal(typeof r.labelKey, "string");
    assert.ok(["config", "runtime", "status"].includes(r.source));
    assert.equal(typeof r.field, "string");
  }
  assert.deepEqual(m.boundWhen, { source: "config", field: "configured" });
});
