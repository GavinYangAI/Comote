// B 组 UX/安全修复（docs/2026-07-13-codex-resolve-fix-and-ux-review.md）：
// B-4 /approve 归属校验、B-5 /tail 走 desktop RPC、B-6 会话指针按身份、
// B-7 CLI-only 续聊提示、B-10 picker 逃生口、B-12b notice/welcome 持久化。
import test from "node:test";
import assert from "node:assert/strict";

import { AuthorizationStore } from "../src/core/authorization.js";
import { ProjectStore } from "../src/core/projects.js";
import { SessionStore } from "../src/core/sessions.js";
import { CommandRouter } from "../src/core/commands.js";

function makeIdentity(stableId, channel = "wechat") {
  return { channel, stableId, displayName: stableId };
}

function makeRouter({ codexDesktop = null, codexCli = null, transcript = null, persisted = {} } = {}) {
  const authorization = new AuthorizationStore();
  const projects = new ProjectStore();
  const sessions = new SessionStore();
  projects.replaceProjects([
    { name: "comote", path: "/repo", source: "codex-desktop", status: "available" },
  ]);
  const router = new CommandRouter({
    authorization,
    projects,
    sessions,
    codexDesktop,
    codexCli,
    transcript,
    persisted,
  });
  return { authorization, projects, sessions, router };
}

// ---------------------------------------------------------------------------
// B-4: /approve <code> / /deny <code> ownership gate
// ---------------------------------------------------------------------------

function approvalDesktop(decisions, { threadId = "thread_1" } = {}) {
  return {
    getStatus: () => ({ state: "connected" }),
    listPendingApprovals: () => [
      { id: "42", shortCode: "a1", threadId, method: "execCommandApproval" },
    ],
    resolveApproval: async (id, decision) => {
      decisions.push([id, decision]);
      return { ok: true };
    },
  };
}

test("[B-4] a non-owner cannot /approve another user's approval", async () => {
  const decisions = [];
  const { authorization, router } = makeRouter({ codexDesktop: approvalDesktop(decisions) });
  const alice = makeIdentity("wxid_alice");
  const bob = makeIdentity("wxid_bob");
  authorization.confirmIdentity(alice);
  authorization.confirmIdentity(bob);

  // Alice owns thread_1 (conversation recorded, then thread bound to her).
  await router.handleMessageAsync({
    identity: alice,
    text: "/status",
    conversation: { channel: "wechat", conversationId: "c_alice" },
  });
  router.bindThreadForIdentity(alice, "thread_1", "/repo");

  // Burn Bob's one-time welcome so the assertion sees only the denial.
  await router.handleMessageAsync({ identity: bob, text: "/status" });
  const reply = await router.handleMessageAsync({ identity: bob, text: "/approve a1" });

  assert.equal(reply.kind, "error");
  assert.match(reply.text, /发起人/);
  assert.deepEqual(decisions, [], "the approval must not reach the connector");

  const denyReply = await router.handleMessageAsync({ identity: bob, text: "/deny a1" });
  assert.equal(denyReply.kind, "error");
  assert.deepEqual(decisions, []);
});

test("[B-4] the thread owner can still /approve and /deny", async () => {
  const decisions = [];
  const { authorization, router } = makeRouter({ codexDesktop: approvalDesktop(decisions) });
  const alice = makeIdentity("wxid_alice");
  authorization.confirmIdentity(alice);

  await router.handleMessageAsync({
    identity: alice,
    text: "/status",
    conversation: { channel: "wechat", conversationId: "c_alice" },
  });
  router.bindThreadForIdentity(alice, "thread_1", "/repo");

  const reply = await router.handleMessageAsync({ identity: alice, text: "/approve a1" });
  assert.match(reply.text, /已批准 a1/);
  assert.deepEqual(decisions, [["a1", "accept"]]);
});

