import test from "node:test";
import assert from "node:assert/strict";

import {
  renderMarkdown,
  textCard,
  statusCard,
  approvalCard,
  approvalResolvedCard,
  pickerCard,
} from "../src/channels/feishu/cards.js";

test("renderMarkdown wraps prose in a markdown element", () => {
  const elements = renderMarkdown("**hi** there");
  assert.equal(elements.length, 1);
  assert.equal(elements[0].tag, "markdown");
  assert.equal(elements[0].content, "**hi** there");
});

test("renderMarkdown splits text longer than the element limit", () => {
  const elements = renderMarkdown("x".repeat(7000));
  assert.ok(elements.length >= 3);
  assert.ok(elements.every((el) => el.tag === "markdown" && el.content.length <= 3000));
});

test("renderMarkdown returns a placeholder for empty input", () => {
  const elements = renderMarkdown("");
  assert.equal(elements.length, 1);
  assert.match(elements[0].content, /无内容/);
});

test("textCard renders markdown elements with wide-screen config", () => {
  const card = textCard("hello");
  assert.equal(card.config.wide_screen_mode, true);
  assert.equal(card.elements[0].content, "hello");
});

test("statusCard shows a cancel button while running", () => {
  const card = statusCard({ phase: "progress", threadId: "t1", steps: 3 });
  assert.equal(card.header.template, "blue");
  assert.match(card.header.title.content, /处理中/);
  const action = card.elements.find((el) => el.tag === "action");
  assert.ok(action, "running card has an action element");
  assert.deepEqual(action.actions[0].value, { kind: "cancel", threadId: "t1" });
});

test("statusCard for a completed turn has no cancel button and shows text", () => {
  const card = statusCard({ phase: "completed", threadId: "t1", text: "done", done: true });
  assert.equal(card.header.template, "green");
  assert.ok(!card.elements.some((el) => el.tag === "action"));
  assert.ok(card.elements.some((el) => el.tag === "markdown" && el.content === "done"));
});

test("statusCard renders the error phase with a red header and the message", () => {
  const card = statusCard({ phase: "error", text: "boom", done: true });
  assert.equal(card.header.template, "red");
  assert.ok(card.elements.some((el) => el.tag === "markdown" && el.content === "boom"));
});

test("statusCard renders tool activity inside the card", () => {
  const card = statusCard({
    phase: "progress",
    threadId: "t1",
    activities: [
      { label: "running npm", detail: '{"command":"npm test","cwd":"/repo"}' },
      "edited app.js",
    ],
  });
  const panel = card.elements.find((element) => element.tag === "collapsible_panel");
  assert.ok(panel, "tool activity uses Feishu's collapsible panel");
  assert.equal(panel.expanded, false);
  const body = panel.elements.map((element) => element.content ?? "").join("\n");
  assert.match(body, /running npm/);
  assert.match(body, /npm test/);
  assert.match(body, /\/repo/);
  assert.match(body, /edited app\.js/);
});

test("statusCard keeps tool activity between the text blocks where it occurred", () => {
  const card = statusCard({
    phase: "streaming",
    content: [
      { type: "text", text: "before tools" },
      { type: "activities", activities: ["running npm"] },
      { type: "text", text: "after tools" },
    ],
  });
  const before = card.elements.findIndex((element) => element.content === "before tools");
  const tools = card.elements.findIndex((element) => element.tag === "collapsible_panel");
  const after = card.elements.findIndex((element) => element.content === "after tools");
  assert.ok(before < tools && tools < after);
});

test("approvalCard carries approve/session/decline button values", () => {
  const card = approvalCard({ shortCode: "a1", detail: "rm -rf build" });
  assert.match(card.header.title.content, /a1/);
  const action = card.elements.find((el) => el.tag === "action");
  assert.deepEqual(action.actions.map((b) => b.value.decision), ["accept", "acceptForSession", "decline"]);
  assert.ok(action.actions.every((b) => b.value.kind === "approval" && b.value.code === "a1"));
});

test("auto-approved approvalCard has a notice and no actions", () => {
  const card = approvalCard({ shortCode: "a1", detail: "npm test", autoApproved: true });
  assert.ok(!card.elements.some((element) => element.tag === "action"));
  const body = card.elements.map((element) => element.content ?? "").join("\n");
  assert.match(body, /自动模式/);
  assert.doesNotMatch(body, /\/approve|\/deny/);
});

test("approvalCard includes the /approve text-command fallback (works when buttons can't)", () => {
  // Feishu card-action button callbacks can fail to reach Comote (transport/
  // subscription dependent), but the /approve|/deny text command always works
  // over the message-event path. The card MUST surface that fallback so a user
  // is never stuck with dead buttons and forced to the Comote desktop.
  const card = approvalCard({ shortCode: "a1", detail: "rm -rf build" });
  const body = card.elements
    .filter((el) => el.tag === "markdown")
    .map((el) => el.content)
    .join("\n");
  assert.match(body, /\/approve a1/);
  assert.match(body, /\/deny a1/);
});

