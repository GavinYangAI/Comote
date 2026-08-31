import test from "node:test";
import assert from "node:assert/strict";

import { createServer } from "../src/server/app.js";

async function withServer(state, run) {
  const server = createServer(state).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function apiState() {
  const calls = [];
  return {
    calls,
    globalManager: {
      publicSnapshot: () => ({ status: "ready", enabled: true, appId: "cli_app", manager: { stableId: "ou_1" } }),
      bindCurrentFeishu: async () => { calls.push("bind"); return { status: "ready", appId: "cli_app", manager: { stableId: "ou_1" } }; },
      sendTest: async () => { calls.push("test"); return { ok: true }; },
      unbind: async () => { calls.push("unbind"); return { status: "unbound", enabled: false }; },
    },
    taskMonitor: { snapshot: () => ({ state: "ready", tasks: [{ id: "t1" }] }) },
    eventLog: { info() {}, warn() {} },
  };
}

test("global-manager APIs expose status, bind, test, tasks, and unbind", async () => {
  const state = apiState();
  await withServer(state, async (base) => {
    const status = await fetch(`${base}/api/global-manager`).then((response) => response.json());
    assert.equal(status.appId, "cli_app");
    assert.equal(Object.hasOwn(status, "appSecret"), false);

    assert.equal((await fetch(`${base}/api/global-manager/bind`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`${base}/api/global-manager/test`, { method: "POST" })).status, 200);
    const tasks = await fetch(`${base}/api/global-manager/tasks`).then((response) => response.json());
    assert.deepEqual(tasks.tasks, [{ id: "t1" }]);
    assert.equal((await fetch(`${base}/api/global-manager`, { method: "DELETE" })).status, 200);
  });
  assert.deepEqual(state.calls, ["bind", "test", "unbind"]);
});