test("[B-4] identity-less resolveApproval (desktop UI path) skips the ownership gate", async () => {
  const decisions = [];
  const { authorization, router } = makeRouter({ codexDesktop: approvalDesktop(decisions) });
  const alice = makeIdentity("wxid_alice");
  authorization.confirmIdentity(alice);
  await router.handleMessageAsync({
    identity: alice,
    text: "/status",
    conversation: { channel: "wechat", conversationId: "c_alice" },
  });
  router.bindThreadForIdentity(alice, "thread_1", "/repo");

  // Called the way the channel runtimes / server API call it: no identity.
  await router.resolveApproval("a1", "accept");
  assert.deepEqual(decisions, [["a1", "accept"]]);
});

test("[B-4] approvals without a threadId or owner binding stay resolvable by any authorized identity", async () => {
  const decisions = [];
  const { authorization, router } = makeRouter({
    codexDesktop: approvalDesktop(decisions, { threadId: null }),
  });
  const bob = makeIdentity("wxid_bob");
  authorization.confirmIdentity(bob);

  await router.handleMessageAsync({ identity: bob, text: "/status" });
  const reply = await router.handleMessageAsync({ identity: bob, text: "/approve a1" });

  assert.match(reply.text, /已批准 a1/);
  assert.deepEqual(decisions, [["a1", "accept"]]);
});

// ---------------------------------------------------------------------------
// B-5: /tail reads desktop history (RPC + transcript fallback)
// ---------------------------------------------------------------------------

test("[B-5] /tail on a desktop thread pulls recent messages via the desktop RPC", async () => {
  const codexDesktop = {
    getStatus: () => ({ state: "connected" }),
    listRecentMessages: async ({ threadId, limit }) => {
      assert.equal(threadId, "thread_1");
      assert.equal(limit, 2);
      return {
        messages: [
          { role: "user", text: "fix the bug" },
          { role: "assistant", text: "done, tests green" },
        ],
      };
    },
  };
  const { authorization, sessions, router } = makeRouter({ codexDesktop });
  const alice = makeIdentity("wxid_alice");
  authorization.confirmIdentity(alice);

  router.handleMessage({ identity: alice, text: "/open 1" });
  sessions.upsertExternalSession({
    projectPath: "/repo",
    id: "thread_1",
    title: "Fix bug",
    identityKey: "wechat:wxid_alice",
  });

  const reply = await router.handleMessageAsync({ identity: alice, text: "/tail 2" });

  assert.match(reply.text, /你：\*\* fix the bug/);
  assert.match(reply.text, /Codex：\*\* done, tests green/);
});

test("[B-5] /tail falls back to the local transcript when the desktop RPC fails", async () => {
  const codexDesktop = {
    getStatus: () => ({ state: "connected" }),
    listRecentMessages: async () => {
      throw new Error("rpc down");
    },
  };
  const transcript = {
    listThread: (threadId, { limit }) => {
      assert.equal(threadId, "thread_1");
      assert.equal(limit, 3);
      // listThread returns newest-first.
      return {
        messages: [
          { role: "assistant", text: "second" },
          { role: "user", text: "first" },
        ],
      };
    },
  };
  const { authorization, sessions, router } = makeRouter({ codexDesktop, transcript });
  const alice = makeIdentity("wxid_alice");
  authorization.confirmIdentity(alice);

  router.handleMessage({ identity: alice, text: "/open 1" });
  sessions.upsertExternalSession({
    projectPath: "/repo",
    id: "thread_1",
    title: "Fix bug",
    identityKey: "wechat:wxid_alice",
  });

  const reply = await router.handleMessageAsync({ identity: alice, text: "/tail 3" });

  // Chronological order after the reverse.
  assert.match(reply.text, /first[\s\S]*second/);
});

