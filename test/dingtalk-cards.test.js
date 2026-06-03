import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toParamMap,
  approvalCardData,
  approvalResolvedCardData,
  pickerCardData,
  statusCardData,
  PICKER_OPTIONS_KEY,
} from "../src/channels/dingtalk/cards.js";

test("toParamMap stringifies every value", () => {
  const map = toParamMap({ a: "x", n: 3, b: true, arr: [1, 2], obj: { k: 1 }, nul: null });
  assert.equal(map.a, "x");
  assert.equal(map.n, "3");
  assert.equal(map.b, "true");
  assert.equal(map.arr, "[1,2]");
  assert.equal(map.obj, '{"k":1}');
  assert.equal(map.nul, ""); // null/undefined → empty string, never "null"
});

test("approvalCardData carries title/detail + button params", () => {
  const data = approvalCardData({ shortCode: "a1b2", detail: "rm -rf build" });
  assert.equal(typeof data.title, "string");
  assert.equal(data.detail, "rm -rf build");
  assert.deepEqual(data.approveParams, { action: "approve", code: "a1b2" });
  assert.deepEqual(data.rejectParams, { action: "reject", code: "a1b2" });
});

test("pickerCardData encodes options as a stringified array for the loop container", () => {
  const data = pickerCardData({
    pickKind: "project",
    title: "选择项目",
    text: "请选择",
    conversationId: "staff-9",
    items: [
      { index: 1, label: "alpha" },
      { index: 2, label: "beta" },
    ],
  });
  const options = JSON.parse(data[PICKER_OPTIONS_KEY]);
  assert.equal(options.length, 2);
  assert.equal(options[0].label, "alpha");
  // each option carries the params a click must echo back
  assert.deepEqual(options[0].params, { action: "pick", pickKind: "project", index: "1", conv: "staff-9" });
  assert.deepEqual(options[1].params, { action: "pick", pickKind: "project", index: "2", conv: "staff-9" });
});

test("statusCardData maps phase to a localized title + body text", () => {
  const data = statusCardData({ phase: "completed", text: "done", done: true });
  assert.equal(typeof data.title, "string");
  assert.equal(data.body, "done");
  assert.equal(data.done, true); // raw boolean — renderer.buildStatusCard stringifies via toParamMap
});

test("approvalResolvedCardData reflects the decision", () => {
  const accepted = approvalResolvedCardData({ code: "a1", decision: "accept" });
  assert.match(accepted.title, /a1/);
  assert.equal(accepted.accepted, true);
  const rejected = approvalResolvedCardData({ code: "a1", decision: "decline" });
  assert.equal(rejected.accepted, false);
});
