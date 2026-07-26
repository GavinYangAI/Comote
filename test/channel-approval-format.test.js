import test from "node:test";
import assert from "node:assert/strict";
import { describeApprovalForChat, approvalDetail, summarizeChanges, countDiffLines } from "../src/channels/base/approval-format.js";

test("countDiffLines counts +/- excluding headers", () => {
  const { added, removed } = countDiffLines("+++ a\n+x\n+y\n--- b\n-z");
  assert.equal(added, 2);
  assert.equal(removed, 1);
});

test("approvalDetail wraps a command in backticks when no changes", () => {
  const md = approvalDetail({ method: "exec", params: { command: "rm -rf build" } });
  assert.match(md, /`rm -rf build`/);
});

test("describeApprovalForChat includes code, command and the /approve instruction", () => {
  const text = describeApprovalForChat({ shortCode: "a1", method: "exec", params: { command: "rm -rf build" } });
  assert.match(text, /rm -rf build/);
  assert.match(text, /\/approve a1/);
});

test("auto-approved chat text notifies without manual approval instructions", () => {
  const text = describeApprovalForChat(
    { shortCode: "a1", method: "exec", params: { command: "npm test" } },
    { autoApproved: true },
  );
  assert.match(text, /自动模式/);
  assert.doesNotMatch(text, /\/approve|\/deny/);
});

test("summarizeChanges lists changed paths with stats", () => {
  const text = summarizeChanges([{ kind: { type: "add" }, path: "x.js", diff: "+a\n+b\n-c" }]);
  assert.match(text, /x\.js/);
  assert.match(text, /\+2 -1/);
});