test("[B-5] /tail keeps the in-memory read for local cli_ sessions", async () => {
  const { authorization, sessions, router } = makeRouter();
  const alice = makeIdentity("wxid_alice");
  authorization.confirmIdentity(alice);

  router.handleMessage({ identity: alice, text: "/open 1" });
  sessions.upsertExternalSession({
    projectPath: "/repo",
    id: "cli_123",
    title: "CLI run",
    messages: [{ role: "user", text: "inspect repo" }],
    identityKey: "wechat:wxid_alice",
  });

  const reply = await router.handleMessageAsync({ identity: alice, text: "/tail" });

  assert.match(reply.text, /user: inspect repo/);
});

// ---------------------------------------------------------------------------
// B-6: active-session pointer is per identity
// ---------------------------------------------------------------------------

test("[B-6] user A's /use does not redirect user B's plain messages", async () => {
  const calls = [];
  const codexDesktop = {
    getStatus: () => ({ state: "connected" }),
    listThreads: async () => ({ data: [] }),
    resumeThread: async ({ threadId }) => ({ thread: { id: threadId } }),
    startTurn: async ({ threadId, text }) => {
      calls.push({ threadId, text });
      return { turnId: "turn_1" };
    },
  };
  const { authorization, sessions, router } = makeRouter({ codexDesktop });
  const alice = makeIdentity("wxid_alice");
  const bob = makeIdentity("wxid_bob");
  authorization.confirmIdentity(alice);
  authorization.confirmIdentity(bob);

  sessions.upsertExternalSession({ projectPath: "/repo", id: "thread_a", title: "Alice thread" });

  router.handleMessage({ identity: alice, text: "/open 1" });
  router.handleMessage({ identity: bob, text: "/open 1" });
  await router.handleMessageAsync({ identity: alice, text: "/use thread_a" });

  // Burn Bob's welcome, then send his plain message.
  const reply = await router.handleMessageAsync({ identity: bob, text: "帮我改一下配置" });

  assert.deepEqual(calls, [], "Bob's message must not enter Alice's thread");
  assert.match(reply.text, /新建对话|请选择对话/, "Bob is guided to pick his own session");
  assert.equal(sessions.getActiveSession("/repo", "wechat:wxid_bob"), null);
  assert.equal(sessions.getActiveSession("/repo", "wechat:wxid_alice")?.id, "thread_a");
});

test("[B-6] per-identity active pointers persist through snapshot/restore", () => {
  const store = new SessionStore();
  store.upsertExternalSession({
    projectPath: "/repo",
    id: "thread_a",
    title: "A",
    identityKey: "wechat:wxid_alice",
  });
  store.upsertExternalSession({ projectPath: "/repo", id: "thread_b", title: "B" });

  const restored = new SessionStore({ sessions: store.snapshot() });

  assert.equal(restored.getActiveSession("/repo", "wechat:wxid_alice")?.id, "thread_a");
  // The identity-less (global) pointer still works for desktop callers.
  assert.equal(restored.getActiveSession("/repo")?.id, "thread_b");
  // An identity with no pointer of its own gets none — not someone else's.
  assert.equal(restored.getActiveSession("/repo", "wechat:wxid_bob"), null);
});

test("[B-6] legacy array snapshots (pre per-identity pointers) restore gracefully", () => {
  const legacy = [
    { projectPath: "/repo", id: "thread_a", title: "A", state: "idle", messages: [] },
  ];
  const restored = new SessionStore({ sessions: legacy });

  assert.equal(restored.getActiveSession("/repo")?.id, "thread_a");
  assert.equal(restored.getActiveSession("/repo", "wechat:wxid_alice"), null);
  assert.equal(restored.listSessions("/repo").length, 1);
});

// ---------------------------------------------------------------------------
// B-7: CLI-only follow-up dead end gets an actionable message
// ---------------------------------------------------------------------------

