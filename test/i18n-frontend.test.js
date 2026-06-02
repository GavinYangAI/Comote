import test from "node:test";
import assert from "node:assert/strict";
import { WEB_LOCALES, webDict, tWeb, setWebLocale } from "../public/i18n.js";

test("frontend locales all share the same key set", () => {
  const base = Object.keys(webDict("zh")).sort();
  for (const loc of WEB_LOCALES) {
    assert.deepEqual(Object.keys(webDict(loc)).sort(), base, `web locale ${loc} differs`);
  }
});

test("frontend locales share the same {placeholder} vars as zh", () => {
  const placeholders = (s) => [...new Set((String(s).match(/\{(\w+)\}/g) ?? []))].sort();
  const zh = webDict("zh");
  for (const key of Object.keys(zh)) {
    const want = placeholders(zh[key]);
    for (const loc of WEB_LOCALES) {
      assert.deepEqual(placeholders(webDict(loc)[key]), want, `web ${loc}/${key} placeholder mismatch`);
    }
  }
});

test("tWeb localizes and falls back", () => {
  setWebLocale("en");
  assert.equal(tWeb("web.nav.connectPhone"), "Connect phone");
  setWebLocale("zh");
  assert.equal(tWeb("web.nav.connectPhone"), "连接手机");
  setWebLocale("xx"); // unknown -> default zh
  assert.equal(tWeb("web.nav.connectPhone"), "连接手机");
  assert.equal(tWeb("__missing__"), "__missing__");
});
