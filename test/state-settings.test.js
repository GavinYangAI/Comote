import test from "node:test";
import assert from "node:assert/strict";
import { createComoteState } from "../src/server/state.js";
import { getLocale, setLocale } from "../src/core/i18n/index.js";

test("state initializes i18n locale from persisted settings", () => {
  createComoteState({ persisted: { settings: { locale: "en" } } });
  assert.equal(getLocale(), "en");
});

test("setLocale updates settings and i18n; getSettings reflects it", () => {
  const state = createComoteState({ persisted: {} });
  state.setLocale("ja");
  assert.equal(getLocale(), "ja");
  assert.equal(state.getSettings().locale, "ja");
  // i18n locale is a module-level global; reset so later tests aren't affected.
  setLocale("zh");
});