test("[B-7] plain messages to a cli_ session while desktop is down explain the /new way out", async () => {
  const codexDesktop = { getStatus: () => ({ state: "not_connected" }) };
  const { authorization, sessions, router } = makeRouter({ codexDesktop });
  const alice = makeIdentity("wxid_alice");
  authorization.confirmIdentity(alice);

  router.handleMessage({ identity: alice, text: "/open 1" });
  sessions.upsertExternalSession({
    projectPath: "/repo",
    id: "cli_abc",
    title: "inspect repo",
    identityKey: "wechat:wxid_alice",
  });

  await router.handleMessageAsync({ identity: alice, text: "/status" });
  const reply = await router.handleMessageAsync({ identity: alice, text: "继续刚才的任务" });

  assert.equal(reply.kind, "error");
  assert.match(reply.text, /\/new/);
  assert.match(reply.text, /CLI/);
});

test("[B-7] non-CLI sessions keep the plain not-connected error", async () => {
  const codexDesktop = { getStatus: () => ({ state: "not_connected" }) };
  const { authorization, sessions, router } = makeRouter({ codexDesktop });
  const alice = makeIdentity("wxid_alice");
  authorization.confirmIdentity(alice);

  router.handleMessage({ identity: alice, text: "/open 1" });
  sessions.upsertExternalSession({
    projectPath: "/repo",
    id: "thread_1",
    title: "Desktop thread",
    identityKey: "wechat:wxid_alice",
  });

  await router.handleMessageAsync({ identity: alice, text: "/status" });
  const reply = await router.handleMessageAsync({ identity: alice, text: "继续" });

  assert.equal(reply.kind, "error");
  assert.match(reply.text, /Codex Desktop 未连接/);
});

// ---------------------------------------------------------------------------
// B-10: picker states get an escape hatch
// ---------------------------------------------------------------------------

function pickerDesktop(calls) {
  return {
    getStatus: () => ({ state: "connected" }),
    listThreads: async () => ({ data: [{ id: "thread_1", preview: "Existing thread" }] }),
    resumeThread: async ({ threadId }) => ({ thread: { id: threadId } }),
    startTurn: async ({ threadId, text }) => {
      calls.push({ threadId, text });
      return { turnId: "turn_1" };
    },
  };
}

test("[B-10] non-numeric input in a picker hints once, then falls through as a normal message", async () => {
  const calls = [];
  const { authorization, sessions, router } = makeRouter({ codexDesktop: pickerDesktop(calls) });
  const alice = makeIdentity("wxid_alice");
  authorization.confirmIdentity(alice);

  router.handleMessage({ identity: alice, text: "/open 1" });
  sessions.upsertExternalSession({
    projectPath: "/repo",
    id: "thread_1",
    title: "Existing thread",
    identityKey: "wechat:wxid_alice",
  });
  await router.handleMessageAsync({ identity: alice, text: "/status" });
  // Open the session picker.
  await router.handleMessageAsync({ identity: alice, text: "/sessions" });

  const firstMiss = await router.handleMessageAsync({ identity: alice, text: "改一下 README" });
  assert.match(firstMiss.text, /\/cancel/, "first miss surfaces the /cancel escape");
  assert.deepEqual(calls, [], "first miss is not forwarded to Codex");

  const secondMiss = await router.handleMessageAsync({ identity: alice, text: "改一下 README 再试" });
  assert.deepEqual(calls, [{ threadId: "thread_1", text: "改一下 README 再试" }]);
  assert.match(secondMiss.text, /已发送给 Codex Desktop/);
});

test("[B-10] numeric input after a miss still picks from the list", async () => {
  const calls = [];
  const { authorization, router } = makeRouter({ codexDesktop: pickerDesktop(calls) });
  const alice = makeIdentity("wxid_alice");
  authorization.confirmIdentity(alice);

  router.handleMessage({ identity: alice, text: "/open 1" });
  await router.handleMessageAsync({ identity: alice, text: "/status" });
  await router.handleMessageAsync({ identity: alice, text: "/sessions" });

  await router.handleMessageAsync({ identity: alice, text: "随便说的" });
  const picked = await router.handleMessageAsync({ identity: alice, text: "1" });

  assert.match(picked.text, /已进入对话/);
});

