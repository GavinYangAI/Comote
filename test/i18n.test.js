import test from "node:test";
import assert from "node:assert/strict";
import { t, setLocale, getLocale, SUPPORTED_LOCALES, DEFAULT_LOCALE } from "../src/core/i18n/index.js";
import zh from "../src/core/i18n/locales/zh.js";
import en from "../src/core/i18n/locales/en.js";
import ja from "../src/core/i18n/locales/ja.js";
import ko from "../src/core/i18n/locales/ko.js";
import fr from "../src/core/i18n/locales/fr.js";
import es from "../src/core/i18n/locales/es.js";

test("defaults to zh and returns the source string", () => {
  setLocale("zh");
  assert.equal(getLocale(), "zh");
  assert.equal(t("card.phase.completed"), "✅ Codex 已完成");
});

test("setLocale switches language; unknown falls back to default", () => {
  assert.equal(setLocale("en"), "en");
  assert.equal(t("card.phase.completed"), "✅ Codex done");
  assert.equal(setLocale("xx"), DEFAULT_LOCALE);
  setLocale("zh");
});

test("interpolates {vars}", () => {
  setLocale("zh");
  assert.equal(t("cmd.file.sending", { name: "a.png" }), "正在发送：a.png");
});

test("missing key falls back to zh then to the key itself", () => {
  setLocale("en");
  assert.equal(t("__nonexistent__"), "__nonexistent__");
  setLocale("zh");
});

test("all locales expose exactly the same key set as zh", () => {
  const dicts = { zh, en, ja, ko, fr, es };
  const base = Object.keys(zh).sort();
  for (const loc of SUPPORTED_LOCALES) {
    assert.deepEqual(Object.keys(dicts[loc]).sort(), base, `locale ${loc} key set differs from zh`);
  }
});
