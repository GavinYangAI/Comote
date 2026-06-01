import test from "node:test";
import assert from "node:assert/strict";

import { AuthorizationStore } from "../src/core/authorization.js";
import { CommandRouter } from "../src/core/commands.js";
import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";

function createRouter({ desktop = null } = {}) {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "wechat", stableId: "wx:owner", displayName: "Alice" };
  authorization.confirmIdentity(identity);
  projects.replaceProjects([{
    name: "comote",
    path: "/repo/comote",
    source: "codex-desktop",
    status: "available",
  }]);
  const router = new CommandRouter({ authorization, projects, sessions, codexDesktop: desktop });
  return { router, identity, sessions };
}

test("phone help lists the supported remote-control commands", async () => {
  const { router, identity } = createRouter();

  const reply = await router.handleMessageAsync({ identity, text: "/help" });

  assert.equal(reply.kind, "text");
  assert.match(reply.text, /\/projects/);
  assert.match(reply.text, /\/switch/);
  assert.match(reply.text, /\/tail/);
  assert.match(reply.text, /\/cancel/);
});

test("current, switch, and tail make phone session navigation explicit", async () => {
  const { router, identity, sessions } = createRouter();

  await router.handleMessageAsync({ identity, text: "/open 1" });
  sessions.upsertExternalSession({
    projectPath: "/repo/comote",
    id: "thread_1",
    title: "Fix tests",
    messages: [
      { role: "user", text: "fix tests" },
      { role: "assistant", text: "done" },
    ],
  });
  const current = await router.handleMessageAsync({ identity, text: "/current" });
  const switched = await router.handleMessageAsync({ identity, text: "/switch 1" });
  const tail = await router.handleMessageAsync({ identity, text: "/tail 2" });

  assert.match(current.text, /项目：\/repo\/comote/);
  assert.match(current.text, /对话：Fix tests/);
  assert.match(switched.text, /已切换到对话 Fix tests/);
  assert.match(tail.text, /user: fix tests/);
  assert.match(tail.text, /assistant: done/);
});

test("cancel delegates to Codex Desktop when a session is active", async () => {
  const cancelled = [];
  const desktop = {
    getStatus: () => ({ state: "connected" }),
    async cancelTurn({ threadId }) {
      cancelled.push(threadId);
      return { ok: true };
    },
  };
  const { router, identity, sessions } = createRouter({ desktop });

  await router.handleMessageAsync({ identity, text: "/open 1" });
  sessions.upsertExternalSession({ projectPath: "/repo/comote", id: "thread_1", title: "Run task" });
  const reply = await router.handleMessageAsync({ identity, text: "/cancel" });

  assert.equal(reply.text, "已取消当前 Codex 任务\nthread_1");
  assert.deepEqual(cancelled, ["thread_1"]);
});

test("unauthorized identity gets a one-time guidance notice", async () => {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const router = new CommandRouter({ authorization, projects, sessions });
  const identity = { channel: "wechat", stableId: "wx:stranger", displayName: "Stranger" };

  // First message: should get a notice with 确认
  const first = await router.handleMessageAsync({ identity, text: "hello" });
  assert.equal(first.kind, "notice");
  assert.ok(first.text.length > 0);
  assert.ok(first.text.includes("确认"), `expected text to include "确认", got: ${first.text}`);

  // Second message (same still-unauthorized identity): should be silently denied
  const second = await router.handleMessageAsync({ identity, text: "hello again" });
  assert.equal(second.kind, "denied");
});

test("authorized identity is welcomed on the first message only", async () => {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  const identity = { channel: "wechat", stableId: "wx:newuser", displayName: "NewUser" };
  authorization.confirmIdentity(identity);
  projects.replaceProjects([{ name: "comote", path: "/repo/comote", source: "codex-desktop", status: "available" }]);
  const router = new CommandRouter({ authorization, projects, sessions });

  // First message: should prepend welcome banner AND contain status output
  const first = await router.handleMessageAsync({ identity, text: "/status" });
  assert.ok(first.text.includes("欢迎使用 Comote"), `expected welcome banner in first reply, got: ${first.text}`);
  assert.ok(first.text.includes("Comote 状态"), `expected status output in first reply, got: ${first.text}`);

  // Second message: should NOT contain welcome banner
  const second = await router.handleMessageAsync({ identity, text: "/status" });
  assert.ok(!second.text.includes("欢迎使用 Comote"), `expected no welcome banner in second reply, got: ${second.text}`);
});

test("thread binding records the project path", () => {
  const { router, identity } = createRouter();
  router.conversationByIdentity.set(router.identityKey(identity), {
    channel: "feishu",
    conversationId: "c1",
  });
  router.bindThreadForIdentity(identity, "t1", "/home/proj");
  assert.equal(router.getThreadBinding("t1").projectPath, "/home/proj");
});