test("[B-10] /cancel exits an open picker instead of cancelling a turn", async () => {
  const { authorization, router } = makeRouter();
  const alice = makeIdentity("wxid_alice");
  authorization.confirmIdentity(alice);

  router.handleMessage({ identity: alice, text: "/open 1" });
  await router.handleMessageAsync({ identity: alice, text: "/status" });
  await router.handleMessageAsync({ identity: alice, text: "/sessions" });

  const reply = await router.handleMessageAsync({ identity: alice, text: "/cancel" });

  assert.match(reply.text, /已退出选择/);
  assert.equal(router.pendingByIdentity.get("wechat:wxid_alice"), undefined);
});

test("[B-10] the project picker also gets the escape hatch", async () => {
  const { authorization, router } = makeRouter();
  const alice = makeIdentity("wxid_alice");
  authorization.confirmIdentity(alice);

  await router.handleMessageAsync({ identity: alice, text: "/status" });
  await router.handleMessageAsync({ identity: alice, text: "/projects" });

  const firstMiss = await router.handleMessageAsync({ identity: alice, text: "不是数字" });
  assert.match(firstMiss.text, /\/cancel/);

  const cancel = await router.handleMessageAsync({ identity: alice, text: "/cancel" });
  assert.match(cancel.text, /已退出选择/);
});

// ---------------------------------------------------------------------------
// B-12b: welcome / unauthorized-notice sets survive a restart
// ---------------------------------------------------------------------------

test("[B-12b] router snapshot carries noticed/greeted identities and restore suppresses repeats", async () => {
  const { authorization, router } = makeRouter();
  const alice = makeIdentity("wxid_alice");
  const stranger = makeIdentity("wxid_stranger");
  authorization.confirmIdentity(alice);

  const welcome = await router.handleMessageAsync({ identity: alice, text: "/status" });
  assert.match(welcome.text, /你已连接到 Comote/);
  const notice = await router.handleMessageAsync({ identity: stranger, text: "hello" });
  assert.equal(notice.kind, "notice");

  const snapshot = router.snapshot();
  assert.ok(snapshot.greetedIdentities.includes("wechat:wxid_alice"));
  assert.ok(snapshot.noticedIdentities.includes("wechat:wxid_stranger"));

  // Simulated restart: a fresh router restored from the snapshot.
  const { authorization: authorization2, router: router2 } = makeRouter({ persisted: snapshot });
  authorization2.confirmIdentity(alice);

  const second = await router2.handleMessageAsync({ identity: alice, text: "/status" });
  assert.ok(!second.text.includes("你已连接到 Comote"), "welcome must not repeat after restart");
  const strangerAgain = await router2.handleMessageAsync({ identity: stranger, text: "hello" });
  assert.equal(strangerAgain.kind, "denied", "notice must not repeat after restart");
});

test("[B-12b] the remembered-identity sets are capped at 500 with FIFO eviction", async () => {
  const { router } = makeRouter();

  for (let i = 0; i < 505; i += 1) {
    await router.handleMessageAsync({
      identity: makeIdentity(`wxid_stranger_${i}`),
      text: "hi",
    });
  }

  const snapshot = router.snapshot();
  assert.equal(snapshot.noticedIdentities.length, 500);
  assert.ok(!snapshot.noticedIdentities.includes("wechat:wxid_stranger_0"), "oldest entry evicted");
  assert.ok(snapshot.noticedIdentities.includes("wechat:wxid_stranger_504"), "newest entry kept");
});

test("[B-12b] restore also honors the 500-entry cap on oversized persisted arrays", () => {
  const noticed = Array.from({ length: 700 }, (_, i) => `wechat:wxid_${i}`);
  const { router } = makeRouter({ persisted: { noticedIdentities: noticed, greetedIdentities: [] } });

  const snapshot = router.snapshot();
  assert.equal(snapshot.noticedIdentities.length, 500);
  assert.ok(snapshot.noticedIdentities.includes("wechat:wxid_699"));
  assert.ok(!snapshot.noticedIdentities.includes("wechat:wxid_0"));
});