test("approvalResolvedCard reflects the decision", () => {
  const accepted = approvalResolvedCard({ code: "a1", decision: "acceptForSession", detail: "`npm test`" });
  assert.match(accepted.header.title.content, /已批准/);
  assert.equal(accepted.header.template, "green");
  assert.equal(accepted.elements[0].content, "`npm test`");
  const acceptedActions = accepted.elements.find((element) => element.tag === "action").actions;
  assert.equal(acceptedActions.length, 1);
  assert.equal(acceptedActions[0].type, "primary");
  assert.equal("value" in acceptedActions[0], false, "resolved button must have no callback value");

  const rejected = approvalResolvedCard({ code: "a1", decision: "decline" });
  assert.match(rejected.header.title.content, /已拒绝/);
  assert.equal(rejected.header.template, "red");
  const rejectedButton = rejected.elements.find((element) => element.tag === "action").actions[0];
  assert.equal(rejectedButton.type, "danger");
  assert.equal("value" in rejectedButton, false);
});

test("pickerCard renders one button per item with pick values", () => {
  const card = pickerCard({
    kind: "session",
    title: "请选择对话",
    items: [
      { label: "新建对话", index: "0" },
      { label: "修复登录", index: "1" },
    ],
  });
  const action = card.elements.find((el) => el.tag === "action");
  assert.equal(action.actions.length, 2);
  assert.deepEqual(action.actions[1].value, { kind: "pick", pickKind: "session", index: "1" });
});

test("statusCard renders pushfile buttons for changed files on completion", () => {
  const card = statusCard({
    phase: "completed",
    threadId: "t1",
    text: "done",
    done: true,
    files: [{ path: "/home/proj/out/a.png", name: "a.png" }],
  });
  const action = card.elements.find((e) => e.tag === "action");
  assert.ok(action, "expected an action block");
  const btn = action.actions[0];
  assert.equal(btn.value.kind, "pushfile");
  assert.equal(btn.value.threadId, "t1");
  assert.equal(btn.value.path, "/home/proj/out/a.png");
  assert.match(btn.text.content, /a\.png/);
});

test("statusCard falls back to the path basename when a file has no name", () => {
  const card = statusCard({
    phase: "completed",
    threadId: "t1",
    done: true,
    files: [{ path: "/home/proj/out/chart.png" }],
  });
  const action = card.elements.find((e) => e.tag === "action");
  assert.ok(action, "expected an action block");
  const btn = action.actions[0];
  assert.equal(btn.value.path, "/home/proj/out/chart.png");
  assert.match(btn.text.content, /chart\.png/);
});

test("statusCard caps pushfile buttons at 8 and notes the remainder", () => {
  const files = Array.from({ length: 9 }, (_, i) => ({
    path: `/home/proj/out/file${i}.png`,
    name: `file${i}.png`,
  }));
  const card = statusCard({ phase: "completed", threadId: "t1", done: true, files });
  const action = card.elements.find((e) => e.tag === "action");
  assert.ok(action, "expected an action block");
  assert.equal(action.actions.length, 8);
  const remainder = card.elements.find(
    (e) => e.tag === "markdown" && /还有\s*1\s*个/.test(e.content),
  );
  assert.ok(remainder, "expected a markdown element noting the remaining count");
});

test("statusCard without files renders no pushfile action", () => {
  const card = statusCard({ phase: "completed", text: "done", done: true });
  const action = (card.elements || []).find((e) => e.tag === "action");
  assert.equal(action, undefined);
});

test("renderMarkdown does not sever a fenced code block across elements", () => {
  const code = "const x = 1;\n".repeat(300);
  const input = `intro paragraph\n\`\`\`\n${code}\`\`\`\noutro paragraph`;
  const elements = renderMarkdown(input);
  assert.ok(elements.length >= 2, "long input is split into multiple elements");
  for (const element of elements) {
    const fenceCount = (element.content.match(/```/g) ?? []).length;
    assert.equal(fenceCount % 2, 0, "each element has balanced code fences");
    assert.ok(element.content.length <= 3000, "each element stays within the size limit");
  }
});

import { setLocale } from "../src/core/i18n/index.js";
test("status card title and cancel button localize to en", () => {
  setLocale("en");
  const card = statusCard({ phase: "progress", threadId: "t1" });
  assert.equal(card.header.title.content, "⏳ Codex working");
  const action = card.elements.find((e) => e.tag === "action");
  assert.equal(action.actions[0].text.content, "Cancel task");
  setLocale("zh");
});

test("steps line localizes to en", () => {
  setLocale("en");
  const card = statusCard({ phase: "progress", threadId: "t1", steps: 3 });
  const md = card.elements.find((e) => e.tag === "markdown" && /step/.test(e.content));
  assert.match(md.content, /3.*step/);
  setLocale("zh");
});
