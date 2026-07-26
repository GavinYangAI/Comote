// test/dingtalk-plugin.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import dingtalkPlugin from "../src/channels/dingtalk/index.js";

test("meta declares a credentials channel with the right shape", () => {
  const m = dingtalkPlugin.meta;
  assert.equal(m.id, "dingtalk");
  assert.equal(m.inboundMode, "push");
  assert.equal(m.binding, "credentials");
  assert.equal(m.capabilities.cards, 1);
  assert.equal(m.capabilities.liveUpdates, 1);
  assert.equal(m.capabilities.reactions, 0);
  const names = m.configFields.map((f) => f.name);
  assert.deepEqual(names, ["appKey", "appSecret", "approvalTemplateId", "statusTemplateId", "pickerTemplateId"]);
  const secret = m.configFields.find((f) => f.name === "appSecret");
  assert.equal(secret.secret, true);
});

test("normalizeConfig keeps the credential + template fields", () => {
  const c = dingtalkPlugin.normalizeConfig({ enabled: true, appKey: "ak", appSecret: "as", approvalTemplateId: "a.schema" });
  assert.equal(c.appKey, "ak");
  assert.equal(c.appSecret, "as");
  assert.equal(c.approvalTemplateId, "a.schema");
  assert.equal(c.statusTemplateId, null);
});

test("publicConfig masks the secret and reports configured", () => {
  const pub = dingtalkPlugin.publicConfig(dingtalkPlugin.normalizeConfig({ enabled: true, appKey: "ak", appSecret: "as" }));
  assert.equal(pub.hasAppSecret, true);
  assert.equal(pub.appSecret, undefined);
  assert.equal(pub.configured, true);
});

test("normalizeSecretPatch drops a masked secret so it is not overwritten", () => {
  const patch = dingtalkPlugin.normalizeSecretPatch({ appKey: "ak", appSecret: "********" });
  assert.equal("appSecret" in patch, false);
  assert.equal(patch.appKey, "ak");
});

test("createDriver returns null until enabled + credentials present", () => {
  assert.equal(dingtalkPlugin.createDriver(dingtalkPlugin.normalizeConfig({ enabled: false })), null);
  assert.equal(dingtalkPlugin.createDriver(dingtalkPlugin.normalizeConfig({ enabled: true, appKey: "ak" })), null);
  const d = dingtalkPlugin.createDriver(dingtalkPlugin.normalizeConfig({ enabled: true, appKey: "ak", appSecret: "as" }));
  assert.ok(d, "driver constructed when credentials present");
});

test("createRenderer injects the template ids", () => {
  const r = dingtalkPlugin.createRenderer(dingtalkPlugin.normalizeConfig({ approvalTemplateId: "a.schema", pickerTemplateId: "p.schema" }));
  assert.equal(r.templates.approval, "a.schema");
  assert.equal(r.templates.picker, "p.schema");
});
