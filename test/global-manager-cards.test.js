import test from "node:test";
import assert from "node:assert/strict";

import { globalManagerBindCard, globalManagerDashboardCard, globalManagerTaskCard } from "../src/channels/feishu/global-manager-cards.js";

test("global manager bind card has a button and a text-command fallback", () => {
  const card = globalManagerBindCard();
  const action = card.elements.find((element) => element.tag === "action");
  assert.equal(action.actions[0].text.content, "/manager bind");
  assert.equal(action.actions[0].value.kind, "global_manager_bind");
  assert.match(JSON.stringify(card), /\/manager bind/);
});

test("global manager task card shows the current Codex content directly below the task title", () => {
  const card = globalManagerTaskCard({
    id: "thread-running",
    title: "优化品牌胸章Logo设计",
    project: { name: "品牌项目" },
    state: "running",
    currentContent: "放大检查后，第 1 张点赞手已经能读出 1 个拇指 + 4 个握拳指节。",
    capabilities: { cancel: false },
  });
  const lines = card.elements[0].content.split("\n");

  assert.match(lines[1], /优化品牌胸章Logo设计/);
  assert.match(lines[2], /放大检查后/);
  assert.match(lines[3], /running/);
});

test("global manager dashboard remains the compact task list", () => {
  const card = globalManagerDashboardCard({
    state: "ready",
    counts: { running: 1, waiting: 0, attention: 0, completedToday: 0 },
    tasks: [{ id: "running", title: "Current task", project: { name: "Comote" }, state: "running" }],
  });

  assert.equal(card.elements.length, 4);
  assert.match(card.elements[2].content, /Current task/);
});
